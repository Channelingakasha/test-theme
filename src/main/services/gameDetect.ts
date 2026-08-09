import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { GameEdition, GameInstall } from '@shared/types'
import { exists, isDir, readTextIfExists } from './fsx'

const PALWORLD_APPID = '1623730'

/** Candidate Steam roots on a typical Windows box. */
function steamRoots(): string[] {
  const roots: string[] = []
  const drives = ['C:', 'D:', 'E:', 'F:', 'G:']
  const progFiles = [
    process.env['ProgramFiles(x86)'],
    process.env.ProgramFiles,
    process.env.ProgramW6432
  ].filter(Boolean) as string[]
  for (const pf of progFiles) roots.push(path.join(pf, 'Steam'))
  for (const d of drives) {
    roots.push(path.join(`${d}\\`, 'Steam'))
    roots.push(path.join(`${d}\\`, 'SteamLibrary'))
  }
  return roots
}

/**
 * Parse Steam's libraryfolders.vdf for every library path.
 * The file is Valve KeyValues; we only need the "path" entries, so a
 * line scan is both sufficient and resilient to format drift.
 */
async function steamLibraryPaths(): Promise<string[]> {
  const libs: string[] = []
  for (const root of steamRoots()) {
    const vdf =
      (await readTextIfExists(path.join(root, 'steamapps', 'libraryfolders.vdf'))) ??
      (await readTextIfExists(path.join(root, 'config', 'libraryfolders.vdf')))
    if (!vdf) continue
    libs.push(root)
    for (const m of vdf.matchAll(/"path"\s*"([^"]+)"/g)) {
      libs.push(m[1].replace(/\\\\/g, '\\'))
    }
  }
  return [...new Set(libs)]
}

/** Read the install folder name out of the app manifest, when present. */
async function steamInstallDir(library: string): Promise<string | null> {
  const manifest = await readTextIfExists(
    path.join(library, 'steamapps', `appmanifest_${PALWORLD_APPID}.acf`)
  )
  if (!manifest) return null
  const m = manifest.match(/"installdir"\s*"([^"]+)"/)
  return m ? path.join(library, 'steamapps', 'common', m[1]) : null
}

async function candidateRoots(): Promise<{ root: string; edition: GameEdition }[]> {
  const out: { root: string; edition: GameEdition }[] = []

  for (const lib of await steamLibraryPaths()) {
    const fromManifest = await steamInstallDir(lib)
    if (fromManifest) out.push({ root: fromManifest, edition: 'steam' })
    out.push({ root: path.join(lib, 'steamapps', 'common', 'Palworld'), edition: 'steam' })
  }

  // Xbox / Game Pass keeps the game under XboxGames/<Title>/Content.
  for (const d of ['C:', 'D:', 'E:', 'F:']) {
    out.push({ root: path.join(`${d}\\`, 'XboxGames', 'Palworld', 'Content'), edition: 'xbox' })
  }

  // Epic default install location.
  for (const pf of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)) {
    out.push({ root: path.join(pf as string, 'Epic Games', 'Palworld'), edition: 'epic' })
  }

  return out
}

/** True when the folder looks like a Palworld install root. */
async function looksLikePalworld(root: string): Promise<boolean> {
  return (await isDir(path.join(root, 'Pal', 'Content', 'Paks'))) || (await exists(path.join(root, 'Palworld.exe')))
}

/**
 * UE4SS 3.x lives in Binaries/Win64/ue4ss with Mods inside it; older builds put
 * Mods directly in Binaries/Win64. Prefer whichever actually exists.
 */
async function resolveUe4ss(
  binariesDir: string
): Promise<{ modsDir: string; installed: boolean; version?: string }> {
  const modern = path.join(binariesDir, 'ue4ss')
  const modernMods = path.join(modern, 'Mods')
  const legacyMods = path.join(binariesDir, 'Mods')

  const loaderPresent =
    (await exists(path.join(binariesDir, 'dwmapi.dll'))) ||
    (await exists(path.join(binariesDir, 'UE4SS.dll'))) ||
    (await exists(path.join(modern, 'UE4SS.dll')))

  let version: string | undefined
  for (const p of [path.join(modern, 'UE4SS-settings.ini'), path.join(binariesDir, 'UE4SS-settings.ini')]) {
    const text = await readTextIfExists(p)
    const m = text?.match(/(\d+\.\d+\.\d+)/)
    if (m) {
      version = m[1]
      break
    }
  }

  if (await isDir(modernMods)) return { modsDir: modernMods, installed: loaderPresent || true, version }
  if (await isDir(legacyMods)) return { modsDir: legacyMods, installed: loaderPresent || true, version }
  // Nothing there yet — target the modern layout for future installs.
  return { modsDir: modernMods, installed: loaderPresent, version }
}

export async function describeInstall(root: string, edition: GameEdition): Promise<GameInstall> {
  const paksDir = path.join(root, 'Pal', 'Content', 'Paks')
  const binariesDir = path.join(root, 'Pal', 'Binaries', 'Win64')
  const ue4ss = await resolveUe4ss(binariesDir)

  // PalSchema is a UE4SS mod that loads JSON definitions from its own mods
  // folder, so it lives alongside the other UE4SS mods.
  const palSchemaRoot = path.join(ue4ss.modsDir, 'PalSchema')

  return {
    root,
    edition,
    paksDir,
    modsDir: path.join(paksDir, '~mods'),
    logicModsDir: path.join(paksDir, 'LogicMods'),
    binariesDir,
    ue4ssModsDir: ue4ss.modsDir,
    ue4ssInstalled: ue4ss.installed,
    ue4ssVersion: ue4ss.version,
    palSchemaDir: path.join(palSchemaRoot, 'mods'),
    palSchemaInstalled: await isDir(palSchemaRoot),
    valid: await looksLikePalworld(root)
  }
}

/** Search the usual places; returns null when the game can't be found. */
export async function detectGame(): Promise<GameInstall | null> {
  for (const { root, edition } of await candidateRoots()) {
    if (await looksLikePalworld(root)) return describeInstall(root, edition)
  }
  return null
}

/**
 * Accept a user-picked folder. People often pick the Paks folder, the Pal
 * folder, or the Steam "common" folder — walk up or down to the real root.
 */
export async function resolveUserPickedRoot(picked: string): Promise<GameInstall | null> {
  const tries = [
    picked,
    path.resolve(picked, '..'),
    path.resolve(picked, '..', '..'),
    path.resolve(picked, '..', '..', '..'),
    path.resolve(picked, '..', '..', '..', '..'),
    path.join(picked, 'Palworld')
  ]
  for (const t of tries) {
    if (await looksLikePalworld(t)) return describeInstall(t, 'manual')
  }
  return null
}

/** %LOCALAPPDATA%/Pal/Saved — where saves and some mod configs live. */
export function savedDir(): string {
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
  return path.join(local, 'Pal', 'Saved')
}

/** Create the mod folders the game reads, so installs never fail on a missing dir. */
export async function ensureModDirs(install: GameInstall): Promise<void> {
  for (const d of [install.modsDir, install.logicModsDir]) {
    await fs.mkdir(d, { recursive: true })
  }
}
