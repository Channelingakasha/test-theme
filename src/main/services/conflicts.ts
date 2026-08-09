import path from 'node:path'
import type { Conflict, GameInstall, Mod, ModKind, ModTarget } from '@shared/types'
import { exists, readJsonIfExists, writeJson } from './fsx'
import { dataDir } from './store'
import { indexContainers } from './pak'
import { classifyAssets } from './targets'

/**
 * Per-mod fingerprint used for conflict checks. Computed once at install time
 * and cached, because re-reading pak indices on every add would be slow.
 */
export interface ModIndex {
  modId: string
  assets: string[]
  chunkIds: string[]
  /** UFunction names hooked by script mods. */
  hooks: string[]
  /** Keys bound by script mods. */
  hotkeys: string[]
  readable: boolean
}

function indexPath(modId: string): string {
  return path.join(dataDir(), 'indexes', `${modId}.json`)
}

export async function saveModIndex(index: ModIndex): Promise<void> {
  await writeJson(indexPath(index.modId), index)
}

export async function loadModIndex(modId: string): Promise<ModIndex | null> {
  return readJsonIfExists<ModIndex>(indexPath(modId))
}

/** Build a fingerprint from a set of container files plus parsed script info. */
export async function buildIndex(
  modId: string,
  containerFiles: string[],
  hooks: string[],
  hotkeys: string[]
): Promise<ModIndex> {
  const { assets, chunkIds, readable } = await indexContainers(containerFiles)
  return { modId, assets, chunkIds, hooks, hotkeys, readable }
}

/**
 * What a mod changes in game, from its cooked asset paths. Uses the cached
 * index when one exists so nothing is re-read from disk.
 */
export async function targetsForMod(mod: Mod): Promise<ModTarget[]> {
  let index = await loadModIndex(mod.id)

  // Mods added before indexing existed, or whose index was lost, get one now.
  if (!index) {
    const containers = mod.files
      .filter((f) => /\.(pak|utoc)$/i.test(f.dest))
      .map((f) => f.dest)
    if (containers.length === 0) return []
    index = await buildIndex(mod.id, containers, [], [])
    await saveModIndex(index)
  }

  return classifyAssets(index.assets)
}

function intersect(a: string[], b: Set<string>, limit = 12): string[] {
  const out: string[] = []
  for (const x of a) {
    if (b.has(x)) {
      out.push(x)
      if (out.length >= limit) break
    }
  }
  return out
}

export interface ConflictInput {
  /** Destination paths the new mod wants to write. */
  plannedDests: string[]
  /** Container files in the staging folder, for asset comparison. */
  containerFiles: string[]
  hooks: string[]
  hotkeys: string[]
  kind: ModKind
  name: string
  sourceUrl?: string
  install: GameInstall
}

/**
 * Compare a staged mod against everything already installed.
 * Nothing here writes to disk — it only reports.
 */
