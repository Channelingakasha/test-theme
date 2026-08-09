import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import path from 'node:path'
import type {
  AdoptCandidate,
  AppSettings,
  GameInstall,
  LookupCandidate,
  Mod,
  ModSetting,
  StagedMod
} from '@shared/types'
import { adoptInPlace, isInsideGame, scanFolder, scanGameFolders } from './services/adopt'
import { detectGame, describeInstall, ensureModDirs, resolveUserPickedRoot } from './services/gameDetect'
import {
  applyOptionSelection,
  discardStage,
  installStaged,
  refreshModSettings,
  restageOptions,
  setModEnabled,
  stageSource,
  uninstallMod,
  type InstallChoices
} from './services/installer'
import { targetsForMod } from './services/conflicts'
import { applyLookup, lookupMod } from './services/lookup'
import { writeSetting } from './services/modConfig'
import { getMods, getSettings, setSettings, upsertMod } from './services/store'
import { exists } from './services/fsx'

let cachedInstall: GameInstall | null = null

/** Resolve the game install, preferring a path the user set explicitly. */
async function resolveInstall(force = false): Promise<GameInstall | null> {
  if (cachedInstall && !force) return cachedInstall

  const settings = await getSettings()
  if (settings.gameRoot) {
    const fromSetting = await resolveUserPickedRoot(settings.gameRoot)
    if (fromSetting) {
      cachedInstall = fromSetting
      return cachedInstall
    }
  }

  cachedInstall = await detectGame()
  return cachedInstall
}

async function requireInstall(): Promise<GameInstall> {
  const install = await resolveInstall()
  if (!install) {
    throw new Error("Palworld wasn't found. Set the game folder in Settings first.")
  }
  return install
}

type Send = () => BrowserWindow | null

