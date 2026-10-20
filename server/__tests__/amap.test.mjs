/**
 * Amap integration checks: the direction adapter, its fallback, and the
 * settings surface that stores the key. No network, no real server.
 *
 * Run: node server/__tests__/amap.test.mjs
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createSources } from '../sources.js'
import { registerRoutes } from '../routes.js'
import { gcj02ToWgs84, wgs84ToGcj02 } from '../../client/src/geo.js'

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

const FROM = { lat: 31.3263, lng: 120.6247 }
const TO = { lat: 31.3149, lng: 120.6297 }

/* --- Amap directions are used when a key exists ---------------------- */
{
  const fromGcj = wgs84ToGcj02(FROM.lat, FROM.lng)
  const toGcj = wgs84ToGcj02(TO.lat, TO.lng)
  const payload = {
    status: '1',
    route: {
      paths: [
        {
          distance: '1973',
          duration: '300',
          steps: [{ polyline: `${fromGcj.lng},${fromGcj.lat};${toGcj.lng},${toGcj.lat}` }],
        },
      ],
    },
  }
  let seen = ''
  const sources = createSources({
    getAmapKey: async () => 'demo-key',
    fetchImpl: async (url) => {
      seen = String(url)
      return { ok: true, json: async () => payload }
    },
  })
  const route = await sources.routeLeg(FROM, TO, 'drive')
  const decoded = decodeURIComponent(seen)

  check('a configured key routes through Amap', () => {
    assert.ok(decoded.includes('restapi.amap.com/v3/direction/driving'))
    assert.ok(decoded.includes('key=demo-key'))
    assert.equal(route.provider, 'amap')
  })
  check('request coordinates are converted to GCJ-02', () => {
    assert.ok(decoded.includes(`origin=${fromGcj.lng.toFixed(6)},${fromGcj.lat.toFixed(6)}`) ||
      decoded.includes(`origin=${fromGcj.lng},${fromGcj.lat}`))
  })
  check('the returned polyline is converted back to WGS-84', () => {
    const expected = gcj02ToWgs84(fromGcj.lat, fromGcj.lng)
    assert.ok(Math.abs(route.geometry[0][0] - expected.lat) < 1e-5)
    assert.ok(Math.abs(route.geometry[0][1] - expected.lng) < 1e-5)
    assert.ok(Math.abs(route.geometry[0][0] - FROM.lat) < 1e-5)
  })
  check('walking asks the Amap walking endpoint', async () => {
    await sources.routeLeg(FROM, TO, 'walk')
    assert.ok(decodeURIComponent(seen).includes('/direction/walking'))
  })
}

/* --- an Amap failure falls back to OSRM ------------------------------ */
{
  const osrm = {
    code: 'Ok',
    routes: [
      {
        distance: 2000,
        duration: 240,
        geometry: { coordinates: [[120.62, 31.32], [120.63, 31.31]] },
      },
    ],
  }
  let sawOsrm = false
  const sources = createSources({
    getAmapKey: async () => 'bad-key',
    fetchImpl: async (url) => {
      if (String(url).includes('amap.com')) {
        return { ok: true, json: async () => ({ status: '0', info: 'INVALID_USER_KEY' }) }
      }
      sawOsrm = true
      return { ok: true, json: async () => osrm }
    },
  })
  const route = await sources.routeLeg(FROM, TO, 'drive')
  check('an Amap error degrades to OSRM instead of failing the leg', () => {
    assert.equal(route.provider, 'osrm')
    assert.equal(sawOsrm, true)
  })
}

/* --- settings surface ------------------------------------------------ */
{
  let stored = null
  const settings = {
    describeAmapKey: async () => ({
      configured: Boolean(stored),
      source: stored ? 'credentials' : undefined,
      writable: true,
    }),
    setAmapKey: async (value) => {
      stored = value
    },
    clearAmapKey: async () => {
      stored = null
    },
  }

  let handler = null
  registerRoutes(
    { webServer: { register: (route) => ((handler = route.handler), () => {}) } },
    { trips: {}, config: { geocoder: 'nominatim' }, sources: null, settings },
  )

  function call(method, url, body) {
    return new Promise((resolve) => {
      const req = new EventEmitter()
      req.method = method
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
          resolve({ status: this.statusCode, json: JSON.parse(text) })
        },
      }
      Promise.resolve(handler(req, res)).catch(() => {})
      setTimeout(() => {
        if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
        req.emit('end')
      }, 0)
    })
  }

  const before = await call('GET', '/roam/api/settings')
  check('settings report the keyless fallback first', () => {
    assert.equal(before.status, 200)
    assert.equal(before.json.amapKey.configured, false)
    assert.equal(before.json.routing, 'osrm')
    assert.equal(before.json.geocoding, 'nominatim')
  })

  const saved = await call('POST', '/roam/api/settings', { amapKey: 'secret-value' })
  check('saving a key flips both providers without a restart', () => {
    assert.equal(saved.status, 200)
    assert.equal(saved.json.amapKey.configured, true)
    assert.equal(saved.json.routing, 'amap')
    assert.equal(saved.json.geocoding, 'amap')
  })
  check('the response never echoes the key', () => {
    assert.ok(!JSON.stringify(saved.json).includes('secret-value'))
  })

  const empty = await call('POST', '/roam/api/settings', { amapKey: '   ' })
  check('an empty key is rejected', () => assert.equal(empty.status, 400))

  const cleared = await call('DELETE', '/roam/api/settings')
  check('removing the key restores the fallback', () => {
    assert.equal(cleared.status, 200)
    assert.equal(cleared.json.amapKey.configured, false)
    assert.equal(cleared.json.routing, 'osrm')
  })
}

console.log(failed === 0 ? '\namap checks passed' : `\n${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
