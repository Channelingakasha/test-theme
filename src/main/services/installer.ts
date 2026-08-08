import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  Conflict,
  GameInstall,
  InstalledFile,
  Mod,
  ModKind,
  StagedMod
} from '@shared/types'
import { archiveKind, copyIntoStage, extractArchive } from './archive'
import { classifyStage, destinationFor, type ClassifiedFile } from './classify'
import { buildIndex, detectConflicts, saveModIndex } from './conflicts'
import { downloadTo } from './download'
import { ensureModDirs, savedDir } from './gameDetect'
import {
  copyFile,
  ensureDir,
  exists,
  humanSize,
  moveFile,
  readTextIfExists,
  removeIfEmpty,
  rmrf,
  sha1File,
  unwrapSingleRoot
} from './fsx'
import { mergeHowTo, readDocs, scanScripts } from './howto'
import { fetchMetadata, localizeImage, nameFromPath } from './metadata'
import { readSettings } from './modConfig'
import { getMods, getSettings, removeMod, stagingDir, upsertMod, vaultDir } from './store'

export type ProgressFn = (phase: string, value: number, detail?: string) => void

const CONTAINER_EXT = new Set(['.pak', '.ucas', '.utoc', '.sig'])

/** In-memory record of staged payloads awaiting an install decision. */
interface StageRecord {
  staged: StagedMod
  files: ClassifiedFile[]
  install: GameInstall
  imageCandidate?: string
  hooks: string[]
}

const stages = new Map<string, StageRecord>()

function isUrl(s: string): boolean {
  return /^https?:\/\//i.test(s.trim())
}

/** Files belonging to options the user did not select are left out of the plan. */
function filesForSelection(
  files: ClassifiedFile[],
  staged: Pick<StagedMod, 'options'>,
  selectedOptionIds: string[]
): ClassifiedFile[] {
  if (staged.options.length === 0) return files
  const optioned = new Set<string>()
  for (const o of staged.options) for (const f of o.files) optioned.add(f.toLowerCase())
  const selected = new Set<string>()
  for (const o of staged.options) {
    if (selectedOptionIds.includes(o.id)) for (const f of o.files) selected.add(f.toLowerCase())
  }
  return files.filter((f) => {
    const rel = f.rel.replace(/\\/g, '/').toLowerCase()
    if (!optioned.has(rel)) return true
    return selected.has(rel)
  })
}

/**
 * Prepare a source for installation without touching the game folder.
 * Handles URLs, archives, loose files and folders alike.
 */
