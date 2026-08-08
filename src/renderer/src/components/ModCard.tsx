import type { Mod } from '@shared/types'
import { humanSize, imageSrc, kindIcon, kindLabel } from '../lib/format'
import { Toggle } from './Toggle'

interface Props {
  mod: Mod
  onOpen: (id: string) => void
  onToggle: (id: string, enabled: boolean) => Promise<void>
}

/** Library tile: preview photo, name, and the activate switch. */
export function ModCard({ mod, onOpen, onToggle }: Props): JSX.Element {
  const src = imageSrc(mod.meta.image)
  const variants = mod.options.filter((o) => o.group === 'variant')

  return (
    <article
      className={`card ${mod.state === 'disabled' ? 'disabled' : ''}`}
      onClick={() => onOpen(mod.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen(mod.id)
        }
      }}
      tabIndex={0}
      role="button"
      aria-label={`Open ${mod.meta.name}`}
    >
      <div className="thumb">
        {src ? (
          <img
            src={src}
            alt=""
            onError={(e) => {
              // Fall back to the icon tile if the cached image went missing.
              e.currentTarget.style.display = 'none'
            }}
          />
        ) : (
          <div className="thumb-fallback">{kindIcon(mod.kind)}</div>
        )}

        <div className="thumb-badges">
          <span className="badge">{kindLabel(mod.kind)}</span>
          {mod.state === 'disabled' && <span className="badge warn">Off</span>}
          {variants.length > 0 && <span className="badge accent">{variants.length} options</span>}
        </div>
      </div>

      <div className="card-body">
        <div className="card-title">{mod.meta.name}</div>
        <div className="card-desc">
          {mod.meta.description?.trim() ||
            (mod.adopted ? 'Imported from your existing install.' : 'No description available.')}
        </div>

        <div className="card-foot">
          <span className="card-meta">
            {humanSize(mod.sizeBytes)}
            {mod.meta.version ? ` · ${mod.meta.version}` : ''}
          </span>
          <div onClick={(e) => e.stopPropagation()}>
            <Toggle
              on={mod.state === 'enabled'}
              onChange={(next) => onToggle(mod.id, next)}
              label={`${mod.state === 'enabled' ? 'Deactivate' : 'Activate'} ${mod.meta.name}`}
            />
          </div>
        </div>
      </div>
    </article>
  )
}
