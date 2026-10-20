/**
 * Enforces the harness's JSON Schema subset on every tool this plugin
 * registers.
 *
 * The host rejects a definition whose schema uses an unsupported keyword or a
 * multi-value `type`, and that rejection aborts the whole `apply()` — tools and
 * routes alike. This test walks the real definitions so the mistake surfaces
 * here instead of as a 404 in the GUI.
 *
 * Run: node server/__tests__/tool-schema.test.mjs
 */
import assert from 'node:assert/strict'
import { registerTools } from '../tools.js'

const CONSTRAINT = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
])
const ANNOTATION = new Set(['description', 'title', 'default', 'examples'])
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

function violations(schema, path = '#') {
  const out = []
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return [`${path}: not a schema object`]
  }
  for (const key of Object.keys(schema)) {
    if (!CONSTRAINT.has(key) && !ANNOTATION.has(key)) out.push(`${path}.${key}: unsupported keyword`)
  }
  if (schema.type !== undefined && !TYPES.has(schema.type)) {
    out.push(`${path}.type: must be one scalar type string`)
  }
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || schema.required.some((name) => typeof name !== 'string')) {
      out.push(`${path}.required: must be an array of strings`)
    }
  }
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') {
    out.push(`${path}.additionalProperties: must be a boolean`)
  }
  for (const [name, sub] of Object.entries(schema.properties || {})) {
    out.push(...violations(sub, `${path}.properties.${name}`))
  }
  if (schema.items) out.push(...violations(schema.items, `${path}.items`))
  if (Array.isArray(schema.oneOf)) {
    schema.oneOf.forEach((sub, index) => out.push(...violations(sub, `${path}.oneOf[${index}]`)))
  }
  return out
}

const definitions = []
const ctx = {
  logger: { info() {}, warn() {} },
  tools: {
    register(definition) {
      definitions.push(definition)
      return () => {}
    },
  },
}

registerTools(ctx, {}, {})

let failed = 0
console.log(`registered ${definitions.length} tools`)
for (const definition of definitions) {
  const problems = [
    ...violations(definition.parameters, `${definition.name}.parameters`),
    ...violations(definition.output?.schema, `${definition.name}.output.schema`),
  ]
  if (problems.length > 0) {
    failed += 1
    console.log(`FAIL ${definition.name}`)
    for (const problem of problems) console.log(`     ${problem}`)
  } else {
    console.log(`ok   ${definition.name}`)
  }
}

assert.ok(definitions.length > 0, 'the plugin registers at least one tool')
console.log(failed === 0 ? '\ntool schema checks passed' : `\n${failed} tool(s) rejected by the subset`)
process.exit(failed === 0 ? 0 : 1)
