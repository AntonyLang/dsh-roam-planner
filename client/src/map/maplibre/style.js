/**
 * Style construction for the MapLibre renderer. Pure functions only, so the
 * style can be validated against the MapLibre style specification in Node.
 *
 * Basemap: a raster style object built from OpenStreetMap tiles. No API key, no
 * account, no glyph server. The dark variant is the same tiles with raster paint
 * (saturation / contrast / brightness), which leaves the stop and leg colours
 * untouched — the fairest possible comparison with a Leaflet raster renderer.
 */

import { DAY_COLORS } from '../../contracts.js'
import { DEFAULT_BASEMAP_ID, resolveBasemap, tileUrls } from '../../basemaps.js'

export const SRC_STOPS = 'roam-stops'
export const SRC_LEGS = 'roam-legs'
export const LYR_BG = 'roam-basemap-background'
export const LYR_BASE = 'roam-basemap-raster'
export const LYR_LEGS = 'roam-legs-line'
export const LYR_LEGS_DASHED = 'roam-legs-dashed'
export const LYR_STOPS = 'roam-stops-circle'
export const LYR_STOPS_SELECTED = 'roam-stops-selected'

/** Keyless OSM raster tiles. Demo use; attribution stays on the map. */
export const OSM_TILES = [
  'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
  'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png',
  'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png',
]

export const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors'

export const DARK_BG = '#0b1220'
export const LIGHT_BG = '#e9eef3'

const LIGHT_RASTER_PAINT = {
  'raster-saturation': 0,
  'raster-contrast': 0,
  'raster-brightness-min': 0,
  'raster-brightness-max': 1,
}

const DARK_RASTER_PAINT = {
  'raster-saturation': -0.82,
  'raster-contrast': 0.12,
  'raster-brightness-min': 0.02,
  'raster-brightness-max': 0.44,
}

export function isDarkTheme(theme) {
  return theme === 'dark'
}

export function backgroundColor(theme) {
  return isDarkTheme(theme) ? DARK_BG : LIGHT_BG
}

/** Raster paint used to derive the dark (or light) basemap. */
export function rasterPaint(theme) {
  return Object.assign({}, isDarkTheme(theme) ? DARK_RASTER_PAINT : LIGHT_RASTER_PAINT)
}

/** Raster style built from a basemap descriptor (see client/src/basemaps.js). */
export function rasterStyleFromBasemap(basemap, theme) {
  const dark = isDarkTheme(theme)
  const preDark = Boolean(basemap && basemap.preDark)
  const label = basemap && basemap.label ? basemap.label : 'Roam basemap'
  return {
    version: 8,
    name: `${label} raster`,
    sources: {
      'roam-basemap': {
        type: 'raster',
        tiles: tileUrls(basemap),
        tileSize: 256,
        minzoom: 0,
        maxzoom: (basemap && basemap.maxZoom) || 19,
        attribution: (basemap && basemap.attribution) || '',
      },
    },
    layers: [
      {
        id: LYR_BG,
        type: 'background',
        paint: { 'background-color': backgroundColor(theme) },
      },
      {
        id: LYR_BASE,
        type: 'raster',
        source: 'roam-basemap',
        // An already-dark provider must not be darkened twice.
        paint: dark && !preDark ? rasterPaint(theme) : Object.assign({}, LIGHT_RASTER_PAINT),
      },
    ],
  }
}

/** Default keyless OSM raster style. */
export function baseStyle(theme, basemap) {
  return rasterStyleFromBasemap(basemap || resolveBasemap(DEFAULT_BASEMAP_ID), theme)
}

/** A custom style wins over the basemap raster style. */
export function resolveStyle(props, theme) {
  if (props && props.mapStyle && typeof props.mapStyle === 'object') return props.mapStyle
  if (props && typeof props.styleUrl === 'string' && props.styleUrl) return props.styleUrl
  return baseStyle(theme, props && props.basemap)
}

/** Identity of the active style so prop changes can be detected. */
export function styleKeyOf(props) {
  if (props && props.mapStyle && typeof props.mapStyle === 'object') {
    try {
      return 'inline:' + JSON.stringify(props.mapStyle)
    } catch (_err) {
      return 'inline:unserializable'
    }
  }
  if (props && typeof props.styleUrl === 'string' && props.styleUrl) return 'url:' + props.styleUrl
  const id = (props && props.basemap && props.basemap.id) || DEFAULT_BASEMAP_ID
  return 'basemap:' + id
}

/** `['match', ['get', 'dayIndex'], 0, color0, ..., fallback]` */
export function dayColorExpression() {
  const expression = ['match', ['get', 'dayIndex']]
  DAY_COLORS.forEach((color, index) => {
    expression.push(index, color)
  })
  expression.push(DAY_COLORS[0])
  return expression
}

/**
 * Circle radius by zoom. A zoom `interpolate` may appear only once in an
 * expression, so the selection is a separate filtered layer rather than a
 * `case` around this one.
 */
export function radiusExpression() {
  return ['interpolate', ['linear'], ['zoom'], 3, 3, 6, 4.5, 10, 7, 14, 10, 18, 14]
}

/** Filter selecting exactly one stop; an empty id matches nothing. */
export function selectionFilter(selectedStopId) {
  return ['==', ['get', 'stopId'], selectedStopId == null ? '' : String(selectedStopId)]
}

export function legsLayer() {
  return {
    id: LYR_LEGS,
    type: 'line',
    source: SRC_LEGS,
    filter: ['!=', ['get', 'dashed'], true],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': dayColorExpression(),
      'line-width': ['interpolate', ['linear'], ['zoom'], 5, 1.2, 10, 2.4, 15, 4],
      'line-opacity': 0.72,
    },
  }
}

/**
 * Legs without provider geometry: intercity hops and straight-line fallbacks.
 * Dashed so nobody mistakes them for a real road.
 */
export function legsDashedLayer() {
  return {
    id: LYR_LEGS_DASHED,
    type: 'line',
    source: SRC_LEGS,
    filter: ['==', ['get', 'dashed'], true],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': dayColorExpression(),
      'line-width': ['interpolate', ['linear'], ['zoom'], 5, 1, 10, 1.8, 15, 2.6],
      'line-opacity': 0.55,
      'line-dasharray': [2, 2],
    },
  }
}

export function stopsLayer() {
  return {
    id: LYR_STOPS,
    type: 'circle',
    source: SRC_STOPS,
    paint: {
      'circle-radius': radiusExpression(),
      'circle-color': dayColorExpression(),
      'circle-opacity': 0.96,
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 1.5,
      'circle-stroke-opacity': 0.95,
    },
  }
}

/**
 * Enlarged copy of the selected stop, driven by a filter instead of paint, so
 * the base radius expression stays zoom-only.
 */
export function selectedStopLayer(selectedStopId) {
  return {
    id: LYR_STOPS_SELECTED,
    type: 'circle',
    source: SRC_STOPS,
    filter: selectionFilter(selectedStopId),
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 5.5, 6, 8, 10, 12, 14, 17, 18, 24],
      'circle-color': dayColorExpression(),
      'circle-opacity': 0.98,
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 2.5,
      'circle-stroke-opacity': 1,
    },
  }
}

/** Layers added on top of the basemap, bottom to top. */
export function overlayLayers(selectedStopId) {
  return [legsLayer(), legsDashedLayer(), stopsLayer(), selectedStopLayer(selectedStopId)]
}

/** Filter for one day (or everything). */
export function dayFilter(selectedDay) {
  return selectedDay == null ? null : ['==', ['get', 'dayIndex'], Number(selectedDay)]
}


