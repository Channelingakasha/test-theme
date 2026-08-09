import { app } from 'electron'
import path from 'node:path'
import type { AppSettings, Mod, Profile } from '@shared/types'
import { ensureDir, readJsonIfExists, writeJson } from './fsx'

interface Db {
  version: number
  mods: Mod[]
  profiles: Profile[]
  activeProfileId?: string
  settings: AppSettings
}

const DEFAULT_SETTINGS: AppSettings = {
  watchFolders: [],
  backupBeforeOverwrite: true,
  autoResolveSafeConflicts: false,
  theme: 'dark'
}

let db: Db | null = null

export function dataDir(): string {
  return app.getPath('userData')
}

export function dbPath(): string {
  return path.join(dataDir(), 'library.json')
}

/** Where we keep disabled payloads and pre-overwrite backups. */
export function vaultDir(): string {
  return path.join(dataDir(), 'vault')
}

export function imageCacheDir(): string {
  return path.join(dataDir(), 'images')
}

export function stagingDir(): string {
  return path.join(dataDir(), 'staging')
}

export type { Db }

export async function loadDb(): Promise<Db> {
  if (db) return db
  const loaded = await readJsonIfExists<Db>(dbPath())
  db = loaded ?? { version: 1, mods: [], profiles: [], settings: DEFAULT_SETTINGS }
  db.settings = { ...DEFAULT_SETTINGS, ...db.settings }
  if (!Array.isArray(db.mods)) db.mods = []
  // Databases written before profiles existed have no array here.
  if (!Array.isArray(db.profiles)) db.profiles = []
  await ensureDir(vaultDir())
  await ensureDir(imageCacheDir())
  return db
}

export async function saveDb(): Promise<void> {
  if (!db) return
  await writeJson(dbPath(), db)
}

export async function getMods(): Promise<Mod[]> {
  return (await loadDb()).mods
}

export async function getMod(id: string): Promise<Mod | undefined> {
  return (await loadDb()).mods.find((m) => m.id === id)
}

export async function upsertMod(mod: Mod): Promise<void> {
  const d = await loadDb()
  const i = d.mods.findIndex((m) => m.id === mod.id)
  if (i >= 0) d.mods[i] = mod
  else d.mods.push(mod)
  await saveDb()
}

export async function removeMod(id: string): Promise<void> {
  const d = await loadDb()
  d.mods = d.mods.filter((m) => m.id !== id)
  await saveDb()
}

export async function getSettings(): Promise<AppSettings> {
  return (await loadDb()).settings
}

export async function setSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const d = await loadDb()
  d.settings = { ...d.settings, ...patch }
  await saveDb()
  return d.settings
}
