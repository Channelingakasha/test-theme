/**
 * Finds a mod's page on the web and fills in the details we couldn't get
 * locally — description, author, preview photo and how-to-use.
 *
 * Mods adopted from an existing install arrive with nothing but a filename, so
 * this turns that filename into search terms, ranks what comes back, and then
 * reuses the same page-extraction path used when a link is pasted by hand.
 */
import path from 'node:path'
import type { LookupCandidate, Mod } from '@shared/types'
import { cacheImage, fetchText } from './download'
import { sha1 } from './fsx'
import { mergeHowTo } from './howto'
import { collectGallery } from './images'
import { fetchMetadata, localizeImage } from './metadata'
import { imageCacheDir } from './store'

/** Hosts that actually publish Palworld mods, ranked by how likely they are. */
const KNOWN_HOSTS: Record<string, number> = {
  'nexusmods.com': 1,
  'github.com': 0.9,
  'thunderstore.io': 0.85,
  'moddb.com': 0.7,
  'gamebanana.com': 0.7,
  'curseforge.com': 0.6
}

/**
 * Packaging noise that appears in mod filenames but never in published names.
 * Deliberately conservative: over-stripping loses real words ("Pal" starts many
 * genuine mod names), and the query already has "Palworld mod" appended.
 */
const FILENAME_NOISE = /\b(pakchunk\d*|p|pak|ucas|utoc|sig|palworld|win64|x64|v?\d+[\d._]*)\b/gi

/**
 * Turn a mod's name and filenames into a human-readable search phrase.
 * "LunaOutfit_P.pak" -> "Luna Outfit"
 */
export function searchTermsFor(mod: Pick<Mod, 'meta' | 'files' | 'kind'>): string {
  const raw =
    mod.meta.name?.trim() ||
    path.basename(mod.files[0]?.rel ?? mod.files[0]?.dest ?? '').replace(/\.[a-z0-9]+$/i, '')

  const spaced = raw
    // Split CamelCase and snake/kebab into words. Only lowercase->uppercase
    // counts as a word break, so acronyms survive intact: "UE4SS" must not
    // become "UE4 SS", while "PalHUD" still becomes "Pal HUD".
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')

  const cleaned = spaced
    .replace(FILENAME_NOISE, ' ')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  // If stripping noise left nothing useful, fall back to the original words.
  return (cleaned.length >= 3 ? cleaned : spaced.replace(/\s+/g, ' ').trim()).slice(0, 80)
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2)
}

