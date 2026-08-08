import { useMemo } from 'react'
import { AddBar } from '../components/AddBar'
import { ModCard } from '../components/ModCard'
import { ProgressBar } from '../components/ProgressBar'
import { filterMods, useStore, type Filter } from '../state'

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'enabled', label: 'Active' },
  { id: 'disabled', label: 'Inactive' }
]

export function Library(): JSX.Element {
  const allMods = useStore((s) => s.mods)
  const filter = useStore((s) => s.filter)
  const setFilter = useStore((s) => s.setFilter)
  const query = useStore((s) => s.query)
  const setQuery = useStore((s) => s.setQuery)
  const mods = useMemo(() => filterMods(allMods, filter, query), [allMods, filter, query])
  const total = allMods.length
  const go = useStore((s) => s.go)
  const toggleMod = useStore((s) => s.toggleMod)
  const progress = useStore((s) => s.progress)
  const staged = useStore((s) => s.staged)
  const scanGame = useStore((s) => s.scanGame)
  const install = useStore((s) => s.install)

  const active = useStore((s) => s.mods.filter((m) => m.state === 'enabled').length)

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Your mods</h1>
          <div className="subtitle">
            {total === 0
              ? 'Nothing installed yet'
              : `${total} installed · ${active} active`}
          </div>
        </div>

        <div className="row wrap">
          <input
            className="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search mods…"
            aria-label="Search mods"
          />
          <div className="filter-tabs">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                className={`filter-tab ${filter === f.id ? 'active' : ''}`}
                onClick={() => setFilter(f.id)}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <AddBar />

      {progress && !staged && (
        <div className="panel" style={{ padding: 22 }}>
          <ProgressBar
            label={`${progress.label}${progress.detail ? ` — ${progress.detail}` : ''}`}
            value={progress.value}
          />
        </div>
      )}

      {mods.length === 0 ? (
        <div className="empty">
          <div className="icon" aria-hidden>
            🎒
          </div>
          <h2>{total === 0 ? 'No mods yet' : 'Nothing matches that'}</h2>
          <p style={{ marginBottom: 22 }}>
            {total === 0
              ? 'Paste a mod link above, drop a zip in this window, or import the mods you already have.'
              : 'Try a different search or filter.'}
          </p>
          {total === 0 && install && (
            <button className="btn" onClick={() => void scanGame()}>
              🔍 Find mods already installed
            </button>
          )}
        </div>
      ) : (
        <div className="grid">
          {mods.map((mod) => (
            <ModCard
              key={mod.id}
              mod={mod}
              onOpen={(id) => go('detail', id)}
              onToggle={toggleMod}
            />
          ))}
        </div>
      )}
    </>
  )
}
