/**
 * Minimal readers for Unreal packaging formats, used for asset-level conflict
 * detection. We only ever read the index — never the payload — so this stays
 * fast even on multi-GB paks.
 *
 * Every parse is best-effort: mod paks come from many UnrealPak versions and
 * some ship encrypted indices. On anything unexpected we return `null` and the
 * caller falls back to filename-level conflict checks.
 */
import { open } from 'node:fs/promises'

const PAK_MAGIC = 0x5a6f12e1
const UTOC_MAGIC = '-==--==--==--==-'

class Reader {
  private off = 0
  constructor(private buf: Buffer) {}
  get offset(): number {
    return this.off
  }
  set offset(v: number) {
    this.off = v
  }
  get remaining(): number {
    return this.buf.length - this.off
  }
  u8(): number {
    return this.buf.readUInt8(this.off++)
  }
  i32(): number {
    const v = this.buf.readInt32LE(this.off)
    this.off += 4
    return v
  }
  u32(): number {
    const v = this.buf.readUInt32LE(this.off)
    this.off += 4
    return v
  }
  i64(): number {
    const v = this.buf.readBigInt64LE(this.off)
    this.off += 8
    return Number(v)
  }
  skip(n: number): void {
    this.off += n
  }
  /** Unreal FString: positive length = ASCII, negative = UTF-16, both NUL-terminated. */
  fstring(): string {
    const len = this.i32()
    if (len === 0) return ''
    if (len > 0) {
      if (len > 1 << 16 || len > this.remaining) throw new Error('bad fstring')
      const s = this.buf.toString('latin1', this.off, this.off + len - 1)
      this.off += len
      return s
    }
    const chars = -len
    if (chars > 1 << 16 || chars * 2 > this.remaining) throw new Error('bad fstring')
    const s = this.buf.toString('utf16le', this.off, this.off + (chars - 1) * 2)
    this.off += chars * 2
    return s
  }
}

/** Skip one FPakEntry (legacy index layout, versions 8–9). */
function skipPakEntry(r: Reader, version: number): void {
  r.skip(8) // Offset
  r.skip(8) // Size
  r.skip(8) // UncompressedSize
  let compressionMethodIndex: number
  if (version < 8) {
    compressionMethodIndex = r.i32()
  } else {
    compressionMethodIndex = r.i32()
  }
  r.skip(20) // Hash
  if (compressionMethodIndex !== 0) {
    const blocks = r.i32()
    if (blocks < 0 || blocks > 1 << 22) throw new Error('bad block count')
    r.skip(blocks * 16)
  }
  r.skip(1) // bEncrypted
  r.skip(4) // CompressionBlockSize
}

function normalizeAsset(mountPoint: string, p: string): string {
  let full = `${mountPoint}${p}`
  full = full.replace(/\\/g, '/').replace(/\/+/g, '/')
  // Mount points are relative to the pak root, e.g. "../../../Pal/Content/…".
  full = full.replace(/^(\.\.\/)+/, '').replace(/^\/+/, '')
  return full.toLowerCase()
}

/**
 * Read the file list out of a .pak. Returns normalized asset paths, or null if
 * the index can't be read (encrypted, or an unsupported version).
 */
