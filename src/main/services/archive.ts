import AdmZip from 'adm-zip'
import Seven from 'node-7z'
import { path7za } from '7zip-bin'
import fs from 'node:fs/promises'
import path from 'node:path'
import { ensureDir, isInside } from './fsx'

export type ArchiveKind = 'zip' | '7z' | 'rar' | 'none'

export function archiveKind(file: string): ArchiveKind {
  const l = file.toLowerCase()
  if (l.endsWith('.zip')) return 'zip'
  if (l.endsWith('.7z')) return '7z'
  if (l.endsWith('.rar')) return 'rar'
  return 'none'
}

/** In a packaged app the 7-Zip binary is unpacked next to the asar. */
function sevenZipPath(): string {
  return path7za.replace('app.asar', 'app.asar.unpacked')
}

/**
 * Extract a .zip. Entries are validated against the destination root so a
 * crafted archive can't write outside the staging folder (zip-slip).
 */
async function extractZip(file: string, dest: string): Promise<void> {
  const zip = new AdmZip(file)
  await ensureDir(dest)

  for (const entry of zip.getEntries()) {
    const name = entry.entryName.replace(/\\/g, '/')
    if (name.startsWith('__MACOSX/')) continue
    const target = path.resolve(dest, name)
    if (!isInside(dest, target)) continue

    if (entry.isDirectory) {
      await ensureDir(target)
      continue
    }
    await ensureDir(path.dirname(target))
    await fs.writeFile(target, entry.getData())
  }
}

/** Extract .7z and .rar through the bundled 7-Zip binary. */
function extract7z(file: string, dest: string, onProgress?: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = Seven.extractFull(file, dest, {
      $bin: sevenZipPath(),
      $progress: true,
      recursive: true,
      yes: true
    })
    stream.on('progress', (p) => onProgress?.(Math.max(0, Math.min(1, (p.percent ?? 0) / 100))))
    stream.on('end', () => resolve())
    stream.on('error', (err) => reject(err))
  })
}

/**
 * Extract any supported archive into `dest`.
 * Throws with a readable message when the format isn't supported.
 */
export async function extractArchive(
  file: string,
  dest: string,
  onProgress?: (pct: number) => void
): Promise<void> {
  const kind = archiveKind(file)
  await ensureDir(dest)

  switch (kind) {
    case 'zip':
      // 7-Zip handles some zips adm-zip chokes on (zip64, odd compressors),
      // so fall back rather than failing the whole install.
      try {
        await extractZip(file, dest)
      } catch {
        await extract7z(file, dest, onProgress)
      }
      return
    case '7z':
    case 'rar':
      await extract7z(file, dest, onProgress)
      return
    default:
      throw new Error(`Unsupported archive: ${path.basename(file)}`)
  }
}

/** Copy a loose file or a whole folder into the staging area. */
export async function copyIntoStage(src: string, dest: string): Promise<void> {
  const st = await fs.stat(src)
  await ensureDir(dest)
  if (st.isDirectory()) {
    await fs.cp(src, dest, { recursive: true, dereference: false, force: true })
  } else {
    await fs.copyFile(src, path.join(dest, path.basename(src)))
  }
}
