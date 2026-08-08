import path from 'node:path'
import type { GameInstall, ModKind, ModOption } from '@shared/types'
import { walk, type WalkedFile } from './fsx'

const CONTAINER_EXT = new Set(['.pak', '.ucas', '.utoc', '.sig'])
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
const DOC_EXT = new Set(['.txt', '.md', '.pdf', '.rtf', '.html'])

/** Folder names that mean "pick one of these". */
const VARIANT_HINTS = [
  'optional',
  'options',
  'option',
  'variant',
  'variants',
  'choose',
  'choice',
  'alternative',
  'alternate',
  'colors',
  'colours',
  'styles',
  'versions',
  'pick one',
  'select one',
  'skins'
]

export interface ClassifiedFile extends WalkedFile {
  kind: ModKind
  /** Destination relative to the target root for its kind. */
  destRel: string
  ignored?: boolean
}

function posix(rel: string): string {
  return rel.replace(/\\/g, '/')
}

function segments(rel: string): string[] {
  return posix(rel).split('/').filter(Boolean)
}

/** Base name with the container extension stripped, so a pak/ucas/utoc trio groups as one. */
function containerSetKey(rel: string): string {
  const p = posix(rel)
  return p.replace(/\.(pak|ucas|utoc|sig)$/i, '').toLowerCase()
}

function hasSegment(rel: string, name: string): boolean {
  return segments(rel).some((s) => s.toLowerCase() === name.toLowerCase())
}

function isVariantFolderName(name: string): boolean {
  const l = name.toLowerCase()
  return VARIANT_HINTS.some((h) => l.includes(h))
}

/**
 * Work out what a single file is and where it goes.
 * `luaModRoots` holds relative dirs already identified as UE4SS mod folders;
 * an empty string means the payload root itself is the mod folder, in which
 * case `fallbackName` supplies the name to install under.
 */
