/* Unit tests for working out what a mod changes from its cooked asset paths. */
import { classifyAssets, palDisplayName } from '../src/main/services/targets'

let failures = 0
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`  ok   ${name}`)
  else {
    failures++
    console.log(`  FAIL ${name}`, extra ?? '')
  }
}

const label = (t: { label: string }[]): string[] => t.map((x) => x.label)

console.log('\nplayer character detection:')
const player = classifyAssets([
  'pal/content/pal/character/player/male/sk_player_male.uasset',
  'pal/content/pal/character/player/male/mi_player_body.uasset',
  'pal/content/pal/character/player/hair/sm_hair01.uasset'
])
check('recognises the player character', player[0]?.kind === 'player', player)
check('counts every asset', player[0]?.assetCount === 3, player[0])
check('keeps example paths', (player[0]?.examples.length ?? 0) === 3)

console.log('\npal detection:')
const pal = classifyAssets([
  'pal/content/pal/character/monster/pinkcat/sk_pinkcat.uasset',
  'pal/content/pal/character/monster/pinkcat/mi_pinkcat_body.uasset',
  'pal/content/pal/character/monster/sheepball/sk_sheepball.uasset'
])
check('finds two distinct pals', pal.filter((t) => t.kind === 'pal').length === 2, label(pal))
check('maps known codenames to game names', label(pal).some((l) => l.startsWith('Cattiva (')), label(pal))
check('keeps the codename visible', label(pal).some((l) => l.includes('PinkCat') || l.includes('pinkcat')), label(pal))
check(
  'groups a pal\'s assets together',
  pal.find((t) => t.label.includes('Cattiva'))?.assetCount === 2,
  pal
)

const unknownPal = classifyAssets(['pal/content/pal/character/monster/WeirdNewPal/sk_x.uasset'])
check(
  'unmapped pals fall back to a readable codename',
  unknownPal[0]?.label === 'Weird New Pal',
  unknownPal
)

console.log('\nshared rigs are not pals:')
const shared = classifyAssets([
  'pal/content/pal/character/monster/common/abp_shared.uasset',
  'pal/content/pal/character/monster/template/base_rig.uasset'
])
check('does not invent a pal from common/', !shared.some((t) => t.kind === 'pal'), shared)

console.log('\nother content types:')
const mixed = classifyAssets([
  'pal/content/pal/weapon/rifle/sm_rifle.uasset',
  'pal/content/pal/building/wall/sm_wall.uasset',
  'pal/content/pal/ui/mainmenu/wbp_menu.uasset',
  'pal/content/pal/datatable/character/dt_palmonsterparameter.uasset',
  'pal/content/pal/sound/bgm/track01.uasset',
  'pal/content/pal/level/overworld/map01.umap',
  'pal/content/pal/effect/niagara/ns_fire.uasset'
])
const kinds = mixed.map((t) => t.kind)
check('weapons', kinds.includes('weapon'), kinds)
check('buildings', kinds.includes('building'), kinds)
check('interface', kinds.includes('ui'), kinds)
check('game data', kinds.includes('data'), kinds)
check('audio', kinds.includes('audio'), kinds)
check('maps', kinds.includes('map'), kinds)
check('effects', kinds.includes('effect'), kinds)

console.log('\nordering:')
const ordered = classifyAssets([
  'pal/content/pal/ui/a/wbp_a.uasset',
  'pal/content/pal/ui/b/wbp_b.uasset',
  'pal/content/pal/ui/c/wbp_c.uasset',
  'pal/content/pal/character/monster/pinkcat/sk.uasset',
  'pal/content/pal/character/player/male/sk.uasset'
])
check('player comes first', ordered[0]?.kind === 'player', ordered.map((t) => t.kind))
check('pals come before ui even with fewer assets', ordered[1]?.kind === 'pal', ordered.map((t) => t.kind))

console.log('\nrobustness:')
check('empty input yields nothing', classifyAssets([]).length === 0)
check('unrecognised paths become "other"', classifyAssets(['weird/thing.uasset'])[0]?.kind === 'other')
check(
  'handles backslashes',
  classifyAssets(['pal\\content\\pal\\character\\player\\male\\sk.uasset'])[0]?.kind === 'player'
)
check(
  'handles a leading slash',
  classifyAssets(['/pal/content/pal/character/player/male/sk.uasset'])[0]?.kind === 'player'
)
check(
  'is case insensitive',
  classifyAssets(['Pal/Content/Pal/Character/Player/Male/SK.uasset'])[0]?.kind === 'player'
)

console.log('\npal name display:')
check('known name shows both', palDisplayName('PinkCat') === 'Cattiva (PinkCat)', palDisplayName('PinkCat'))
check(
  'a mapped name shows the game name first',
  palDisplayName('PlantSlime') === 'Gumoss (PlantSlime)',
  palDisplayName('PlantSlime')
)
check(
  'an unmapped name is split into words',
  palDisplayName('FrostyBearCub') === 'Frosty Bear Cub',
  palDisplayName('FrostyBearCub')
)

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
