/**
 * `/ops` route checks: the atomic edits the map page sends.
 *
 * Run: node server/__tests__/ops.test.mjs
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { registerRoutes } from '../routes.js'

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

let stored = {
  tripId: 't1',
  title: 'Suzhou',
  crs: 'WGS84',
  status: 'draft',
  revision: 1,
  days: [
    {
      index: 0,
      date: '2026-10-24',
      stops: [
        { id: 'a', name: '拙政园', lat: 31.32, lng: 120.62, start: '09:00', stayMinutes: 120 },
        { id: 'b', name: '平江路', lat: 31.31, lng: 120.63 },
      ],
      legs: [{ from: 'a', to: 'b', mode: 'walk', minutes: 15 }],
    },
    { index: 1, date: '2026-10-25', stops: [], legs: [] },
  ],
}

const trips = {
  getTrip: async () => JSON.parse(JSON.stringify(stored)),
  updateDraft: async (_id, patch) => {
    stored = { ...stored, title: patch.title ?? stored.title, days: patch.days ?? stored.days, revision: stored.revision + 1 }
    return { tripId: 't1', revision: stored.revision, status: 'draft' }
  },
}

const geocoder = {
  geocode: async (name) => ({ lat: 31.3, lng: 120.6, label: name, provider: 'test' }),
}

let handler = null
registerRoutes(
  { webServer: { register: (route) => ((handler = route.handler), () => {}) } },
  { trips, config: {}, sources: null, settings: null, geocoder },
)

function call(body) {
  return new Promise((resolve) => {
    const req = new EventEmitter()
    req.method = 'POST'
    req.url = '/roam/api/trips/t1/ops'
    req.headers = {}
    const res = {
      statusCode: 0,
      payload: '',
      writeHead(code) {
        this.statusCode = code
      },
      end(text) {
        this.payload = text
        resolve({ status: this.statusCode, json: JSON.parse(text) })
      },
    }
    Promise.resolve(handler(req, res)).catch(() => {})
    setTimeout(() => {
      req.emit('data', Buffer.from(JSON.stringify(body)))
      req.emit('end')
    }, 0)
  })
}

const edited = await call({ ops: [{ op: 'updateStop', stopId: 'a', patch: { name: '拙政园（东门）', start: '08:30', stayMinutes: 90 } }] })
await check('updateStop renames and retimes', () => {
  assert.equal(edited.status, 200)
  const stop = edited.json.days[0].stops.find((row) => row.id === 'a')
  assert.equal(stop.name, '拙政园（东门）')
  assert.equal(stop.start, '08:30')
  assert.equal(stop.stayMinutes, 90)
})

const removed = await call({ ops: [{ op: 'removeStop', stopId: 'b' }] })
await check('removeStop drops the stop and its legs', () => {
  assert.equal(removed.json.days[0].stops.length, 1)
  assert.equal(removed.json.days[0].legs.length, 0)
})

const added = await call({ ops: [{ op: 'addStop', dayIndex: 1, stop: { name: '虎丘' } }] })
await check('addStop geocodes a name and appends it', () => {
  const day = added.json.days.find((row) => row.index === 1)
  assert.equal(day.stops.length, 1)
  assert.equal(day.stops[0].name, '虎丘')
  assert.ok(Number.isFinite(day.stops[0].lat))
})

const moved = await call({ ops: [{ op: 'moveStop', stopId: 'a', toDay: 1 }] })
await check('moveStop relocates a stop between days', () => {
  const day0 = moved.json.days.find((row) => row.index === 0)
  const day1 = moved.json.days.find((row) => row.index === 1)
  assert.equal(day0.stops.length, 0)
  assert.equal(day1.stops.length, 2)
})

const reordered = await call({ ops: [{ op: 'moveStop', stopId: 'a', toDay: 1, toIndex: 0 }] })
await check('moveStop honours toIndex for ordering', () => {
  const day1 = reordered.json.days.find((row) => row.index === 1)
  assert.equal(day1.stops[0].id, 'a')
})

const renamed = await call({ ops: [{ op: 'setTitle', title: '苏州两日 · 慢游' }] })
await check('setTitle renames the trip', () => {
  assert.equal(renamed.json.title, '苏州两日 · 慢游')
})

const bad = await call({ ops: [{ op: 'removeStop', stopId: 'nope' }] })
await check('an unknown stop is a 404', () => assert.equal(bad.status, 404))

console.log(failed === 0 ? '\nops checks passed' : `\n${failed} failed`)
process.exit(failed === 0 ? 0 : 1)

