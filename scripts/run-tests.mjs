/**
 * Run every test file under server/__tests__.
 *
 * Uses spawnSync with inherited stdio: the harness sandbox refuses piped
 * child stdio, and CI does not care either way.
 */
import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const dir = path.join(root, 'server', '__tests__')
const files = readdirSync(dir)
  .filter((name) => name.endsWith('.mjs'))
  .sort()

let failed = 0
for (const file of files) {
  const result = spawnSync(process.execPath, [path.join(dir, file)], { stdio: 'inherit' })
  if (result.status !== 0) {
    failed += 1
    console.log(`FAILED ${file}`)
  }
}

console.log(`\n${files.length - failed}/${files.length} test file(s) passed`)
process.exit(failed === 0 ? 0 : 1)
