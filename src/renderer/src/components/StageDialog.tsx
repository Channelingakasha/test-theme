import { useMemo, useState } from 'react'
import type { Conflict } from '@shared/types'
import { humanSize, kindLabel } from '../lib/format'
import { useStore } from '../state'
import { ProgressBar } from './ProgressBar'

function ConflictRow({ conflict }: { conflict: Conflict }): JSX.Element {
  const icon =
    conflict.severity === 'blocking' ? '⛔' : conflict.severity === 'warning' ? '⚠️' : 'ℹ️'
  return (
    <div className={`conflict ${conflict.severity}`}>
      <span className="conflict-icon" aria-hidden>
        {icon}
      </span>
      <div>
        <div className="conflict-msg">{conflict.message}</div>
        {conflict.details.length > 0 && (
          <div className="conflict-details">
            {conflict.details.slice(0, 6).map((d) => (
              <div key={d}>{d}</div>
            ))}
            {conflict.details.length > 6 && <div>+{conflict.details.length - 6} more</div>}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Shown after a source is staged: what we found, what it will overwrite, which
 * variant to install. Nothing has touched the game folder at this point.
 */
export function StageDialog(): JSX.Element | null {
  const staged = useStore((s) => s.staged)
  const mods = useStore((s) => s.mods)
  const progress = useStore((s) => s.progress)
  const setStagedOptions = useStore((s) => s.setStagedOptions)
  const confirmInstall = useStore((s) => s.confirmInstall)
  const cancelStage = useStore((s) => s.cancelStage)
  const [installing, setInstalling] = useState(false)

  const selected = staged?.suggestedOptionIds ?? []

  const grouped = useMemo(() => {
    const map = new Map<string, typeof staged extends null ? never : NonNullable<typeof staged>['options']>()
    for (const o of staged?.options ?? []) {
      const arr = map.get(o.group) ?? []
      arr.push(o)
      map.set(o.group, arr)
    }
    return [...map.entries()]
  }, [staged])

  if (!staged) return null

  const blocking = staged.conflicts.filter((c) => c.severity === 'blocking')
  const fileBlocking = blocking.filter((c) => c.type === 'file-collision')
  const dupe = staged.conflicts.find((c) => c.type === 'duplicate-mod')
  const replaceId = dupe?.withModIds[0]
  const replaceName = mods.find((m) => m.id === replaceId)?.meta.name

  const toggleOption = (id: string, group: string): void => {
    const exclusive = group === 'variant'
    let next: string[]
    if (exclusive) {
      next = [...selected.filter((s) => !(staged.options.find((o) => o.id === s)?.group === group)), id]
    } else if (selected.includes(id)) {
      next = selected.filter((s) => s !== id)
    } else {
      next = [...selected, id]
    }
    void setStagedOptions(next)
  }

  const install = async (overwrite: boolean, replace?: string): Promise<void> => {
    setInstalling(true)
    try {
      await confirmInstall(overwrite, replace)
    } finally {
      setInstalling(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={() => !installing && void cancelStage()}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{staged.meta.name}</h2>
          <div className="subtitle">
            {kindLabel(staged.kind)} · {staged.plan.length} file
            {staged.plan.length === 1 ? '' : 's'} · {humanSize(staged.sizeBytes)}
            {staged.meta.author ? ` · by ${staged.meta.author}` : ''}
          </div>
        </div>

        <div className="modal-body">
          {staged.meta.description && <p className="prose">{staged.meta.description}</p>}

          {staged.conflicts.length > 0 && (
            <section className="stack">
              <h3>Conflicts found</h3>
              {staged.conflicts.map((c, i) => (
                <ConflictRow key={`${c.type}-${i}`} conflict={c} />
              ))}
            </section>
          )}

          {grouped.map(([group, options]) => (
            <section key={group} className="stack">
              <h3>{group === 'variant' ? 'Choose a version' : 'Optional extras'}</h3>
              <div className="options">
                {options.map((o) => (
                  <button
                    key={o.id}
                    className={`option ${selected.includes(o.id) ? 'selected' : ''}`}
                    onClick={() => toggleOption(o.id, o.group)}
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
            </section>
          ))}

          <section className="stack">
            <h3>Where it will go</h3>
            <div className="stack">
              {[...new Set(staged.plan.map((p) => p.dest.replace(/[\\/][^\\/]+$/, '')))]
                .slice(0, 5)
                .map((dir) => (
                  <div key={dir} className="path-row">
                    {dir}
                  </div>
                ))}
            </div>
          </section>

          {staged.unhandled.length > 0 && (
            <section className="stack">
              <h3>Not installed</h3>
              <div className="small muted">
                {staged.unhandled.length} file
                {staged.unhandled.length === 1 ? '' : 's'} weren't recognised as mod content (readmes,
                screenshots, loose extras) and will be left out.
              </div>
            </section>
          )}

          {progress && installing && (
            <ProgressBar label={progress.detail ?? 'Installing…'} value={progress.value} />
          )}
        </div>

        <div className="modal-foot">
          <button className="btn ghost" onClick={() => void cancelStage()} disabled={installing}>
            Cancel
          </button>

          {replaceId && (
            <button className="btn" onClick={() => void install(true, replaceId)} disabled={installing}>
              Replace {replaceName ? `"${replaceName}"` : 'existing'}
            </button>
          )}

          {fileBlocking.length > 0 ? (
            <button className="btn danger" onClick={() => void install(true)} disabled={installing}>
              Overwrite and install
            </button>
          ) : (
            <button className="btn primary" onClick={() => void install(true)} disabled={installing}>
              {installing ? 'Installing…' : 'Install'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
