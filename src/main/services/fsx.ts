import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

export async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory()
  } catch {
    return false
  }
}

export async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true })
}

export interface WalkedFile {
  abs: string
  rel: string
  size: number
}

/** Depth-limited recursive walk that skips junk and never follows symlinks. */
export async function walk(root: string, maxDepth = 12): Promise<WalkedFile[]> {
  const out: WalkedFile[] = []
  const skip = new Set(['.git', 'node_modules', '__MACOSX', '.vs', '.idea'])

  async function rec(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (skip.has(e.name) || e.name === '.DS_Store' || e.name === 'Thumbs.db') continue
      const abs = path.join(dir, e.name)
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) {
        await rec(abs, depth + 1)
      } else if (e.isFile()) {
        try {
          const st = await fs.stat(abs)
          out.push({ abs, rel: path.relative(root, abs), size: st.size })
        } catch {
          /* unreadable file — ignore */
        }
      }
    }
  }

  await rec(root, 0)
  return out
}

export async function sha1File(p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha1')
    const s = createReadStream(p)
    s.on('data', (c) => h.update(c))
    s.on('error', reject)
    s.on('end', () => resolve(h.digest('hex')))
  })
}

export function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex')
}

/** Copy a file, creating parent directories as needed. */
export async function copyFile(src: string, dest: string): Promise<void> {
  await ensureDir(path.dirname(dest))
  await fs.copyFile(src, dest)
}

/** Move a file across devices safely (rename, falling back to copy+unlink). */
export async function moveFile(src: string, dest: string): Promise<void> {
  await ensureDir(path.dirname(dest))
  try {
    await fs.rename(src, dest)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'EXDEV') throw err
    await fs.copyFile(src, dest)
    await fs.unlink(src)
  }
}

export async function rmrf(p: string): Promise<void> {
  await fs.rm(p, { recursive: true, force: true })
}

/** Remove a directory only if it contains nothing (used to tidy after uninstall). */
export async function removeIfEmpty(dir: string): Promise<void> {
  try {
    const entries = await fs.readdir(dir)
    if (entries.length === 0) await fs.rmdir(dir)
  } catch {
    /* not empty or gone — fine */
  }
}

export async function readTextIfExists(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, 'utf8')
  } catch {
    return null
  }
}

export async function readJsonIfExists<T>(p: string): Promise<T | null> {
  const text = await readTextIfExists(p)
  if (text === null) return null
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

export async function writeJson(p: string, data: unknown): Promise<void> {
  await ensureDir(path.dirname(p))
  await fs.writeFile(p, JSON.stringify(data, null, 2), 'utf8')
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`
}

/**
 * Strip a leading wrapper folder ("ModName-1.2/…") from an extracted tree.
 *
 * A folder is kept — not unwrapped — when it is itself a UE4SS mod folder,
 * because for those the folder name *is* the mod's identity: unwrapping it
 * would leave a bare Scripts/ directory with no name to install under.
 */
export async function unwrapSingleRoot(dir: string): Promise<string> {
  for (let i = 0; i < 3; i++) {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return dir
    }
    const real = entries.filter((e) => e.name !== '__MACOSX' && e.name !== '.DS_Store')
    if (real.length !== 1 || !real[0].isDirectory()) return dir

    const child = path.join(dir, real[0].name)
    if (await isUe4ssModFolder(child)) return dir

    dir = child
  }
  return dir
}

/** A UE4SS mod folder holds Scripts/ or dlls/ directly. */
async function isUe4ssModFolder(dir: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    return entries.some(
      (e) => e.isDirectory() && ['scripts', 'dlls'].includes(e.name.toLowerCase())
    )
  } catch {
    return false
  }
}

/** Reject paths that escape their intended root (zip-slip / traversal defence). */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}
