/* Smoke tests for the electron-free services. */
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { classifyStage } from '../src/main/services/classify'
import { readSettings, writeSetting } from '../src/main/services/modConfig'
import { scanScripts, parseDoc, mergeHowTo } from '../src/main/services/howto'
import { readPakAssets, readUtocChunkIds } from '../src/main/services/pak'

let failures = 0
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    console.log(`  ok   ${name}`)
  } else {
    failures++
    console.log(`  FAIL ${name}`, extra ?? '')
  }
}

/* ---------- build a fake UnrealPak v11 file (full directory index) -------- */

function fstring(s: string): Buffer {
  const b = Buffer.alloc(4 + s.length + 1)
  b.writeInt32LE(s.length + 1, 0)
  b.write(s, 4, 'latin1')
  b.writeUInt8(0, 4 + s.length)
  return b
}

function makePakV11(assets: { dir: string; file: string }[]): Buffer {
  const mountPoint = '../../../'

  // Full directory index: numDirs, then per dir { name, numFiles, [name, u32] }
  const byDir = new Map<string, string[]>()
  for (const a of assets) {
    const arr = byDir.get(a.dir) ?? []
    arr.push(a.file)
    byDir.set(a.dir, arr)
  }
  const fdiParts: Buffer[] = []
  const numDirs = Buffer.alloc(4)
  numDirs.writeInt32LE(byDir.size)
  fdiParts.push(numDirs)
  for (const [dir, files] of byDir) {
    fdiParts.push(fstring(dir))
    const n = Buffer.alloc(4)
    n.writeInt32LE(files.length)
    fdiParts.push(n)
    for (const f of files) {
      fdiParts.push(fstring(f))
      const enc = Buffer.alloc(4)
      enc.writeUInt32LE(0)
      fdiParts.push(enc)
    }
  }
  const fdi = Buffer.concat(fdiParts)

  // Primary index
  const idxParts: Buffer[] = []
  idxParts.push(fstring(mountPoint))
  const numEntries = Buffer.alloc(4)
  numEntries.writeInt32LE(assets.length)
  idxParts.push(numEntries)
  idxParts.push(Buffer.alloc(8)) // PathHashSeed
  const noHash = Buffer.alloc(4)
  noHash.writeInt32LE(0) // bHasPathHashIndex = 0
  idxParts.push(noHash)
  const hasFdi = Buffer.alloc(4)
  hasFdi.writeInt32LE(1)
  idxParts.push(hasFdi)
  const fdiOffsetBuf = Buffer.alloc(8)
  const fdiSizeBuf = Buffer.alloc(8)
  idxParts.push(fdiOffsetBuf, fdiSizeBuf, Buffer.alloc(20))
  const index = Buffer.concat(idxParts)

  const dataLen = 64 // pretend payload
  const indexOffset = dataLen
  const fdiOffset = indexOffset + index.length
  fdiOffsetBuf.writeBigInt64LE(BigInt(fdiOffset))
  fdiSizeBuf.writeBigInt64LE(BigInt(fdi.length))
  const index2 = Buffer.concat(idxParts) // rebuild with offsets filled in

  // Footer: EncryptionKeyGuid(16) bEncrypted(1) Magic(4) Version(4) IndexOffset(8) IndexSize(8) Hash(20)
  const footer = Buffer.alloc(16 + 1 + 4 + 4 + 8 + 8 + 20)
  let o = 16
  footer.writeUInt8(0, o)
  o += 1
  footer.writeUInt32LE(0x5a6f12e1, o)
  o += 4
  footer.writeInt32LE(11, o)
  o += 4
  footer.writeBigInt64LE(BigInt(indexOffset), o)
  o += 8
  footer.writeBigInt64LE(BigInt(index2.length), o)

  return Buffer.concat([Buffer.alloc(dataLen), index2, fdi, footer])
}