export async function readPakAssets(file: string, limit = 20000): Promise<string[] | null> {
  let fh: Awaited<ReturnType<typeof open>> | null = null
  try {
    fh = await open(file, 'r')
    const { size } = await fh.stat()
    if (size < 64) return null

    // The footer sits at the very end; scan a window back from EOF for the magic.
    const tailLen = Math.min(size, 4096)
    const tail = Buffer.alloc(tailLen)
    await fh.read(tail, 0, tailLen, size - tailLen)

    let magicPos = -1
    for (let i = tail.length - 4; i >= 0; i--) {
      if (tail.readUInt32LE(i) === PAK_MAGIC) {
        magicPos = i
        break
      }
    }
    if (magicPos < 0) return null

    const f = new Reader(tail)
    f.offset = magicPos + 4
    const version = f.i32()
    const indexOffset = f.i64()
    const indexSize = f.i64()
    if (
      version < 3 ||
      version > 12 ||
      indexOffset <= 0 ||
      indexSize <= 0 ||
      indexOffset + indexSize > size ||
      indexSize > 512 * 1024 * 1024
    ) {
      return null
    }

    const index = Buffer.alloc(indexSize)
    await fh.read(index, 0, indexSize, indexOffset)
    const r = new Reader(index)

    const mountPoint = r.fstring()
    const numEntries = r.i32()
    if (numEntries < 0 || numEntries > 5_000_000) return null

    const assets: string[] = []

    if (version < 10) {
      for (let i = 0; i < numEntries && assets.length < limit; i++) {
        const name = r.fstring()
        skipPakEntry(r, version)
        assets.push(normalizeAsset(mountPoint, name))
      }
      return assets
    }

    // Version 10/11: the names live in a separate full directory index block.
    r.skip(8) // PathHashSeed
    const hasPathHashIndex = r.i32()
    if (hasPathHashIndex !== 0) r.skip(8 + 8 + 20)
    const hasFullDirectoryIndex = r.i32()
    if (hasFullDirectoryIndex === 0) return null
    const fdiOffset = r.i64()
    const fdiSize = r.i64()
    if (fdiOffset <= 0 || fdiSize <= 0 || fdiOffset + fdiSize > size || fdiSize > 256 * 1024 * 1024) {
      return null
    }

    const fdi = Buffer.alloc(fdiSize)
    await fh.read(fdi, 0, fdiSize, fdiOffset)
    const d = new Reader(fdi)
    const numDirs = d.i32()
    if (numDirs < 0 || numDirs > 1_000_000) return null
    for (let i = 0; i < numDirs && assets.length < limit; i++) {
      const dir = d.fstring()
      const numFiles = d.i32()
      if (numFiles < 0 || numFiles > 1_000_000) return null
      for (let j = 0; j < numFiles && assets.length < limit; j++) {
        const name = d.fstring()
        d.skip(4) // encoded entry offset
        assets.push(normalizeAsset(mountPoint, `${dir}${name}`))
      }
    }
    return assets
  } catch {
    return null
  } finally {
    await fh?.close()
  }
}

/**
 * Read chunk IDs from a .utoc (IoStore container). Two containers sharing a
 * chunk ID are patching the same cooked object — the most precise conflict
 * signal available for modern Palworld mods.
 */
export async function readUtocChunkIds(file: string, limit = 50000): Promise<string[] | null> {
  let fh: Awaited<ReturnType<typeof open>> | null = null
  try {
    fh = await open(file, 'r')
    const { size } = await fh.stat()
    if (size < 144) return null

    const head = Buffer.alloc(144)
    await fh.read(head, 0, 144, 0)
    if (head.toString('latin1', 0, 16) !== UTOC_MAGIC) return null

    const headerSize = head.readUInt32LE(20)
    const entryCount = head.readUInt32LE(24)
    if (headerSize < 64 || headerSize > 4096 || entryCount === 0 || entryCount > 5_000_000) {
      return null
    }
    const idsSize = entryCount * 12
    if (headerSize + idsSize > size) return null

    const ids = Buffer.alloc(idsSize)
    await fh.read(ids, 0, idsSize, headerSize)

    const out: string[] = []
    const n = Math.min(entryCount, limit)
    for (let i = 0; i < n; i++) {
      out.push(ids.toString('hex', i * 12, i * 12 + 12))
    }
    return out
  } catch {
    return null
  } finally {
    await fh?.close()
  }
}

export interface ContainerIndex {
  /** Cooked asset paths (from .pak) — empty when unreadable. */
  assets: string[]
  /** IoStore chunk ids (from .utoc) — empty when unreadable. */
  chunkIds: string[]
  /** True when at least one container's index parsed successfully. */
  readable: boolean
}

/** Index every container file in a set of paths. */
export async function indexContainers(files: string[]): Promise<ContainerIndex> {
  const assets = new Set<string>()
  const chunkIds = new Set<string>()
  let readable = false

  for (const f of files) {
    const lower = f.toLowerCase()
    if (lower.endsWith('.pak')) {
      const a = await readPakAssets(f)
      if (a) {
        readable = true
        for (const x of a) assets.add(x)
      }
    } else if (lower.endsWith('.utoc')) {
      const c = await readUtocChunkIds(f)
      if (c) {
        readable = true
        for (const x of c) chunkIds.add(x)
      }
    }
  }

  return { assets: [...assets], chunkIds: [...chunkIds], readable }
}
