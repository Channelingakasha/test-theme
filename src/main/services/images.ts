/**
 * Gallery collection for mod pages.
 *
 * Mod pages are full of images that are not screenshots — avatars, site logos,
 * badges, tracking pixels, ad banners. Filtering by URL alone is unreliable, so
 * each candidate is downloaded and measured: real screenshots are large and
 * roughly landscape, decoration is small or extremely elongated.
 *
 * Dimensions are read straight from the file headers so this needs no image
 * library.
 */
import { net } from 'electron'
import type { GalleryImage } from '@shared/types'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { ensureDir } from './fsx'

export interface ImageSize {
  width: number
  height: number
}

/** Read pixel dimensions from PNG, GIF, JPEG or WebP headers. */
export function imageSize(buf: Buffer): ImageSize | null {
  if (buf.length < 16) return null

  // PNG: 8-byte signature, then IHDR with width/height as big-endian uint32.
  if (buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  }

  // GIF: "GIF8", then width/height as little-endian uint16.
  if (buf.toString('latin1', 0, 4) === 'GIF8') {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
  }

  // WebP: RIFF container; VP8X carries the canvas size, VP8 the frame size.
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = buf.toString('latin1', 12, 16)
    if (chunk === 'VP8X' && buf.length >= 30) {
      const width = 1 + (buf.readUInt8(24) | (buf.readUInt8(25) << 8) | (buf.readUInt8(26) << 16))
      const height = 1 + (buf.readUInt8(27) | (buf.readUInt8(28) << 8) | (buf.readUInt8(29) << 16))
      return { width, height }
    }
    if (chunk === 'VP8 ' && buf.length >= 30) {
      const start = buf.indexOf(Buffer.from([0x9d, 0x01, 0x2a]), 20)
      if (start > 0 && buf.length >= start + 7) {
        return {
          width: buf.readUInt16LE(start + 3) & 0x3fff,
          height: buf.readUInt16LE(start + 5) & 0x3fff
        }
      }
    }
    if (chunk === 'VP8L' && buf.length >= 25) {
      const bits = buf.readUInt32LE(21)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
    return null
  }

  // JPEG: walk the marker segments looking for a start-of-frame.
  if (buf.readUInt16BE(0) === 0xffd8) {
    let offset = 2
    while (offset + 9 < buf.length) {
      if (buf.readUInt8(offset) !== 0xff) {
        offset++
        continue
      }
      const marker = buf.readUInt8(offset + 1)
      // SOF0..SOF15, excluding the huffman/arithmetic/restart markers.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: buf.readUInt16BE(offset + 7), height: buf.readUInt16BE(offset + 5) }
      }
      const segmentLength = buf.readUInt16BE(offset + 2)
      if (segmentLength < 2) return null
      offset += 2 + segmentLength
    }
  }

  return null
}

/** URL patterns that are never a mod screenshot. */
const DECORATIVE =
  /(avatar|profile[_-]?pic|\bicon\b|favicon|logo|sprite|badge|emoji|spacer|pixel|banner|advert|\bads?\b|button|arrow|placeholder|loading|spinner|patreon|paypal|ko-?fi|discord|twitter|youtube-?logo)/i