export async function stageSource(
  source: string,
  install: GameInstall,
  onProgress: ProgressFn = () => {}
): Promise<StagedMod> {
  const stageId = randomUUID()
  const root = path.join(stagingDir(), stageId)
  const payload = path.join(root, 'payload')
  await ensureDir(payload)

  let localPath = source
  let sourceUrl: string | undefined
  let fetchedMeta: Awaited<ReturnType<typeof fetchMetadata>> = null

  if (isUrl(source)) {
    sourceUrl = source
    onProgress('scan', -1, 'Reading mod page…')
    fetchedMeta = await fetchMetadata(source)

    // Prefer a real download link discovered on the page (GitHub release asset).
    const target = fetchedMeta?.downloadUrl ?? source
    onProgress('download', 0, 'Downloading…')
    const dl = await downloadTo(target, path.join(root, 'download'), (v, d) =>
      onProgress('download', v, d)
    )
    localPath = dl.file
  }

  if (!(await exists(localPath))) {
    throw new Error(`Can't find "${localPath}".`)
  }

  const stat = await fs.stat(localPath)
  if (!stat.isDirectory() && archiveKind(localPath) !== 'none') {
    onProgress('extract', -1, 'Extracting…')
    await extractArchive(localPath, payload, (v) => onProgress('extract', v))
  } else {
    onProgress('extract', -1, 'Copying files…')
    await copyIntoStage(localPath, payload)
  }

  const payloadRoot = await unwrapSingleRoot(payload)

  // Metadata: page data wins, then the filename.
  const fallbackName = nameFromPath(isUrl(source) ? localPath : source)

  onProgress('scan', -1, 'Inspecting files…')
  const classified = await classifyStage(payloadRoot, fetchedMeta?.meta.name ?? fallbackName)
  const meta = fetchedMeta?.meta ?? {
    name: fallbackName,
    sourceUrl,
    tags: []
  }
  if (!meta.name) meta.name = fallbackName

  const scripts = await scanScripts([payloadRoot])
  const docs = await readDocs(classified.docs)
  const settings = await readSettings([payloadRoot])
  const howTo = mergeHowTo(
    [fetchedMeta?.howTo ?? { directions: [], tips: [], requirements: [], hotkeys: [] }, docs, scripts],
    settings,
    sourceUrl
  )

  const selected = classified.suggestedOptionIds
  const planFiles = filesForSelection(
    classified.files.filter((f) => !f.ignored),
    { options: classified.options },
    selected
  )

  const plan = planFiles.map((f) => ({
    rel: f.rel,
    dest: destinationFor(f, install, savedDir()),
    size: f.size
  }))

  const containerFiles = planFiles
    .filter((f) => CONTAINER_EXT.has(path.extname(f.abs).toLowerCase()))
    .map((f) => f.abs)

  onProgress('scan', -1, 'Checking for conflicts…')
  const conflicts = await detectConflicts(
    {
      plannedDests: plan.map((p) => p.dest),
      containerFiles,
      hooks: scripts.hooks,
      hotkeys: scripts.hotkeys.map((h) => h.key),
      kind: classified.kind,
      name: meta.name,
      sourceUrl,
      install
    },
    await getMods()
  )

  const staged: StagedMod = {
    stageId,
    stageDir: payloadRoot,
    meta,
    kind: classified.kind,
    options: classified.options,
    suggestedOptionIds: selected,
    settings,
    howTo,
    conflicts,
    plan,
    sizeBytes: plan.reduce((n, p) => n + p.size, 0),
    unhandled: classified.unhandled
  }

  stages.set(stageId, {
    staged,
    files: classified.files.filter((f) => !f.ignored),
    install,
    imageCandidate: meta.image ?? classified.images[0],
    hooks: scripts.hooks
  })

  onProgress('done', 1)
  return staged
}

/** Re-plan a staged mod after the user changes which options they want. */
export async function restageOptions(stageId: string, selectedOptionIds: string[]): Promise<StagedMod> {
  const rec = stages.get(stageId)
  if (!rec) throw new Error('That download is no longer staged — add it again.')

  const planFiles = filesForSelection(rec.files, rec.staged, selectedOptionIds)
  rec.staged.plan = planFiles.map((f) => ({
    rel: f.rel,
    dest: destinationFor(f, rec.install, savedDir()),
    size: f.size
  }))
  rec.staged.suggestedOptionIds = selectedOptionIds
  rec.staged.sizeBytes = rec.staged.plan.reduce((n, p) => n + p.size, 0)
  return rec.staged
}

/** UE4SS reads Mods/mods.txt as `ModName : 1`. Keep that file honest. */
async function setUe4ssModEnabled(
  ue4ssModsDir: string,
  modFolder: string,
  enabled: boolean
): Promise<void> {
  const file = path.join(ue4ssModsDir, 'mods.txt')
  const existing = (await readTextIfExists(file)) ?? ''
  const lines = existing.split(/\r?\n/)
  const flag = enabled ? '1' : '0'
  let found = false

  const updated = lines.map((line) => {
    const m = line.match(/^(\s*)([^;:\s][^:]*?)\s*:\s*([01])\s*$/)
    if (m && m[2].trim().toLowerCase() === modFolder.toLowerCase()) {
      found = true
      return `${m[1]}${m[2]} : ${flag}`
    }
    return line
  })

  if (!found) {
    // Keep the trailing blank line UE4SS ships with.
    const body = updated.filter((l) => l.trim().length > 0)
    body.push(`${modFolder} : ${flag}`)
    await ensureDir(ue4ssModsDir)
    await fs.writeFile(file, `${body.join('\n')}\n`, 'utf8')
    return
  }

  await ensureDir(ue4ssModsDir)
  await fs.writeFile(file, updated.join('\n'), 'utf8')
}

