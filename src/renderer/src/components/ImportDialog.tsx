import { useEffect, useState } from 'react'
import { humanSize, kindIcon, kindLabel } from '../lib/format'
import { useStore } from '../state'

/**
 * Results of scanning a folder — e.g. the folder of mods already sitting on the
 * user's desktop, or the game's own mod folders after manual installs.
 */
export function ImportDialog(): JSX.Element | null {
  const candidates = useStore((s) => s.candidates)
  const scanning = useStore((s) => s.scanning)
  const importCandidates = useStore((s) => s.importCandidates)
  const clearCandidates = useStore((s) => s.clearCandidates)
  const [picked, setPicked] = useState<Set<string>>(new Set())

  useEffect(() => {
    // Default to everything not already tracked.
    setPicked(new Set((candidates ?? []).filter((c) => !c.alreadyTracked).map((c) => c.path)))
  }, [candidates])

  if (!candidates) return null

  const toggle = (p: string): void => {
    const next = new Set(picked)
    if (next.has(p)) next.delete(p)
    else next.add(p)
    setPicked(next)
  }

  const chosen = candidates.filter((c) => picked.has(c.path))

  return (
    <div className="modal-backdrop" onClick={() => !scanning && clearCandidates()}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Import mods</h2>
          <div className="subtitle">
            Found {candidates.length} mod{candidates.length === 1 ? '' : 's'}. Ones already in your game
            folder are taken over in place; anything else gets installed.
          </div>
        </div>

        <div className="modal-body">
          <div className="stack" style={{ gap: 10 }}>
            {candidates.map((c) => (
              <button
                key={c.path}
                className={`option ${picked.has(c.path) ? 'selected' : ''}`}
                onClick={() => toggle(c.path)}
                style={{ width: '100%' }}
              >
                <span className="radio square" />
                <span aria-hidden style={{ fontSize: 18 }}>
                  {kindIcon(c.kind)}
                </span>
                <span style={{ minWidth: 0, flex: 1 }}>
                  <div className="option-label">{c.suggestedName}</div>
                  <div className="option-sub">
                    {kindLabel(c.kind)} · {c.fileCount} file{c.fileCount === 1 ? '' : 's'} ·{' '}
                    {humanSize(c.sizeBytes)}
                    {c.alreadyTracked ? ' · already in your library' : ''}
                  </div>
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="modal-foot">
          <button className="btn ghost" onClick={clearCandidates} disabled={scanning}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={() => void importCandidates(chosen)}
            disabled={scanning || chosen.length === 0}
          >
            {scanning ? 'Importing…' : `Import ${chosen.length} mod${chosen.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  )
}
