/* Profiles and the Edit tab's database layer, against real files on disk. */
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { describeInstall } from '../src/main/services/gameDetect'
import { stageSource, installStaged, setModEnabled } from '../src/main/services/installer'
import { createProfile, applyProfile, listProfiles } from '../src/main/services/profiles'
import { getMods } from '../src/main/services/store'
import { rescan, listTable, validateRecord, saveRecord } from '../src/main/services/db'
import AdmZip from 'adm-zip'

let failures = 0
const check = (n: string, c: boolean, extra?: unknown): void => {
  if (c) console.log('  ok   ' + n); else { failures++; console.log('  FAIL ' + n, extra ?? '') }
}
const exists = async (p: string): Promise<boolean> => { try { await fs.access(p); return true } catch { return false } }

async function main(): Promise<void> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'palmod-prof-'))
  const game = path.join(tmp, 'Palworld')
  await fs.mkdir(path.join(game, 'Pal', 'Content', 'Paks'), { recursive: true })
  await fs.writeFile(path.join(game, 'Palworld.exe'), '')
  const install = await describeInstall(game, 'manual')

  // Two simple pak mods
  const ids: string[] = []
  for (const name of ['AlphaMod', 'BetaMod']) {
    const zip = new AdmZip()
    zip.addFile(`${name}_P.pak`, Buffer.from(name))
    const zp = path.join(tmp, `${name}.zip`)
    zip.writeZip(zp)
    const staged = await stageSource(zp, install)
    const mod = await installStaged(staged.stageId, { selectedOptionIds: [], overwrite: true })
    ids.push(mod.id)
  }

  console.log('\nprofiles:')
  const both = await createProfile('Everything', true)
  check('profile captures current setup', both.enabledModIds.length === 2, both.enabledModIds.length)

  // Turn one off, save that as a second profile
  await setModEnabled(ids[1], false, install)
  const minimal = await createProfile('Alpha only', true)
  check('second profile captures the reduced setup', minimal.enabledModIds.length === 1, minimal.enabledModIds)

  const betaPak = path.join(install.modsDir, 'BetaMod_P.pak')
  check('disabled mod file is gone from the game folder', !(await exists(betaPak)))

  const applied = await applyProfile(both.id, install)
  check('applying re-enables', applied.enabled === 1, applied)
  check('beta file is back on disk', await exists(betaPak))
  check('library state agrees', (await getMods()).every((m) => m.state === 'enabled'))

  const back = await applyProfile(minimal.id, install)
  check('switching back disables', back.disabled === 1, back)
  check('beta file removed again', !(await exists(betaPak)))
  check('two profiles listed', (await listProfiles()).length === 2)

  console.log('\nedit tab backend:')
  const modRows = await listTable('mods')
  check('mods table lists both', modRows.length === 2, modRows.length)
  check('rows carry the full record', typeof modRows[0].record === 'object')

  const good = JSON.stringify({ ...(modRows[0].record as object), meta: { ...(modRows[0].record as any).meta, name: 'Renamed Mod' } })
  const okResult = await saveRecord('mods', modRows[0].id, good)
  check('valid edit saves', okResult.ok, okResult.errors)
  check('rename took effect', (await getMods()).some((m) => m.meta.name === 'Renamed Mod'))

  const badId = validateRecord('mods', modRows[0].id, JSON.stringify({ ...(modRows[0].record as object), id: 'hijacked' }))
  check('changing the id is rejected', !badId.ok, badId.errors)
  const badJson = validateRecord('mods', modRows[0].id, '{ not json')
  check('malformed json is rejected', !badJson.ok)
  const badSettings = validateRecord('settings', 'settings', JSON.stringify({ watchFolders: [], backupBeforeOverwrite: 'yes', autoResolveSafeConflicts: false, theme: 'dark' }))
  check('settings type errors are caught', !badSettings.ok, badSettings.errors)

  console.log('\nrescan:')
  await fs.rm(path.join(install.modsDir, 'AlphaMod_P.pak'), { force: true })
  const result = await rescan()
  check('rescan checks every mod', result.checked === 2, result)
  check('missing files reported', result.missingFiles.length === 1, result.missingFiles)
  check('state corrected to disabled', result.corrected.length === 1, result.corrected)

  await fs.rm(tmp, { recursive: true, force: true })
  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
