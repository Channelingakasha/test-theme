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

async function renderAt(size) {
  const win = new BrowserWindow({
    width: size,
    height: size,
    show: false,
    frame: false,
    backgroundColor: '#0b0c0f',
    webPreferences: { offscreen: true }
  })

  const svg = await fs.readFile(svgPath, 'utf8')
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
      process.stdout.write(`  rendered ${size}x${size}\n`)
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
