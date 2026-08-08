import fs from 'node:fs/promises'
import path from 'node:path'
import type { HowToUse, ModSetting } from '@shared/types'
import { walk } from './fsx'

const USAGE_HEADINGS = /^(how to use|usage|how it works|instructions|controls|hotkeys|keybinds?|getting started|features)\b/i
const TIP_HEADINGS = /^(tips?|notes?|troubleshooting|faq|known issues|warning)\b/i
const REQ_HEADINGS = /^(requirements?|dependencies|prerequisites|requires)\b/i

const KEY_TOKEN =
  /\b((?:ctrl|alt|shift)\s*\+\s*)?(f\d{1,2}|insert|delete|home|end|page ?up|page ?down|numpad ?\d|num ?lock|backspace|escape|esc|tab|space(?:bar)?|enter|tilde|`|~)\b/gi

function cleanLine(line: string): string {
  return line
    .replace(/^[\s>*\-+•\d.)]+/, '')
    .replace(/[*_`#]/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // markdown links -> text
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

function headingText(line: string): string {
  return line
    .replace(/^\s*#{1,6}\s+/, '')
    .replace(/^\s*[[*_-]+/, '')
    .replace(/[\]:*_]+\s*$/, '')
    .trim()
}

/**
 * Headings in mod readmes are wildly inconsistent: markdown hashes, a bare
 * "How to use" on its own line, "CONTROLS:", or "== Usage ==". Accept a short
 * line as a heading when it names a section we care about.
 */
function isHeading(line: string): boolean {
  if (/^\s*#{1,6}\s+/.test(line)) return true
  if (/^\s*=+\s*$/.test(line)) return true
  if (/^\s*[A-Z][A-Za-z /&-]{2,40}:\s*$/.test(line)) return true

  const bare = headingText(line)
  if (bare.length === 0 || bare.length > 44) return false
  if (/[.!?]$/.test(bare)) return false
  return USAGE_HEADINGS.test(bare) || TIP_HEADINGS.test(bare) || REQ_HEADINGS.test(bare)
}

/**
 * Read a readme-style document and sort its content into the buckets the
 * "How to use" panel shows.
 */
export function parseDoc(text: string): Omit<HowToUse, 'source'> {
  const directions: string[] = []
  const tips: string[] = []
  const requirements: string[] = []
  const hotkeys: { key: string; action: string }[] = []

  const lines = text.split(/\r?\n/)
  let bucket: 'none' | 'usage' | 'tips' | 'req' = 'none'

  for (const raw of lines) {
    if (isHeading(raw)) {
      const h = headingText(raw)
      if (USAGE_HEADINGS.test(h)) bucket = 'usage'
      else if (TIP_HEADINGS.test(h)) bucket = 'tips'
      else if (REQ_HEADINGS.test(h)) bucket = 'req'
      else bucket = 'none'
      continue
    }

    const line = cleanLine(raw)
    if (!line || line.length < 3) continue

    // A line that names a key and describes an action is a hotkey wherever it appears.
    const keyMatches = [...line.matchAll(KEY_TOKEN)]
    if (keyMatches.length === 1 && line.length < 160) {
      const key = keyMatches[0][0].replace(/\s*\+\s*/g, '+').toUpperCase()
      const action = line
        .replace(keyMatches[0][0], '')
        .replace(/^[\s:—–\-=>|]+/, '')
        .replace(/^(key|button|press|hit|to)\b\s*/i, '')
        .trim()
      if (action.length > 2 && action.length < 140) {
        hotkeys.push({ key, action: action.replace(/^\w/, (c) => c.toUpperCase()) })
        continue
      }
    }

    if (line.length > 300) continue
    if (bucket === 'usage' && directions.length < 12) directions.push(line)
    else if (bucket === 'tips' && tips.length < 10) tips.push(line)
    else if (bucket === 'req' && requirements.length < 8) requirements.push(line)
    else if (bucket === 'none' && /\b(requires?|requirement|depends on)\b/i.test(line) && requirements.length < 8) {
      requirements.push(line)
    }
  }

  return { directions, tips, requirements, hotkeys }
}

/**
 * Hotkeys registered in UE4SS Lua source, e.g.
 *   RegisterKeyBind(Key.F5, function() ... end)
 *   RegisterKeyBind(Key.NUM_ONE, {ModifierKey.CONTROL}, ...)
 */
export function parseLuaHotkeys(source: string): { key: string; action: string }[] {
  const out: { key: string; action: string }[] = []
  const re = /RegisterKeyBind\s*\(\s*Key\.([A-Z0-9_]+)\s*(?:,\s*\{([^}]*)\})?/g

  for (const m of source.matchAll(re)) {
    const mods = (m[2] ?? '')
      .split(',')
      .map((s) => s.trim().replace(/^ModifierKey\./, ''))
      .filter(Boolean)
      .map((s) => s.replace(/_/g, ' '))
    const key = [...mods, m[1].replace(/_/g, ' ')].join('+').toUpperCase()

    // Try to name the action from a comment on the line above or beside it.
    const idx = m.index ?? 0
    const before = source.slice(Math.max(0, idx - 220), idx)
    const comment = [...before.matchAll(/--\s*(.+)/g)].pop()?.[1]?.trim()
    out.push({ key, action: comment ? cleanLine(comment) : 'Bound by this mod' })
  }

  return out
}

/** UFunction names hooked by a script mod — used to spot two mods fighting. */
export function parseLuaHooks(source: string): string[] {
  const out = new Set<string>()
  for (const m of source.matchAll(/RegisterHook\s*\(\s*["']([^"']+)["']/g)) out.add(m[1])
  for (const m of source.matchAll(/NotifyOnNewObject\s*\(\s*["']([^"']+)["']/g)) out.add(m[1])
  return [...out]
}

export interface ScriptScan {
  hotkeys: { key: string; action: string }[]
  hooks: string[]
}

/** Read every Lua file under the given roots and pull out binds and hooks. */
export async function scanScripts(roots: string[]): Promise<ScriptScan> {
  const hotkeys: { key: string; action: string }[] = []
  const hooks = new Set<string>()

  for (const root of roots) {
    let files: { abs: string }[]
    try {
      files = await walk(root, 6)
    } catch {
      continue
    }
    for (const f of files) {
      if (path.extname(f.abs).toLowerCase() !== '.lua') continue
      let text: string
      try {
        text = await fs.readFile(f.abs, 'utf8')
      } catch {
        continue
      }
      if (text.length > 1024 * 1024) continue
      hotkeys.push(...parseLuaHotkeys(text))
      for (const h of parseLuaHooks(text)) hooks.add(h)
    }
  }

  const seen = new Set<string>()
  return {
    hotkeys: hotkeys.filter((h) => (seen.has(h.key) ? false : (seen.add(h.key), true))),
    hooks: [...hooks]
  }
}

/** Read readme/txt docs bundled with a mod. */
export async function readDocs(files: string[]): Promise<Omit<HowToUse, 'source'>> {
  const merged: Omit<HowToUse, 'source'> = { directions: [], tips: [], requirements: [], hotkeys: [] }

  for (const f of files.slice(0, 6)) {
    const ext = path.extname(f).toLowerCase()
    if (!['.txt', '.md', '.html'].includes(ext)) continue
    let text: string
    try {
      text = await fs.readFile(f, 'utf8')
    } catch {
      continue
    }
    if (text.length > 512 * 1024) continue
    const parsed = parseDoc(text)
    merged.directions.push(...parsed.directions)
    merged.tips.push(...parsed.tips)
    merged.requirements.push(...parsed.requirements)
    merged.hotkeys.push(...parsed.hotkeys)
  }

  return merged
}

/** Merge every source of guidance into the final How-to-use block. */
export function mergeHowTo(
  parts: Partial<Omit<HowToUse, 'source'>>[],
  settings: ModSetting[],
  source?: string
): HowToUse {
  const directions: string[] = []
  const tips: string[] = []
  const requirements: string[] = []
  const hotkeys: { key: string; action: string }[] = []

  for (const p of parts) {
    directions.push(...(p.directions ?? []))
    tips.push(...(p.tips ?? []))
    requirements.push(...(p.requirements ?? []))
    hotkeys.push(...(p.hotkeys ?? []))
  }

  // Key-bound settings are hotkeys the player can actually change.
  for (const s of settings) {
    if (s.control === 'key' && typeof s.value === 'string') {
      hotkeys.push({ key: String(s.value).toUpperCase(), action: s.comment || s.label })
    }
  }

  const uniq = (arr: string[]): string[] => {
    const seen = new Set<string>()
    return arr.filter((x) => {
      const k = x.toLowerCase()
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
  }

  const seenKeys = new Set<string>()
  return {
    directions: uniq(directions).slice(0, 12),
    tips: uniq(tips).slice(0, 10),
    requirements: uniq(requirements).slice(0, 8),
    hotkeys: hotkeys.filter((h) => (seenKeys.has(h.key) ? false : (seenKeys.add(h.key), true))).slice(0, 14),
    source
  }
}
