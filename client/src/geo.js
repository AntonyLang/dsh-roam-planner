/**
 * Shared datum helpers.
 *
 * `Stop.lat` / `Stop.lng` arrive in the datum named by `TripView.crs`, while the
 * default basemap (OpenStreetMap raster tiles) is WGS-84. GCJ-02 points plotted
 * raw on a WGS-84 basemap are offset by up to ~700 m in China, so they are
 * converted once, here, for every renderer.
 *
 * The GCJ-02 pair below is the public, published algorithm, independently
 * written for this project (see PROVENANCE.md).
 */

const A = 6378245.0
const EE = 0.00669342162296594323
const PI = Math.PI

/** Roughly mainland China; outside it the two datums coincide. */
function outOfChina(lat, lng) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271
}

function transformLat(x, y) {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x))
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0
  ret += ((20.0 * Math.sin(y * PI) + 40.0 * Math.sin((y / 3.0) * PI)) * 2.0) / 3.0
  ret += ((160.0 * Math.sin((y / 12.0) * PI) + 320.0 * Math.sin((y * PI) / 30.0)) * 2.0) / 3.0
  return ret
}

function transformLng(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x))
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0
  ret += ((20.0 * Math.sin(x * PI) + 40.0 * Math.sin((x / 3.0) * PI)) * 2.0) / 3.0
  ret += ((150.0 * Math.sin((x / 12.0) * PI) + 300.0 * Math.sin((x / 30.0) * PI)) * 2.0) / 3.0
  return ret
}

/** WGS-84 -> GCJ-02, public forward formula. */
export function wgs84ToGcj02(lat, lng) {
  if (outOfChina(lat, lng)) return { lat, lng }
  let dLat = transformLat(lng - 105.0, lat - 35.0)
  let dLng = transformLng(lng - 105.0, lat - 35.0)
  const radLat = (lat / 180.0) * PI
  let magic = Math.sin(radLat)
  magic = 1 - EE * magic * magic
  const sqrtMagic = Math.sqrt(magic)
  dLat = (dLat * 180.0) / (((A * (1 - EE)) / (magic * sqrtMagic)) * PI)
  dLng = (dLng * 180.0) / ((A / sqrtMagic) * Math.cos(radLat) * PI)
  return { lat: lat + dLat, lng: lng + dLng }
}

/**
 * GCJ-02 -> WGS-84 by inverting the forward formula iteratively. Five passes
 * converge well below a centimetre.
 */
export function gcj02ToWgs84(lat, lng) {
  if (outOfChina(lat, lng)) return { lat, lng }
  let wgsLat = lat
  let wgsLng = lng
  for (let i = 0; i < 6; i += 1) {
    const forward = wgs84ToGcj02(wgsLat, wgsLng)
    const dLat = forward.lat - lat
    const dLng = forward.lng - lng
    wgsLat -= dLat
    wgsLng -= dLng
    if (Math.abs(dLat) < 1e-10 && Math.abs(dLng) < 1e-10) break
  }
  return { lat: wgsLat, lng: wgsLng }
}

/**
 * Convert a stored coordinate to the datum the basemap uses.
 *
 * @param {number} lat
 * @param {number} lng
 * @param {'WGS84'|'GCJ02'|undefined|null} crs
 * @returns {{lat: number, lng: number}}
 */
export function toDisplay(lat, lng, crs) {
  const la = Number(lat)
  const ln = Number(lng)
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return { lat: NaN, lng: NaN }
  // Clamp to the Web Mercator limit so a bad row cannot poison the whole fit.
  const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, la))
  const clampedLng = Math.max(-180, Math.min(180, ln))
  if (String(crs || '').toUpperCase() === 'GCJ02') {
    return gcj02ToWgs84(clampedLat, clampedLng)
  }
  return { lat: clampedLat, lng: clampedLng }
}

function normalizeCrs(value) {
  return String(value || 'WGS84').toUpperCase() === 'GCJ02' ? 'GCJ02' : 'WGS84'
}

/**
 * Convert a stored coordinate into the datum a specific basemap draws in.
 *
 * `toDisplay()` assumes a WGS-84 basemap. A GCJ-02 provider (Amap and friends)
 * needs the opposite direction, or the whole trip sits ~700 m off.
 *
 * @param {number} lat
 * @param {number} lng
 * @param {'WGS84'|'GCJ02'|undefined|null} tripCrs    Datum of the stored point.
 * @param {'WGS84'|'GCJ02'|undefined|null} basemapCrs Datum the tiles use.
 * @returns {{lat: number, lng: number}}
 */
export function toBasemap(lat, lng, tripCrs, basemapCrs) {
  const la = Number(lat)
  const ln = Number(lng)
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return { lat: NaN, lng: NaN }
  const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, la))
  const clampedLng = Math.max(-180, Math.min(180, ln))
  const from = normalizeCrs(tripCrs)
  const to = normalizeCrs(basemapCrs)
  if (from === to) return { lat: clampedLat, lng: clampedLng }
  return to === 'GCJ02'
    ? wgs84ToGcj02(clampedLat, clampedLng)
    : gcj02ToWgs84(clampedLat, clampedLng)
}
