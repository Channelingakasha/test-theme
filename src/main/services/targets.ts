/**
 * Works out what a mod actually changes in the game, from the cooked asset
 * paths inside its .pak files.
 *
 * Those paths are already read for conflict detection, so this costs nothing
 * extra and tells the user something a filename never could: whether a mod
 * touches their player character, a specific Pal, the UI, or game balance.
 */
import type { ModTarget, ModTargetKind } from '@shared/types'

/**
 * Palworld ships Pals under internal codenames that look nothing like the
 * names in game. This table covers the ones that are well established in the
 * modding community; anything missing falls through to the internal name,
 * which is still more useful than a filename. Add entries freely.
 */
export const PAL_NAMES: Record<string, string> = {
  sheepball: 'Lamball',
  chickenpal: 'Chikipi',
  pinkcat: 'Cattiva',
  kitsunebi: 'Foxparks',
  boar: 'Rushoar',
  penguin: 'Pengullet',
  plantslime: 'Gumoss',
  hedgehog: 'Hoocrates',
  fairydragon: 'Jetragon',
  electricpanda: 'Grizzbolt'
}

/** Pretty-print a Pal's internal folder name. */
export function palDisplayName(internal: string): string {
  const known = PAL_NAMES[internal.toLowerCase()]
  if (known) return `${known} (${internal})`
  // Split the codename into words so "PlantSlime" reads as "Plant Slime".
  return internal.replace(/([a-z])([A-Z])/g, '$1 $2')
}

interface Rule {
  kind: ModTargetKind
  test: RegExp
  label: string
}

/**
 * Order matters: the first rule that matches wins, so the specific patterns
 * (player, individual Pals) are checked before the broad ones.
 */
const RULES: Rule[] = [
  { kind: 'player', test: /\/character\/player\//, label: 'Your player character' },
  { kind: 'player', test: /\/(playercharacter|playerequipment|customize)\//, label: 'Your player character' },
  { kind: 'weapon', test: /\/(weapon|weapons)\//, label: 'Weapons' },
  { kind: 'building', test: /\/(building|buildobject|structure)\//, label: 'Base building' },
  { kind: 'item', test: /\/(inventoryitemicon|item|items)\//, label: 'Items' },
  { kind: 'ui', test: /\/(ui|umg|widget|hud)\//, label: 'Interface' },
  { kind: 'data', test: /\/(datatable|dt_|balance)/, label: 'Game data and balance' },
  { kind: 'audio', test: /\/(sound|audio|wwise|bgm|voice)\//, label: 'Audio' },
  { kind: 'map', test: /\/(level|levels|maps?|world)\//, label: 'World and maps' },
  { kind: 'effect', test: /\/(effect|effects|niagara|vfx|fx|particle)\//, label: 'Visual effects' },
  { kind: 'other', test: /\/(texture|material|mesh|skeletalmesh)\//, label: 'Models and textures' }
]

/**
 * Pull a Pal's codename out of a monster asset path.
 *
 * Matched case-insensitively against the original path, not a lowercased one,
 * so the codename keeps its capitalisation for display. Note the plural in
 * `/pals/`: `/pal/` is the game's own content root, so matching the singular
 * would treat every asset in the game as a Pal.
 */
function palFromPath(assetPath: string): string | null {
  const m =
    assetPath.match(/\/character\/monster\/([^/]+)\//i) ??
    assetPath.match(/\/pals\/([^/]+)\//i) ??
    assetPath.match(/\/monster\/([^/]+)\//i)
  if (!m) return null

  const name = m[1]
  // Shared rigs and templates are not an individual Pal.
  if (/^(common|shared|base|template|default|_+)/i.test(name)) return null
  return name
}

/**
 * Group a mod's cooked asset paths into the things it changes.
 * Returns the most-affected targets first, player and Pals prioritised since
 * those are what people actually look for.
 */
export function classifyAssets(assets: string[]): ModTarget[] {
  const buckets = new Map<string, ModTarget>()

  const add = (kind: ModTargetKind, label: string, assetPath: string): void => {
    const key = `${kind}::${label}`
    const existing = buckets.get(key)
    if (existing) {
      existing.assetCount++
      if (existing.examples.length < 3) existing.examples.push(assetPath)
    } else {
      buckets.set(key, { kind, label, assetCount: 1, examples: [assetPath] })
    }
  }

  for (const raw of assets) {
    // Normalise separators and guarantee a leading slash so the patterns can
    // anchor on path segments. Case is kept for the Pal codename.
    const normalized = `/${raw.replace(/\\/g, '/').replace(/^\/+/, '')}`
    const lower = normalized.toLowerCase()

    const pal = palFromPath(normalized)
    if (pal) {
      add('pal', palDisplayName(pal), raw)
      continue
    }

    const rule = RULES.find((r) => r.test.test(lower))
    if (rule) {
      add(rule.kind, rule.label, raw)
      continue
    }

    add('other', 'Other content', raw)
  }

  const priority: Record<ModTargetKind, number> = {
    player: 0,
    pal: 1,
    weapon: 2,
    building: 3,
    item: 4,
    ui: 5,
    data: 6,
    effect: 7,
    audio: 8,
    map: 9,
    other: 10
  }

  return [...buckets.values()].sort(
    (a, b) => priority[a.kind] - priority[b.kind] || b.assetCount - a.assetCount
  )
}
