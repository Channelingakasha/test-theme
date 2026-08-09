import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AdoptCandidate, GameInstall, InstalledFile, Mod, ModKind } from '@shared/types'
import { archiveKind } from './archive'
import { buildIndex, saveModIndex } from './conflicts'
import { exists, isDir, isInside, sha1File, walk } from './fsx'
import { mergeHowTo, readDocs, scanScripts } from './howto'
import { nameFromPath } from './metadata'
import { readSettings } from './modConfig'
import { getMods, upsertMod } from './store'
import { classifyAssets } from './targets'

const CONTAINER_EXT = new Set(['.pak', '.ucas', '.utoc', '.sig'])

function prettyName(raw: string): string {
  return (
    nameFromPath(raw)
      .replace(/\b(pakchunk\d*|_?p)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim() || raw
  )
}

/** Group a container set (pak + ucas + utoc + sig sharing a base name). */
function setKey(file: string): string {
  return file.replace(/\.(pak|ucas|utoc|sig)$/i, '').toLowerCase()
}

/**
 * Look through a folder for things that look like Palworld mods.
 * Works both on a game folder (already installed) and on a loose folder of
 * downloads, e.g. the one on the user's desktop.
 */
export async function scanFolder(folder: string): Promise<AdoptCandidate[]> {
  if (!(await isDir(folder))) return []

  const files = await walk(folder, 8)
  const mods = await getMods()
  const tracked = new Set<string>()
  for (const m of mods) for (const f of m.files) tracked.add(path.normalize(f.dest).toLowerCase())

  const candidates = new Map<string, AdoptCandidate>()

  const add = (key: string, c: AdoptCandidate): void => {
    const existing = candidates.get(key)
    if (existing) {
      existing.fileCount += c.fileCount
      existing.sizeBytes += c.sizeBytes
      existing.alreadyTracked = existing.alreadyTracked || c.alreadyTracked
    } else {
      candidates.set(key, c)
    }
  }

  // 1) UE4SS mod folders — a directory holding Scripts/main.lua or dlls/.
  const luaRoots = new Set<string>()
  for (const f of files) {
    const rel = f.rel.replace(/\\/g, '/')
    const lower = rel.toLowerCase()
    const s = lower.lastIndexOf('/scripts/')
    const d = lower.lastIndexOf('/dlls/')
    if (s > 0) luaRoots.add(path.join(folder, rel.slice(0, s)))
    else if (d > 0) luaRoots.add(path.join(folder, rel.slice(0, d)))
  }
  for (const root of luaRoots) {
    const inner = await walk(root, 6)
    add(root.toLowerCase(), {
      path: root,
      suggestedName: prettyName(path.basename(root)),
      kind: (await exists(path.join(root, 'dlls'))) ? 'ue4ss-dll' : 'ue4ss-lua',
      fileCount: inner.length,
      sizeBytes: inner.reduce((n, x) => n + x.size, 0),
      alreadyTracked: inner.every((x) => tracked.has(path.normalize(x.abs).toLowerCase()))
    })
  }

  for (const f of files) {
    const ext = path.extname(f.abs).toLowerCase()
    const inLuaRoot = [...luaRoots].some((r) => isInside(r, f.abs))
    if (inLuaRoot) continue

    // 2) Loose archives waiting to be installed.
    if (archiveKind(f.abs) !== 'none') {
      add(f.abs.toLowerCase(), {
        path: f.abs,
        suggestedName: prettyName(path.basename(f.abs)),
        kind: 'unknown',
        fileCount: 1,
        sizeBytes: f.size,
        alreadyTracked: false
      })
      continue
    }

    // 3) Container sets already sitting in a mods folder.
    if (CONTAINER_EXT.has(ext)) {
      const key = setKey(f.abs)
      const isLogic = f.rel.toLowerCase().includes('logicmods')
      add(key, {
        path: f.abs,
        // Name from the real filename — the grouping key is lowercased.
        suggestedName: prettyName(path.basename(f.abs).replace(/\.(pak|ucas|utoc|sig)$/i, '')),
        kind: isLogic ? 'logicmod' : 'pak',
        fileCount: 1,
        sizeBytes: f.size,
        alreadyTracked: tracked.has(path.normalize(f.abs).toLowerCase())
      })
    }
  }

  return [...candidates.values()].sort((a, b) => a.suggestedName.localeCompare(b.suggestedName))
}

/** All files that belong to a candidate (the set siblings, or the whole folder). */
async function filesOfCandidate(c: AdoptCandidate): Promise<string[]> {
  if (await isDir(c.path)) {
    return (await walk(c.path, 8)).map((f) => f.abs)
  }
  const dir = path.dirname(c.path)
  const base = path.basename(setKey(c.path))
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return [c.path]
  }
  return entries
    .filter((e) => CONTAINER_EXT.has(path.extname(e).toLowerCase()) && setKey(e) === base.toLowerCase())
    .map((e) => path.join(dir, e))
}

