import { useState } from 'react'
import type { Mod, ModSetting } from '@shared/types'
import { Toggle } from '../components/Toggle'
import { humanSize, imageSrc, kindIcon, kindLabel, needsInfo, relativeDate } from '../lib/format'
import { useStore } from '../state'

function SettingRow({
  setting,
  onChange
}: {
  setting: ModSetting
  onChange: (value: string | number | boolean) => void
}): JSX.Element {
  const [local, setLocal] = useState(setting.value)

  const commit = (v: string | number | boolean): void => {
    setLocal(v)
    onChange(v)
  }

  return (
    <div className="setting">
      <div className="setting-label">
        <div className="setting-name">{setting.label}</div>
        {setting.comment && <div className="setting-hint">{setting.comment}</div>}
      </div>

      {setting.control === 'toggle' && (
        <Toggle on={Boolean(local)} onChange={(next) => commit(next)} label={setting.label} />
      )}

      {setting.control === 'number' && (
        <input
          className="input num"
          type="number"
          value={String(local)}
          min={setting.min}
          max={setting.max}
          onChange={(e) => setLocal(e.target.value === '' ? '' : Number(e.target.value))}
          onBlur={(e) => commit(Number(e.target.value))}
        />
      )}

      {setting.control === 'select' && (
        <select className="select" value={String(local)} onChange={(e) => commit(e.target.value)}>
          {(setting.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      )}

      {(setting.control === 'text' || setting.control === 'key') && (
        <input
          className="input"
          value={String(local)}
          onChange={(e) => setLocal(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          spellCheck={false}
          style={setting.control === 'key' ? { textAlign: 'center', maxWidth: 130 } : undefined}
        />
      )}
    </div>
  )
}

export function ModDetail({ mod }: { mod: Mod }): JSX.Element {
  const go = useStore((s) => s.go)
  const toggleMod = useStore((s) => s.toggleMod)
  const uninstall = useStore((s) => s.uninstall)
  const setModOptions = useStore((s) => s.setModOptions)
  const changeSetting = useStore((s) => s.changeSetting)
  const startLookup = useStore((s) => s.startLookup)
  const [confirming, setConfirming] = useState(false)

  const src = imageSrc(mod.meta.image)
  const { howTo } = mod
  const hasHowTo =
    howTo.directions.length > 0 ||
    howTo.hotkeys.length > 0 ||
    howTo.tips.length > 0 ||
    howTo.requirements.length > 0

  const variantGroups = [...new Set(mod.options.map((o) => o.group))]

  const chooseOption = (id: string, group: string): void => {
    const inGroup = mod.options.filter((o) => o.group === group).map((o) => o.id)
    let next: string[]
    if (group === 'variant') {
      next = [...mod.selectedOptionIds.filter((s) => !inGroup.includes(s)), id]
    } else if (mod.selectedOptionIds.includes(id)) {
      next = mod.selectedOptionIds.filter((s) => s !== id)
    } else {
      next = [...mod.selectedOptionIds, id]
    }
    void setModOptions(mod.id, next)
  }

  return (
    <>
      <button className="btn ghost sm" onClick={() => go('library')} style={{ marginBottom: 20 }}>
        ← Back to library
      </button>

      <div className="detail-hero">
        <div className="detail-cover">
          {src ? (
            <img src={src} alt="" />
          ) : (
            <div className="thumb-fallback" style={{ fontSize: 54 }}>
              {kindIcon(mod.kind)}
            </div>
          )}
        </div>

        <div className="detail-headline">
          <div className="grow">
            <div className="detail-title">{mod.meta.name}</div>
            <div className="detail-sub">
              {kindLabel(mod.kind)}
              {mod.meta.author ? ` · by ${mod.meta.author}` : ''}
              {mod.meta.version ? ` · ${mod.meta.version}` : ''} · {humanSize(mod.sizeBytes)} · added{' '}
              {relativeDate(mod.installedAt)}
            </div>
          </div>

          <div className="row">
            <span className="small muted">{mod.state === 'enabled' ? 'Active' : 'Inactive'}</span>
            <Toggle on={mod.state === 'enabled'} onChange={(next) => toggleMod(mod.id, next)} />
          </div>
        </div>
      </div>

      <div className="panels">
        <div>
          <section className="panel">
            <div className="panel-head">
              <h2>About this mod</h2>
              <div className="row">
                {needsInfo(mod) && (
                  <button className="btn sm" onClick={() => void startLookup(mod.id)}>
                    🔎 Get info
                  </button>
                )}
                {mod.meta.sourceUrl && (
                  <button
                    className="btn ghost sm"
                    onClick={() => void window.palmod.mods.openUrl(mod.meta.sourceUrl as string)}
                  >
                    Open mod page ↗
                  </button>
                )}
              </div>
            </div>
            <p className="prose">
              {mod.meta.description?.trim() ||
                (mod.adopted
                  ? 'This mod was imported from your existing install, so all PalMod knows about it is its filename. Use Get info to search the web and fill in the rest.'
                  : 'No description was found for this mod. If you added it from a link, the page may not publish one.')}
            </p>
            {mod.notes && (
              <p className="prose small muted" style={{ marginTop: 14 }}>
                {mod.notes}
              </p>
            )}
            {mod.meta.tags.length > 0 && (
              <div className="chips" style={{ marginTop: 16 }}>
                {mod.meta.tags.map((t) => (
                  <span key={t} className="chip">
                    {t}
                  </span>
                ))}
              </div>
            )}
          </section>

          {hasHowTo && (
            <section className="panel">
              <div className="panel-head">
                <h2>How to use</h2>
                {howTo.source && <span className="small muted">from the mod page</span>}
              </div>

              <div className="stack" style={{ gap: 24 }}>
                {howTo.requirements.length > 0 && (
                  <div className="stack" style={{ gap: 12 }}>
                    <h3>Requirements</h3>
                    <div className="list">
                      {howTo.requirements.map((r) => (
                        <div key={r} className="list-row">
                          <span className="bullet" aria-hidden>
                            ▸
                          </span>
                          <span>{r}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {howTo.directions.length > 0 && (
                  <div className="stack" style={{ gap: 12 }}>
                    <h3>Directions</h3>
                    <div className="list">
                      {howTo.directions.map((d) => (
                        <div key={d} className="list-row">
                          <span className="bullet" aria-hidden>
                            ▸
                          </span>
                          <span>{d}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {howTo.hotkeys.length > 0 && (
                  <div className="stack" style={{ gap: 12 }}>
                    <h3>Hotkeys</h3>
                    <div className="list">
                      {howTo.hotkeys.map((h) => (
                        <div key={h.key} className="list-row">
                          <span className="kbd">{h.key}</span>
                          <span>{h.action}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {howTo.tips.length > 0 && (
                  <div className="stack" style={{ gap: 12 }}>
                    <h3>Tips &amp; tricks</h3>
                    <div className="list">
                      {howTo.tips.map((t) => (
                        <div key={t} className="list-row">
                          <span className="bullet" aria-hidden>
                            ★
                          </span>
                          <span>{t}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </section>
          )}

          {mod.options.length > 0 && (
            <section className="panel">
              <div className="panel-head">
                <h2>Included options</h2>
                <span className="small muted">
                  {mod.selectedOptionIds.length} of {mod.options.length} active
                </span>
              </div>

              <div className="stack" style={{ gap: 20 }}>
                {variantGroups.map((group) => (
                  <div key={group} className="stack" style={{ gap: 12 }}>
                    <h3>{group === 'variant' ? 'Pick one' : 'Extras'}</h3>
                    <div className="options">
                      {mod.options
                        .filter((o) => o.group === group)
                        .map((o) => (
                          <button
                            key={o.id}
                            className={`option ${mod.selectedOptionIds.includes(o.id) ? 'selected' : ''}`}
                            onClick={() => chooseOption(o.id, group)}
                          >
                            <span className={`radio ${group === 'variant' ? '' : 'square'}`} />
                            <span style={{ minWidth: 0 }}>
                              <div className="option-label">{o.label}</div>
                              <div className="option-sub">
                                {o.files.length} file{o.files.length === 1 ? '' : 's'}
                              </div>
                            </span>
                          </button>
                        ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {mod.settings.length > 0 && (
            <section className="panel">
              <div className="panel-head">
                <h2>Mod settings</h2>
                <button
                  className="btn ghost sm"
                  onClick={() => void window.palmod.mods.refreshSettings(mod.id)}
                >
                  Reload from disk
                </button>
              </div>
              <div>
                {mod.settings.map((s) => (
                  <SettingRow
                    key={`${s.file}-${s.key}`}
                    setting={s}
                    onChange={(v) => void changeSetting(mod.id, s.key, v)}
                  />
                ))}
              </div>
            </section>
          )}
        </div>

        <div>
          <section className="panel">
            <div className="panel-head">
              <h2>File location</h2>
            </div>
            <div className="stack" style={{ gap: 10 }}>
              {mod.installRoots.map((root) => (
                <div key={root} className="path-row">
                  <span>{root}</span>
                  <button
                    className="icon-btn"
                    title="Show in File Explorer"
                    onClick={() => void window.palmod.mods.reveal(root)}
                  >
                    ↗
                  </button>
                </div>
              ))}
            </div>

            <div className="divider" style={{ margin: '18px 0' }} />

            <h3 style={{ marginBottom: 12 }}>
              Files ({mod.files.length})
            </h3>
            <div className="stack" style={{ gap: 8, maxHeight: 260, overflowY: 'auto' }}>
              {mod.files.map((f) => (
                <div key={f.dest} className="path-row" style={{ padding: '9px 12px' }}>
                  <span>{f.rel || f.dest}</span>
                  <span className="muted" style={{ marginLeft: 'auto', flex: 'none' }}>
                    {humanSize(f.size)}
                  </span>
                </div>
              ))}
            </div>
          </section>

          <section className="panel">
            <h2 style={{ marginBottom: 14 }}>Manage</h2>
            <div className="stack">
              <button
                className="btn"
                onClick={() => void window.palmod.mods.reveal(mod.files[0]?.dest ?? mod.installRoots[0])}
              >
                📂 Open in File Explorer
              </button>

              {confirming ? (
                <div className="stack" style={{ gap: 10 }}>
                  <div className="small muted">
                    Remove {mod.meta.name} and delete its files from the game folder?
                  </div>
                  <div className="row">
                    <button className="btn danger" onClick={() => void uninstall(mod.id)}>
                      Yes, remove it
                    </button>
                    <button className="btn ghost" onClick={() => setConfirming(false)}>
                      Keep
                    </button>
                  </div>
                </div>
              ) : (
                <button className="btn danger" onClick={() => setConfirming(true)}>
                  🗑 Uninstall mod
                </button>
              )}
            </div>
          </section>
        </div>
      </div>
    </>
  )
}
