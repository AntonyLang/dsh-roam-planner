/**
 * External sources for the trip: road geometry and daily weather.
 *
 * Both providers are keyless and free, which keeps the plugin usable straight
 * after install:
 *   - OSRM public demo for routes (walking / driving; transit falls back to the
 *     driving profile because the demo has no transit graph);
 *   - Open-Meteo for the daily forecast.
 *
 * Every call is best-effort: a provider failure returns null and the caller
 * keeps its previous value (usually the straight dashed line). Results are
 * cached per process for repeated plans.
 */

const OSRM_URL = 'https://router.project-osrm.org/route/v1'
const AMAP_DIRECTION_URL = 'https://restapi.amap.com/v3/direction'
const AMAP_PLACE_URL = 'https://restapi.amap.com/v3/place/text'
const METEO_URL = 'https://api.open-meteo.com/v1/forecast'
const USER_AGENT = 'dsh-roam-planner/0.0.0 (local trip planner)'

import { wgs84ToGcj02, gcj02ToWgs84 } from '../client/src/geo.js'

const MODE_PROFILE = { walk: 'walking', drive: 'driving', transit: 'driving' }

/**
 * The public OSRM demo answers the `walking` profile with car timings (a 2 km
 * walk came back as 3 minutes). Rather than publish nonsense, walking time is
 * derived from distance at 4.8 km/h, and driving/transit durations are kept
 * only when the implied speed is plausible; otherwise they fall back too.
 */
const WALK_METRES_PER_MINUTE = 80
const PLAUSIBLE_KMH = { drive: [8, 130], transit: [8, 80] }

function estimateMinutes(meters, seconds, mode) {
  if (!Number.isFinite(meters) || meters <= 0) return 1
  if (mode === 'walk') return Math.max(1, Math.round(meters / WALK_METRES_PER_MINUTE))
  const speed = Number.isFinite(seconds) && seconds > 0 ? (meters / seconds) * 3.6 : NaN
  const [low, high] = PLAUSIBLE_KMH[mode] || PLAUSIBLE_KMH.drive
  if (Number.isFinite(speed) && speed >= low && speed <= high) {
    return Math.max(1, Math.round(seconds / 60))
  }
  const fallbackKmh = mode === 'transit' ? 25 : 40
  return Math.max(1, Math.round((meters / 1000 / fallbackKmh) * 60))
}

function round6(value) {
  return Math.round(value * 1e6) / 1e6
}

/**
 * Amap polylines are GCJ-02 "lng,lat;lng,lat" strings; the trip store keeps
 * WGS-84, so every point is converted on the way in.
 */
function pointsFromPolylines(polylines) {
  const points = []
  for (const polyline of polylines) {
    for (const pair of String(polyline || '').split(';')) {
      const [lng, lat] = pair.split(',').map(Number)
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue
      const wgs = gcj02ToWgs84(lat, lng)
      points.push([round6(wgs.lat), round6(wgs.lng)])
    }
  }
  return points
}

/**
 * @param {any} [options]
 */
