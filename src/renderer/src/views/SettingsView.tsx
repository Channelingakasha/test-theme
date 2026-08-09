import { useStore } from '../state'
import { Toggle } from '../components/Toggle'

export function SettingsView(): JSX.Element {
  const install = useStore((s) => s.install)
  const settings = useStore((s) => s.settings)
  const pickGame = useStore((s) => s.pickGame)
  const scanGame = useStore((s) => s.scanGame)
  const scanFolder = useStore((s) => s.scanFolder)
  const scanning = useStore((s) => s.scanning)
  const toast = useStore((s) => s.toast)

  const save = async (patch: Parameters<NonNullable<typeof window.palmod.settings.set>>[0]): Promise<void> => {
    const next = await window.palmod.settings.set(patch)
    useStore.setState({ settings: next })
  }

  const pickWatchFolder = async (): Promise<void> => {
    const folder = await window.palmod.add.pickFolder()
    if (!folder) return
    await scanFolder(folder)
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <div className="subtitle">Where Palworld lives and how PalMod handles your files</div>
        </div>
      </div>

      <div className="panels">
        <div>
          <section className="panel">
            <div className="panel-head">
              <h2>Game folder</h2>
              <button className="btn sm" onClick={() => void pickGame()}>
                Change folder
              </button>
            </div>

            {install ? (
              <div className="stack" style={{ gap: 12 }}>
                <div className="row small">
                  <span className={`dot ${install.valid ? 'ok' : 'bad'}`} />
                  <span className="muted">
                    Detected via {install.edition === 'manual' ? 'manual selection' : install.edition}
                  </span>
                </div>
                <div className="path-row">{install.root}</div>

                <h3 style={{ marginTop: 10 }}>Mod folders</h3>
                <div className="path-row">
                  <span>{install.modsDir}</span>
                  <button className="icon-btn" onClick={() => void window.palmod.game.open('mods')}>
                    ↗
                  </button>
                </div>
                <div className="path-row">
                  <span>{install.logicModsDir}</span>
                  <button className="icon-btn" onClick={() => void window.palmod.game.open('logic')}>
                    ↗
                  </button>
                </div>
                <div className="path-row">
                  <span>{install.ue4ssModsDir}</span>
                  <button className="icon-btn" onClick={() => void window.palmod.game.open('ue4ss')}>
                    ↗
                  </button>
                </div>

                <div className="row small" style={{ marginTop: 6 }}>
                  <span className={`dot ${install.ue4ssInstalled ? 'ok' : 'warn'}`} />
                  <span className="muted">
                    {install.ue4ssInstalled
                      ? `UE4SS detected${install.ue4ssVersion ? ` (${install.ue4ssVersion})` : ''} — script and blueprint mods will work`
                      : 'UE4SS not found — script and blueprint mods need it installed first'}
                  </span>
                </div>
              </div>
            ) : (
              <div className="stack">
                <div className="row small">
                  <span className="dot bad" />
                  <span className="muted">Palworld wasn't found automatically.</span>
                </div>
                <button className="btn primary" onClick={() => void pickGame()}>
                  Locate Palworld folder
                </button>
              </div>
            )}
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Import existing mods</h2>
            </div>
            <p className="prose" style={{ marginBottom: 18 }}>
              Already have mods installed by hand, or a folder of downloads sitting on your desktop?
              Point PalMod at it and it will take them over — cards, toggles and all. Mods already inside
              the game folder are adopted in place, so nothing gets moved.
            </p>
            <div className="row wrap">
              <button className="btn" onClick={() => void scanGame()} disabled={!install || scanning}>
                🔍 Scan the game folder
              </button>
              <button className="btn" onClick={() => void pickWatchFolder()} disabled={scanning}>
                📁 Scan another folder
              </button>
            </div>
          </section>
        </div>

        <div>
          <section className="panel">
            <h2 style={{ marginBottom: 8 }}>Behaviour</h2>

            <div className="setting">
              <div className="setting-label">
                <div className="setting-name">Back up overwritten files</div>
                <div className="setting-hint">
                  Keep a copy of anything a mod replaces, so uninstalling restores the original.
                </div>
              </div>
              <Toggle
                on={settings?.backupBeforeOverwrite ?? true}
                onChange={(next) => save({ backupBeforeOverwrite: next })}
              />
            </div>

            <div className="setting">
              <div className="setting-label">
                <div className="setting-name">Auto-resolve safe conflicts</div>
                <div className="setting-hint">
                  Skip the prompt when the only conflicts are informational.
                </div>
              </div>
              <Toggle
                on={settings?.autoResolveSafeConflicts ?? false}
                onChange={(next) => save({ autoResolveSafeConflicts: next })}
              />
            </div>
          </section>

          <section className="panel">
            <h2 style={{ marginBottom: 14 }}>Troubleshooting</h2>
            <div className="stack">
              <button
                className="btn"
                onClick={() => void window.palmod.game.open('root')}
                disabled={!install}
              >
                📂 Open Palworld folder
              </button>
              <button
                className="btn"
                onClick={() => {
                  void window.palmod.game.detect().then((i) => {
                    useStore.setState({ install: i })
                    toast(i ? 'Game folder re-detected' : 'Still could not find Palworld', i ? 'success' : 'error')
                  })
                }}
              >
                🔄 Re-detect game
              </button>
            </div>
          </section>
        </div>
      </div>
    </>
  )
}
