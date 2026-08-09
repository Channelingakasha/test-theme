import { useCallback, useEffect, useState } from 'react'
import { imageSrc } from '../lib/format'

interface Props {
  /** Local image paths, largest first. */
  images: string[]
}

/** Screenshots from the mod's page, with a full-size viewer. */
export function Gallery({ images }: Props): JSX.Element | null {
  const [open, setOpen] = useState<number | null>(null)
  const [broken, setBroken] = useState<Set<string>>(new Set())

  const usable = images.filter((i) => !broken.has(i))

  const step = useCallback(
    (delta: number) => {
      setOpen((current) => {
        if (current === null) return current
        const next = (current + delta + usable.length) % usable.length
        return next
      })
    },
    [usable.length]
  )

  useEffect(() => {
    if (open === null) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(null)
      if (e.key === 'ArrowRight') step(1)
      if (e.key === 'ArrowLeft') step(-1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, step])

  if (usable.length === 0) return null

  const activeSrc = open !== null ? imageSrc(usable[open]) : null

  return (
    <>
      <div className="gallery">
        {usable.map((img, i) => {
          const src = imageSrc(img)
          if (!src) return null
          return (
            <button
              key={img}
              className="gallery-item"
              onClick={() => setOpen(i)}
              aria-label={`View screenshot ${i + 1} of ${usable.length}`}
            >
              <img
                src={src}
                alt=""
                loading="lazy"
                onError={() => setBroken((b) => new Set(b).add(img))}
              />
            </button>
          )
        })}
      </div>

      {activeSrc && (
        <div className="lightbox" onClick={() => setOpen(null)} role="dialog" aria-modal="true">
          <button
            className="lightbox-close"
            onClick={() => setOpen(null)}
            aria-label="Close viewer"
          >
            ✕
          </button>

          {usable.length > 1 && (
            <button
              className="lightbox-nav prev"
              onClick={(e) => {
                e.stopPropagation()
                step(-1)
              }}
              aria-label="Previous screenshot"
            >
              ‹
            </button>
          )}

          <img
            className="lightbox-img"
            src={activeSrc}
            alt=""
            onClick={(e) => e.stopPropagation()}
          />

          {usable.length > 1 && (
            <button
              className="lightbox-nav next"
              onClick={(e) => {
                e.stopPropagation()
                step(1)
              }}
              aria-label="Next screenshot"
            >
              ›
            </button>
          )}

          <div className="lightbox-count">
            {(open ?? 0) + 1} / {usable.length}
          </div>
        </div>
      )}
    </>
  )
}
