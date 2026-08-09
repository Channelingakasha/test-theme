import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AdoptCandidate,
  AppSettings,
  GameInstall,
  LookupCandidate,
  Mod,
  Progress,
  StagedMod
} from '@shared/types'

export interface InstallChoices {
  selectedOptionIds: string[]
  overwrite: boolean
  replaceModId?: string
  loadOrderPrefix?: number
}

const api = {
  game: {
    detect: (): Promise<GameInstall | null> => ipcRenderer.invoke('game:detect'),
    pick: (): Promise<GameInstall | null> => ipcRenderer.invoke('game:pick'),
    open: (which: 'mods' | 'logic' | 'ue4ss' | 'root'): Promise<void> =>
      ipcRenderer.invoke('game:open', which)
  },
  mods: {
    list: (): Promise<Mod[]> => ipcRenderer.invoke('mods:list'),
    setEnabled: (id: string, enabled: boolean): Promise<Mod> =>
      ipcRenderer.invoke('mods:setEnabled', id, enabled),
    uninstall: (id: string): Promise<void> => ipcRenderer.invoke('mods:uninstall', id),
    setOptions: (id: string, optionIds: string[]): Promise<Mod> =>
      ipcRenderer.invoke('mods:setOptions', id, optionIds),
    setSetting: (id: string, key: string, value: string | number | boolean): Promise<Mod | null> =>
      ipcRenderer.invoke('mods:setSetting', id, key, value),
    refreshSettings: (id: string): Promise<Mod | null> => ipcRenderer.invoke('mods:refreshSettings', id),
    /** Search the web for this mod's page and return ranked matches. */
    lookup: (id: string): Promise<LookupCandidate[]> => ipcRenderer.invoke('mods:lookup', id),
    /** Fill in the mod's missing details from a chosen page. */
    applyInfo: (id: string, url: string): Promise<Mod> => ipcRenderer.invoke('mods:applyInfo', id, url),
    reveal: (target: string): Promise<void> => ipcRenderer.invoke('mods:reveal', target),
    openUrl: (url: string): Promise<void> => ipcRenderer.invoke('mods:openUrl', url)
  },
  add: {
    stage: (source: string): Promise<StagedMod> => ipcRenderer.invoke('add:stage', source),
    restage: (stageId: string, optionIds: string[]): Promise<StagedMod> =>
      ipcRenderer.invoke('add:restage', stageId, optionIds),
    install: (stageId: string, choices: InstallChoices): Promise<Mod> =>
      ipcRenderer.invoke('add:install', stageId, choices),
    discard: (stageId: string): Promise<void> => ipcRenderer.invoke('add:discard', stageId),
    pickFiles: (): Promise<string[]> => ipcRenderer.invoke('add:pickFiles'),
    pickFolder: (): Promise<string | null> => ipcRenderer.invoke('add:pickFolder')
  },
  scan: {
    folder: (folder: string): Promise<AdoptCandidate[]> => ipcRenderer.invoke('scan:folder', folder),
    game: (): Promise<AdoptCandidate[]> => ipcRenderer.invoke('scan:game'),
    import: (candidates: AdoptCandidate[]): Promise<{ adopted: number; staged: StagedMod[] }> =>
      ipcRenderer.invoke('scan:import', candidates)
  },
  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
    set: (patch: Partial<AppSettings>): Promise<AppSettings> => ipcRenderer.invoke('settings:set', patch)
  },
  /** Resolve real paths for dropped files — the renderer never sees a raw path otherwise. */
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  onProgress: (cb: (p: Progress) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, p: Progress): void => cb(p)
    ipcRenderer.on('progress', handler)
    return () => ipcRenderer.removeListener('progress', handler)
  }
}

contextBridge.exposeInMainWorld('palmod', api)

export type PalModApi = typeof api
