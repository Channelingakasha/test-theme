import { create } from 'zustand'
import type { AdoptCandidate, AppSettings, GameInstall, Mod, Progress, StagedMod } from '@shared/types'

export type View = 'library' | 'detail' | 'settings'
export type Filter = 'all' | 'enabled' | 'disabled' | 'conflicts'

export interface Toast {
  id: number
  kind: 'info' | 'success' | 'error'
  message: string
}

interface State {
  view: View
  selectedModId: string | null
  filter: Filter
  query: string

  install: GameInstall | null
  settings: AppSettings | null
  mods: Mod[]
  loading: boolean

  staged: StagedMod | null
  staging: boolean
  candidates: AdoptCandidate[] | null
  scanning: boolean

  progress: Progress | null
  toasts: Toast[]

  init: () => Promise<void>
  refresh: () => Promise<void>
  go: (view: View, modId?: string) => void
  setFilter: (f: Filter) => void
  setQuery: (q: string) => void

  addSource: (source: string) => Promise<void>
  setStagedOptions: (optionIds: string[]) => Promise<void>
  confirmInstall: (overwrite: boolean, replaceModId?: string) => Promise<void>
  cancelStage: () => Promise<void>

  toggleMod: (id: string, enabled: boolean) => Promise<void>
  uninstall: (id: string) => Promise<void>
  setModOptions: (id: string, optionIds: string[]) => Promise<void>
  changeSetting: (id: string, key: string, value: string | number | boolean) => Promise<void>

  scanFolder: (folder: string) => Promise<void>
  scanGame: () => Promise<void>
  importCandidates: (candidates: AdoptCandidate[]) => Promise<void>
  clearCandidates: () => void

  pickGame: () => Promise<void>
  toast: (message: string, kind?: Toast['kind']) => void
  dismissToast: (id: number) => void
}

const api = (): Window['palmod'] => window.palmod

function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  // Electron wraps handler errors; keep only the useful part.
  return raw.replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^Error:\s*/, '')
}

let toastSeq = 0

