/* Unit tests for the "Get info" web lookup: query building, scoring, parsing. */
import {
  searchTermsFor,
  similarity,
  scoreCandidate,
  parseDuckDuckGo,
  hostOf
} from '../src/main/services/lookup'
import type { Mod } from '../src/shared/types'

let failures = 0
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`  ok   ${name}`)
  else {
    failures++
    console.log(`  FAIL ${name}`, extra ?? '')
  }
}

function fakeMod(name: string, file = 'thing.pak'): Mod {
  return {
    id: 'x',
    meta: { name, tags: [] },
    kind: 'pak',
    state: 'enabled',
    installRoots: [],
    files: [{ dest: `/game/${file}`, rel: file, size: 1, sha1: '' }],
    options: [],
    selectedOptionIds: [],
    settings: [],
    howTo: { directions: [], hotkeys: [], tips: [], requirements: [] },
    loadOrder: 100,
    installedAt: 0,
    updatedAt: 0,
    sizeBytes: 1
  }
}

console.log('\nsearch term building:')
check('splits CamelCase filenames', searchTermsFor(fakeMod('LunaOutfit')) === 'Luna Outfit', searchTermsFor(fakeMod('LunaOutfit')))
check(
  'strips the _P pak suffix',
  searchTermsFor(fakeMod('BiggerBackpack_P')) === 'Bigger Backpack',
  searchTermsFor(fakeMod('BiggerBackpack_P'))
)
check(
  'strips version numbers',
  searchTermsFor(fakeMod('AutoHarvest_v1.4.2')) === 'Auto Harvest',
  searchTermsFor(fakeMod('AutoHarvest_v1.4.2'))
)
check(
  'strips pakchunk noise',
  searchTermsFor(fakeMod('pakchunk99-BetterUI_P')) === 'Better UI',
  searchTermsFor(fakeMod('pakchunk99-BetterUI_P'))
)
check(
  'keeps multi-word names intact',
  searchTermsFor(fakeMod('Grizzbolt Rework')) === 'Grizzbolt Rework',
  searchTermsFor(fakeMod('Grizzbolt Rework'))
)
check(
  'keeps acronyms intact',
  searchTermsFor(fakeMod('UE4SS')) === 'UE4SS',
  searchTermsFor(fakeMod('UE4SS'))
)
check(
  'splits a name from a trailing acronym',
  searchTermsFor(fakeMod('PalHUD')) === 'Pal HUD',
  searchTermsFor(fakeMod('PalHUD'))
)
check(
  'does not strip "Pal" from real mod names',
  searchTermsFor(fakeMod('PalBuildTools')) === 'Pal Build Tools',
  searchTermsFor(fakeMod('PalBuildTools'))
)
check(
  'handles hyphenated acronym names',
  searchTermsFor(fakeMod('RE-UE4SS')) === 'RE UE4SS',
  searchTermsFor(fakeMod('RE-UE4SS'))
)
check(
  'falls back rather than returning nothing',
  searchTermsFor(fakeMod('Palworld_Mod_P')).length > 0,
  searchTermsFor(fakeMod('Palworld_Mod_P'))
)
check(
  'uses the filename when there is no name',
  searchTermsFor({ ...fakeMod(''), meta: { name: '', tags: [] } } as Mod).length > 0,
  searchTermsFor({ ...fakeMod(''), meta: { name: '', tags: [] } } as Mod)
)

console.log('\nsimilarity:')
check('identical titles score 1', similarity('Luna Outfit', 'Luna Outfit') === 1)
check('partial overlap scores between', similarity('Luna Outfit Pack', 'Luna Outfit') > 0.5)
check('unrelated titles score 0', similarity('Luna Outfit', 'Dragon Sword Remake') === 0)
check('is case insensitive', similarity('luna outfit', 'LUNA OUTFIT') === 1)

console.log('\ncandidate scoring:')
const nexus = scoreCandidate('Luna Outfit', 'Luna Outfit at Palworld Nexus', 'https://www.nexusmods.com/palworld/mods/123')
const github = scoreCandidate('Auto Harvest', 'grimwold/auto-harvest', 'https://github.com/grimwold/auto-harvest')
const junk = scoreCandidate('Luna Outfit', 'Top 10 Palworld Mods 2024', 'https://randomblog.example.com/post')
const wrongMod = scoreCandidate('Luna Outfit', 'Dragon Sword Remake', 'https://www.nexusmods.com/palworld/mods/999')

check('a matching nexus page scores high', nexus > 0.7, nexus)
check('a matching github repo scores high', github > 0.6, github)
check('an unknown host is rejected outright', junk === 0, junk)
check('a known host with a wrong name scores low', wrongMod < 0.4, wrongMod)
check('the right match outranks the wrong one', nexus > wrongMod)

console.log('\nhost parsing:')
check('strips www', hostOf('https://www.nexusmods.com/palworld/mods/1') === 'nexusmods.com')
check('handles bad urls', hostOf('not a url') === '')

console.log('\nduckduckgo result parsing:')
const html = `
<div class="results">
  <div class="result"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.nexusmods.com%2Fpalworld%2Fmods%2F123&amp;rut=abc">Luna <b>Outfit</b> at Palworld Nexus</a></div>
  <div class="result"><a class="result__a" href="https://github.com/grimwold/auto-harvest">grimwold/auto-harvest</a></div>
</div>`
const parsed = parseDuckDuckGo(html)
check('finds both results', parsed.length === 2, parsed)
check('unwraps the redirect', parsed[0]?.url === 'https://www.nexusmods.com/palworld/mods/123', parsed[0]?.url)
check('strips markup from titles', parsed[0]?.title === 'Luna Outfit at Palworld Nexus', parsed[0]?.title)
check('keeps direct links as-is', parsed[1]?.url === 'https://github.com/grimwold/auto-harvest', parsed[1]?.url)
check('empty html yields nothing, no throw', parseDuckDuckGo('').length === 0)
check('garbage html yields nothing, no throw', parseDuckDuckGo('<html><body>nope</body></html>').length === 0)

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