export function createSources(options = {}) {
  const { fetchImpl, logger, getAmapKey, defaultCity } = options || {}
  const doFetch = fetchImpl || globalThis.fetch
  const routeCache = new Map()
  const weatherCache = new Map()
  const placeCache = new Map()
  const city = typeof defaultCity === 'string' && defaultCity.trim() !== '' ? defaultCity.trim() : null

  /**
   * Amap directions. The API speaks GCJ-02 in both directions, while the trip
   * store keeps WGS-84, so the request points are converted in and the returned
   * polyline is converted back.
   */
  async function amapRoute(from, to, mode, key) {
    const endpoint = mode === 'walk' ? 'walking' : 'driving'
    const origin = wgs84ToGcj02(from.lat, from.lng)
    const destination = wgs84ToGcj02(to.lat, to.lng)
    const params = new URLSearchParams({
      key,
      origin: `${origin.lng},${origin.lat}`,
      destination: `${destination.lng},${destination.lat}`,
    })
    const response = await doFetch(`${AMAP_DIRECTION_URL}/${endpoint}?${params.toString()}`, {
      signal: AbortSignal.timeout(12000),
    })
    if (!response.ok) throw new Error(`amap route HTTP ${response.status}`)
    const payload = await response.json()
    if (payload.status !== '1') throw new Error(`amap route: ${payload.info || 'failed'}`)
    const path = payload.route?.paths?.[0]
    if (!path) return null

    const geometry = pointsFromPolylines((path.steps || []).map((step) => step.polyline))
    if (geometry.length < 2) return null

    const meters = Number(path.distance) || 0
    return {
      geometry,
      meters: Math.round(meters),
      minutes: estimateMinutes(meters, Number(path.duration) || 0, mode),
      provider: 'amap',
    }
  }

  /**
   * Amap transit. The endpoint needs the origin city, which we take from the
   * deployment default; without one this returns null and the caller falls back
   * to OSRM.
   */
  async function amapTransitRoute(from, to, key, city) {
    if (!city) return null
    const origin = wgs84ToGcj02(from.lat, from.lng)
    const destination = wgs84ToGcj02(to.lat, to.lng)
    const params = new URLSearchParams({
      key,
      city,
      origin: `${origin.lng},${origin.lat}`,
      destination: `${destination.lng},${destination.lat}`,
    })
    const response = await doFetch(`${AMAP_DIRECTION_URL}/transit/integrated?${params.toString()}`, {
      signal: AbortSignal.timeout(12000),
    })
    if (!response.ok) throw new Error(`amap transit HTTP ${response.status}`)
    const payload = await response.json()
    if (payload.status !== '1') throw new Error(`amap transit: ${payload.info || 'failed'}`)
    const transit = payload.route?.transits?.[0]
    if (!transit) return null

    const polylines = []
    for (const segment of transit.segments || []) {
      for (const step of segment.walking?.steps || []) polylines.push(step.polyline)
      for (const line of segment.bus?.buslines || []) polylines.push(line.polyline)
    }
    const geometry = pointsFromPolylines(polylines)
    if (geometry.length < 2) return null

    const meters = Number(transit.distance) || 0
    return {
      geometry,
      meters: Math.round(meters),
      minutes: estimateMinutes(meters, Number(transit.duration) || 0, 'transit'),
      provider: 'amap',
    }
  }

  /** Amap POI text search: the first step of "what is worth visiting here". */
  /**
   * @param {any} [options]
   */
  async function searchPlaces({ keywords, city, limit = 8 } = {}) {
    const query = String(keywords || '').trim()
    if (!query) return null
    let key = null
    if (typeof getAmapKey === 'function') {
      try {
        key = await getAmapKey()
      } catch {
        key = null
      }
    }
    if (!key) return null
    const cacheKey = `poi|${city || ''}|${query}|${limit}`
    if (placeCache.has(cacheKey)) return placeCache.get(cacheKey)

    const params = new URLSearchParams({
      key,
      keywords: query,
      offset: String(Math.min(20, Math.max(1, Number(limit) || 8))),
      page: '1',
      extensions: 'base',
    })
    if (city) params.set('city', city)
    const response = await doFetch(`${AMAP_PLACE_URL}?${params.toString()}`, {
      signal: AbortSignal.timeout(12000),
    })
    if (!response.ok) throw new Error(`amap place HTTP ${response.status}`)
    const payload = await response.json()
    if (payload.status !== '1') throw new Error(`amap place: ${payload.info || 'failed'}`)

    const places = []
    for (const poi of payload.pois || []) {
      const [lng, lat] = String(poi.location || '').split(',').map(Number)
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue
      const wgs = gcj02ToWgs84(lat, lng)
      places.push({
        name: String(poi.name || ''),
        address: Array.isArray(poi.address) ? '' : String(poi.address || ''),
        type: Array.isArray(poi.type) ? '' : String(poi.type || ''),
        lat: round6(wgs.lat),
        lng: round6(wgs.lng),
      })
    }
    placeCache.set(cacheKey, places)
    return places
  }

  /**
   * @param {{lat: number, lng: number}} from
   * @param {{lat: number, lng: number}} to
   * @param {'walk'|'drive'|'transit'} mode
   * @returns {Promise<{geometry: number[][], meters: number, minutes: number, provider: string} | null>}
   */
  async function routeLeg(from, to, mode) {
    const profile = MODE_PROFILE[mode] || 'driving'
    const cacheKey = `${profile}|${from.lat.toFixed(5)},${from.lng.toFixed(5)}|${to.lat.toFixed(5)},${to.lng.toFixed(5)}`
    if (routeCache.has(cacheKey)) return routeCache.get(cacheKey)

    // A configured Amap key wins; the demo OSRM stays the fallback so the
    // plugin keeps working without one.
    let amapKey = null
    if (typeof getAmapKey === 'function') {
      try {
        amapKey = await getAmapKey()
      } catch {
        amapKey = null
      }
    }
    if (amapKey) {
      try {
        const amap =
          mode === 'transit'
            ? await amapTransitRoute(from, to, amapKey, city)
            : await amapRoute(from, to, mode, amapKey)
        if (amap) {
          routeCache.set(cacheKey, amap)
          return amap
        }
      } catch (error) {
        logger?.warn?.(`dsh-roam-planner: amap route failed, falling back to OSRM: ${error?.message || error}`)
      }
    }

    const url = `${OSRM_URL}/${profile}/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`
    let payload
    try {
      const response = await doFetch(url, {
        headers: { 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(12000),
      })
      if (!response.ok) throw new Error(`route HTTP ${response.status}`)
      payload = await response.json()
    } catch (error) {
      logger?.warn?.(`dsh-roam-planner: route failed: ${error?.message || error}`)
      return null
    }
    if (payload?.code !== 'Ok' || !Array.isArray(payload.routes) || !payload.routes[0]) return null

    const route = payload.routes[0]
    const coordinates = Array.isArray(route.geometry?.coordinates) ? route.geometry.coordinates : []
    const geometry = coordinates
      .filter((pair) => Array.isArray(pair) && pair.length >= 2)
      .map(([lng, lat]) => [round6(lat), round6(lng)])
    if (geometry.length < 2) return null

    const result = {
      geometry,
      meters: Math.round(Number(route.distance) || 0),
      minutes: estimateMinutes(Number(route.distance) || 0, Number(route.duration) || 0, mode),
      provider: 'osrm',
    }
    routeCache.set(cacheKey, result)
    return result
  }

  /**
   * Daily forecast for one point. Missing values stay null so the page can show
   * a dash instead of a fake zero.
   *
   * @returns {Promise<{provider: string, days: Array<{date: string, tMax: number|null, tMin: number|null, precip: number|null}>} | null>}
   */
  async function dailyWeather(lat, lng, startDate, endDate) {
    const key = `${round6(lat)},${round6(lng)}|${startDate}|${endDate}`
    if (weatherCache.has(key)) return weatherCache.get(key)

    const params = new URLSearchParams({
      latitude: String(round6(lat)),
      longitude: String(round6(lng)),
      daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max',
      timezone: 'auto',
    })
    if (startDate) params.set('start_date', startDate)
    if (endDate) params.set('end_date', endDate)

    let payload
    try {
      const response = await doFetch(`${METEO_URL}?${params.toString()}`, {
        headers: { 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(12000),
      })
      if (!response.ok) throw new Error(`weather HTTP ${response.status}`)
      payload = await response.json()
    } catch (error) {
      logger?.warn?.(`dsh-roam-planner: weather failed: ${error?.message || error}`)
      return null
    }

    const daily = payload?.daily
    if (!daily || !Array.isArray(daily.time)) return null
    const pick = (values, index) => {
      const value = Array.isArray(values) ? values[index] : null
      return typeof value === 'number' && Number.isFinite(value) ? value : null
    }
    const days = daily.time.map((date, index) => ({
      date: String(date),
      tMax: pick(daily.temperature_2m_max, index),
      tMin: pick(daily.temperature_2m_min, index),
      precip: pick(daily.precipitation_probability_max, index),
    }))
    const result = { provider: 'open-meteo', days }
    weatherCache.set(key, result)
    return result
  }

  return { routeLeg, dailyWeather, searchPlaces }
}




