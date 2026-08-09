import fs from 'node:fs/promises'
import path from 'node:path'
import type { ModSetting, SettingControl } from '@shared/types'
import { walk } from './fsx'

const CONFIG_NAMES = [
  'config.lua',
  'settings.lua',
  'conf.lua',
  'config.ini',
  'settings.ini',
  'config.cfg',
  'mod.cfg',
  'config.json',
  'settings.json'
]

const KEY_NAMES = new Set([
  'f1','f2','f3','f4','f5','f6','f7','f8','f9','f10','f11','f12',
  'insert','delete','home','end','pageup','pagedown','tab','capslock',
  'numpadone','numpadtwo','numpadthree','numlock','backspace','enter','space','escape','tilde'
])

function titleCase(key: string): string {
  return key
    .replace(/[_.]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\w/, (c) => c.toUpperCase())
}

function looksLikeKeyBinding(value: string): boolean {
  const v = value.toLowerCase().replace(/^key\./, '').replace(/[_\s]/g, '')
  return KEY_NAMES.has(v) || /^[a-z]$/.test(v)
}

/** Pull "options: a | b | c" or "one of: a, b" out of a trailing comment. */
function optionsFromComment(comment?: string): string[] | undefined {
  if (!comment) return undefined
  const m = comment.match(/(?:options?|one of|valid|choices?)\s*[:=]\s*(.+)$/i)
  if (!m) return undefined
  const parts = m[1]
    .split(/[|,/]/)
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter((s) => s.length > 0 && s.length < 32)
  return parts.length >= 2 ? parts : undefined
}

function inferControl(value: string | number | boolean, comment?: string): SettingControl {
  if (typeof value === 'boolean') return 'toggle'
  if (typeof value === 'number') return 'number'
  if (optionsFromComment(comment)) return 'select'
  if (looksLikeKeyBinding(value)) return 'key'
  return 'text'
}

/** Range hints like "(0-100)" or "min 1 max 10" in the comment. */
function rangeFromComment(comment?: string): { min?: number; max?: number } {
  if (!comment) return {}
  const dash = comment.match(/(-?\d+(?:\.\d+)?)\s*(?:-|to|\.\.)\s*(-?\d+(?:\.\d+)?)/)
  if (dash) return { min: Number(dash[1]), max: Number(dash[2]) }
  const min = comment.match(/min(?:imum)?\s*[:=]?\s*(-?\d+(?:\.\d+)?)/i)
  const max = comment.match(/max(?:imum)?\s*[:=]?\s*(-?\d+(?:\.\d+)?)/i)
  return { min: min ? Number(min[1]) : undefined, max: max ? Number(max[1]) : undefined }
}

function makeSetting(
  key: string,
  raw: string | number | boolean,
  file: string,
  format: ModSetting['format'],
  line: number,
  comment?: string
): ModSetting {
  const options = optionsFromComment(comment)
  const control = options ? 'select' : inferControl(raw, comment)
  const { min, max } = control === 'number' ? rangeFromComment(comment) : {}
  return {
    key,
    label: titleCase(key),
    control,
    value: raw,
    defaultValue: raw,
    options,
    min,
    max,
    comment: comment?.trim() || undefined,
    file,
    format,
    line
  }
}

