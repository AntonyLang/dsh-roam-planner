/**
 * Route-level checks for the weather endpoint. No network, no real server.
 *
 * Run: node server/__tests__/routes-weather.test.mjs
 */
import assert from 'node:assert/strict'
import { registerRoutes } from '../routes.js'

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

function makeRouter({ sources }) {
  let handler = null
  const ctx = {
    webServer: {
      register(route) {
        handler = route.handler
        return () => {}
      },
    },
  }
  const trips = {
    getTrip: async (tripId) => ({
      tripId,
      title: 't',
      crs: 'WGS84',
      status: 'draft',
      revision: 1,
      days: [
        {
          index: 0,
          date: '2026-10-24',
          stops: [{ id: 's1', name: '拙政园', lat: 31.32, lng: 120.62 }],
          legs: [],
        },
        { index: 1, date: '2026-10-25', stops: [], legs: [] },
      ],
    }),
  }
  registerRoutes(ctx, { trips, config: {}, sources })
  return handler
}

function call(handler, method, url) {
  return new Promise((resolve) => {
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
    const req = { method, url, headers: {} }
    Promise.resolve(handler(req, res)).catch(() => {})
  })
}

const sources = {
  dailyWeather: async (_lat, _lng, start) => ({
    provider: 'open-meteo',
    days: [{ date: start, tMax: 24, tMin: 18, precip: 50 }],
  }),
}

const handler = makeRouter({ sources })
const ok = await call(handler, 'GET', '/roam/api/trips/t1/weather')
check('weather route answers 200 with one entry per day', () => {
  assert.equal(ok.status, 200)
  assert.equal(ok.json.days.length, 2)
  assert.equal(ok.json.days[0].tMax, 24)
  assert.equal(ok.json.days[0].place, '拙政园')
})
check('a day without stops yields nulls, not zeros', () => {
  assert.equal(ok.json.days[1].tMax, null)
  assert.equal(ok.json.days[1].precip, null)
})

const wrongMethod = await call(handler, 'POST', '/roam/api/trips/t1/weather')
check('POST is rejected with 405', () => assert.equal(wrongMethod.status, 405))

const noSource = await call(makeRouter({ sources: null }), 'GET', '/roam/api/trips/t1/weather')
check('a missing source answers 503 instead of throwing', () => assert.equal(noSource.status, 503))

console.log(failed === 0 ? '\nroute checks passed' : `\n${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
