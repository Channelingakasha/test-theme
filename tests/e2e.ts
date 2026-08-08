/* End-to-end: zip -> stage -> conflict check -> install -> toggle -> uninstall. */
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import AdmZip from 'adm-zip'
import { describeInstall } from '../src/main/services/gameDetect'
import {
  stageSource,
  installStaged,
  setModEnabled,
  uninstallMod,
  applyOptionSelection
} from '../src/main/services/installer'
import { getMods } from '../src/main/services/store'
import { scanFolder, adoptInPlace } from '../src/main/services/adopt'

let failures = 0
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`  ok   ${name}`)
  else {
    failures++
    console.log(`  FAIL ${name}`, extra ?? '')
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/* --- fake pak with a readable index, so asset-overlap detection is exercised --- */
function fstring(s: string): Buffer {
  const b = Buffer.alloc(4 + s.length + 1)
  b.writeInt32LE(s.length + 1, 0)
  b.write(s, 4, 'latin1')
  return b
}

function makePak(assetDir: string, assetFile: string): Buffer {
  const fdiParts: Buffer[] = []
  const nd = Buffer.alloc(4)
  nd.writeInt32LE(1)
  fdiParts.push(nd, fstring(assetDir))
  const nf = Buffer.alloc(4)
  nf.writeInt32LE(1)
  fdiParts.push(nf, fstring(assetFile), Buffer.alloc(4))
  const fdi = Buffer.concat(fdiParts)

  const idx: Buffer[] = []
  idx.push(fstring('../../../'))
  const ne = Buffer.alloc(4)
  ne.writeInt32LE(1)
  idx.push(ne, Buffer.alloc(8))
  const noHash = Buffer.alloc(4)
  idx.push(noHash)
  const hasFdi = Buffer.alloc(4)
  hasFdi.writeInt32LE(1)
  idx.push(hasFdi)
  const off = Buffer.alloc(8)
  const size = Buffer.alloc(8)
  idx.push(off, size, Buffer.alloc(20))
  const index = Buffer.concat(idx)

  const dataLen = 64
  off.writeBigInt64LE(BigInt(dataLen + index.length))
  size.writeBigInt64LE(BigInt(fdi.length))
  const index2 = Buffer.concat(idx)

  const footer = Buffer.alloc(16 + 1 + 4 + 4 + 8 + 8 + 20)
  let o = 17
  footer.writeUInt32LE(0x5a6f12e1, o)
  o += 4
  footer.writeInt32LE(11, o)
  o += 4
  footer.writeBigInt64LE(BigInt(dataLen), o)
  o += 8
  footer.writeBigInt64LE(BigInt(index2.length), o)

  return Buffer.concat([Buffer.alloc(dataLen), index2, fdi, footer])
}

async function main(): Promise<void> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'palmod-e2e-'))
  const game = path.join(tmp, 'Palworld')
  await fs.mkdir(path.join(game, 'Pal', 'Content', 'Paks'), { recursive: true })
  await fs.mkdir(path.join(game, 'Pal', 'Binaries', 'Win64', 'ue4ss', 'Mods'), { recursive: true })
  await fs.writeFile(path.join(game, 'Palworld.exe'), '')
  await fs.writeFile(path.join(game, 'Pal', 'Binaries', 'Win64', 'dwmapi.dll'), '')

  const install = await describeInstall(game, 'manual')
  console.log('\ngame detection:')
  check('install recognised', install.valid)
  check('ue4ss detected', install.ue4ssInstalled)
  check('modern ue4ss Mods path used', install.ue4ssModsDir.endsWith(path.join('ue4ss', 'Mods')), install.ue4ssModsDir)

  /* ---------------- character mod with two variants, delivered as a zip -------- */
  const zip = new AdmZip()
  // "Blue Version" sorts first, so it is the variant preselected on install.
  zip.addFile('HeroSkin/Optional/Blue Version/HeroSkin_P.pak', makePak('Pal/Content/Pal/Hero/', 'Hero.uasset'))
  zip.addFile('HeroSkin/Optional/Red Version/HeroSkin_P.pak', makePak('Pal/Content/Pal/Hero/', 'Hero_Alt.uasset'))
  zip.addFile(
    'HeroSkin/README.txt',
    Buffer.from('How to use\nOpen the wardrobe to equip.\nPress F7 to swap colour.\n')
  )
  const zipPath = path.join(tmp, 'HeroSkin-v2.zip')
  zip.writeZip(zipPath)

  console.log('\nstaging a zip:')
  const staged = await stageSource(zipPath, install)
  check('name derived from filename', staged.meta.name.includes('HeroSkin'), staged.meta.name)
  check('two variants offered', staged.options.length === 2, staged.options.map((o) => o.label))
  check('exactly one preselected', staged.suggestedOptionIds.length === 1)
  check('plan only includes the chosen variant', staged.plan.length === 1, staged.plan)
  check(
    'destination is the ~mods folder',
    staged.plan[0]?.dest.includes(path.join('Paks', '~mods')),
    staged.plan[0]?.dest
  )
  check('how-to directions found in readme', staged.howTo.directions.length >= 1, staged.howTo.directions)
  check('hotkey found in readme', staged.howTo.hotkeys.some((h) => h.key === 'F7'), staged.howTo.hotkeys)
  check('no conflicts on a clean install', staged.conflicts.length === 0, staged.conflicts)

  console.log('\ninstalling:')
  const mod = await installStaged(staged.stageId, {
    selectedOptionIds: staged.suggestedOptionIds,
    overwrite: true
  })
  const installedPak = mod.files[0].dest
  check('one file installed', mod.files.length === 1, mod.files.length)
  check('pak landed in ~mods', await exists(installedPak), installedPak)
  check('other variant not installed', mod.files.length === 1)
  check('library has the mod', (await getMods()).length === 1)
  check('staging cleaned up', !(await exists(staged.stageDir)))

  console.log('\ntoggling off and on:')
  await setModEnabled(mod.id, false, install)
  check('file removed from game folder when off', !(await exists(installedPak)))
  check('state recorded as disabled', (await getMods())[0].state === 'disabled')
  await setModEnabled(mod.id, true, install)
  check('file restored when on', await exists(installedPak))
  check('state recorded as enabled', (await getMods())[0].state === 'enabled')

  console.log('\nswitching variant in place:')
  // Both variants ship the same filename, so the proof of a switch is that the
  // bytes at the destination changed and the tracked file list follows.
  const firstId = mod.selectedOptionIds[0]
  const other = mod.options.find((o) => o.id !== firstId)
  if (other) {
    const beforeBytes = await fs.readFile(installedPak)
    const after = await applyOptionSelection(mod.id, [other.id], install)
    check('selection updated', after.selectedOptionIds[0] === other.id)
    check('only one variant tracked', after.files.length === 1, after.files.length)
    check(
      'tracked file is the newly chosen variant',
      after.files[0]?.rel === other.files[0],
      after.files[0]?.rel
    )
    check('destination still present', await exists(installedPak))
    const afterBytes = await fs.readFile(installedPak)
    check('file contents actually swapped', !beforeBytes.equals(afterBytes))

    // put it back for the conflict test
    await applyOptionSelection(mod.id, [firstId], install)
    check('switching back restores the original bytes', (await fs.readFile(installedPak)).equals(beforeBytes))
  }

  /* ------------- second mod touching the same asset -> conflict --------------- */
  console.log('\nconflict detection on a second mod:')
  const zip2 = new AdmZip()
  zip2.addFile('RivalSkin/RivalSkin_P.pak', makePak('Pal/Content/Pal/Hero/', 'Hero.uasset'))
  const zip2Path = path.join(tmp, 'RivalSkin.zip')
  zip2.writeZip(zip2Path)

  const staged2 = await stageSource(zip2Path, install)
  const overlap = staged2.conflicts.find((c) => c.type === 'asset-overlap')
  check('asset overlap detected', Boolean(overlap), staged2.conflicts.map((c) => c.type))
  check('overlap names the other mod', overlap?.withModIds[0] === mod.id)
  check(
    'overlap lists the shared asset',
    Boolean(overlap?.details.some((d) => d.includes('hero.uasset'))),
    overlap?.details
  )
  check('no false file collision', !staged2.conflicts.some((c) => c.type === 'file-collision'))

  await installStaged(staged2.stageId, { selectedOptionIds: [], overwrite: true })

  /* ------------- a third copy of the same file -> file collision -------------- */
  const zip3 = new AdmZip()
  zip3.addFile('RivalSkin_P.pak', makePak('Pal/Content/Pal/Other/', 'Other.uasset'))
  const zip3Path = path.join(tmp, 'RivalSkin-again.zip')
  zip3.writeZip(zip3Path)
  const staged3 = await stageSource(zip3Path, install)
  check(
    'exact file collision detected',
    staged3.conflicts.some((c) => c.type === 'file-collision'),
    staged3.conflicts.map((c) => c.type)
  )

  /* ------------------------ ue4ss script mod install -------------------------- */
  console.log('\nue4ss script mod:')
  const zip4 = new AdmZip()
  zip4.addFile(
    'AutoHarvest/Scripts/main.lua',
    Buffer.from('-- Toggle harvesting\nRegisterKeyBind(Key.F6, function() end)\n')
  )
  zip4.addFile('AutoHarvest/Scripts/config.lua', Buffer.from('Config.Radius = 15 -- Radius (1-50)\n'))
  const zip4Path = path.join(tmp, 'AutoHarvest.zip')
  zip4.writeZip(zip4Path)

  const staged4 = await stageSource(zip4Path, install)
  check('classified as script mod', staged4.kind === 'ue4ss-lua', staged4.kind)
  check(
    'targets the ue4ss Mods folder',
    staged4.plan.every((p) => p.dest.includes(path.join('ue4ss', 'Mods'))),
    staged4.plan.map((p) => p.dest)
  )
  check('lua hotkey surfaced', staged4.howTo.hotkeys.some((h) => h.key === 'F6'), staged4.howTo.hotkeys)
  check('config setting surfaced', staged4.settings.some((s) => s.key === 'Config.Radius'), staged4.settings)

  const scriptMod = await installStaged(staged4.stageId, { selectedOptionIds: [], overwrite: true })
  const modsTxt = path.join(install.ue4ssModsDir, 'mods.txt')
  check('mods.txt written', await exists(modsTxt))
  check(
    'mod registered as enabled',
    (await fs.readFile(modsTxt, 'utf8')).includes('AutoHarvest : 1'),
    await fs.readFile(modsTxt, 'utf8')
  )
  check(
    'enabled.txt marker created',
    await exists(path.join(install.ue4ssModsDir, 'AutoHarvest', 'enabled.txt'))
  )

  await setModEnabled(scriptMod.id, false, install)
  check(
    'disabling flips mods.txt to 0',
    (await fs.readFile(modsTxt, 'utf8')).includes('AutoHarvest : 0'),
    await fs.readFile(modsTxt, 'utf8')
  )
  check(
    'script files stay in place when disabled',
    await exists(path.join(install.ue4ssModsDir, 'AutoHarvest', 'Scripts', 'main.lua'))
  )

  /* ----------------------------- adopting existing ---------------------------- */
  console.log('\nadopting a manually-installed mod:')
  const manualPak = path.join(install.modsDir, 'ManualMod_P.pak')
  await fs.writeFile(manualPak, makePak('Pal/Content/Pal/Manual/', 'Manual.uasset'))
  const found = await scanFolder(install.modsDir)
  const manual = found.find((c) => c.suggestedName.includes('ManualMod'))
  check('manual pak discovered', Boolean(manual), found.map((f) => f.suggestedName))
  check('already-installed ones flagged as tracked', found.some((c) => c.alreadyTracked))

  if (manual) {
    const adopted = await adoptInPlace([manual], install)
    check('adopted into the library', adopted.length === 1)
    check('marked as adopted', adopted[0]?.adopted === true)
    check('file left where it was', await exists(manualPak))
  }

  /* --------------------------------- uninstall -------------------------------- */
  console.log('\nuninstalling:')
  const before = (await getMods()).length
  await uninstallMod(mod.id)
  check('removed from library', (await getMods()).length === before - 1)
  check('files deleted from game folder', !(await exists(installedPak)))

  await fs.rm(tmp, { recursive: true, force: true })
  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
