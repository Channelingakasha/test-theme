import { useEffect, useState } from 'react'
import { ImportDialog } from './components/ImportDialog'
import { InfoLookupDialog } from './components/InfoLookupDialog'
import { StageDialog } from './components/StageDialog'
import { Toasts } from './components/Toasts'
import { Library } from './views/Library'
import { ModDetail } from './views/ModDetail'
import { SettingsView } from './views/SettingsView'
import { useStore } from './state'

function Sidebar(): JSX.Element {
  const view = useStore((s) => s.view)
  const go = useStore((s) => s.go)
  const mods = useStore((s) => s.mods)
  const install = useStore((s) => s.install)
  const pickGame = useStore((s) => s.pickGame)

  const active = mods.filter((m) => m.state === 'enabled').length

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark" aria-hidden>
          🥚
        </div>
        <div>
          <div className="brand-name">PalMod</div>
          <div className="brand-sub">Palworld mod manager</div>
        </div>
      </div>

      <nav className="nav">
        <div className="nav-label">Library</div>
        <button
          className={`nav-item ${view === 'library' || view === 'detail' ? 'active' : ''}`}
          onClick={() => go('library')}
        >
          <span aria-hidden>🎒</span>
          <span>All mods</span>
          <span className="nav-count">{mods.length}</span>
        </button>
        <button className={`nav-item ${view === 'settings' ? 'active' : ''}`} onClick={() => go('settings')}>
          <span aria-hidden>⚙️</span>
          <span>Settings</span>
        </button>
      </nav>

      <div className="game-status">
        <div className="row">
          <span className={`dot ${install?.valid ? 'ok' : 'bad'}`} />
          <strong style={{ fontSize: 12.5 }}>{install?.valid ? 'Palworld found' : 'Game not found'}</strong>
        </div>

        {install ? (
          <>
            <div className="path-chip">{install.root}</div>
            <div className="row">
              <span className={`dot ${install.ue4ssInstalled ? 'ok' : 'warn'}`} />
              <span style={{ fontSize: 11.5 }}>
                {install.ue4ssInstalled ? 'UE4SS ready' : 'UE4SS missing'}
              </span>
            </div>
            <div className="row" style={{ fontSize: 11.5, color: 'var(--text-mute)' }}>
              {active} of {mods.length} active
            </div>
          </>
        ) : (
          <button className="btn sm primary" onClick={() => void pickGame()}>
            Locate Palworld
          </button>
        )}
      </div>
    </aside>
  )
}

/** Full-window drop target: files, folders and dragged links all land here. */
function useDropTarget(): boolean {
  const addSource = useStore((s) => s.addSource)
  const scanFolder = useStore((s) => s.scanFolder)
  const [over, setOver] = useState(false)

  useEffect(() => {
    let depth = 0

    const onDragEnter = (e: DragEvent): void => {
      e.preventDefault()
      depth++
      setOver(true)
    }
    const onDragOver = (e: DragEvent): void => e.preventDefault()
    const onDragLeave = (e: DragEvent): void => {
      e.preventDefault()
      depth = Math.max(0, depth - 1)
      if (depth === 0) setOver(false)
    }

    const onDrop = async (e: DragEvent): Promise<void> => {
      e.preventDefault()
      depth = 0
      setOver(false)
      if (!e.dataTransfer) return

      const files = [...e.dataTransfer.files]
      if (files.length > 0) {
        for (const file of files) {
          const p = window.palmod.pathForFile(file)
          if (!p) continue
          // A dropped folder gets scanned; a single file is staged directly.
          const looksLikeFolder = !/\.[a-z0-9]{1,6}$/i.test(p)
          if (looksLikeFolder) await scanFolder(p)
          else await addSource(p)
        }
        return
      }

      const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain')
      if (text?.trim()) await addSource(text.trim())
    }

    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', (e) => void onDrop(e))

    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
    }
  }, [addSource, scanFolder])

  return over
}

export default function App(): JSX.Element {
  const init = useStore((s) => s.init)
  const view = useStore((s) => s.view)
  const loading = useStore((s) => s.loading)
  const selectedModId = useStore((s) => s.selectedModId)
  const mod = useStore((s) => s.mods.find((m) => m.id === s.selectedModId))
  const dragging = useDropTarget()

  useEffect(() => {
    void init()
  }, [init])

  return (
    <>
      <div className="titlebar" />
      <div className="app">
        <Sidebar />
        <main className="main">
          {loading ? (
            <div className="empty">
              <div className="icon" aria-hidden>
                ⏳
              </div>
              <h2>Looking for Palworld…</h2>
            </div>
          ) : view === 'settings' ? (
            <SettingsView />
          ) : view === 'detail' && mod ? (
            <ModDetail mod={mod} />
          ) : view === 'detail' && selectedModId ? (
            <div className="empty">
              <h2>That mod is gone</h2>
              <p>It was removed from your library.</p>
            </div>
          ) : (
            <Library />
          )}
        </main>
      </div>

      {dragging && (
        <div className="drop-overlay">
          <div className="drop-inner">
            <div style={{ fontSize: 48 }} aria-hidden>
              📥
            </div>
            <div className="big">Drop to add</div>
            <div className="muted small" style={{ marginTop: 8 }}>
              Zip, 7z, rar, loose files, or a whole folder
            </div>
          </div>
        </div>
      )}

      <StageDialog />
      <ImportDialog />
      <InfoLookupDialog />
      <Toasts />
    </>
  )
}
