/**
 * Plan diff checks.
 *
 * Run: node server/__tests__/diff.test.mjs
 */
import assert from 'node:assert/strict'
import { diffPlans } from '../diff.js'

let failed = 0
function check(name, fn) {
  try {
    fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${name}: ${error.message}`)
  }
}

const stop = (name, extra = {}) => ({ id: name, name, lat: 31.3, lng: 120.6, ...extra })
const day = (index, date, names, extra = {}) => ({
  index,
  date,
  stops: names.map((name) => stop(name, extra[name] || {})),
  legs: [],
})

const base = {
  title: 'Suzhou',
  days: [day(0, '2026-10-24', ['拙政园', '平江路'], { 拙政园: { start: '09:30' } })],
}

check('an identical plan reports no changes', () => {
  const result = diffPlans(base, JSON.parse(JSON.stringify(base)))
  assert.equal(result.unchanged, true)
  assert.equal(result.counts.added, 0)
})

check('a new stop is counted as added', () => {
  const next = {
    title: 'Suzhou',
    days: [day(0, '2026-10-24', ['拙政园', '平江路', '山塘街'], { 拙政园: { start: '09:30' } })],
  }
  const result = diffPlans(base, next)
  assert.equal(result.counts.added, 1)
  assert.equal(result.added[0].name, '山塘街')
  assert.equal(result.unchanged, false)
})

check('a missing stop is counted as removed', () => {
  const next = {
    title: 'Suzhou',
    days: [day(0, '2026-10-24', ['拙政园'], { 拙政园: { start: '09:30' } })],
  }
  const result = diffPlans(base, next)
  assert.equal(result.counts.removed, 1)
  assert.equal(result.removed[0].name, '平江路')
})

check('a stop on another day is moved, not added', () => {
  const next = {
    title: 'Suzhou',
    days: [
      day(0, '2026-10-24', ['拙政园'], { 拙政园: { start: '09:30' } }),
      day(1, '2026-10-25', ['平江路']),
    ],
  }
  const result = diffPlans(base, next)
  assert.equal(result.counts.added, 0)
  assert.equal(result.counts.moved, 1)
  assert.deepEqual(result.moved[0], { name: '平江路', from: 0, to: 1 })
})

check('a changed start time is retimed', () => {
  const next = {
    title: 'Suzhou',
    days: [day(0, '2026-10-24', ['拙政园', '平江路'], { 拙政园: { start: '10:15' } })],
  }
  const result = diffPlans(base, next)
  assert.equal(result.counts.retimed, 1)
  assert.equal(result.retimed[0].to.start, '10:15')
})

check('a moved date and a renamed trip are reported', () => {
  const next = {
    title: 'Suzhou v2',
    days: [day(0, '2026-10-26', ['拙政园', '平江路'], { 拙政园: { start: '09:30' } })],
  }
  const result = diffPlans(base, next)
  assert.equal(result.counts.datesChanged, 1)
  assert.equal(result.counts.titleChanged, 1)
  assert.deepEqual(result.titleChange, { from: 'Suzhou', to: 'Suzhou v2' })
})

check('stop order inside a day is not a change', () => {
  const next = {
    title: 'Suzhou',
    days: [day(0, '2026-10-24', ['平江路', '拙政园'], { 拙政园: { start: '09:30' } })],
  }
  const result = diffPlans(base, next)
  assert.equal(result.unchanged, true)
})

check('an empty baseline counts every stop as added', () => {
  const result = diffPlans({ title: '', days: [] }, base)
  assert.equal(result.counts.added, 2)
  assert.equal(result.counts.daysAdded, 1)
})

console.log(failed === 0 ? '\ndiff checks passed' : `\n${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
