/* Unit tests for gallery extraction and header-based image measurement. */
import zlib from 'node:zlib'
import {
  imageSize,
  extractImageUrls,
  fullSizeCandidates,
  imageIdentity,
  largestInSrcset
} from '../src/main/services/images'

let failures = 0
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`  ok   ${name}`)
  else {
    failures++
    console.log(`  FAIL ${name}`, extra ?? '')
  }
}

/* ------------------------- real encoded headers ------------------------- */

function crcTable(): number[] {
  const t: number[] = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
}
const TABLE = crcTable()
function crc32(buf: Buffer): number {
  let crc = 0xffffffff
  for (const b of buf) crc = TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const c = Buffer.alloc(4)
  c.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, c])
}
function makePng(w: number, h: number): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.alloc(w * h * 3 + h))),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function makeGif(w: number, h: number): Buffer {
  const b = Buffer.alloc(32)
  b.write('GIF89a', 0, 'latin1')
  b.writeUInt16LE(w, 6)
  b.writeUInt16LE(h, 8)
  return b
}

function makeJpeg(w: number, h: number): Buffer {
  // SOI, a JFIF APP0 segment to skip over, then SOF0 carrying the size.
  const app0 = Buffer.alloc(18)
  app0.writeUInt16BE(0xffe0, 0)
  app0.writeUInt16BE(16, 2)
  app0.write('JFIF\0', 4, 'latin1')
  const sof = Buffer.alloc(11)
  sof.writeUInt16BE(0xffc0, 0)
  sof.writeUInt16BE(9, 2)
  sof.writeUInt8(8, 4)
  sof.writeUInt16BE(h, 5)
  sof.writeUInt16BE(w, 7)
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(20)])
}

function makeWebpVp8x(w: number, h: number): Buffer {
  const b = Buffer.alloc(40)
  b.write('RIFF', 0, 'latin1')
  b.write('WEBP', 8, 'latin1')
  b.write('VP8X', 12, 'latin1')
  const wm = w - 1
  const hm = h - 1
  b.writeUInt8(wm & 0xff, 24)
  b.writeUInt8((wm >> 8) & 0xff, 25)
  b.writeUInt8((wm >> 16) & 0xff, 26)
  b.writeUInt8(hm & 0xff, 27)
  b.writeUInt8((hm >> 8) & 0xff, 28)
  b.writeUInt8((hm >> 16) & 0xff, 29)
  return b
}

console.log('\nimage dimension reading:')
const png = imageSize(makePng(1920, 1080))
check('png dimensions', png?.width === 1920 && png?.height === 1080, png)
const gif = imageSize(makeGif(640, 480))
check('gif dimensions', gif?.width === 640 && gif?.height === 480, gif)
const jpg = imageSize(makeJpeg(1280, 720))
check('jpeg dimensions past the APP0 segment', jpg?.width === 1280 && jpg?.height === 720, jpg)
const webp = imageSize(makeWebpVp8x(2560, 1440))
check('webp VP8X dimensions', webp?.width === 2560 && webp?.height === 1440, webp)
check('garbage returns null, no throw', imageSize(Buffer.alloc(64, 9)) === null)
check('truncated buffer returns null', imageSize(Buffer.from([137, 80])) === null)
check('an avatar-sized png still reports its size', imageSize(makePng(64, 64))?.width === 64)

console.log('\nimage url extraction:')
const html = `
<html><head>
<meta property="og:image" content="https://cdn.example.com/mods/hero-cover.jpg">
</head><body>
<img src="/images/screenshot1.png" alt="shot">
<img data-src="https://cdn.example.com/images/screenshot2.jpg" src="/img/loading.gif">
<img srcset="/small.jpg 480w, https://cdn.example.com/large.jpg 1200w">
<picture><source srcset="/thumb.webp 200w, /images/screenshot3.webp 900w"></picture>
<a href="https://cdn.example.com/full/screenshot4.png"><img src="/t/screenshot4-thumb.png"></a>
<img src="/assets/avatar-user.png">
<img src="/assets/site-logo.svg">
<img src="/ads/banner-728.png">
</body></html>`