/** Some UE4SS builds also honour an `enabled.txt` marker inside the mod folder. */
async function setEnabledMarker(modDir: string, enabled: boolean): Promise<void> {
  const marker = path.join(modDir, 'enabled.txt')
  if (enabled) {
    if (!(await exists(marker))) await fs.writeFile(marker, '', 'utf8')
  } else {
    await fs.rm(marker, { force: true })
  }
}

function ue4ssFolderName(mod: Mod, install: GameInstall): string | null {
  if (mod.kind !== 'ue4ss-lua' && mod.kind !== 'ue4ss-dll') return null
  for (const f of mod.files) {
    const rel = path.relative(install.ue4ssModsDir, f.dest)
    if (!rel.startsWith('..')) {
      const first = rel.split(path.sep)[0]
      if (first) return first
    }
  }
  return null
}

export interface InstallChoices {
  selectedOptionIds: string[]
  /** Overwrite files owned by other mods / already on disk. */
  overwrite: boolean
  /** Replace an already-installed copy of the same mod. */
  replaceModId?: string
  loadOrderPrefix?: number
}

/** Commit a staged mod into the game folder. */
export async function installStaged(
  stageId: string,
  choices: InstallChoices,
  onProgress: ProgressFn = () => {}
): Promise<Mod> {
  const rec = stages.get(stageId)
  if (!rec) throw new Error('That download is no longer staged — add it again.')

  const { install } = rec
  const appSettings = await getSettings()
  await ensureModDirs(install)

  if (choices.replaceModId) {
    await uninstallMod(choices.replaceModId, { keepBackups: true })
  }

  const staged = await restageOptions(stageId, choices.selectedOptionIds)
  const modId = randomUUID()
  const installed: InstalledFile[] = []
  const roots = new Set<string>()

  const planFiles = filesForSelection(rec.files, staged, choices.selectedOptionIds)
  const total = planFiles.length || 1

  for (let i = 0; i < planFiles.length; i++) {
    const f = planFiles[i]
    let dest = destinationFor(f, install, savedDir())

    // Load-order prefix lets the user decide which pak wins.
    if (choices.loadOrderPrefix !== undefined && (f.kind === 'pak' || f.kind === 'logicmod')) {
      const dir = path.dirname(dest)
      const base = path.basename(dest).replace(/^\d{1,3}[-_ ]/, '')
      dest = path.join(dir, `${String(choices.loadOrderPrefix).padStart(3, '0')}-${base}`)
    }

    onProgress('install', i / total, path.basename(dest))

    const alreadyThere = await exists(dest)
    let backupPath: string | undefined

    if (alreadyThere) {
      if (!choices.overwrite) continue
      if (appSettings.backupBeforeOverwrite) {
        backupPath = path.join(vaultDir(), 'backups', modId, path.basename(dest))
        await copyFile(dest, backupPath)
      }
    }

    await copyFile(f.abs, dest)
    installed.push({
      dest,
      rel: f.rel,
      size: f.size,
      sha1: await sha1File(f.abs),
      backedUp: Boolean(backupPath),
      backupPath
    })
    roots.add(path.dirname(dest))
  }

  if (installed.length === 0) {
    throw new Error('Nothing was installed — every file was skipped.')
  }

  // Register script mods with UE4SS so they actually load.
  const modFolder =
    staged.kind === 'ue4ss-lua' || staged.kind === 'ue4ss-dll'
      ? path.relative(install.ue4ssModsDir, installed[0].dest).split(path.sep)[0]
      : null
  if (modFolder) {
    await setUe4ssModEnabled(install.ue4ssModsDir, modFolder, true)
    await setEnabledMarker(path.join(install.ue4ssModsDir, modFolder), true)
  }

  // Keep a copy of every option's files — including the ones not chosen — so
  // the user can switch variants later without downloading the mod again.
  const optionsStash = path.join(vaultDir(), 'options', modId)
  const optionsWithDests = staged.options.map((o) => ({
    ...o,
    dests: o.files.map((rel) => {
      const f = rec.files.find((x) => x.rel.replace(/\\/g, '/') === rel)
      return f ? destinationFor(f, install, savedDir()) : ''
    })
  }))
  for (const o of staged.options) {
    for (const rel of o.files) {
      const f = rec.files.find((x) => x.rel.replace(/\\/g, '/') === rel)
      if (f) await copyFile(f.abs, path.join(optionsStash, rel))
    }
  }

  onProgress('install', 0.9, 'Reading mod settings…')
  const installRoots = [...roots]
  const liveSettings = await readSettings(installRoots)
  const image = await localizeImage(rec.imageCandidate, modId)

  const containerFiles = installed
    .filter((f) => CONTAINER_EXT.has(path.extname(f.dest).toLowerCase()))
    .map((f) => f.dest)
  const scripts = await scanScripts(installRoots)

  await saveModIndex(
    await buildIndex(modId, containerFiles, scripts.hooks, scripts.hotkeys.map((h) => h.key))
  )

  const now = Date.now()
  const mod: Mod = {
    id: modId,
    meta: { ...staged.meta, image },
    kind: staged.kind,
    state: 'enabled',
    installRoots,
    files: installed,
    options: optionsWithDests,
    selectedOptionIds: choices.selectedOptionIds,
    settings: liveSettings.length ? liveSettings : staged.settings,
    howTo: mergeHowTo([staged.howTo, scripts], liveSettings, staged.meta.sourceUrl),
    loadOrder: choices.loadOrderPrefix ?? 100,
    installedAt: now,
    updatedAt: now,
    sizeBytes: installed.reduce((n, f) => n + f.size, 0)
  }

  await upsertMod(mod)
  await rmrf(path.join(stagingDir(), stageId))
  stages.delete(stageId)

  onProgress('done', 1, `${mod.meta.name} installed (${humanSize(mod.sizeBytes)})`)
  return mod
}