export function registerIpc(getWindow: Send): void {
  const emit = (channel: string, payload: unknown): void => {
    getWindow()?.webContents.send(channel, payload)
  }

  const progress = (id: string, label: string) => (phase: string, value: number, detail?: string) => {
    emit('progress', { id, label, phase, value, detail })
  }

  // --- game ----------------------------------------------------------------
  ipcMain.handle('game:detect', async (): Promise<GameInstall | null> => resolveInstall(true))

  ipcMain.handle('game:pick', async (): Promise<GameInstall | null> => {
    const win = getWindow()
    const res = await dialog.showOpenDialog(win!, {
      title: 'Select your Palworld folder',
      properties: ['openDirectory']
    })
    if (res.canceled || !res.filePaths[0]) return null

    const install = await resolveUserPickedRoot(res.filePaths[0])
    if (!install) {
      throw new Error("That folder doesn't look like a Palworld install (no Pal/Content/Paks inside).")
    }
    await setSettings({ gameRoot: install.root })
    await ensureModDirs(install)
    cachedInstall = install
    return install
  })

  ipcMain.handle('game:open', async (_e, which: 'mods' | 'logic' | 'ue4ss' | 'root') => {
    const install = await requireInstall()
    const target =
      which === 'mods'
        ? install.modsDir
        : which === 'logic'
          ? install.logicModsDir
          : which === 'ue4ss'
            ? install.ue4ssModsDir
            : install.root
    await ensureModDirs(install)
    await shell.openPath(target)
  })

  // --- library -------------------------------------------------------------
  ipcMain.handle('mods:list', async (): Promise<Mod[]> => {
    const mods = await getMods()

    // Mods added before asset analysis existed get it filled in once, from
    // their cached index where possible so nothing is re-read from disk.
    for (const mod of mods) {
      if (mod.targets !== undefined) continue
      try {
        mod.targets = await targetsForMod(mod)
        await upsertMod(mod)
      } catch {
        mod.targets = [] // unreadable pak — don't retry on every listing
      }
    }

    return mods
  })

  ipcMain.handle('mods:setEnabled', async (_e, id: string, enabled: boolean): Promise<Mod> => {
    const install = await requireInstall()
    return setModEnabled(id, enabled, install)
  })

  ipcMain.handle('mods:uninstall', async (_e, id: string): Promise<void> => {
    await uninstallMod(id)
  })

  ipcMain.handle('mods:setOptions', async (_e, id: string, optionIds: string[]): Promise<Mod> => {
    const install = await requireInstall()
    return applyOptionSelection(id, optionIds, install)
  })

  ipcMain.handle(
    'mods:setSetting',
    async (_e, id: string, key: string, value: string | number | boolean): Promise<Mod | null> => {
      const mods = await getMods()
      const mod = mods.find((m) => m.id === id)
      if (!mod) return null

      const setting = mod.settings.find((s) => s.key === key)
      if (!setting) return null

      await writeSetting(setting, value)
      setting.value = value
      mod.updatedAt = Date.now()
      await upsertMod(mod)
      return mod
    }
  )

  ipcMain.handle('mods:refreshSettings', async (_e, id: string): Promise<Mod | null> =>
    refreshModSettings(id)
  )

  ipcMain.handle('mods:lookup', async (_e, id: string): Promise<LookupCandidate[]> => {
    const mod = (await getMods()).find((m) => m.id === id)
    if (!mod) throw new Error('Mod not found.')
    return lookupMod(mod)
  })

  ipcMain.handle('mods:applyInfo', async (_e, id: string, url: string): Promise<Mod> => {
    const mod = (await getMods()).find((m) => m.id === id)
    if (!mod) throw new Error('Mod not found.')
    if (!/^https?:\/\//i.test(url)) throw new Error('That doesn’t look like a web link.')

    const updated = await applyLookup(mod, url)
    await upsertMod(updated)
    return updated
  })

  ipcMain.handle('mods:reveal', async (_e, target: string): Promise<void> => {
    if (await exists(target)) shell.showItemInFolder(target)
    else await shell.openPath(path.dirname(target))
  })

  ipcMain.handle('mods:openUrl', async (_e, url: string): Promise<void> => {
    if (/^https?:\/\//i.test(url)) await shell.openExternal(url)
  })

  // --- adding --------------------------------------------------------------
  ipcMain.handle('add:stage', async (_e, source: string): Promise<StagedMod> => {
    const install = await requireInstall()
    const label = source.length > 60 ? `${source.slice(0, 57)}…` : source
    return stageSource(source, install, progress(source, label))
  })

  ipcMain.handle('add:restage', async (_e, stageId: string, optionIds: string[]): Promise<StagedMod> =>
    restageOptions(stageId, optionIds)
  )

  ipcMain.handle('add:install', async (_e, stageId: string, choices: InstallChoices): Promise<Mod> => {
    return installStaged(stageId, choices, progress(stageId, 'Installing'))
  })

  ipcMain.handle('add:discard', async (_e, stageId: string): Promise<void> => {
    await discardStage(stageId)
  })

  ipcMain.handle('add:pickFiles', async (): Promise<string[]> => {
    const win = getWindow()
    const res = await dialog.showOpenDialog(win!, {
      title: 'Choose mod files',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Mods and archives', extensions: ['zip', '7z', 'rar', 'pak', 'ucas', 'utoc', 'lua', 'dll'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    return res.canceled ? [] : res.filePaths
  })

  ipcMain.handle('add:pickFolder', async (): Promise<string | null> => {
    const win = getWindow()
    const res = await dialog.showOpenDialog(win!, {
      title: 'Choose a mod folder',
      properties: ['openDirectory']
    })
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })

  // --- adopting existing installs -----------------------------------------
  ipcMain.handle('scan:folder', async (_e, folder: string): Promise<AdoptCandidate[]> =>
    scanFolder(folder)
  )

  ipcMain.handle('scan:game', async (): Promise<AdoptCandidate[]> => {
    const install = await requireInstall()
    return scanGameFolders(install)
  })

  ipcMain.handle(
    'scan:import',
    async (_e, candidates: AdoptCandidate[]): Promise<{ adopted: number; staged: StagedMod[] }> => {
      const install = await requireInstall()
      const inGame = candidates.filter((c) => isInsideGame(c.path, install))
      const outside = candidates.filter((c) => !isInsideGame(c.path, install))

      const adopted = await adoptInPlace(inGame, install)

      // Anything outside the game folder is a source we still need to install.
      const staged: StagedMod[] = []
      for (const c of outside) {
        staged.push(await stageSource(c.path, install, progress(c.path, c.suggestedName)))
      }

      return { adopted: adopted.length, staged }
    }
  )

  // --- settings ------------------------------------------------------------
  ipcMain.handle('settings:get', async (): Promise<AppSettings> => getSettings())

  ipcMain.handle('settings:set', async (_e, patch: Partial<AppSettings>): Promise<AppSettings> => {
    const next = await setSettings(patch)
    if (patch.gameRoot) {
      cachedInstall = (await resolveUserPickedRoot(patch.gameRoot)) ?? cachedInstall
    }
    return next
  })

  ipcMain.handle('settings:describeInstall', async (_e, root: string): Promise<GameInstall | null> =>
    describeInstall(root, 'manual')
  )
}

export type { ModSetting }
