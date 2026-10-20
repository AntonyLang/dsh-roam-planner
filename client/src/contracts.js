/**
 * Shared contract for every workstream. Do not change a shape here without
 * telling the integrator: the host, the page shell and both map renderers
 * are written against it.
 *
 * Coordinate note: `crs` says which datum the lat/lng are in. The host stores
 * whatever the source returned and normalizes on write; renderers must call
 * `toDisplay()` from client/src/geo.js instead of assuming one datum.
 */

/**
 * @typedef {Object} Stop
 * @property {string} id
 * @property {string} name
 * @property {number} lat
 * @property {number} lng
 * @property {string} [start]        Wall clock, "09:30".
 * @property {number} [stayMinutes]
 * @property {string} [note]
 * @property {string} [category]     "sight" | "food" | "stay" | "transit"
 */

/**
 * @typedef {Object} Leg
 * @property {string} from           Stop id.
 * @property {string} to             Stop id.
 * @property {'walk'|'transit'|'drive'} mode
 * @property {number} [minutes]
 * @property {number[][]} [geometry] [[lat, lng], ...] already in display datum.
 */

/**
 * @typedef {Object} Day
 * @property {number} index          0-based.
 * @property {string} date           "YYYY-MM-DD".
 * @property {Stop[]} stops
 * @property {Leg[]} legs
 */

/**
 * @typedef {Object} TripView
 * @property {string} tripId
 * @property {string} title
 * @property {'WGS84'|'GCJ02'} crs
 * @property {'draft'|'candidate'|'adopted'} status
 * @property {number} revision
 * @property {Day[]} days
 * @property {string} [updatedAt]
 */

/**
 * Props every map renderer receives. Implement this exactly; the shell swaps
 * `engine` between "leaflet" and "maplibre" and nothing else changes.
 *
 * @typedef {Object} MapRendererProps
 * @property {TripView} view
 * @property {number|null} selectedDay        null = all days.
 * @property {string|null} selectedStopId
 * @property {'light'|'dark'} theme
 * @property {(stopId: string) => void} onSelectStop
 * @property {(detail: {bounds: number[][]|null}) => void} [onViewChanged]
 * @property {string} [className]
 */

/**
 * A renderer module exports one React component with these props.
 * Both implementations live at:
 *   client/src/map/leaflet/index.jsx   -> export function LeafletMap(props)
 *   client/src/map/maplibre/index.jsx  -> export function MapLibreMap(props)
 * The shell picks one; they never import each other.
 */

/** Palette shared by both renderers so the two engines compare fairly. */
export const DAY_COLORS = ['#0f766e', '#b45309', '#7c3aed', '#be123c', '#0369a1', '#4d7c0f']

/** Color for a day index, wrapping around. */
export function dayColor(index) {
  return DAY_COLORS[((index % DAY_COLORS.length) + DAY_COLORS.length) % DAY_COLORS.length]
}
