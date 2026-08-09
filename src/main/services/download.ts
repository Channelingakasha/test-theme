import { net } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { ensureDir } from './fsx'

export interface Downloaded {
  file: string
  contentType?: string
  finalUrl: string
}

function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null
  const star = header.match(/filename\*=(?:UTF-8'')?"?([^";]+)"?/i)
  if (star) {
    try {
      return decodeURIComponent(star[1])
    } catch {
      return star[1]
    }
  }
  const plain = header.match(/filename="?([^";]+)"?/i)
  return plain ? plain[1] : null
}

function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 180) || 'download'
}

/** Fetch a URL to a temp file, reporting progress when the server sends a length. */
export async function downloadTo(
  url: string,
  destDir: string,
  onProgress?: (pct: number, detail?: string) => void
): Promise<Downloaded> {
  await ensureDir(destDir)

  const res = await net.fetch(url, {
    redirect: 'follow',
    headers: {
      // Some mod hosts refuse requests without a browser-shaped UA.
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
      Accept: '*/*'
    }
  })

  if (!res.ok) throw new Error(`Download failed (${res.status} ${res.statusText})`)

  const finalUrl = res.url || url
  const contentType = res.headers.get('content-type') ?? undefined

  let name = filenameFromDisposition(res.headers.get('content-disposition'))
  if (!name) {
    const fromUrl = decodeURIComponent(new URL(finalUrl).pathname.split('/').pop() ?? '')
    name = fromUrl || 'download'
  }
  if (!path.extname(name)) {
    if (contentType?.includes('zip')) name += '.zip'
    else if (contentType?.includes('7z')) name += '.7z'
    else if (contentType?.includes('rar')) name += '.rar'
  }

  const file = path.join(destDir, safeName(name))
  const total = Number(res.headers.get('content-length') ?? 0)

  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer())
    await fs.writeFile(file, buf)
    onProgress?.(1)
    return { file, contentType, finalUrl }
  }

  const handle = await fs.open(file, 'w')
  try {
    let received = 0
    // Electron's fetch body is an async-iterable web stream.
    const stream = res.body as unknown as AsyncIterable<Uint8Array>
    for await (const chunk of stream) {
      const buf = Buffer.from(chunk)
      await handle.write(buf)
      received += buf.length
      onProgress?.(total ? received / total : -1, `${(received / 1048576).toFixed(1)} MB`)
    }
  } finally {
    await handle.close()
  }

  return { file, contentType, finalUrl }
}

/** Fetch a page/asset as text (used for metadata scraping). */
export async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await net.fetch(url, {
      redirect: 'follow',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
        Accept: 'text/html,application/json;q=0.9,*/*;q=0.8'
      }
    })
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  }
}

/** Download an image into the local cache and return its absolute path. */
export async function cacheImage(url: string, destDir: string, key: string): Promise<string | null> {
  try {
    await ensureDir(destDir)
    const res = await net.fetch(url, { redirect: 'follow' })
    if (!res.ok) return null
    const type = res.headers.get('content-type') ?? ''
    if (!type.startsWith('image/')) return null
    const ext = type.includes('png')
      ? '.png'
      : type.includes('webp')
        ? '.webp'
        : type.includes('gif')
          ? '.gif'
          : '.jpg'
    const file = path.join(destDir, key + ext)
    await fs.writeFile(file, Buffer.from(await res.arrayBuffer()))
    return file
  } catch {
    return null
  }
}
