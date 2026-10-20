/**
 * The bundled skill must actually reach ctx.skills — the host does not scan the
 * package for skills, so a silent failure here means the skill never appears.
 */
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { registerBundledSkills } from '../skill.js'

let failed = 0
async function check(name, fn) {
  try {
    await fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${name}: ${error.message}`)
  }
}

const directory = fileURLToPath(new URL('../../skills/', import.meta.url))

const registered = []
let removed = 0
const ctx = {
  skills: {
    register(definition) {
      registered.push(definition)
      return () => {
        removed += 1
      }
    },
  },
}

const bundle = registerBundledSkills(ctx, directory)

await check('the travel-planning skill is registered', () => {
  const entry = bundle.report.find((row) => row.name === 'travel-planning')
  assert.ok(entry, `report: ${JSON.stringify(bundle.report)}`)
  assert.equal(entry.ok, true, entry.detail)
})

await check('the definition carries name, description and body', () => {
  const definition = registered.find((row) => row.name === 'travel-planning')
  assert.ok(definition, 'definition missing')
  assert.equal(definition.name, 'travel-planning')
  assert.ok(definition.description.length > 10, 'description too short')
  assert.ok(definition.content.includes('## 流程'), 'body lost the flow section')
  assert.ok(!definition.content.startsWith('---'), 'frontmatter leaked into the body')
})

await check('the resource base points at the skill directory', () => {
  const definition = registered.find((row) => row.name === 'travel-planning')
  assert.equal(definition.resourceBase.kind, 'directory')
  assert.ok(definition.resourceBase.path.endsWith('travel-planning'))
})

await check('dispose unregisters every registered skill', () => {
  bundle.dispose()
  assert.equal(removed, registered.length)
})

await check('a host without ctx.skills reports rather than throws', () => {
  const result = registerBundledSkills({}, directory)
  assert.equal(result.report.length, 1)
  assert.equal(result.report[0].ok, false)
  result.dispose()
})

console.log(failed === 0 ? '\nskill registration checks passed' : `\n${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
