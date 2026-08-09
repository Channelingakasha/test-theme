/**
 * Direct access to PalMod's own database, for the Edit tab.
 *
 * This is the escape hatch: when the UI can't express a change, the underlying
 * record can be edited as raw JSON. Every write is validated first, because a
 * malformed record here would break the library on next launch — the editor
 * refuses to save anything it can't vouch for.
 */
import type {
  AppSettings,
  Mod,
  Profile,
  RescanResult,
  TableName,
  TableRow,
  ValidationResult
} from '@shared/types'
import { exists } from './fsx'
import { loadDb, saveDb } from './store'
import { targetsForMod } from './conflicts'
import { readSettings } from './modConfig'

export const TABLES: TableName[] = ['mods', 'profiles', 'settings']

export async function listTable(table: TableName): Promise<TableRow[]> {
  const db = await loadDb()

  if (table === 'mods') {
    return db.mods.map((m) => ({
      id: m.id,
      label: m.meta.name,
      columns: {
        name: m.meta.name,
        kind: m.kind,
        state: m.state,
        version: m.meta.version ?? '—',
        files: m.files.length,
        size: m.sizeBytes,
        adopted: Boolean(m.adopted)
      },
      record: m
    }))
  }

  if (table === 'profiles') {
    return (db.profiles ?? []).map((p) => ({
      id: p.id,
      label: p.name,
      columns: {
        name: p.name,
        mods: p.enabledModIds.length,
        active: db.activeProfileId === p.id,
        updated: new Date(p.updatedAt).toLocaleDateString()
      },
      record: p
    }))
  }

  // Settings is a single record; the grid shows it as one row.
  return [
    {
      id: 'settings',
      label: 'Application settings',
      columns: {
        gameRoot: db.settings.gameRoot ?? '—',
        backups: db.settings.backupBeforeOverwrite,
        theme: db.settings.theme
      },
      record: db.settings
    }
  ]
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function validateMod(value: unknown, id: string): string[] {
  const errors: string[] = []
  if (!isObject(value)) return ['A mod record must be a JSON object.']

  if (value.id !== id) errors.push(`"id" must stay "${id}" — changing it would orphan the record.`)
  if (!isObject(value.meta)) errors.push('"meta" must be an object.')
  else if (typeof (value.meta as Record<string, unknown>).name !== 'string') {
    errors.push('"meta.name" must be a string.')
  }

  const kinds = ['pak', 'logicmod', 'ue4ss-lua', 'ue4ss-dll', 'ue4ss-core', 'palschema', 'save', 'unknown']
  if (typeof value.kind !== 'string' || !kinds.includes(value.kind)) {
    errors.push(`"kind" must be one of: ${kinds.join(', ')}.`)
  }
  if (value.state !== 'enabled' && value.state !== 'disabled') {
    errors.push('"state" must be "enabled" or "disabled".')
  }
  if (!Array.isArray(value.files)) errors.push('"files" must be an array.')
  else {
    value.files.forEach((f, i) => {
      if (!isObject(f) || typeof f.dest !== 'string') {
        errors.push(`"files[${i}].dest" must be a string path.`)
      }
    })
  }
  if (!Array.isArray(value.installRoots)) errors.push('"installRoots" must be an array.')
  if (!Array.isArray(value.options)) errors.push('"options" must be an array.')
  if (!Array.isArray(value.settings)) errors.push('"settings" must be an array.')

  return errors
}

function validateProfile(value: unknown, id: string): string[] {
  const errors: string[] = []
  if (!isObject(value)) return ['A profile record must be a JSON object.']

  if (value.id !== id) errors.push(`"id" must stay "${id}".`)
  if (typeof value.name !== 'string' || value.name.trim() === '') {
    errors.push('"name" must be a non-empty string.')
  }
  if (!Array.isArray(value.enabledModIds)) errors.push('"enabledModIds" must be an array of mod ids.')
  else if (value.enabledModIds.some((x) => typeof x !== 'string')) {
    errors.push('"enabledModIds" must contain only strings.')
  }
  return errors
}

function validateSettings(value: unknown): string[] {
  const errors: string[] = []
  if (!isObject(value)) return ['Settings must be a JSON object.']

  if (value.gameRoot !== undefined && typeof value.gameRoot !== 'string') {
    errors.push('"gameRoot" must be a string path.')
  }
  if (!Array.isArray(value.watchFolders)) errors.push('"watchFolders" must be an array.')
  for (const key of ['backupBeforeOverwrite', 'autoResolveSafeConflicts']) {
    if (typeof value[key] !== 'boolean') errors.push(`"${key}" must be true or false.`)
  }
  if (value.theme !== 'dark') errors.push('"theme" must be "dark" (the only theme available).')
  return errors
}

/** Parse and check a record without writing anything. */
export function validateRecord(table: TableName, id: string, text: string): ValidationResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { ok: false, errors: [`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`] }
  }

  const errors =
    table === 'mods'
      ? validateMod(parsed, id)
      : table === 'profiles'
        ? validateProfile(parsed, id)
        : validateSettings(parsed)

  return { ok: errors.length === 0, errors, formatted: JSON.stringify(parsed, null, 2) }
}

/** Validate and commit an edited record. */
export async function saveRecord(table: TableName, id: string, text: string): Promise<ValidationResult> {
  const result = validateRecord(table, id, text)
  if (!result.ok) return result

  const parsed = JSON.parse(text)
  const db = await loadDb()

  if (table === 'mods') {
    const i = db.mods.findIndex((m) => m.id === id)
    if (i < 0) return { ok: false, errors: ['That mod is no longer in the library.'] }
    db.mods[i] = { ...(parsed as Mod), updatedAt: Date.now() }
  } else if (table === 'profiles') {
    const i = (db.profiles ?? []).findIndex((p) => p.id === id)
    if (i < 0) return { ok: false, errors: ['That profile no longer exists.'] }
    db.profiles[i] = { ...(parsed as Profile), updatedAt: Date.now() }
  } else {
    db.settings = parsed as AppSettings
  }

  await saveDb()
  return result
}

/**
 * Re-read the mod folders and reconcile the library with what's on disk.
 * Run after an edit, since a hand-changed record can easily disagree with
 * reality — and after any change made outside the app.
 */
export async function rescan(): Promise<RescanResult> {
  const db = await loadDb()
  const result: RescanResult = { checked: 0, missingFiles: [], corrected: [], settingsRefreshed: 0 }

  for (const mod of db.mods) {
    result.checked++

    const present: boolean[] = []
    for (const f of mod.files) present.push(await exists(f.dest))
    const anyPresent = present.some(Boolean)
    const allMissing = mod.files.length > 0 && !anyPresent

    // A disabled pak mod is *meant* to have nothing at its destination — its
    // files are parked in the vault — so only an enabled mod can be missing.
    const scriptMod = mod.kind === 'ue4ss-lua' || mod.kind === 'ue4ss-dll'
    if (allMissing && mod.state === 'enabled') {
      result.missingFiles.push(mod.meta.name)
      // Script mods stay in place when off, so absent files there mean the
      // mod is genuinely gone rather than switched off.
      if (!scriptMod) {
        mod.state = 'disabled'
        result.corrected.push(mod.meta.name)
      }
    }

    if (anyPresent) {
      const settings = await readSettings(mod.installRoots)
      if (settings.length > 0) {
        mod.settings = settings
        result.settingsRefreshed++
      }
      try {
        mod.targets = await targetsForMod(mod)
      } catch {
        /* unreadable pak — leave whatever was there */
      }
    }

    mod.updatedAt = Date.now()
  }

  await saveDb()
  return result
}