/** Discard a staged payload the user decided not to install. */
export async function discardStage(stageId: string): Promise<void> {
  stages.delete(stageId)
  await rmrf(path.join(stagingDir(), stageId))
}

/**
 * Turn a mod on or off.
 * Pak content is moved out of the game folder entirely (the only reliable way
 * to stop Unreal loading it); script mods are flipped in UE4SS's mods.txt.
 */
export async function setModEnabled(modId: string, enabled: boolean, install: GameInstall): Promise<Mod> {
  const mods = await getMods()
  const mod = mods.find((m) => m.id === modId)
  if (!mod) throw new Error('Mod not found.')
  if ((mod.state === 'enabled') === enabled) return mod

  const folder = ue4ssFolderName(mod, install)

  if (folder) {
    await setUe4ssModEnabled(install.ue4ssModsDir, folder, enabled)
    await setEnabledMarker(path.join(install.ue4ssModsDir, folder), enabled)
  } else {
    const store = path.join(vaultDir(), 'disabled', mod.id)
    for (const f of mod.files) {
      const parked = path.join(store, f.rel.replace(/\\/g, '/'))
      if (enabled) {
        if (await exists(parked)) await moveFile(parked, f.dest)
      } else if (await exists(f.dest)) {
        await moveFile(f.dest, parked)
        await removeIfEmpty(path.dirname(f.dest))
      }
    }
    if (enabled) await rmrf(store)
  }

  mod.state = enabled ? 'enabled' : 'disabled'
  mod.updatedAt = Date.now()
  await upsertMod(mod)
  return mod
}

/** Remove a mod's files and restore anything it overwrote. */
export async function uninstallMod(
  modId: string,
  opts: { keepBackups?: boolean } = {}
): Promise<void> {
  const mods = await getMods()
  const mod = mods.find((m) => m.id === modId)
  if (!mod) return

  for (const f of mod.files) {
    // Adopted mods point at files we didn't create; still ours to remove,
    // since the user asked for the mod to go.
    await fs.rm(f.dest, { force: true })
    if (f.backedUp && f.backupPath && (await exists(f.backupPath))) {
      await copyFile(f.backupPath, f.dest)
    }
    await removeIfEmpty(path.dirname(f.dest))
  }

  await rmrf(path.join(vaultDir(), 'disabled', mod.id))
  await rmrf(path.join(vaultDir(), 'options', mod.id))
  if (!opts.keepBackups) await rmrf(path.join(vaultDir(), 'backups', mod.id))
  await removeMod(modId)
}