export async function detectConflicts(
  input: ConflictInput,
  installed: Mod[],
  opts: { excludeModId?: string } = {}
): Promise<Conflict[]> {
  const conflicts: Conflict[] = []
  const others = installed.filter((m) => m.id !== opts.excludeModId)

  // --- Same mod already present -------------------------------------------
  const dupe = others.find(
    (m) =>
      (input.sourceUrl && m.meta.sourceUrl === input.sourceUrl) ||
      m.meta.name.toLowerCase().trim() === input.name.toLowerCase().trim()
  )
  if (dupe) {
    conflicts.push({
      type: 'duplicate-mod',
      severity: 'warning',
      message: `"${dupe.meta.name}" is already installed${
        dupe.meta.version ? ` (version ${dupe.meta.version})` : ''
      }.`,
      withModIds: [dupe.id],
      details: [`Installed ${new Date(dupe.installedAt).toLocaleDateString()}`],
      resolutions: ['replace-existing', 'keep-both', 'cancel']
    })
  }

  // --- Exact file collisions ----------------------------------------------
  const ownerByDest = new Map<string, Mod>()
  for (const m of others) {
    for (const f of m.files) ownerByDest.set(path.normalize(f.dest).toLowerCase(), m)
  }

  const collisionsByMod = new Map<string, string[]>()
  const untrackedCollisions: string[] = []

  for (const dest of input.plannedDests) {
    const key = path.normalize(dest).toLowerCase()
    const owner = ownerByDest.get(key)
    if (owner) {
      const arr = collisionsByMod.get(owner.id) ?? []
      arr.push(path.basename(dest))
      collisionsByMod.set(owner.id, arr)
    } else if (await exists(dest)) {
      untrackedCollisions.push(path.basename(dest))
    }
  }

  for (const [modId, filesHit] of collisionsByMod) {
    const owner = others.find((m) => m.id === modId)
    if (!owner || owner.id === dupe?.id) continue
    conflicts.push({
      type: 'file-collision',
      severity: 'blocking',
      message: `${filesHit.length} file${filesHit.length === 1 ? '' : 's'} would overwrite "${owner.meta.name}".`,
      withModIds: [owner.id],
      details: filesHit.slice(0, 12),
      resolutions: ['overwrite', 'skip', 'cancel']
    })
  }

  if (untrackedCollisions.length) {
    conflicts.push({
      type: 'file-collision',
      severity: 'warning',
      message: `${untrackedCollisions.length} file${
        untrackedCollisions.length === 1 ? '' : 's'
      } already exist in the game folder but aren't managed by PalMod.`,
      withModIds: [],
      details: untrackedCollisions.slice(0, 12),
      resolutions: ['overwrite', 'skip', 'cancel']
    })
  }

  // --- Asset-level overlap between containers ------------------------------
  const newIndex = await indexContainers(input.containerFiles)
  if (newIndex.readable && (newIndex.assets.length || newIndex.chunkIds.length)) {
    for (const m of others) {
      if (m.id === dupe?.id) continue
      const other = await loadModIndex(m.id)
      if (!other?.readable) continue

      const assetHits = intersect(newIndex.assets, new Set(other.assets))
      const chunkHits = intersect(newIndex.chunkIds, new Set(other.chunkIds))
      if (!assetHits.length && !chunkHits.length) continue

      const details = assetHits.length
        ? assetHits
        : chunkHits.map((c) => `shared cooked object ${c.slice(0, 12)}`)

      conflicts.push({
        type: 'asset-overlap',
        severity: 'warning',
        message: `Edits the same game assets as "${m.meta.name}". Only one of them will take effect.`,
        withModIds: [m.id],
        details,
        resolutions: ['raise-load-order', 'lower-load-order', 'install-anyway', 'cancel']
      })
    }
  } else if (input.containerFiles.length && !newIndex.readable) {
    conflicts.push({
      type: 'load-order',
      severity: 'info',
      message: "This mod's package index couldn't be read, so asset overlap wasn't checked.",
      withModIds: [],
      details: ['Load order still applies: later-sorting files win.'],
      resolutions: ['install-anyway']
    })
  }

  // --- Script mod clashes ---------------------------------------------------
  for (const m of others) {
    const other = await loadModIndex(m.id)
    if (!other) continue

    const keyHits = intersect(input.hotkeys, new Set(other.hotkeys))
    if (keyHits.length) {
      conflicts.push({
        type: 'hotkey-clash',
        severity: 'warning',
        message: `Uses the same hotkey${keyHits.length === 1 ? '' : 's'} as "${m.meta.name}".`,
        withModIds: [m.id],
        details: keyHits,
        resolutions: ['install-anyway', 'cancel']
      })
    }

    const hookHits = intersect(input.hooks, new Set(other.hooks))
    if (hookHits.length) {
      conflicts.push({
        type: 'hook-clash',
        severity: 'info',
        message: `Hooks the same game functions as "${m.meta.name}".`,
        withModIds: [m.id],
        details: hookHits,
        resolutions: ['install-anyway', 'cancel']
      })
    }
  }

  // --- Requirements ---------------------------------------------------------
  const needsUe4ss = input.kind === 'ue4ss-lua' || input.kind === 'ue4ss-dll' || input.kind === 'logicmod'
  if (needsUe4ss && !input.install.ue4ssInstalled) {
    conflicts.push({
      type: 'missing-requirement',
      severity: 'blocking',
      message:
        input.kind === 'logicmod'
          ? 'Blueprint mods need UE4SS with BPModLoader, which is not installed.'
          : 'This is a script mod and needs UE4SS, which is not installed.',
      withModIds: [],
      details: [`Expected loader in ${input.install.binariesDir}`],
      resolutions: ['install-anyway', 'cancel']
    })
  }

  return conflicts
}

/** Highest severity present, for badge colouring in the UI. */
export function worstSeverity(conflicts: Conflict[]): 'blocking' | 'warning' | 'info' | 'none' {
  if (conflicts.some((c) => c.severity === 'blocking')) return 'blocking'
  if (conflicts.some((c) => c.severity === 'warning')) return 'warning'
  if (conflicts.length) return 'info'
  return 'none'
}
