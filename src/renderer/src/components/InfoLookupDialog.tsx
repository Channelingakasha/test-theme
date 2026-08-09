import { useState } from 'react'
import { imageSrc } from '../lib/format'
import { useStore } from '../state'

/**
 * Results of searching the web for an imported mod. The user confirms which
 * page is theirs — an automatic guess that's wrong would write bad details
 * into their library, so nothing is applied until they pick.
 */
export function InfoLookupDialog(): JSX.Element | null {
  const modId = useStore((s) => s.lookupModId)
  const results = useStore((s) => s.lookupResults)
  const busy = useStore((s) => s.lookingUp)
  const mod = useStore((s) => s.mods.find((m) => m.id === s.lookupModId))
  const applyLookup = useStore((s) => s.applyLookup)
  const close = useStore((s) => s.closeLookup)
  const [manual, setManual] = useState('')

  if (!modId) return null

  const confidenceLabel = (score: number): string =>
    score >= 0.7 ? 'Strong match' : score >= 0.45 ? 'Likely match' : 'Possible match'

  return (
    <div className="modal-backdrop" onClick={() => !busy && close()}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Find details for {mod?.meta.name ?? 'this mod'}</h2>
          <div className="subtitle">
            {busy && !results
              ? 'Searching the web…'
              : results && results.length > 0
                ? 'Pick the page that matches your mod and its details will be filled in.'
                : 'No matches found. Paste the mod page link below instead.'}
          </div>
        </div>

        <div className="modal-body">
          {busy && !results && (
            <div className="empty" style={{ padding: '40px 20px', border: 'none' }}>
              <div className="icon" aria-hidden>
                🔎
              </div>
              <div className="muted">Looking for “{mod?.meta.name}” on mod sites…</div>
            </div>
          )}

          {results && results.length > 0 && (
            <div className="stack" style={{ gap: 12 }}>
              {results.map((c) => {
                const src = imageSrc(c.image)
                return (
                  <button
                    key={c.url}
                    className="option"
                    style={{ alignItems: 'flex-start', width: '100%' }}
                    disabled={busy}
                    onClick={() => void applyLookup(modId, c.url)}
                  >
                    {src ? (
                      <img
                        src={src}
                        alt=""
                        style={{
                          width: 92,
                          height: 52,
                          objectFit: 'cover',
                          borderRadius: 8,
                          flex: 'none'
                        }}
                      />
                    ) : (
                      <span
                        style={{
                          width: 92,
                          height: 52,
                          display: 'grid',
                          placeItems: 'center',
                          background: 'var(--surface-2)',
                          borderRadius: 8,
                          flex: 'none',
                          fontSize: 20
                        }}
                        aria-hidden
                      >
                        🔗
                      </span>
                    )}

                    <span style={{ minWidth: 0, flex: 1 }}>
                      <div className="option-label">{c.title}</div>
                      <div className="option-sub">
                        {c.source} · {confidenceLabel(c.score)}
                      </div>
                      {c.description && (
                        <div
                          className="option-sub"
                          style={{
                            marginTop: 6,
                            display: '-webkit-box',
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: 'vertical',
                            overflow: 'hidden'
                          }}
                        >
                          {c.description}
                        </div>
                      )}
                    </span>
                  </button>
                )
              })}
            </div>
          )}

          {results && (
            <div className="stack" style={{ gap: 10 }}>
              <h3>{results.length > 0 ? 'None of these?' : 'Mod page link'}</h3>
              <div className="row">
                <input
                  className="input"
                  style={{ flex: 1 }}
                  value={manual}
                  onChange={(e) => setManual(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && manual.trim()) void applyLookup(modId, manual.trim())
                  }}
                  placeholder="Paste the mod's page link…"
                  spellCheck={false}
                />
                <button
                  className="btn"
                  disabled={busy || !manual.trim()}
                  onClick={() => void applyLookup(modId, manual.trim())}
                >
                  Use this
                </button>
              </div>
              <div className="small muted">
                Nexus Mods blocks automated search, so its pages rarely show up here — pasting the link
                works for any site.
              </div>
            </div>
          )}
        </div>

        <div className="modal-foot">
          <button className="btn ghost" onClick={close} disabled={busy && !results}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