/**
 * Change which variant of a multi-option mod is active, in place.
 * Files come from the vault copy made at install time, so switching works even
 * for options that were never installed.
 */
export async function applyOptionSelection(
  modId: string,
  selectedOptionIds: string[],
  install: GameInstall
): Promise<Mod> {
  const mods = await getMods()
  const mod = mods.find((m) => m.id === modId)
  if (!mod) throw new Error('Mod not found.')

  const stash = path.join(vaultDir(), 'options', mod.id)
  const optionedRels = new Set<string>()
  for (const o of mod.options) for (const rel of o.files) optionedRels.add(rel.replace(/\\/g, '/'))

  // Deactivate first: variants often share a filename, so the old file has to
  // go before the new one can take its place.
  for (const o of mod.options) {
    if (selectedOptionIds.includes(o.id)) continue
    for (let i = 0; i < o.files.length; i++) {
      const dest = o.dests?.[i]
      if (!dest || !(await exists(dest))) continue
      await fs.rm(dest, { force: true })
      await removeIfEmpty(path.dirname(dest))
    }
  }

  const active: InstalledFile[] = []
  for (const o of mod.options) {
    if (!selectedOptionIds.includes(o.id)) continue
    for (let i = 0; i < o.files.length; i++) {
      const rel = o.files[i].replace(/\\/g, '/')
      const dest = o.dests?.[i]
      if (!dest) continue
      const parked = path.join(stash, rel)
      if (!(await exists(dest))) {
        if (!(await exists(parked))) continue
        await copyFile(parked, dest)
      }
      let size = 0
      try {
        size = (await fs.stat(dest)).size
      } catch {
        continue
      }
      active.push({ dest, rel, size, sha1: await sha1File(dest) })
    }
  }

  // Rebuild the file list: everything that isn't part of an option, plus the
  // files belonging to the options now switched on.
  mod.files = [...mod.files.filter((f) => !optionedRels.has(f.rel.replace(/\\/g, '/'))), ...active]
  mod.installRoots = [...new Set(mod.files.map((f) => path.dirname(f.dest)))]
  mod.sizeBytes = mod.files.reduce((n, f) => n + f.size, 0)
  mod.selectedOptionIds = selectedOptionIds
  mod.updatedAt = Date.now()
  await upsertMod(mod)

  // The active containers changed, so the conflict fingerprint has to follow.
  const containerFiles = mod.files
    .filter((f) => CONTAINER_EXT.has(path.extname(f.dest).toLowerCase()))
    .map((f) => f.dest)
  const scripts = await scanScripts(mod.installRoots)
  await saveModIndex(
    await buildIndex(mod.id, containerFiles, scripts.hooks, scripts.hotkeys.map((h) => h.key))
  )

  void install
  return mod
}

/** Re-read a mod's config files from disk (after an external edit). */
export async function refreshModSettings(modId: string): Promise<Mod | null> {
  const mods = await getMods()
  const mod = mods.find((m) => m.id === modId)
  if (!mod) return null
  mod.settings = await readSettings(mod.installRoots)
  mod.updatedAt = Date.now()
  await upsertMod(mod)
  return mod
}

export function kindLabel(kind: ModKind): string {
  switch (kind) {
    case 'pak':
      return 'Content mod'
    case 'logicmod':
      return 'Blueprint mod'
    case 'ue4ss-lua':
      return 'Script mod'
    case 'ue4ss-dll':
      return 'Native mod'
    case 'ue4ss-core':
      return 'UE4SS loader'
    case 'save':
      return 'Save data'
    default:
      return 'Unknown'
  }
}

export type { Conflict }
