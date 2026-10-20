/**
 * Place name -> coordinate resolution.
 *
 * The model should never invent latitude/longitude: it names a place, the host
 * looks it up. Two providers are supported:
 *
 *   - `nominatim` (default): OpenStreetMap, no key, WGS-84, ~1 request/second.
 *   - `amap`: needs `amapKey`, returns GCJ-02, converted to WGS-84 on the way in
 *     so stored trips keep one datum.
 *
 * Chinese place names are ambiguous in OSM: "虎丘" resolves to 虎丘区 (the
 * district) before it resolves to the hill. So the resolver ranks candidates
 * (a POI beats a road, a road beats an administrative area) and, when only an
 * administrative area matched, retries a few common suffixes ("虎丘山").
 * When it still ends on an administrative area the result is marked
 * `ambiguous` instead of silently pinning a district centroid.
 */

import { gcj02ToWgs84 } from '../client/src/geo.js'

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search'
const AMAP_URL = 'https://restapi.amap.com/v3/geocode/geo'
const USER_AGENT = 'dsh-roam-planner/0.0.0 (local trip planner; geocoding on demand)'

/** Nominatim asks for at most one request per second. */
const NOMINATIM_MIN_GAP_MS = 1100

/** Tried only when the first hit was an administrative area. */
const RETRY_SUFFIXES = ['山', '公园', '景区']
const MAX_RETRY_KM = 40

function round6(value) {
  return Math.round(value * 1e6) / 1e6
}

function haversineKm(a, b) {
  const R = 6371
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLng = ((b.lng - a.lng) * Math.PI) / 180
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

function isAdministrative(hit) {
  return /administrative|boundary/.test(String(hit.type || ''))
}

function isRoad(hit) {
  return /^(motorway|trunk|primary|secondary|tertiary|residential|service|unclassified|pedestrian|footway)$/.test(
    String(hit.type || ''),
  )
}

/** Higher is better: POI > road > administrative area. */
function rank(hit) {
  if (isAdministrative(hit)) return 0
  if (isRoad(hit)) return 1
  return 2
}

/**
 * @param {any} [options]
 */
export function createGeocoder(options = {}) {
  const { config = {}, logger, fetchImpl, getAmapKey } = options || {}
  const doFetch = fetchImpl || globalThis.fetch
  const cache = new Map()
  let lastNominatim = 0

  /**
   * A key set through the settings page switches the provider at the next call,
   * without a restart. `off` always wins.
   */
  async function resolveMode() {
    if (config.geocoder === 'off') return { mode: 'off', key: null }
    let key = config.amapKey || null
    if (typeof getAmapKey === 'function') {
      try {
        const live = await getAmapKey()
        if (live) key = live
      } catch {
        /* keep the configured key when the credential store is unavailable */
      }
    }
    return { mode: key ? 'amap' : 'nominatim', key }
  }

  async function throttle() {
    const now = Date.now()
    const wait = lastNominatim + NOMINATIM_MIN_GAP_MS - now
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    lastNominatim = Date.now()
  }

  function normalizeNominatim(row) {
    const lat = Number(row?.lat)
    const lng = Number(row?.lon)
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
    return {
      lat: round6(lat),
      lng: round6(lng),
      label: typeof row.display_name === 'string' ? row.display_name : '',
      type: typeof row.type === 'string' ? row.type : '',
      provider: 'nominatim',
      ambiguous: false,
      warning: '',
    }
  }

  async function nominatimSearch(query, signal) {
    await throttle()
    const url = `${NOMINATIM_URL}?format=jsonv2&limit=5&accept-language=zh-CN&q=${encodeURIComponent(query)}`
    const response = await doFetch(url, {
      headers: { 'user-agent': USER_AGENT },
      signal: signal || AbortSignal.timeout(10000),
    })
    if (!response.ok) throw new Error(`geocoder HTTP ${response.status}`)
    const rows = await response.json()
    if (!Array.isArray(rows)) return []
    return rows.map(normalizeNominatim).filter(Boolean)
  }

  async function amapSearch(place, city, key, signal) {
    const params = new URLSearchParams({ key, address: place })
    if (city) params.set('city', city)
    const response = await doFetch(`${AMAP_URL}?${params.toString()}`, {
      signal: signal || AbortSignal.timeout(10000),
    })
    if (!response.ok) throw new Error(`geocoder HTTP ${response.status}`)
    const payload = await response.json()
    if (payload.status !== '1') throw new Error(`amap geocoder: ${payload.info || 'failed'}`)
    const row = Array.isArray(payload.geocodes) ? payload.geocodes[0] : null
    if (!row || typeof row.location !== 'string') return null
    const [lng, lat] = row.location.split(',').map(Number)
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
    // Amap answers in GCJ-02; the trip store keeps WGS-84.
    const wgs = gcj02ToWgs84(lat, lng)
    return {
      lat: round6(wgs.lat),
      lng: round6(wgs.lng),
      label: typeof row.formatted_address === 'string' ? row.formatted_address : '',
      type: 'poi',
      provider: 'amap',
      ambiguous: false,
      warning: '',
    }
  }

  async function resolveNominatim(place, city, signal) {
    const withCity = city ? `${place}, ${city}` : place
    const hits = await nominatimSearch(withCity, signal)
    if (hits.length === 0) return null
    hits.sort((a, b) => rank(b) - rank(a))
    let hit = hits[0]
    if (!isAdministrative(hit)) return hit

    // Only an administrative area matched: try a more specific name nearby.
    const district = hit
    for (const suffix of RETRY_SUFFIXES) {
      const candidates = await nominatimSearch(city ? `${place}${suffix}, ${city}` : `${place}${suffix}`, signal)
      const better = candidates
        .filter((candidate) => !isAdministrative(candidate) && !isRoad(candidate))
        .sort((a, b) => haversineKm(district, a) - haversineKm(district, b))[0]
      if (better && haversineKm(district, better) <= MAX_RETRY_KM) return better
    }

    hit = {
      ...district,
      ambiguous: true,
      warning: `matched the administrative area "${String(district.label).split(',')[0]}"; use a more specific name`,
    }
    return hit
  }

  /**
   * @param {string} name Place name, e.g. "平江路".
   * @param {{city?: string, signal?: AbortSignal}} [options]
   * @returns {Promise<{lat: number, lng: number, label: string, type: string, provider: string, ambiguous: boolean, warning: string} | null>}
   */
  async function geocode(name, { city, signal } = {}) {
    const place = String(name || '').trim()
    if (!place) return null
    const { mode, key } = await resolveMode()
    if (mode === 'off') return null
    const cacheKey = `${mode}|${city || ''}|${place}`
    if (cache.has(cacheKey)) return cache.get(cacheKey)

    let hit
    try {
      hit =
        mode === 'amap'
          ? await amapSearch(place, city, key, signal)
          : await resolveNominatim(place, city, signal)
    } catch (error) {
      logger?.warn?.(`dsh-roam-planner: geocode "${place}" failed: ${error?.message || error}`)
      throw error
    }
    if (hit) {
      if (hit.ambiguous) logger?.warn?.(`dsh-roam-planner: geocode "${place}" is ambiguous: ${hit.warning}`)
      cache.set(cacheKey, hit)
    }
    return hit
  }

  return { geocode, resolveMode }
}