const IMAGE_EXT = /\.(png|jpe?g|webp|gif)(\?|#|$)/i

/** Turn a possibly-relative image reference into an absolute URL. */
function absolutize(src: string, baseUrl: string): string | null {
  const trimmed = src.trim()
  if (!trimmed || trimmed.startsWith('data:')) return null
  try {
    return new URL(trimmed, baseUrl).toString()
  } catch {
    return null
  }
}

/**
 * Pick the highest-resolution entry from a srcset.
 * Entries are not required to be in ascending order, so the width (`800w`) or
 * density (`2x`) descriptor decides rather than the position in the list.
 */
export function largestInSrcset(srcset: string): string | undefined {
  let best: { url: string; weight: number } | null = null

  for (const part of srcset.split(',')) {
    const [url, descriptor] = part.trim().split(/\s+/)
    if (!url) continue
    const width = descriptor?.match(/^(\d+(?:\.\d+)?)w$/i)
    const density = descriptor?.match(/^(\d+(?:\.\d+)?)x$/i)
    // Densities are scaled so a 2x always loses to a real width descriptor.
    const weight = width ? Number(width[1]) : density ? Number(density[1]) : 1
    if (!best || weight > best.weight) best = { url, weight }
  }

  return best?.url
}

/**
 * Pull every plausible image reference out of a page.
 * Handles lazy-loading attributes and srcset, which most mod sites use, and
 * anchors that link to a full-size image from a thumbnail.
 */
export function extractImageUrls(html: string, baseUrl: string): string[] {
  const found: string[] = []

  const push = (raw: string | undefined): void => {
    if (!raw) return
    const url = absolutize(raw, baseUrl)
    if (url) found.push(url)
  }

  // <img src> plus the common lazy-loading attributes.
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0]
    const attrs = ['data-src', 'data-original', 'data-lazy-src', 'data-lazy', 'src']
    for (const attr of attrs) {
      const hit = tag.match(new RegExp(`${attr}\\s*=\\s*["']([^"']+)["']`, 'i'))
      if (hit) {
        push(hit[1])
        break
      }
    }
    const srcset = tag.match(/srcset\s*=\s*["']([^"']+)["']/i)
    if (srcset) push(largestInSrcset(srcset[1]))
  }

  // <source srcset> inside <picture>.
  for (const m of html.matchAll(/<source\b[^>]*srcset\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    push(largestInSrcset(m[1]))
  }

  // Anchors linking directly to an image — usually the full-size screenshot.
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    if (IMAGE_EXT.test(m[1])) push(m[1])
  }

  // Social preview tags, which are almost always the headline screenshot.
  for (const key of ['og:image', 'twitter:image']) {
    const m =
      html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']*)["']`, 'i')) ??
      html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${key}["']`, 'i'))
    if (m) push(m[1])
  }

  // Markdown image and link syntax, for READMEs fetched as raw text.
  for (const m of html.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)) push(m[1])

  const seen = new Set<string>()
  return found.filter((u) => {
    const key = u.split('#')[0]
    if (seen.has(key)) return false
    seen.add(key)
    return !DECORATIVE.test(key)
  })
}

/**
 * Mod pages almost always put a *thumbnail* in the HTML and keep the full-size
 * image at a sibling URL. Downloading what the page shows gets you a 200px
 * image that looks awful the moment it's opened, so each URL is turned into a
 * list of candidates — most-likely-full-size first — and the first one that
 * downloads and measures bigger wins.
 */