function classifyFile(f: WalkedFile, luaModRoots: string[], fallbackName: string): ClassifiedFile {
  const rel = posix(f.rel)
  const ext = path.extname(rel).toLowerCase()
  const base = path.basename(rel).toLowerCase()
  const segs = segments(rel)

  // UE4SS itself — the loader files that sit next to the game exe.
  if (
    base === 'dwmapi.dll' ||
    base === 'ue4ss.dll' ||
    base === 'ue4ss-settings.ini' ||
    (base === 'mods.txt' && segs.length <= 3 && !luaModRoots.length)
  ) {
    return { ...f, kind: 'ue4ss-core', destRel: rel }
  }

  // Anything inside a detected Lua/DLL mod folder keeps its structure.
  for (const root of luaModRoots) {
    const atPayloadRoot = root === ''
    if (atPayloadRoot || rel === root || rel.startsWith(`${root}/`)) {
      const modName = atPayloadRoot ? fallbackName : (root.split('/').pop() as string)
      const inner = atPayloadRoot ? rel : rel.slice(root.length).replace(/^\//, '')
      const kind: ModKind = hasSegment(inner, 'dlls') ? 'ue4ss-dll' : 'ue4ss-lua'
      return { ...f, kind, destRel: `${modName}/${inner}` }
    }
  }

  if (CONTAINER_EXT.has(ext)) {
    // Blueprint mods must land in LogicMods or BPModLoader won't see them.
    const kind: ModKind = hasSegment(rel, 'LogicMods') ? 'logicmod' : 'pak'
    return { ...f, kind, destRel: path.basename(rel) }
  }

  if (ext === '.sav' || hasSegment(rel, 'Saved')) {
    return { ...f, kind: 'save', destRel: rel }
  }

  // Loose readme/preview material: useful metadata, never installed.
  if (IMAGE_EXT.has(ext) || DOC_EXT.has(ext)) {
    return { ...f, kind: 'unknown', destRel: rel, ignored: true }
  }

  return { ...f, kind: 'unknown', destRel: rel, ignored: true }
}

/**
 * Find UE4SS mod folders. A mod folder is one that directly contains
 * `Scripts/main.lua`, `dlls/main.dll`, or an `enabled.txt`.
 */
function findLuaModRoots(files: WalkedFile[]): string[] {
  const roots = new Set<string>()
  let atPayloadRoot = false

  for (const f of files) {
    const rel = posix(f.rel)
    const l = rel.toLowerCase()
    let root: string | null = null

    const scripts = l.lastIndexOf('/scripts/')
    const dlls = l.lastIndexOf('/dlls/')
    if (l.startsWith('scripts/') || l.startsWith('dlls/')) atPayloadRoot = true
    else if (scripts >= 0) root = rel.slice(0, scripts)
    else if (dlls >= 0) root = rel.slice(0, dlls)
    else if (path.basename(l) === 'enabled.txt') root = path.dirname(rel)

    if (root !== null && root !== '.' && root !== '') roots.add(root)
  }

  // A bare Scripts/ at the top means the archive dropped the mod's own folder;
  // the caller names it instead.
  if (roots.size === 0 && atPayloadRoot) return ['']

  // Keep only the outermost roots so nested matches don't double-count.
  return [...roots].filter((r) => ![...roots].some((o) => o !== r && r.startsWith(`${o}/`)))
}

export interface ClassifyResult {
  files: ClassifiedFile[]
  kind: ModKind
  options: ModOption[]
  suggestedOptionIds: string[]
  unhandled: string[]
  /** Loose images found in the payload — candidates for the card preview. */
  images: string[]
  /** Readme-ish documents, used to build the "How to use" section. */
  docs: string[]
}

/**
 * Detect mutually exclusive variants. Character/skin mods usually ship one
 * container set per look, either in named subfolders or side by side.
 */
function detectOptions(files: ClassifiedFile[]): { options: ModOption[]; suggested: string[] } {
  const containers = files.filter((f) => CONTAINER_EXT.has(path.extname(f.rel).toLowerCase()))
  if (containers.length === 0) return { options: [], suggested: [] }

  // Group pak/ucas/utoc siblings into one logical set. The key is lowercased
  // for matching, but display names keep the original casing from disk.
  interface ContainerSet {
    files: ClassifiedFile[]
    dir: string
    base: string
  }
  const sets = new Map<string, ContainerSet>()
  for (const c of containers) {
    const key = containerSetKey(c.rel)
    const existing = sets.get(key)
    if (existing) {
      existing.files.push(c)
    } else {
      const rel = posix(c.rel)
      sets.set(key, {
        files: [c],
        dir: path.dirname(rel),
        base: path.basename(rel).replace(/\.(pak|ucas|utoc|sig)$/i, '')
      })
    }
  }
  if (sets.size < 2) return { options: [], suggested: [] }

  const setEntries = [...sets.values()]

  const distinctDirs = new Set(setEntries.map((s) => s.dir))
  const underVariantFolder = setEntries.some((s) =>
    segments(s.dir).some((seg) => isVariantFolderName(seg))
  )

  // Exclusive when each set sits in its own subfolder, or the tree is
  // explicitly labelled "optional"/"variants"/etc.
  const exclusive = underVariantFolder || distinctDirs.size === setEntries.length

  const options: ModOption[] = setEntries.map((set, i) => {
    const label =
      set.dir !== '.' && distinctDirs.size === setEntries.length
        ? (segments(set.dir).pop() as string)
        : set.base
    return {
      id: `opt-${i}-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
      label: label.replace(/[_-]+/g, ' ').trim(),
      files: set.files.map((g) => posix(g.rel)),
      group: exclusive ? 'variant' : `addon-${i}`,
      recommended: i === 0 && exclusive
    }
  })

  // Exclusive sets default to the first; independent add-ons all default on.
  const suggested = exclusive ? [options[0].id] : options.map((o) => o.id)
  return { options, suggested }
}

function dominantKind(files: ClassifiedFile[]): ModKind {
  const counts = new Map<ModKind, number>()
  for (const f of files) {
    if (f.ignored) continue
    counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1)
  }
  if (counts.get('ue4ss-core')) return 'ue4ss-core'
  const order: ModKind[] = ['ue4ss-lua', 'ue4ss-dll', 'logicmod', 'pak', 'save']
  let best: ModKind = 'unknown'
  let bestN = 0
  for (const k of order) {
    const n = counts.get(k) ?? 0
    if (n > bestN) {
      best = k
      bestN = n
    }
  }
  return best
}

/**
 * Inspect a staged payload and describe everything we found.
 * `fallbackName` names a script mod whose own folder the archive omitted.
 */
export async function classifyStage(stageDir: string, fallbackName = 'Mod'): Promise<ClassifyResult> {
  const walked = await walk(stageDir)
  const luaModRoots = findLuaModRoots(walked)
  const safeName = fallbackName.replace(/[\\/:*?"<>|]/g, '').trim() || 'Mod'
  const files = walked.map((f) => classifyFile(f, luaModRoots, safeName))

  const { options, suggested } = detectOptions(files)

  return {
    files,
    kind: dominantKind(files),
    options,
    suggestedOptionIds: suggested,
    unhandled: files.filter((f) => f.ignored && !IMAGE_EXT.has(path.extname(f.rel).toLowerCase())).map((f) => posix(f.rel)),
    images: files
      .filter((f) => IMAGE_EXT.has(path.extname(f.rel).toLowerCase()))
      .sort((a, b) => b.size - a.size)
      .map((f) => f.abs),
    docs: files.filter((f) => DOC_EXT.has(path.extname(f.rel).toLowerCase())).map((f) => f.abs)
  }
}

/** Absolute destination for a classified file, given the detected game install. */
export function destinationFor(file: ClassifiedFile, install: GameInstall, savedDir: string): string {
  switch (file.kind) {
    case 'pak':
      return path.join(install.modsDir, file.destRel)
    case 'logicmod':
      return path.join(install.logicModsDir, file.destRel)
    case 'ue4ss-lua':
    case 'ue4ss-dll':
      return path.join(install.ue4ssModsDir, file.destRel)
    case 'ue4ss-core':
      return path.join(install.binariesDir, file.destRel)
    case 'save':
      return path.join(savedDir, file.destRel)
    default:
      return path.join(install.modsDir, file.destRel)
  }
}
