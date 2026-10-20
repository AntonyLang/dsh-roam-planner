import { BASEMAPS, normalizeBasemapList, resolveBasemap, tileUrls, DEFAULT_BASEMAP_ID } from '../../client/src/basemaps.js'
import { toBasemap, wgs84ToGcj02 } from '../../client/src/geo.js'

let failed = 0
const check = (ok, label) => { if (!ok) { failed++; console.log('FAIL ' + label) } else console.log('ok   ' + label) }

check(BASEMAPS.length === 2, 'registry has osm + amap')
check(resolveBasemap('nope').id === DEFAULT_BASEMAP_ID, 'unknown id falls back')
check(resolveBasemap('amap').crs === 'GCJ02', 'amap declares GCJ02')
check(tileUrls(resolveBasemap('amap')).length === 4, 'amap expands 4 subdomains')
check(tileUrls(resolveBasemap('osm')).every(u => u.includes('tile.openstreetmap.org')), 'osm urls expanded')
check(!tileUrls(resolveBasemap('osm'))[0].includes('{s}'), 'no {s} left')

// Deployment config replaces the built-in catalogue.
const configured = normalizeBasemapList([
  { id: 'tianditu', label: '天地图', url: 'https://t0.tianditu.gov.cn/img_w/wmts?x={x}&y={y}&z={z}', attribution: '天地图', maxZoom: 18 },
  { id: 'broken' },
  { id: 'tianditu', label: 'dup', url: 'https://example.com/{z}/{x}/{y}.png' },
])
check(configured.length === 1 && configured[0].id === 'tianditu', 'config list wins, broken and duplicate entries dropped')
check(configured[0].subdomains.join('') === 'abc', 'missing subdomains default to abc')
check(normalizeBasemapList(null) === BASEMAPS, 'no config falls back to the built-ins')
check(normalizeBasemapList([]) === BASEMAPS, 'an empty config falls back to the built-ins')
check(resolveBasemap('tianditu', configured).label === '天地图', 'resolve works against a configured list')

const ws = { lat: 31.32, lng: 120.62 }
const gcj = toBasemap(ws.lat, ws.lng, 'WGS84', 'GCJ02')
check(Math.abs(gcj.lat - wgs84ToGcj02(ws.lat, ws.lng).lat) < 1e-12, 'wgs->gcj matches forward formula')
const back = toBasemap(gcj.lat, gcj.lng, 'GCJ02', 'WGS84')
check(Math.abs(back.lat - ws.lat) < 1e-7 && Math.abs(back.lng - ws.lng) < 1e-7, 'roundtrip < 1e-7 deg')
const same = toBasemap(ws.lat, ws.lng, 'GCJ02', 'GCJ02')
check(same.lat === ws.lat && same.lng === ws.lng, 'same datum is identity')
check(Number.isNaN(toBasemap('x', 1, 'WGS84', 'GCJ02').lat), 'bad input yields NaN')

console.log(failed === 0 ? 'basemap checks passed' : failed + ' failed')
process.exit(failed === 0 ? 0 : 1)


