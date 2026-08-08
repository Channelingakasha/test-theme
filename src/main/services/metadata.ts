import fs from 'node:fs/promises'
import path from 'node:path'
import type { HowToUse, ModMeta } from '@shared/types'
import { cacheImage, fetchText } from './download'
import { imageCacheDir } from './store'
import { ensureDir, sha1 } from './fsx'
import { parseDoc } from './howto'

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
}

/** Read a <meta> value by property or name, tolerating attribute order. */
function metaTag(html: string, key: string): string | undefined {
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${key}["']`, 'i')
  ]
  for (const re of patterns) {
    const m = html.match(re)
    if (m?.[1]) return decodeEntities(m[1]).trim()
  }
  return undefined
}

function titleTag(html: string): string | undefined {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : undefined
}

/** Strip tags to plain text for readme-style parsing. */
function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<\/(p|div|li|tr|h[1-6]|br)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<h([1-6])[^>]*>/gi, '\n### ')
      .replace(/<li[^>]*>/gi, '\n- ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function cleanTitle(raw: string, host: string): string {
  let t = raw
  if (host.includes('nexusmods')) t = t.replace(/\s*(at|-)\s*Palworld Nexus.*$/i, '')
  if (host.includes('github')) t = t.replace(/^GitHub\s*-\s*/i, '').replace(/:.*$/, '')
  return t.replace(/\s*[-|·]\s*(Nexus Mods|GitHub|Thunderstore).*$/i, '').trim()
}

export interface FetchedMeta {
  meta: ModMeta
  howTo: Omit<HowToUse, 'source'>
  /** A direct download URL when the page exposes one (e.g. a GitHub release asset). */
  downloadUrl?: string
}

/** GitHub repos expose everything we need through the public API. */
async function fromGitHub(url: string): Promise<FetchedMeta | null> {
  const m = url.match(/github\.com\/([^/]+)\/([^/?#]+)/i)
  if (!m) return null
  const owner = m[1]
  const repo = m[2].replace(/\.git$/, '')

  const repoJson = await fetchText(`https://api.github.com/repos/${owner}/${repo}`)
  if (!repoJson) return null

  let info: { description?: string; name?: string; owner?: { login?: string }; default_branch?: string }
  try {
    info = JSON.parse(repoJson)
  } catch {
    return null
  }

  // Latest release gives us a version and, usually, the actual mod archive.
  let version: string | undefined
  let downloadUrl: string | undefined
  const relJson = await fetchText(`https://api.github.com/repos/${owner}/${repo}/releases/latest`)
  if (relJson) {
    try {
      const rel = JSON.parse(relJson) as {
        tag_name?: string
        assets?: { browser_download_url?: string; name?: string }[]
      }
      version = rel.tag_name
      const asset = rel.assets?.find((a) => /\.(zip|7z|rar)$/i.test(a.name ?? ''))
      downloadUrl = asset?.browser_download_url
    } catch {
      /* no release — fine */
    }
  }

  const branch = info.default_branch ?? 'main'
  let readme = ''
  for (const name of ['README.md', 'readme.md', 'README.txt']) {
    const text = await fetchText(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${name}`)
    if (text) {
      readme = text
      break
    }
  }

  return {
    meta: {
      name: info.name ?? repo,
      author: info.owner?.login ?? owner,
      version,
      description: info.description,
      image: `https://opengraph.githubassets.com/1/${owner}/${repo}`,
      sourceUrl: url,
      tags: []
    },
    howTo: readme ? parseDoc(readme) : { directions: [], tips: [], requirements: [], hotkeys: [] },
    downloadUrl
  }
}

/** Generic Open Graph scrape — covers Nexus Mods, Thunderstore, ModDB, blogs. */
async function fromOpenGraph(url: string): Promise<FetchedMeta | null> {
  const html = await fetchText(url)
  if (!html) return null

  const host = new URL(url).hostname
  const title = metaTag(html, 'og:title') ?? titleTag(html) ?? ''
  const description = metaTag(html, 'og:description') ?? metaTag(html, 'description')
  const image = metaTag(html, 'og:image') ?? metaTag(html, 'twitter:image')
  const author = metaTag(html, 'author') ?? metaTag(html, 'article:author')

  const text = htmlToText(html)
  const howTo = parseDoc(text)

  return {
    meta: {
      name: cleanTitle(title, host) || host,
      author,
      description,
      image,
      sourceUrl: url,
      tags: []
    },
    howTo
  }
}

/** Look up everything we can about a mod from its page URL. */
export async function fetchMetadata(url: string): Promise<FetchedMeta | null> {
  try {
    const host = new URL(url).hostname.toLowerCase()
    if (host.includes('github.com')) {
      const gh = await fromGitHub(url)
      if (gh) return gh
    }
    return await fromOpenGraph(url)
  } catch {
    return null
  }
}

/**
 * Put the preview image in the local cache so cards render offline — and so it
 * survives the staging folder being cleaned up after install.
 */
export async function localizeImage(imageUrl: string | undefined, modId: string): Promise<string | undefined> {
  if (!imageUrl) return undefined

  if (/^https?:/i.test(imageUrl)) {
    const cached = await cacheImage(imageUrl, imageCacheDir(), `${modId}-${sha1(imageUrl).slice(0, 8)}`)
    return cached ?? undefined
  }

  // A bundled screenshot: copy it out of staging before that folder is deleted.
  try {
    const dest = path.join(imageCacheDir(), `${modId}-local${path.extname(imageUrl).toLowerCase()}`)
    await ensureDir(imageCacheDir())
    await fs.copyFile(imageUrl, dest)
    return dest
  } catch {
    return undefined
  }
}

/** Fall back to a readable name when there's no page to scrape. */
export function nameFromPath(p: string): string {
  const base = path.basename(p).replace(/\.(zip|7z|rar|pak|ucas|utoc|lua|dll)$/i, '')
  return base
    .replace(/[-_]+/g, ' ')
    .replace(/\b(v?\d+[\d.]*)\b/g, (v) => v) // keep version-ish tokens
    .replace(/\s+/g, ' ')
    .trim()
}
