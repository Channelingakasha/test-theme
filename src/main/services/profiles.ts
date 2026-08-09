/**
 * Mod profiles: named loadouts that can be switched between.
 *
 * A profile records which mods are on. Applying one enables exactly those and
 * disables everything else, reusing the same per-kind enable/disable logic the
 * toggles use, so a switch leaves the game folder in a genuinely valid state
 * rather than just rewriting the database.
 */
import { randomUUID } from 'node:crypto'
import type { ApplyResult, GameInstall, Mod, Profile } from '@shared/types'
import { setModEnabled } from './installer'
import { getMods, loadDb, saveDb } from './store'

export async function listProfiles(): Promise<Profile[]> {
  const db = await loadDb()
  return db.profiles ?? []
}

export async function activeProfileId(): Promise<string | null> {
  const db = await loadDb()
  return db.activeProfileId ?? null
}

/** Snapshot the mods that are currently on as a new profile. */
export async function createProfile(name: string, fromCurrent = true): Promise<Profile> {
  const db = await loadDb()
  const mods = await getMods()

  const profile: Profile = {
    id: randomUUID(),
    name: name.trim() || 'New profile',
    enabledModIds: fromCurrent ? mods.filter((m) => m.state === 'enabled').map((m) => m.id) : [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  }

  db.profiles = [...(db.profiles ?? []), profile]
  await saveDb()
  return profile
}

export async function deleteProfile(id: string): Promise<void> {
  const db = await loadDb()
  db.profiles = (db.profiles ?? []).filter((p) => p.id !== id)
  if (db.activeProfileId === id) db.activeProfileId = undefined
  await saveDb()
}

export async function renameProfile(id: string, name: string): Promise<Profile | null> {
  const db = await loadDb()
  const profile = (db.profiles ?? []).find((p) => p.id === id)
  if (!profile) return null
  profile.name = name.trim() || profile.name
  profile.updatedAt = Date.now()
  await saveDb()
  return profile
}

/** Overwrite a profile with whatever is currently switched on. */
export async function saveCurrentToProfile(id: string): Promise<Profile | null> {
  const db = await loadDb()
  const profile = (db.profiles ?? []).find((p) => p.id === id)
  if (!profile) return null

  const mods = await getMods()
  profile.enabledModIds = mods.filter((m) => m.state === 'enabled').map((m) => m.id)
  profile.updatedAt = Date.now()
  await saveDb()
  return profile
}

/**
 * Make the game folder match a profile.
 * Disables first so that mods sharing a filename can hand over cleanly.
 */
export async function applyProfile(id: string, install: GameInstall): Promise<ApplyResult> {
  const db = await loadDb()
  const profile = (db.profiles ?? []).find((p) => p.id === id)
  if (!profile) throw new Error('Profile not found.')

  const mods: Mod[] = await getMods()
  const wanted = new Set(profile.enabledModIds)
  const result: ApplyResult = { enabled: 0, disabled: 0, missing: [], failed: [] }

  for (const modId of profile.enabledModIds) {
    if (!mods.some((m) => m.id === modId)) result.missing.push(modId)
  }

  for (const mod of mods) {
    if (wanted.has(mod.id) || mod.state !== 'enabled') continue
    try {
      await setModEnabled(mod.id, false, install)
      result.disabled++
    } catch (err) {
      result.failed.push({ modId: mod.id, error: err instanceof Error ? err.message : String(err) })
    }
  }

  for (const mod of mods) {
    if (!wanted.has(mod.id) || mod.state === 'enabled') continue
    try {
      await setModEnabled(mod.id, true, install)
      result.enabled++
    } catch (err) {
      result.failed.push({ modId: mod.id, error: err instanceof Error ? err.message : String(err) })
    }
  }

  db.activeProfileId = id
  profile.updatedAt = Date.now()
  await saveDb()
  return result
}
