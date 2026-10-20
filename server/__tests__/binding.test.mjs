/**
 * `/binding` route checks: which trip a conversation edits.
 *
 * Run: node server/__tests__/binding.test.mjs
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

const bound = { tripId: 't1', title: 'Suzhou', status: 'draft', revision: 3, days: [] }
const trips = {
  getSessionTrip: async (session) => (session === 'known' ? bound : null),
}

let handler = null
registerRoutes(
  { webServer: { register: (route) => ((handler = route.handler), () => {}) } },
  { trips, config: {}, sources: null, settings: null, geocoder: null },
)

function call(url) {
  return new Promise((resolve) => {
    const req = new EventEmitter()
    req.method = 'GET'
    req.url = url
    req.headers = {}
    const res = {
      statusCode: 0,
      payload: '',
      writeHead(code) {
        this.statusCode = code
      },
      end(text) {
        this.payload = text
        resolve({ status: this.statusCode, json: text ? JSON.parse(text) : null })
      },
    }
    Promise.resolve(handler(req, res)).catch(() => {})
    setTimeout(() => req.emit('end'), 0)
  })
}

const known = await call('/roam/api/binding?session=known')
await check('a bound session returns its trip', () => {
  assert.equal(known.status, 200)
  assert.equal(known.json.trip.tripId, 't1')
  assert.equal(known.json.trip.title, 'Suzhou')
})

const unknown = await call('/roam/api/binding?session=other')
await check('an unbound session returns null instead of creating a trip', () => {
  assert.equal(unknown.status, 200)
  assert.equal(unknown.json.trip, null)
})

const missing = await call('/roam/api/binding')
await check('a missing session is a 400', () => assert.equal(missing.status, 400))

console.log(failed === 0 ? '\nbinding checks passed' : `\n${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
