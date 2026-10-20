/**
 * Basemap registry shared by both map renderers.
 *
 * One descriptor drives either engine:
 *   - Leaflet      uses `url` + `subdomains` + `attribution` + `maxZoom`
 *   - MapLibre     builds a raster style from the same fields
 *
 * `crs` is the datum the tiles are drawn in, which is NOT necessarily the
 * datum stored in the trip. `geo.js#toBasemap` converts between them; a GCJ-02
 * provider plotted with WGS-84 points would be off by up to ~700 m.
 *
 * `preDark` marks a basemap that is already dark, so the renderers must not
 * apply their additional darkening filter on top of it.
 *
 * Adding a provider: append an entry. Requirements are a `{z}/{x}/{y}` template
 * (plus `{s}` when it has subdomains), the attribution the provider requires,
 * and the datum. Do not ship a keyed provider as the default.
 */

export const BASEMAPS = [
  {
    id: 'osm',
    label: 'OpenStreetMap',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    subdomains: ['a', 'b', 'c'],
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
    crs: 'WGS84',
  },
  {
    id: 'amap',
    label: '高德地图',
    url: 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
    subdomains: ['1', '2', '3', '4'],
    attribution: '&copy; <a href="https://www.amap.com/">高德地图</a>',
    maxZoom: 18,
    crs: 'GCJ02',
    note: 'Tiles are GCJ-02; stop coordinates are converted for display.',
  },
]

export const DEFAULT_BASEMAP_ID = 'osm'

/**
 * Accept the host's `basemaps` config and drop anything unusable.
 *
 * The built-in list is only the fallback: a deployment adds Tianditu, MapTiler
 * or an internal tile server by editing `cordis.patch.yml`, without touching
 * this file. An entry needs `id` + `url` + `attribution`; everything else has a
 * default. A malformed entry is skipped rather than breaking the map.
 *
 * @param {unknown} input
 * @returns {typeof BASEMAPS}
 */
export function normalizeBasemapList(input) {
  if (!Array.isArray(input)) return BASEMAPS
  const entries = []
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue
    const id = typeof raw.id === 'string' ? raw.id.trim() : ''
    const url = typeof raw.url === 'string' ? raw.url.trim() : ''
    if (!id || !url) continue
    if (entries.some((entry) => entry.id === id)) continue
    entries.push({
      id,
      label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : id,
      url,
      subdomains:
        Array.isArray(raw.subdomains) && raw.subdomains.length > 0
          ? raw.subdomains.map((value) => String(value))
          : ['a', 'b', 'c'],
      attribution: typeof raw.attribution === 'string' ? raw.attribution : '',
      maxZoom: Number.isFinite(raw.maxZoom) ? raw.maxZoom : 19,
      crs: String(raw.crs || 'WGS84').toUpperCase() === 'GCJ02' ? 'GCJ02' : 'WGS84',
      preDark: raw.preDark === true,
      note: typeof raw.note === 'string' ? raw.note : '',
    })
  }
  return entries.length > 0 ? entries : BASEMAPS
}

/** Look up a descriptor, falling back to the first entry instead of throwing. */
export function resolveBasemap(id, list = BASEMAPS) {
  const key = typeof id === 'string' ? id.trim() : ''
  const entries = Array.isArray(list) && list.length > 0 ? list : BASEMAPS
  return entries.find((entry) => entry.id === key) || entries[0]
}

/** Expand `{s}` subdomains into concrete tile URLs (MapLibre wants an array). */
export function tileUrls(basemap) {
  const entry = basemap || BASEMAPS[0]
  const template = String(entry.url || '')
  const subs = Array.isArray(entry.subdomains) && entry.subdomains.length > 0 ? entry.subdomains : ['']
  return subs.map((sub) => template.split('{s}').join(sub))
}