export function fullSizeCandidates(url: string): string[] {
  const out: string[] = []
  const add = (u: string): void => {
    if (u && u !== url && !out.includes(u)) out.push(u)
  }

  // Nexus keeps thumbnails under a parallel /thumbnails/ path.
  add(url.replace(/\/thumbnails\//i, '/'))

  // Generic size folders.
  add(url.replace(/\/(thumbs?|small|preview|previews|tn|resized)\//i, '/'))

  // Size suffixes before the extension: -thumb, _small, -150x150, @2x variants.
  add(url.replace(/([-_.])(thumb(nail)?|small|preview|tiny|mini)(\.[a-z0-9]+)(\?|$)/i, '$4$5'))
  add(url.replace(/-\d{2,4}x\d{2,4}(\.[a-z0-9]+)(\?|$)/i, '$1$2'))

  // Resizing query strings — drop them entirely to get the original.
  if (/[?&](w|h|width|height|size|resize|fit|quality|q)=/i.test(url)) {
    add(url.split('?')[0])
  }

  // The page's own URL is always the fallback.
  out.push(url)
  return out
}

/**
 * Key used to recognise the same screenshot arriving at several URLs (thumb
 * and full size), so only the largest copy is kept.
 */
export function imageIdentity(url: string): string {
  return url
    .split('?')[0]
    .toLowerCase()
    .replace(/\/thumbnails\//g, '/')
    .replace(/\/(thumbs?|small|preview|previews|tn|resized)\//g, '/')
    .replace(/([-_.])(thumb(nail)?|small|preview|tiny|mini)(\.[a-z0-9]+)$/, '$4')
    .replace(/-\d{2,4}x\d{2,4}(\.[a-z0-9]+)$/, '$1')
}

export interface GalleryOptions {
  /** Stop downloading after this many candidates. */
  maxFetch?: number
  /** Keep at most this many images. */
  maxKeep?: number
  minWidth?: number
  minHeight?: number
}

/**
 * Download candidate images, keep the ones that look like real screenshots,
 * and store them in the local cache.
 * Returns absolute paths of the saved files, largest first.
 */
/**
 * Bring a legacy gallery (bare file paths) up to the current shape by
 * measuring each cached file. Returns null when nothing needed changing.
 */
export async function migrateGalleryEntries(
  gallery: unknown
): Promise<GalleryImage[] | null> {
  if (!Array.isArray(gallery) || gallery.length === 0) return null
  if (typeof gallery[0] !== 'string') return null

  const migrated: GalleryImage[] = []
  for (const entry of gallery as string[]) {
    try {
      const size = imageSize(await fs.readFile(entry))
      if (size) migrated.push({ path: entry, width: size.width, height: size.height })
    } catch {
      /* cached file is gone — drop it from the gallery */
    }
  }

  return migrated.sort((a, b) => b.width * b.height - a.width * a.height)
}

interface Fetched {
  buf: Buffer
  contentType: string
}

async function loadImage(url: string): Promise<Fetched | null> {
  try {
    if (!/^https?:/i.test(url)) {
      // A screenshot shipped inside the mod archive.
      return {
        buf: await fs.readFile(url),
        contentType: `image/${path.extname(url).slice(1).toLowerCase() || 'jpeg'}`
      }
    }

    const res = await net.fetch(url, {
      redirect: 'follow',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
      }
    })
    if (!res.ok) return null
    const contentType = res.headers.get('content-type') ?? ''
    if (!contentType.startsWith('image/')) return null
    return { buf: Buffer.from(await res.arrayBuffer()), contentType }
  } catch {
    return null
  }
}

function extensionFor(contentType: string): string {
  if (contentType.includes('png')) return '.png'
  if (contentType.includes('webp')) return '.webp'
  if (contentType.includes('gif')) return '.gif'
  return '.jpg'
}

/**
 * Download candidate images, keep the ones that look like real screenshots at
 * a usable resolution, and store them in the local cache.
 * Returns the saved images with their measured dimensions, largest first.
 */
export async function collectGallery(
  urls: string[],
  destDir: string,
  keyPrefix: string,
  opts: GalleryOptions = {}
): Promise<GalleryImage[]> {
  // The floor is deliberately high: anything smaller is a thumbnail, and a
  // thumbnail in the gallery is worse than no image at all — it looks broken
  // the moment it's opened full-screen.
  const { maxFetch = 24, maxKeep = 12, minWidth = 480, minHeight = 270 } = opts
  await ensureDir(destDir)

  /** Best copy found so far for each distinct screenshot. */
  const best = new Map<string, { image: GalleryImage; hash: string }>()
  let fetched = 0

  for (const url of urls) {
    if (fetched >= maxFetch || best.size >= maxKeep) break

    const identity = imageIdentity(url)
    // Try the full-size variants before falling back to what the page showed.
    for (const candidate of fullSizeCandidates(url)) {
      if (fetched >= maxFetch) break
      fetched++

      const loaded = await loadImage(candidate)
      if (!loaded) continue
      if (loaded.buf.length < 2048) continue

      const size = imageSize(loaded.buf)
      if (!size) continue
      if (size.width < minWidth || size.height < minHeight) continue

      // Drop banners and rails: real screenshots are never this elongated.
      const ratio = size.width / size.height
      if (ratio > 5 || ratio < 0.2) continue

      const existing = best.get(identity)
      if (existing && existing.image.width * existing.image.height >= size.width * size.height) {
        break // already have this screenshot at equal or better resolution
      }

      const hash = createHash('sha1').update(loaded.buf).digest('hex')
      const file = path.join(
        destDir,
        `${keyPrefix}-gal-${hash.slice(0, 10)}${extensionFor(loaded.contentType)}`
      )
      try {
        await fs.writeFile(file, loaded.buf)
      } catch {
        continue // cache write failed — try the next candidate
      }

      if (existing) await fs.rm(existing.image.path, { force: true })
      best.set(identity, {
        hash,
        image: { path: file, width: size.width, height: size.height, sourceUrl: candidate }
      })
      break // got a good copy of this screenshot; move to the next URL
    }
  }

  // Identical bytes reached through unrelated URLs still collapse to one.
  const byHash = new Map<string, GalleryImage>()
  for (const { hash, image } of best.values()) {
    const seen = byHash.get(hash)
    if (seen) {
      await fs.rm(image.path, { force: true }).catch(() => undefined)
      continue
    }
    byHash.set(hash, image)
  }

  // Biggest first: the most detailed shot makes the best cover image.
  return [...byHash.values()].sort((a, b) => b.width * b.height - a.width * a.height)
}
