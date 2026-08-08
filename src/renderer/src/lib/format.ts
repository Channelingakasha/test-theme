import type { ModKind } from '@shared/types'

export function humanSize(bytes: number): string {
  if (!bytes) return '0 B'
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

export function kindLabel(kind: ModKind): string {
  switch (kind) {
    case 'pak':
      return 'Content'
    case 'logicmod':
      return 'Blueprint'
    case 'ue4ss-lua':
      return 'Script'
    case 'ue4ss-dll':
      return 'Native'
    case 'ue4ss-core':
      return 'UE4SS'
    case 'save':
      return 'Save data'
    default:
      return 'Mod'
  }
}

export function kindIcon(kind: ModKind): string {
  switch (kind) {
    case 'pak':
      return '🧩'
    case 'logicmod':
      return '🧠'
    case 'ue4ss-lua':
      return '📜'
    case 'ue4ss-dll':
      return '⚙️'
    case 'ue4ss-core':
      return '🔌'
    case 'save':
      return '💾'
    default:
      return '📦'
  }
}

/** Cached images are served through the app's own protocol. */
export function imageSrc(localPath: string | undefined): string | null {
  if (!localPath) return null
  const name = localPath.split(/[\\/]/).pop()
  return name ? `palimg://img/${encodeURIComponent(name)}` : null
}

export function relativeDate(ts: number): string {
  const days = Math.floor((Date.now() - ts) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  return new Date(ts).toLocaleDateString()
}

/** Shorten a long path for display: keep the start and the last two segments. */
export function shortPath(p: string, max = 64): string {
  if (p.length <= max) return p
  const parts = p.split(/[\\/]/)
  if (parts.length <= 3) return p
  return `${parts[0]}${p.includes('\\') ? '\\' : '/'}…${p.includes('\\') ? '\\' : '/'}${parts
    .slice(-2)
    .join(p.includes('\\') ? '\\' : '/')}`
}