function parseScalar(text: string): string | number | boolean | null {
  const t = text.trim()
  if (t === 'true') return true
  if (t === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t)
  const q = t.match(/^["'](.*)["']$/)
  if (q) return q[1]
  return null
}

/** Lua config: `local X = 1 -- comment`, `Config.X = true`, or `X = "F5",` in a table. */
function parseLua(text: string, file: string): ModSetting[] {
  const out: ModSetting[] = []
  const lines = text.split(/\r?\n/)
  lines.forEach((line, i) => {
    if (/^\s*--/.test(line)) return
    const m = line.match(
      /^\s*(?:local\s+)?([A-Za-z_][\w.]*)\s*=\s*([^,\n]+?)\s*,?\s*(?:--\s*(.*))?$/
    )
    if (!m) return
    const value = parseScalar(m[2])
    if (value === null) return
    out.push(makeSetting(m[1], value, file, 'lua', i, m[3]))
  })
  return out
}

/** INI/CFG: `key = value ; comment`, sections prefix the key. */
function parseIni(text: string, file: string): ModSetting[] {
  const out: ModSetting[] = []
  let section = ''
  text.split(/\r?\n/).forEach((line, i) => {
    const sec = line.match(/^\s*\[([^\]]+)\]\s*$/)
    if (sec) {
      section = sec[1]
      return
    }
    if (/^\s*[;#]/.test(line)) return
    const m = line.match(/^\s*([\w.\- ]+?)\s*=\s*([^;#\n]*?)\s*(?:[;#]\s*(.*))?$/)
    if (!m) return
    const raw = parseScalar(m[2]) ?? m[2].trim()
    if (raw === '') return
    const key = section ? `${section}.${m[1].trim()}` : m[1].trim()
    out.push(makeSetting(key, raw, file, 'ini', i, m[3]))
  })
  return out
}

function parseJsonConfig(text: string, file: string): ModSetting[] {
  const out: ModSetting[] = []
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return out
  }
  if (typeof data !== 'object' || data === null) return out

  const visit = (obj: Record<string, unknown>, prefix: string): void => {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k
      if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
        visit(v as Record<string, unknown>, key)
      } else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        out.push(makeSetting(key, v, file, 'json', -1))
      }
    }
  }
  visit(data as Record<string, unknown>, '')
  return out
}

function formatOf(file: string): ModSetting['format'] | null {
  const ext = path.extname(file).toLowerCase()
  if (ext === '.lua') return 'lua'
  if (ext === '.ini' || ext === '.cfg' || ext === '.conf') return 'ini'
  if (ext === '.json') return 'json'
  return null
}

/** Scan a mod's installed folders for config files and read out their settings. */
export async function readSettings(roots: string[]): Promise<ModSetting[]> {
  const settings: ModSetting[] = []

  for (const root of roots) {
    let files: { abs: string; rel: string }[]
    try {
      files = await walk(root, 6)
    } catch {
      continue
    }

    for (const f of files) {
      const base = path.basename(f.abs).toLowerCase()
      const fmt = formatOf(f.abs)
      if (!fmt) continue
      // Only look at plausible config files, not every script in the mod.
      const named = CONFIG_NAMES.includes(base)
      const configish = /config|setting|options?|prefs/i.test(base)
      if (!named && !configish) continue

      let text: string
      try {
        text = await fs.readFile(f.abs, 'utf8')
      } catch {
        continue
      }
      if (text.length > 512 * 1024) continue

      const parsed =
        fmt === 'lua' ? parseLua(text, f.abs) : fmt === 'ini' ? parseIni(text, f.abs) : parseJsonConfig(text, f.abs)

      // Guard against parsing a whole script as "settings".
      if (parsed.length > 0 && parsed.length <= 80) settings.push(...parsed)
    }
  }

  // De-duplicate by file+key, keeping the first occurrence.
  const seen = new Set<string>()
  return settings.filter((s) => {
    const k = `${s.file}::${s.key}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

function luaLiteral(value: string | number | boolean): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return String(value)
  return `"${String(value).replace(/"/g, '\\"')}"`
}

/** Write a changed value back into the mod's own config file, in place. */
export async function writeSetting(setting: ModSetting, value: string | number | boolean): Promise<void> {
  if (setting.format === 'json') {
    const text = await fs.readFile(setting.file, 'utf8')
    const data = JSON.parse(text) as Record<string, unknown>
    const parts = setting.key.split('.')
    let node: Record<string, unknown> = data
    for (let i = 0; i < parts.length - 1; i++) {
      const next = node[parts[i]]
      if (typeof next !== 'object' || next === null) return
      node = next as Record<string, unknown>
    }
    node[parts[parts.length - 1]] = value
    await fs.writeFile(setting.file, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    return
  }

  const text = await fs.readFile(setting.file, 'utf8')
  const lines = text.split(/\r?\n/)
  const i = setting.line ?? -1
  if (i < 0 || i >= lines.length) return

  const line = lines[i]
  if (setting.format === 'lua') {
    lines[i] = line.replace(
      /^(\s*(?:local\s+)?[A-Za-z_][\w.]*\s*=\s*)([^,\n]+?)(\s*,?\s*(?:--.*)?)$/,
      (_all, head: string, _old: string, tail: string) => `${head}${luaLiteral(value)}${tail}`
    )
  } else {
    const literal = typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value)
    lines[i] = line.replace(
      /^(\s*[\w.\- ]+?\s*=\s*)([^;#\n]*?)(\s*(?:[;#].*)?)$/,
      (_all, head: string, _old: string, tail: string) => `${head}${literal}${tail}`
    )
  }

  await fs.writeFile(setting.file, lines.join('\n'), 'utf8')
}