function makeUtoc(chunkIds: string[]): Buffer {
  const headerSize = 144
  const head = Buffer.alloc(headerSize)
  head.write('-==--==--==--==-', 0, 'latin1')
  head.writeUInt8(3, 16) // version
  head.writeUInt32LE(headerSize, 20)
  head.writeUInt32LE(chunkIds.length, 24)
  const ids = Buffer.concat(chunkIds.map((h) => Buffer.from(h, 'hex')))
  return Buffer.concat([head, ids])
}

/* ------------------------------ fixtures ---------------------------------- */

async function main(): Promise<void> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'palmod-test-'))

  // --- character mod with mutually exclusive variants ---
  const skin = path.join(tmp, 'skin')
  await fs.mkdir(path.join(skin, 'Optional', 'Red Version'), { recursive: true })
  await fs.mkdir(path.join(skin, 'Optional', 'Blue Version'), { recursive: true })
  const pakA = makePakV11([{ dir: 'Pal/Content/Pal/Character/', file: 'Hero_Red.uasset' }])
  const pakB = makePakV11([{ dir: 'Pal/Content/Pal/Character/', file: 'Hero_Blue.uasset' }])
  await fs.writeFile(path.join(skin, 'Optional', 'Red Version', 'HeroSkin_P.pak'), pakA)
  await fs.writeFile(path.join(skin, 'Optional', 'Blue Version', 'HeroSkin_P.pak'), pakB)
  await fs.writeFile(
    path.join(skin, 'README.md'),
    `# Hero Skin\n\n## Requirements\nRequires UE4SS 3.0 or newer.\n\n## How to use\nOpen the wardrobe and pick the new outfit.\nPress F7 to cycle colours.\n\n## Tips\nWorks in multiplayer if the host also has it.\n`
  )

  console.log('\ncharacter mod with variants:')
  const skinResult = await classifyStage(skin)
  check('kind is pak', skinResult.kind === 'pak', skinResult.kind)
  check('two options detected', skinResult.options.length === 2, skinResult.options.map((o) => o.label))
  check(
    'options are mutually exclusive',
    skinResult.options.every((o) => o.group === 'variant'),
    skinResult.options.map((o) => o.group)
  )
  check(
    'option labels come from folders',
    skinResult.options.some((o) => o.label === 'Red Version') &&
      skinResult.options.some((o) => o.label === 'Blue Version'),
    skinResult.options.map((o) => o.label)
  )
  check('one variant preselected', skinResult.suggestedOptionIds.length === 1)
  check('paks flatten to the mods folder', skinResult.files.some((f) => f.destRel === 'HeroSkin_P.pak'))
  check('readme found as doc', skinResult.docs.length === 1)

  const doc = parseDoc(await fs.readFile(path.join(skin, 'README.md'), 'utf8'))
  console.log('\nreadme parsing:')
  check('directions extracted', doc.directions.length >= 1, doc.directions)
  check('hotkey extracted from prose', doc.hotkeys.some((h) => h.key === 'F7'), doc.hotkeys)
  check('requirement extracted', doc.requirements.length >= 1, doc.requirements)
  check('tip extracted', doc.tips.length >= 1, doc.tips)

  // --- UE4SS script mod ---
  const script = path.join(tmp, 'script')
  const modDir = path.join(script, 'AutoHarvest', 'Scripts')
  await fs.mkdir(modDir, { recursive: true })
  await fs.writeFile(
    path.join(modDir, 'main.lua'),
    `local cfg = require("config")\n\n-- Toggle auto harvesting\nRegisterKeyBind(Key.F6, function() end)\n\n-- Dump inventory\nRegisterKeyBind(Key.NUM_ONE, {ModifierKey.CONTROL}, function() end)\n\nRegisterHook("/Script/Pal.PalPlayerCharacter:ReceiveTick", function() end)\n`
  )
  await fs.writeFile(
    path.join(modDir, 'config.lua'),
    `local Config = {}\n\nConfig.Enabled = true -- Turn the mod on or off\nConfig.Radius = 15 -- Harvest radius in metres (1-50)\nConfig.ToggleKey = "F6" -- Key that toggles harvesting\nConfig.Mode = "auto" -- options: auto | manual | smart\n\nreturn Config\n`
  )
  await fs.writeFile(path.join(script, 'AutoHarvest', 'enabled.txt'), '')

  console.log('\nue4ss script mod:')
  const scriptResult = await classifyStage(script)
  check('kind is ue4ss-lua', scriptResult.kind === 'ue4ss-lua', scriptResult.kind)
  check(
    'preserves mod folder structure',
    scriptResult.files.some((f) => f.destRel === 'AutoHarvest/Scripts/main.lua'),
    scriptResult.files.map((f) => f.destRel)
  )
  check('no variants invented', scriptResult.options.length === 0)

  const scan = await scanScripts([script])
  check('lua hotkeys found', scan.hotkeys.length === 2, scan.hotkeys)
  check('modifier keys combined', scan.hotkeys.some((h) => h.key === 'CONTROL+NUM ONE'), scan.hotkeys)
  check('hotkey comment used as action', scan.hotkeys.some((h) => h.action === 'Toggle auto harvesting'), scan.hotkeys)
  check('hook captured', scan.hooks.includes('/Script/Pal.PalPlayerCharacter:ReceiveTick'), scan.hooks)

  console.log('\nmod config parsing:')
  const settings = await readSettings([script])
  const byKey = new Map(settings.map((s) => [s.key, s]))
  check('boolean becomes a toggle', byKey.get('Config.Enabled')?.control === 'toggle')
  check('number becomes a number field', byKey.get('Config.Radius')?.control === 'number')
  check('range read from comment', byKey.get('Config.Radius')?.min === 1 && byKey.get('Config.Radius')?.max === 50, {
    min: byKey.get('Config.Radius')?.min,
    max: byKey.get('Config.Radius')?.max
  })
  check('key binding detected', byKey.get('Config.ToggleKey')?.control === 'key')
  check('select options parsed', byKey.get('Config.Mode')?.options?.length === 3, byKey.get('Config.Mode')?.options)

  // write-back round trip
  const radius = byKey.get('Config.Radius')
  if (radius) await writeSetting(radius, 42)
  const enabled = byKey.get('Config.Enabled')
  if (enabled) await writeSetting(enabled, false)
  const after = await fs.readFile(path.join(modDir, 'config.lua'), 'utf8')
  check('number written back in place', /Config\.Radius = 42 -- Harvest radius/.test(after), after)
  check('boolean written back in place', /Config\.Enabled = false -- Turn the mod/.test(after), after)

  const merged = mergeHowTo([doc, scan], settings)
  console.log('\nhow-to merge:')
  check('hotkeys merged and deduped', merged.hotkeys.length >= 3, merged.hotkeys)
  check('directions preserved', merged.directions.length >= 1)

  console.log('\npak / utoc readers:')
  const pakPath = path.join(skin, 'Optional', 'Red Version', 'HeroSkin_P.pak')
  const assets = await readPakAssets(pakPath)
  check('pak index parsed', assets !== null, assets)
  check(
    'asset path normalized',
    assets?.[0] === 'pal/content/pal/character/hero_red.uasset',
    assets
  )

  const utocPath = path.join(tmp, 'test.utoc')
  const ids = ['aabbccddeeff001122334455', '112233445566778899aabbcc']
  await fs.writeFile(utocPath, makeUtoc(ids))
  const readIds = await readUtocChunkIds(utocPath)
  check('utoc chunk ids parsed', readIds?.length === 2, readIds)
  check('chunk ids round-trip', readIds?.[0] === ids[0], readIds)

  const garbage = path.join(tmp, 'garbage.pak')
  await fs.writeFile(garbage, Buffer.alloc(2048, 7))
  check('unreadable pak returns null, no throw', (await readPakAssets(garbage)) === null)

  await fs.rm(tmp, { recursive: true, force: true })
  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