const urls = extractImageUrls(html, 'https://example.com/mods/123')
check('resolves relative urls', urls.includes('https://example.com/images/screenshot1.png'), urls)
check('prefers the lazy-load attribute over the placeholder', urls.includes('https://cdn.example.com/images/screenshot2.jpg'))
check('does not take the loading placeholder', !urls.some((u) => u.includes('loading.gif')), urls)
check('takes the largest srcset entry', urls.includes('https://cdn.example.com/large.jpg'), urls)
check('reads picture/source srcset', urls.includes('https://example.com/images/screenshot3.webp'), urls)
check('follows anchors to full-size images', urls.includes('https://cdn.example.com/full/screenshot4.png'))
check('includes the og:image', urls.includes('https://cdn.example.com/mods/hero-cover.jpg'))
check('drops avatars', !urls.some((u) => u.includes('avatar')), urls)
check('drops logos', !urls.some((u) => u.includes('logo')), urls)
check('drops ad banners', !urls.some((u) => u.includes('banner')), urls)
check('deduplicates', new Set(urls).size === urls.length)
check('empty html yields nothing, no throw', extractImageUrls('', 'https://example.com').length === 0)
check(
  'ignores data uris',
  extractImageUrls('<img src="data:image/png;base64,AAAA">', 'https://example.com').length === 0
)
check(
  'survives a malformed base url',
  extractImageUrls('<img src="/a.png">', 'not a url').length === 0
)

console.log('\nfull-size url upgrading:')
const nexusThumb =
  'https://staticdelivery.nexusmods.com/mods/6063/images/thumbnails/4549/4549-1706-shot.jpeg'
const nexusFull = fullSizeCandidates(nexusThumb)
check(
  'nexus thumbnails resolve to the full image first',
  nexusFull[0] === 'https://staticdelivery.nexusmods.com/mods/6063/images/4549/4549-1706-shot.jpeg',
  nexusFull[0]
)
check('the original stays as a fallback', nexusFull[nexusFull.length - 1] === nexusThumb)

check(
  'a /thumbs/ folder is stripped',
  fullSizeCandidates('https://x.com/img/thumbs/shot.png')[0] === 'https://x.com/img/shot.png',
  fullSizeCandidates('https://x.com/img/thumbs/shot.png')[0]
)
check(
  'a -thumb suffix is stripped',
  fullSizeCandidates('https://x.com/shot-thumb.jpg')[0] === 'https://x.com/shot.jpg',
  fullSizeCandidates('https://x.com/shot-thumb.jpg')[0]
)
check(
  'a -800x600 suffix is stripped',
  fullSizeCandidates('https://x.com/shot-800x600.jpg')[0] === 'https://x.com/shot.jpg',
  fullSizeCandidates('https://x.com/shot-800x600.jpg')[0]
)
check(
  'resizing query strings are dropped',
  fullSizeCandidates('https://x.com/shot.jpg?width=200&quality=60')[0] === 'https://x.com/shot.jpg',
  fullSizeCandidates('https://x.com/shot.jpg?width=200&quality=60')[0]
)
check(
  'a plain url yields only itself',
  fullSizeCandidates('https://x.com/shot.jpg').length === 1,
  fullSizeCandidates('https://x.com/shot.jpg')
)

console.log('\nthumbnail / full-size pairing:')
check(
  'a thumb and its full image share an identity',
  imageIdentity(nexusThumb) ===
    imageIdentity('https://staticdelivery.nexusmods.com/mods/6063/images/4549/4549-1706-shot.jpeg')
)
check(
  'different screenshots keep separate identities',
  imageIdentity('https://x.com/a.jpg') !== imageIdentity('https://x.com/b.jpg')
)
check(
  'query strings do not split an identity',
  imageIdentity('https://x.com/a.jpg?w=200') === imageIdentity('https://x.com/a.jpg')
)

console.log('\nsrcset selection:')
check(
  'picks the widest entry, not the last',
  largestInSrcset('/big.jpg 1600w, /small.jpg 400w') === '/big.jpg',
  largestInSrcset('/big.jpg 1600w, /small.jpg 400w')
)
check(
  'handles density descriptors',
  largestInSrcset('/a.jpg 1x, /b.jpg 3x') === '/b.jpg',
  largestInSrcset('/a.jpg 1x, /b.jpg 3x')
)
check(
  'widths beat densities',
  largestInSrcset('/a.jpg 2x, /b.jpg 1200w') === '/b.jpg',
  largestInSrcset('/a.jpg 2x, /b.jpg 1200w')
)
check('empty srcset is undefined, no throw', largestInSrcset('') === undefined)

console.log('\nmarkdown readme images:')
const md = `# Mod\n![screenshot](docs/shot1.png)\n![another](https://cdn.example.com/shot2.jpg)\n`
const mdUrls = extractImageUrls(md, 'https://raw.githubusercontent.com/o/r/main/')
check('resolves repo-relative markdown images', mdUrls.includes('https://raw.githubusercontent.com/o/r/main/docs/shot1.png'), mdUrls)
check('keeps absolute markdown images', mdUrls.includes('https://cdn.example.com/shot2.jpg'), mdUrls)

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
