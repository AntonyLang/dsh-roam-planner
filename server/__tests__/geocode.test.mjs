/**
 * Geocoder unit checks. No network: the provider is a fake fetch.
 *
 * Run: node server/__tests__/geocode.test.mjs
 */
import assert from 'node:assert/strict'
import { createGeocoder } from '../geocode.js'
import { gcj02ToWgs84 } from '../../client/src/geo.js'

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

/* --- nominatim ------------------------------------------------------- */
{
  let calls = 0
  let lastUrl = ''
  const fakeFetch = async (url) => {
    calls += 1
    lastUrl = String(url)
    return {
      ok: true,
      json: async () => [{ lat: '31.3149294', lon: '120.6296912', display_name: '平江路, 苏州' }],
    }
  }
  const geocoder = createGeocoder({ config: {}, fetchImpl: fakeFetch })

  const hit = await geocoder.geocode('平江路', { city: '苏州' })
  check('nominatim returns coordinates', () => {
    assert.ok(hit)
    assert.equal(hit.lat, 31.314929)
    assert.equal(hit.lng, 120.629691)
    assert.equal(hit.provider, 'nominatim')
  })
  check('nominatim query carries the city', () => {
    assert.ok(lastUrl.includes('nominatim.openstreetmap.org'))
    assert.ok(decodeURIComponent(lastUrl).includes('平江路, 苏州'))
  })

  const before = calls
  await geocoder.geocode('平江路', { city: '苏州' })
  check('repeated query is cached', () => {
    assert.equal(calls, before)
  })
}

/* --- not found ------------------------------------------------------- */
{
  const geocoder = createGeocoder({
    config: {},
    fetchImpl: async () => ({ ok: true, json: async () => [] }),
  })
  const hit = await geocoder.geocode('不存在的地方')
  check('a miss returns null', () => assert.equal(hit, null))
}

/* --- amap converts GCJ-02 back to WGS-84 ------------------------------ */
{
  const gcjLat = 31.317
  const gcjLng = 120.638
  let seen = ''
  const geocoder = createGeocoder({
    config: { geocoder: 'amap', amapKey: 'demo-key' },
    fetchImpl: async (url) => {
      seen = String(url)
      return {
        ok: true,
        json: async () => ({
          status: '1',
          geocodes: [{ location: `${gcjLng},${gcjLat}`, formatted_address: '拙政园' }],
        }),
      }
    },
  })
  const hit = await geocoder.geocode('拙政园', { city: '苏州' })
  check('amap is used when a key is configured', () => {
    assert.ok(seen.includes('restapi.amap.com'))
    assert.ok(seen.includes('key=demo-key'))
    assert.equal(hit.provider, 'amap')
  })
  check('amap result is converted to WGS-84', () => {
    const expected = gcj02ToWgs84(gcjLat, gcjLng)
    assert.ok(Math.abs(hit.lat - expected.lat) < 1e-6)
    assert.ok(Math.abs(hit.lng - expected.lng) < 1e-6)
    assert.ok(Math.abs(hit.lat - gcjLat) > 0, 'the datum shift is actually applied')
  })
}

/* --- disabled -------------------------------------------------------- */
{
  let touched = false
  const geocoder = createGeocoder({
    config: { geocoder: 'off' },
    fetchImpl: async () => {
      touched = true
      return { ok: true, json: async () => [] }
    },
  })
  const hit = await geocoder.geocode('平江路', { city: '苏州' })
  check('off mode never calls the provider', () => {
    assert.equal(hit, null)
    assert.equal(touched, false)
  })
}

/* --- an administrative match retries a suffix ------------------------ */
{
  const rows = (list) => ({ ok: true, json: async () => list })
  const fakeFetch = async (url) => {
    const query = decodeURIComponent(String(url))
    if (query.includes('虎丘山')) {
      return rows([{ lat: '31.3377673', lon: '120.5762174', type: 'peak', display_name: '虎丘山, 苏州' }])
    }
    return rows([{ lat: '31.3312820', lon: '120.4290851', type: 'administrative', display_name: '虎丘区, 苏州市' }])
  }
  const geocoder = createGeocoder({ config: {}, fetchImpl: fakeFetch })
  const hit = await geocoder.geocode('虎丘', { city: '苏州' })
  check('a district match is replaced by the nearby POI', () => {
    assert.equal(hit.type, 'peak')
    assert.ok(Math.abs(hit.lat - 31.337767) < 1e-4)
    assert.equal(hit.ambiguous, false)
  })
}

/* --- a district-only match is marked ambiguous ----------------------- */
{
  const fakeFetch = async () => ({
    ok: true,
    json: async () => [{ lat: '31.3312820', lon: '120.4290851', type: 'administrative', display_name: '虎丘区, 苏州市' }],
  })
  const geocoder = createGeocoder({ config: {}, fetchImpl: fakeFetch })
  const hit = await geocoder.geocode('某新区', { city: '苏州' })
  check('a district-only match is flagged, not silently accepted', () => {
    assert.equal(hit.ambiguous, true)
    assert.ok(hit.warning.includes('administrative'))
  })
}

console.log(failed === 0 ? '\ngeocode checks passed' : `\n${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
