/**
 * Test runner.
 *
 * The services under test are written for Electron's main process, so each
 * suite is bundled with esbuild first, swapping the `electron` import for a
 * small stub. That lets the real install pipeline run under plain node against
 * a throwaway game folder.
 */
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const suites = ['smoke.ts', 'lookup.ts', 'images.ts', 'e2e.ts']

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'palmod-tests-'))
let failed = false

for (const suite of suites) {
  const name = path.basename(suite, '.ts')
  const outfile = path.join(tmp, `${name}.cjs`)

  // Each suite gets its own library file so they can't see each other's state.
  const userData = path.join(tmp, 'userdata', name)
  await fs.mkdir(userData, { recursive: true })

  await build({
    entryPoints: [path.join(here, suite)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    alias: { electron: path.join(here, 'electron-stub.js') },
    external: ['7zip-bin', 'node-7z', 'adm-zip'],
    logLevel: 'error'
  })

  console.log(`\n─── ${suite} ${'─'.repeat(Math.max(0, 50 - suite.length))}`)

  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [outfile], {
      stdio: 'inherit',
      env: {
        ...process.env,
        NODE_PATH: path.join(root, 'node_modules'),
        PALMOD_TEST_USERDATA: userData
      }
    })
    child.on('exit', resolve)
  })

  if (code !== 0) failed = true
}

await fs.rm(tmp, { recursive: true, force: true })
console.log(failed ? '\nSome suites failed.' : '\nAll suites passed.')
process.exit(failed ? 1 : 0)