/**
 * Register mods that are already in the game folder, without moving anything.
 * This is how a manually-modded install gets taken over by PalMod.
 */
export async function adoptInPlace(
  candidates: AdoptCandidate[],
  install: GameInstall
): Promise<Mod[]> {
  const created: Mod[] = []

  for (const c of candidates) {
    const absFiles = await filesOfCandidate(c)
    if (absFiles.length === 0) continue

    const modId = randomUUID()
    const rootDir = (await isDir(c.path)) ? c.path : path.dirname(c.path)

    const files: InstalledFile[] = []
    for (const abs of absFiles) {
      let size = 0
      try {
        size = (await fs.stat(abs)).size
      } catch {
        continue
      }
      files.push({
        dest: abs,
        rel: path.relative(rootDir, abs) || path.basename(abs),
        size,
        sha1: await sha1File(abs)
      })
    }
    if (files.length === 0) continue

    const kind: ModKind = c.kind === 'unknown' ? 'pak' : c.kind
    const installRoots = [...new Set(files.map((f) => path.dirname(f.dest)))]
    const settings = await readSettings(installRoots)
    const scripts = await scanScripts(installRoots)
    const docs = await readDocs(absFiles.filter((f) => /\.(txt|md)$/i.test(f)))

    const containerFiles = files
      .filter((f) => CONTAINER_EXT.has(path.extname(f.dest).toLowerCase()))
      .map((f) => f.dest)
    const index = await buildIndex(modId, containerFiles, scripts.hooks, scripts.hotkeys.map((h) => h.key))
    await saveModIndex(index)

    const now = Date.now()
    const mod: Mod = {
      id: modId,
      meta: { name: c.suggestedName, tags: ['adopted'] },
      kind,
      state: 'enabled',
      installRoots,
      files,
      options: [],
      selectedOptionIds: [],
      settings,
      howTo: mergeHowTo([docs, scripts], settings),
      targets: classifyAssets(index.assets),
      loadOrder: 100,
      installedAt: now,
      updatedAt: now,
      adopted: true,
      sizeBytes: files.reduce((n, f) => n + f.size, 0),
      notes: 'Imported from an existing install — PalMod did not copy these files.'
    }

    await upsertMod(mod)
    created.push(mod)
    void install
  }

  return created
}

/** Folders inside the game install are adopted; anything else is a source to install. */
export function isInsideGame(p: string, install: GameInstall): boolean {
  return isInside(install.root, p) || path.normalize(p).toLowerCase() === path.normalize(install.root).toLowerCase()
}

/** Convenience: scan the game's own mod folders for anything not yet tracked. */
export async function scanGameFolders(install: GameInstall): Promise<AdoptCandidate[]> {
  const out: AdoptCandidate[] = []
  for (const dir of [install.modsDir, install.logicModsDir, install.ue4ssModsDir]) {
    if (await isDir(dir)) out.push(...(await scanFolder(dir)))
  }
  const seen = new Set<string>()
  return out.filter((c) => {
    const k = c.path.toLowerCase()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}
