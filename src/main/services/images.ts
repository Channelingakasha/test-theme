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
    // srcset: take the last (largest) entry.
    const srcset = tag.match(/srcset\s*=\s*["']([^"']+)["']/i)
    if (srcset) {
      const last = srcset[1].split(',').pop()?.trim().split(/\s+/)[0]
      push(last)
    }
  }

  // <source srcset> inside <picture>.
  for (const m of html.matchAll(/<source\b[^>]*srcset\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    push(m[1].split(',').pop()?.trim().split(/\s+/)[0])
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
export async function collectGallery(
  urls: string[],
  destDir: string,
  keyPrefix: string,
  opts: GalleryOptions = {}
): Promise<string[]> {
  const { maxFetch = 18, maxKeep = 12, minWidth = 200, minHeight = 150 } = opts
  await ensureDir(destDir)

  const kept: { file: string; area: number }[] = []
  const seenHashes = new Set<string>()
  let fetched = 0

  for (const url of urls) {
    if (fetched >= maxFetch || kept.length >= maxKeep) break
    fetched++

    let buf: Buffer
    let contentType: string
    try {
      if (/^https?:/i.test(url)) {
        const res = await net.fetch(url, {
          redirect: 'follow',
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
          }
        })
        if (!res.ok) continue
        contentType = res.headers.get('content-type') ?? ''
        if (!contentType.startsWith('image/')) continue
        buf = Buffer.from(await res.arrayBuffer())
      } else {
        // A screenshot shipped inside the mod archive.
        buf = await fs.readFile(url)
        contentType = `image/${path.extname(url).slice(1).toLowerCase() || 'jpeg'}`
      }
    } catch {
      continue
    }

    if (buf.length < 2048) continue // too small to be a screenshot

    const size = imageSize(buf)
    if (!size) continue
    if (size.width < minWidth || size.height < minHeight) continue

    // Drop banners and rails: real screenshots are never this elongated.
    const ratio = size.width / size.height
    if (ratio > 5 || ratio < 0.2) continue

    // The same screenshot often appears at several URLs (thumb and full size).
    const hash = createHash('sha1').update(buf).digest('hex')
    if (seenHashes.has(hash)) continue
    seenHashes.add(hash)

    const ext = contentType.includes('png')
      ? '.png'
      : contentType.includes('webp')
        ? '.webp'
        : contentType.includes('gif')
          ? '.gif'
          : '.jpg'
    const file = path.join(destDir, `${keyPrefix}-gal-${hash.slice(0, 10)}${ext}`)
    try {
      await fs.writeFile(file, buf)
      kept.push({ file, area: size.width * size.height })
    } catch {
      /* cache write failed — skip this one */
    }
  }

  // Biggest first: the most detailed shot makes the best cover image.
  return kept.sort((a, b) => b.area - a.area).map((k) => k.file)
}
