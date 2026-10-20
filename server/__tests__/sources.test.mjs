/**
 * Source adapter checks. No network: OSRM and Open-Meteo are faked.
 *
 * Run: node server/__tests__/sources.test.mjs
 */
import assert from 'node:assert/strict'
import { createSources } from '../sources.js'

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

/* --- routing --------------------------------------------------------- */
{
  let seenUrl = ''
  const sources = createSources({
    fetchImpl: async (url) => {
      seenUrl = String(url)
      return {
        ok: true,
        json: async () => ({
          code: 'Ok',
          routes: [
            {
              distance: 1972.9,
              duration: 900,
              geometry: {
                type: 'LineString',
                // OSRM answers [lng, lat]; the trip stores [lat, lng].
                coordinates: [
                  [120.6247, 31.3263],
                  [120.6297, 31.3149],
                ],
              },
            },
          ],
        }),
      }
    },
  })

  const route = await sources.routeLeg({ lat: 31.3263, lng: 120.6247 }, { lat: 31.3149, lng: 120.6297 }, 'walk')

  check('walking maps to the OSRM walking profile', () => {
    assert.ok(seenUrl.includes('/walking/'))
  })
  check('geometry is flipped to [lat, lng]', () => {
    assert.deepEqual(route.geometry[0], [31.3263, 120.6247])
  })
  check('walking time comes from distance, not the demo car timings', () => {
    // 1973 m at 80 m/min, even though the fake claims 900 s.
    assert.equal(route.minutes, 25)
    assert.equal(route.meters, 1973)
  })

  await sources.routeLeg({ lat: 31.3, lng: 120.6 }, { lat: 31.31, lng: 120.61 }, 'drive')
  check('driving uses the driving profile', () => {
    assert.ok(seenUrl.includes('/driving/'))
  })
}

/* --- implausible driving speed falls back ---------------------------- */
{
  const sources = createSources({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        code: 'Ok',
        routes: [
          {
            distance: 2000,
            duration: 30, // 240 km/h
            geometry: { coordinates: [[120.6, 31.3], [120.61, 31.31]] },
          },
        ],
      }),
    }),
  })
  const route = await sources.routeLeg({ lat: 31.3, lng: 120.6 }, { lat: 31.31, lng: 120.61 }, 'drive')
  check('an implausible drive duration falls back to 40 km/h', () => {
    assert.equal(route.minutes, 3)
  })
}

/* --- routing failure degrades to null -------------------------------- */
{
  const sources = createSources({ fetchImpl: async () => ({ ok: false, status: 503 }) })
  const route = await sources.routeLeg({ lat: 1, lng: 1 }, { lat: 2, lng: 2 }, 'drive')
  check('a provider failure returns null instead of throwing', () => assert.equal(route, null))
}

/* --- weather --------------------------------------------------------- */
{
  let seenUrl = ''
  const sources = createSources({
    fetchImpl: async (url) => {
      seenUrl = String(url)
      return {
        ok: true,
        json: async () => ({
          daily: {
            time: ['2026-10-24'],
            temperature_2m_max: [24.2],
            temperature_2m_min: [18.3],
            precipitation_probability_max: [67],
          },
        }),
      }
    },
  })
  const weather = await sources.dailyWeather(31.32, 120.62, '2026-10-24', '2026-10-24')
  check('weather parses the daily arrays', () => {
    assert.equal(weather.days[0].tMax, 24.2)
    assert.equal(weather.days[0].tMin, 18.3)
    assert.equal(weather.days[0].precip, 67)
  })
  check('weather asks for the trip dates', () => {
    assert.ok(seenUrl.includes('start_date=2026-10-24'))
  })
}

/* --- weather gaps stay null ------------------------------------------ */
{
  const sources = createSources({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        daily: {
          time: ['2030-01-01'],
          temperature_2m_max: [null],
          temperature_2m_min: [null],
          precipitation_probability_max: [null],
        },
      }),
    }),
  })
  const weather = await sources.dailyWeather(31.32, 120.62, '2030-01-01', '2030-01-01')
  check('missing values stay null, never 0', () => {
    assert.equal(weather.days[0].tMax, null)
    assert.equal(weather.days[0].precip, null)
  })
}

console.log(failed === 0 ? '\nsource checks passed' : `\n${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