/** Token overlap between what we searched for and what came back. */
export function similarity(query: string, title: string): number {
  const a = tokens(query)
  const b = new Set(tokens(title))
  if (a.length === 0) return 0
  let hits = 0
  for (const t of a) if (b.has(t)) hits++
  return hits / a.length
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

function hostBoost(host: string): number {
  for (const [known, weight] of Object.entries(KNOWN_HOSTS)) {
    if (host === known || host.endsWith(`.${known}`)) return weight
  }
  return 0
}

/** Confidence that a search result is the mod we're looking for. */
export function scoreCandidate(query: string, title: string, url: string): number {
  const host = hostOf(url)
  const boost = hostBoost(host)
  if (boost === 0) return 0 // ignore forums, wikis, video pages

  const name = similarity(query, title)
  const mentionsGame = /palworld/i.test(title) || /palworld/i.test(url) ? 0.1 : 0
  return Math.min(1, name * 0.75 + boost * 0.2 + mentionsGame)
}

/**
 * Parse DuckDuckGo's HTML endpoint. Results are plain anchors, and the href is
 * usually a redirect wrapper with the real target in `uddg`.
 */
export function parseDuckDuckGo(html: string): { url: string; title: string }[] {
  const out: { url: string; title: string }[] = []
  const re = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi

  for (const m of html.matchAll(re)) {
    let url = m[1]
    if (url.startsWith('//')) url = `https:${url}`

    // Unwrap the DDG redirect.
    try {
      const parsed = new URL(url)
      const target = parsed.searchParams.get('uddg')
      if (target) url = decodeURIComponent(target)
    } catch {
      continue
    }

    const title = m[2]
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#x27;|&#0?39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim()

    if (title && /^https?:/i.test(url)) out.push({ url, title })
  }

  return out
}

async function searchDuckDuckGo(query: string): Promise<{ url: string; title: string }[]> {
  const html = await fetchText(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(`${query} Palworld mod`)}`
  )
  return html ? parseDuckDuckGo(html).slice(0, 20) : []
}

/** GitHub's search API needs no key and covers most UE4SS script mods. */
async function searchGitHub(query: string): Promise<{ url: string; title: string }[]> {
  const json = await fetchText(
    `https://api.github.com/search/repositories?q=${encodeURIComponent(
      `${query} palworld`
    )}&per_page=5`
  )
  if (!json) return []
  try {
    const data = JSON.parse(json) as {
      items?: { html_url?: string; full_name?: string; description?: string }[]
    }
    return (data.items ?? [])
      .filter((i) => i.html_url && i.full_name)
      .map((i) => ({ url: i.html_url as string, title: i.full_name as string }))
  } catch {
    return []
  }
}

/**
 * Search for a mod and return ranked candidates, with page details already
 * fetched for the most promising few so the user can see what they're picking.
 */
export async function lookupMod(mod: Mod, maxDetailed = 3): Promise<LookupCandidate[]> {
  const query = searchTermsFor(mod)
  if (!query) return []

  const [ddg, gh] = await Promise.all([searchDuckDuckGo(query), searchGitHub(query)])

  // De-duplicate by URL, keeping the best-scoring title for each.
  const byUrl = new Map<string, LookupCandidate>()
  for (const r of [...ddg, ...gh]) {
    const score = scoreCandidate(query, r.title, r.url)
    if (score <= 0.15) continue
    const key = r.url.split('#')[0]
    const existing = byUrl.get(key)
    if (!existing || score > existing.score) {
      byUrl.set(key, { url: key, title: r.title, source: hostOf(r.url), score })
    }
  }

  const ranked = [...byUrl.values()].sort((a, b) => b.score - a.score).slice(0, 8)

  // Enrich the top few by actually reading their pages.
  for (const c of ranked.slice(0, maxDetailed)) {
    const meta = await fetchMetadata(c.url)
    if (!meta) continue
    c.title = meta.meta.name || c.title
    c.description = meta.meta.description
    if (meta.meta.image) {
      // Cache remotely-hosted previews locally so the picker can show them
      // without loosening the renderer's image policy.
      const cached = await cacheImage(meta.meta.image, imageCacheDir(), `lookup-${sha1(c.url).slice(0, 10)}`)
      if (cached) c.image = cached
    }
    // Reading the page is itself evidence the result is real.
    c.score = Math.min(1, c.score + 0.05)
  }

  return ranked.sort((a, b) => b.score - a.score)
}

/**
 * Apply a chosen page to a mod, filling in only what's missing so anything the
 * user already has is never clobbered.
 */
export async function applyLookup(mod: Mod, url: string): Promise<Mod> {
  const found = await fetchMetadata(url)
  if (!found) throw new Error("Couldn't read that page — check the link and try again.")

  const meta = found.meta
  mod.meta = {
    ...mod.meta,
    name: mod.meta.name?.trim() && !mod.adopted ? mod.meta.name : meta.name || mod.meta.name,
    author: mod.meta.author ?? meta.author,
    version: mod.meta.version ?? meta.version,
    description: mod.meta.description?.trim() || meta.description,
    sourceUrl: url,
    tags: [...new Set([...mod.meta.tags.filter((t) => t !== 'adopted'), ...meta.tags])]
  }

  // Pull every screenshot off the page, keeping only images big enough to be
  // real (avatars, logos and banners are measured out).
  const gallery = await collectGallery(found.images, imageCacheDir(), mod.id)
  if (gallery.length > 0) mod.meta.gallery = gallery

  if (!mod.meta.image) {
    // Prefer the page's own preview; otherwise the largest screenshot found.
    mod.meta.image = meta.image ? await localizeImage(meta.image, mod.id) : gallery[0]?.path
  }

  // Keep anything we learned from the files on disk; add what the page says.
  mod.howTo = mergeHowTo([mod.howTo, found.howTo], mod.settings, url)
  mod.notes = undefined
  mod.updatedAt = Date.now()

  return mod
}