export const useStore = create<State>((set, get) => ({
  view: 'library',
  selectedModId: null,
  filter: 'all',
  query: '',

  install: null,
  settings: null,
  mods: [],
  loading: true,

  staged: null,
  staging: false,
  candidates: null,
  scanning: false,

  progress: null,
  toasts: [],

  init: async () => {
    set({ loading: true })
    try {
      const [install, settings, mods] = await Promise.all([
        api().game.detect(),
        api().settings.get(),
        api().mods.list()
      ])
      set({ install, settings, mods, loading: false })
    } catch (err) {
      set({ loading: false })
      get().toast(errorText(err), 'error')
    }

    api().onProgress((p) => {
      set({ progress: p.phase === 'done' ? null : p })
    })
  },

  refresh: async () => {
    try {
      const mods = await api().mods.list()
      set({ mods })
    } catch (err) {
      get().toast(errorText(err), 'error')
    }
  },

  go: (view, modId) => set({ view, selectedModId: modId ?? get().selectedModId }),
  setFilter: (filter) => set({ filter }),
  setQuery: (query) => set({ query }),

  addSource: async (source) => {
    const trimmed = source.trim()
    if (!trimmed) return
    set({ staging: true })
    try {
      const staged = await api().add.stage(trimmed)
      set({ staged, staging: false })
    } catch (err) {
      set({ staging: false, progress: null })
      get().toast(errorText(err), 'error')
    }
  },

  setStagedOptions: async (optionIds) => {
    const staged = get().staged
    if (!staged) return
    try {
      const next = await api().add.restage(staged.stageId, optionIds)
      set({ staged: { ...next } })
    } catch (err) {
      get().toast(errorText(err), 'error')
    }
  },

  confirmInstall: async (overwrite, replaceModId) => {
    const staged = get().staged
    if (!staged) return
    try {
      const mod = await api().add.install(staged.stageId, {
        selectedOptionIds: staged.suggestedOptionIds,
        overwrite,
        replaceModId
      })
      set({ staged: null, progress: null })
      await get().refresh()
      get().toast(`${mod.meta.name} installed`, 'success')
    } catch (err) {
      set({ progress: null })
      get().toast(errorText(err), 'error')
    }
  },

  cancelStage: async () => {
    const staged = get().staged
    set({ staged: null, progress: null })
    if (staged) await api().add.discard(staged.stageId).catch(() => undefined)
  },

  toggleMod: async (id, enabled) => {
    try {
      const updated = await api().mods.setEnabled(id, enabled)
      set({ mods: get().mods.map((m) => (m.id === id ? updated : m)) })
    } catch (err) {
      get().toast(errorText(err), 'error')
    }
  },

  uninstall: async (id) => {
    try {
      const mod = get().mods.find((m) => m.id === id)
      await api().mods.uninstall(id)
      set({
        mods: get().mods.filter((m) => m.id !== id),
        view: get().selectedModId === id ? 'library' : get().view,
        selectedModId: get().selectedModId === id ? null : get().selectedModId
      })
      get().toast(`${mod?.meta.name ?? 'Mod'} removed`, 'success')
    } catch (err) {
      get().toast(errorText(err), 'error')
    }
  },

  setModOptions: async (id, optionIds) => {
    try {
      const updated = await api().mods.setOptions(id, optionIds)
      set({ mods: get().mods.map((m) => (m.id === id ? updated : m)) })
    } catch (err) {
      get().toast(errorText(err), 'error')
    }
  },

  changeSetting: async (id, key, value) => {
    try {
      const updated = await api().mods.setSetting(id, key, value)
      if (updated) set({ mods: get().mods.map((m) => (m.id === id ? updated : m)) })
    } catch (err) {
      get().toast(errorText(err), 'error')
    }
  },

  scanFolder: async (folder) => {
    set({ scanning: true })
    try {
      const candidates = await api().scan.folder(folder)
      set({ candidates, scanning: false })
      if (candidates.length === 0) get().toast('No mods found in that folder', 'info')
    } catch (err) {
      set({ scanning: false })
      get().toast(errorText(err), 'error')
    }
  },

  scanGame: async () => {
    set({ scanning: true })
    try {
      const candidates = await api().scan.game()
      set({ candidates, scanning: false })
      if (candidates.length === 0) get().toast('Nothing new found in the game folder', 'info')
    } catch (err) {
      set({ scanning: false })
      get().toast(errorText(err), 'error')
    }
  },

  importCandidates: async (candidates) => {
    set({ scanning: true })
    try {
      const res = await api().scan.import(candidates)
      set({ candidates: null, scanning: false })
      await get().refresh()

      if (res.staged.length > 0) {
        // Anything from outside the game folder still needs an install decision.
        set({ staged: res.staged[0] })
      }
      if (res.adopted > 0) {
        get().toast(`Imported ${res.adopted} mod${res.adopted === 1 ? '' : 's'}`, 'success')
      }
    } catch (err) {
      set({ scanning: false })
      get().toast(errorText(err), 'error')
    }
  },

  clearCandidates: () => set({ candidates: null }),

  pickGame: async () => {
    try {
      const install = await api().game.pick()
      if (install) {
        set({ install })
        get().toast('Game folder set', 'success')
      }
    } catch (err) {
      get().toast(errorText(err), 'error')
    }
  },

  toast: (message, kind = 'info') => {
    const id = ++toastSeq
    set({ toasts: [...get().toasts, { id, kind, message }] })
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 8000 : 4000)
  },

  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) })
}))

/**
 * Mods after the active filter and search query.
 *
 * Deliberately a plain function rather than a store selector: it builds a new
 * array every call, and returning a fresh reference from a zustand selector
 * makes React's useSyncExternalStore re-render without end. Call it from a
 * useMemo in the component instead.
 */
export function filterMods(mods: Mod[], filter: Filter, query: string): Mod[] {
  const q = query.trim().toLowerCase()
  return mods.filter((m) => {
    if (filter === 'enabled' && m.state !== 'enabled') return false
    if (filter === 'disabled' && m.state !== 'disabled') return false
    if (!q) return true
    return (
      m.meta.name.toLowerCase().includes(q) ||
      (m.meta.description ?? '').toLowerCase().includes(q) ||
      (m.meta.author ?? '').toLowerCase().includes(q)
    )
  })
}
