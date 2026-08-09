import { useCallback, useEffect, useRef, useState } from 'react'
import type { GalleryImage } from '@shared/types'
import { imageSrc } from '../lib/format'

interface Props {
  /** Cached screenshots, largest first. */
  images: GalleryImage[]
}

const MAX_ZOOM = 8

/** Screenshots from the mod's page, with a zoomable full-size viewer. */
export function Gallery({ images }: Props): JSX.Element | null {
  const [open, setOpen] = useState<number | null>(null)
  const [broken, setBroken] = useState<Set<string>>(new Set())

  /** 1 = fit to window. Above that the image is panned with the pointer. */
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const dragging = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null)

  const usable = images.filter((i) => !broken.has(i.path))

  const reset = useCallback((): void => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }, [])

  const step = useCallback(
    (delta: number) => {
      setOpen((current) => (current === null ? current : (current + delta + usable.length) % usable.length))
      reset()
    },
    [usable.length, reset]
  )

  const zoomBy = useCallback((factor: number) => {
    setZoom((z) => {
      const next = Math.min(MAX_ZOOM, Math.max(1, z * factor))
      if (next === 1) setPan({ x: 0, y: 0 })
      return next
    })
  }, [])

  useEffect(() => {
    if (open === null) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(null)
      else if (e.key === 'ArrowRight') step(1)
      else if (e.key === 'ArrowLeft') step(-1)
      else if (e.key === '+' || e.key === '=') zoomBy(1.4)
      else if (e.key === '-') zoomBy(1 / 1.4)
      else if (e.key === '0') reset()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, step, zoomBy, reset])

  if (usable.length === 0) return null

  const active = open !== null ? usable[open] : null
  const activeSrc = active ? imageSrc(active.path) : null

  const onWheel = (e: React.WheelEvent): void => {
    e.preventDefault()
    zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15)
  }

  const onPointerDown = (e: React.PointerEvent): void => {
    if (zoom === 1) return
    dragging.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    const d = dragging.current
    if (!d) return
    setPan({ x: d.panX + (e.clientX - d.x), y: d.panY + (e.clientY - d.y) })
  }

  const onPointerUp = (): void => {
    dragging.current = null
  }

  return (
    <>
      <div className="gallery">
        {usable.map((img, i) => {
          const src = imageSrc(img.path)
          if (!src) return null
          return (
            <button
              key={img.path}
              className="gallery-item"
              onClick={() => {
                setOpen(i)
                reset()
              }}
              aria-label={`View screenshot ${i + 1} of ${usable.length}`}
            >
              <img
                src={src}
                alt=""
                loading="lazy"
                onError={() => setBroken((b) => new Set(b).add(img.path))}
              />
              <span className="gallery-dims">
                {img.width} × {img.height}
              </span>
            </button>
          )
        })}
      </div>

      {activeSrc && active && (
        <div className="lightbox" role="dialog" aria-modal="true" onWheel={onWheel}>
          {/* Clicking the backdrop closes; the image itself never does. */}
          <div className="lightbox-backdrop" onClick={() => setOpen(null)} />

          <button className="lightbox-close" onClick={() => setOpen(null)} aria-label="Close viewer">
            ✕
          </button>

          {usable.length > 1 && (
            <button className="lightbox-nav prev" onClick={() => step(-1)} aria-label="Previous screenshot">
              ‹
            </button>
          )}

          <img
            className={`lightbox-img ${zoom > 1 ? 'zoomed' : ''}`}
            src={activeSrc}
            alt=""
            draggable={false}
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              cursor: zoom > 1 ? (dragging.current ? 'grabbing' : 'grab') : 'zoom-in'
            }}
            onClick={() => (zoom === 1 ? zoomBy(2) : reset())}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />

          {usable.length > 1 && (
            <button className="lightbox-nav next" onClick={() => step(1)} aria-label="Next screenshot">
              ›
            </button>
          )}

          <div className="lightbox-bar">
            <span>
              {(open ?? 0) + 1} / {usable.length}
            </span>
            <span className="muted">
              {active.width} × {active.height}
            </span>

            <button className="zoom-btn" onClick={() => zoomBy(1 / 1.4)} aria-label="Zoom out">
              −
            </button>
            <button className="zoom-btn wide" onClick={reset}>
              {Math.round(zoom * 100)}%
            </button>
            <button className="zoom-btn" onClick={() => zoomBy(1.4)} aria-label="Zoom in">
              +
            </button>

            {active.sourceUrl && (
              <button
                className="zoom-btn wide"
                onClick={() => void window.palmod.mods.openUrl(active.sourceUrl as string)}
                title="Open the original image in your browser"
              >
                Original ↗
              </button>
            )}
          </div>
        </div>
      )}
    </>
  )
}
