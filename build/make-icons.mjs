/**
 * Renders build/icon.svg to the PNG and ICO files electron-builder needs.
 *
 * Rasterising is done with Electron's own browser, so there's no native image
 * dependency to install. Run with:  npm run icons
 *
 * To use different artwork, replace build/icon.svg (or drop in your own
 * build/icon.png at 512x512 and skip straight to the ICO step) and re-run.
 */
import { app, BrowserWindow } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const svgPath = path.join(here, 'icon.svg')
const pngPath = path.join(here, 'icon.png')
const icoPath = path.join(here, 'icon.ico')

/** ICO files may embed PNGs directly, so no BMP encoding is needed. */
function buildIco(pngs) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(pngs.length, 4)

  const entries = []
  const images = []
  let offset = 6 + pngs.length * 16

  for (const { size, data } of pngs) {
    const entry = Buffer.alloc(16)
    entry.writeUInt8(size >= 256 ? 0 : size, 0) // 0 means 256
    entry.writeUInt8(size >= 256 ? 0 : size, 1)
    entry.writeUInt8(0, 2) // palette
    entry.writeUInt8(0, 3) // reserved
    entry.writeUInt16LE(1, 4) // colour planes
    entry.writeUInt16LE(32, 6) // bits per pixel
    entry.writeUInt32LE(data.length, 8)
    entry.writeUInt32LE(offset, 12)
    entries.push(entry)
    images.push(data)
    offset += data.length
  }

  return Buffer.concat([header, ...entries, ...images])
}

/**
 * The mark gets its look from a chromatic split: a cyan copy, a magenta copy
 * offset from it, and a black copy halfway between. That offset is ~6 units in
 * a 948-unit viewBox — about a tenth of a pixel on a 16px icon — so at taskbar
 * sizes the colour vanishes and the icon renders as black-on-black.
 *
 * Below 256px the offset is scaled up to keep roughly a pixel of visible
 * fringe, which preserves what the design is *for* rather than its literal
 * coordinates. At 256 and above the artwork is rendered exactly as supplied.
 * Set BOOST_SMALL_SIZES to false for literal output at every size.
 */
const BOOST_SMALL_SIZES = true
const VIEWBOX_UNITS = 948
const OFFSET = { x: 5.114589, y: 3.581231 }
const OFFSET_LENGTH = Math.hypot(OFFSET.x, OFFSET.y)
const TARGET_FRINGE_PX = 1.1

function fringeScale(size) {
  if (!BOOST_SMALL_SIZES) return 1
  const needed = (TARGET_FRINGE_PX * VIEWBOX_UNITS) / (size * OFFSET_LENGTH)
  return Math.max(1, needed)
}

/**
 * Re-space the colour layers for a given scale. Magenta sits a full offset
 * from cyan and black sits at half of it, so both move proportionally and the
 * cyan base stays put.
 */
function applyFringeScale(svg, scale) {
  if (scale === 1) return svg
  let currentFill = ''

  return svg.replace(
    /fill="(#[0-9a-fA-F]{6})"|transform="translate\((-?[\d.]+),\s*(-?[\d.]+)\)"/g,
    (match, fill, tx, ty) => {
      if (fill) {
        currentFill = fill.toLowerCase()
        return match
      }
      const factor =
        currentFill === '#ff00ff' ? scale - 1 : currentFill === '#000000' ? (scale - 1) / 2 : 0
      if (factor === 0) return match
      const x = (Number(tx) + OFFSET.x * factor).toFixed(4)
      const y = (Number(ty) + OFFSET.y * factor).toFixed(4)
      return `transform="translate(${x}, ${y})"`
    }
  )
}

async function renderAt(size) {
  const win = new BrowserWindow({
    width: size,
    height: size,
    show: false,
    frame: false,
    backgroundColor: '#0b0c0f',
    webPreferences: { offscreen: true }
  })

  const svg = applyFringeScale(await fs.readFile(svgPath, 'utf8'), fringeScale(size))
  // Written to a file rather than a data: URL — the inlined SVG is well past
  // the length Chromium will load from one.
  const htmlPath = path.join(here, `.icon-render-${size}.html`)
  await fs.writeFile(
    htmlPath,
    `<!doctype html><meta charset="utf-8">
     <style>html,body{margin:0;padding:0;background:#0b0c0f;overflow:hidden}
     svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
    'utf8'
  )

  try {
    await win.loadFile(htmlPath)
    // Give the renderer a beat to lay out and paint before capturing.
    await new Promise((r) => setTimeout(r, 400))
    const image = await win.webContents.capturePage()
    return image.resize({ width: size, height: size }).toPNG()
  } finally {
    win.destroy()
    await fs.rm(htmlPath, { force: true })
  }
}

app.disableHardwareAcceleration()

// Each size is rendered in its own window; without this, destroying the first
// one triggers Electron's default quit-on-last-window-closed and the run ends
// silently after a single icon.
app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  try {
    const sizes = [16, 24, 32, 48, 64, 128, 256]
    const pngs = []
    for (const size of sizes) {
      pngs.push({ size, data: await renderAt(size) })
      const scale = fringeScale(size)
      process.stdout.write(
        `  rendered ${size}x${size}${scale > 1 ? `  (fringe x${scale.toFixed(1)})` : '  (as supplied)'}\n`
      )
    }

    await fs.writeFile(pngPath, await renderAt(512))
    await fs.writeFile(icoPath, buildIco(pngs))

    console.log(`\nwrote ${path.relative(process.cwd(), pngPath)} (512x512)`)
    console.log(`wrote ${path.relative(process.cwd(), icoPath)} (${sizes.join(', ')})`)
    console.log(`source: ${pathToFileURL(svgPath).href}`)
    app.exit(0)
  } catch (err) {
    console.error('icon generation failed:', err)
    app.exit(1)
  }
})
