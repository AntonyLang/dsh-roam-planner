/**
 * Pure GeoJSON builders for the MapLibre renderer. Kept free of MapLibre and
 * React imports so they can be unit-checked in plain Node.
 */

import { toBasemap } from '../../geo.js'

export const EMPTY_COLLECTION = { type: 'FeatureCollection', features: [] }

/**
 * Build the two GeoJSON sources from a TripView.
 *
 * Stop coordinates are converted from the trip datum to the datum the basemap
 * draws in (`toBasemap`), which matters for GCJ-02 providers. Leg geometry is
 * stored in the trip datum too, so it is converted when the two datums differ;
 * a missing or degenerate leg falls back to a straight two-point line.
 *
 * @param {object|null|undefined} view TripView
 * @param {'WGS84'|'GCJ02'|undefined|null} [basemapCrs] Datum the tiles use.
 * @returns {{stops: object, legs: object, overlayPoints: Array<{coordinates: number[], dayIndex: number, stopId: string, label: string}>}}
 */
export function buildGeometry(view, basemapCrs) {
  const days = view && Array.isArray(view.days) ? view.days : []
  const crs = view ? view.crs : 'WGS84'
  const stopFeatures = []
  const legFeatures = []
  const overlayPoints = []
  const stopsById = new Map()

  days.forEach((day, order) => {
    if (!day) return
    const dayIndex = Number.isFinite(day.index) ? day.index : order
    const stops = Array.isArray(day.stops) ? day.stops : []
    // Markers are numbered by their order *within the day*; the day itself is
    // carried by the colour. Numbering by day made every stop of day one read
    // "1".
    let sequence = 0
    stops.forEach((stop) => {
      if (!stop || stop.id == null) return
      const point = toBasemap(stop.lat, stop.lng, crs, basemapCrs)
      if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return
      sequence += 1
      const stopId = String(stop.id)
      if (!stopsById.has(stopId)) stopsById.set(stopId, point)
      const coordinates = [point.lng, point.lat]
      stopFeatures.push({
        type: 'Feature',
        id: stopId,
        geometry: { type: 'Point', coordinates },
        properties: {
          dayIndex,
          stopId,
          label: String(sequence),
          seq: sequence,
          name: stop.name || '',
          start: stop.start || '',
          category: stop.category || '',
        },
      })
      overlayPoints.push({ coordinates, dayIndex, stopId, label: String(sequence), seq: sequence })
    })
  })

  days.forEach((day, order) => {
    if (!day) return
    const dayIndex = Number.isFinite(day.index) ? day.index : order
    const legs = Array.isArray(day.legs) ? day.legs : []
    legs.forEach((leg) => {
      if (!leg) return
      let coordinates = []
      if (Array.isArray(leg.geometry) && leg.geometry.length >= 2) {
        coordinates = leg.geometry
          .map((pair) => {
            if (!Array.isArray(pair) || pair.length < 2) return null
            const lat = Number(pair[0])
            const lng = Number(pair[1])
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
            const point = toBasemap(lat, lng, crs, basemapCrs)
            return Number.isFinite(point.lat) && Number.isFinite(point.lng)
              ? [point.lng, point.lat]
              : null
          })
          .filter(Boolean)
      }
      if (coordinates.length < 2) {
        const from = stopsById.get(String(leg.from))
        const to = stopsById.get(String(leg.to))
        if (from && to) coordinates = [[from.lng, from.lat], [to.lng, to.lat]]
      }
      if (coordinates.length < 2) return
      const approximate = !(Array.isArray(leg.geometry) && leg.geometry.length >= 2)
      legFeatures.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates },
        properties: {
          dayIndex,
          from: leg.from == null ? '' : String(leg.from),
          to: leg.to == null ? '' : String(leg.to),
          mode: leg.mode || 'walk',
          label: String(dayIndex + 1),
          // A straight line is not a road: draw it dashed so it reads as a hint.
          dashed: approximate,
        },
      })
    })
  })

  // Consecutive days rarely carry an explicit leg (intercity hops), so connect
  // them with a dashed line. Without this the map looks broken between cities.
  const dayStops = days.map((day, order) => {
    const index = Number.isFinite(day && day.index) ? day.index : order
    const stops = Array.isArray(day && day.stops)
      ? day.stops.filter((stop) => stop && stop.id != null)
      : []
    return { index, stops }
  })
  for (let position = 0; position < dayStops.length - 1; position += 1) {
    const current = dayStops[position]
    const next = dayStops[position + 1]
    if (current.stops.length === 0 || next.stops.length === 0) continue
    const fromId = String(current.stops[current.stops.length - 1].id)
    const toId = String(next.stops[0].id)
    const linked = legFeatures.some(
      (feature) => feature.properties.from === fromId && feature.properties.to === toId,
    )
    if (linked) continue
    const from = stopsById.get(fromId)
    const to = stopsById.get(toId)
    if (!from || !to) continue
    legFeatures.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [[from.lng, from.lat], [to.lng, to.lat]] },
      properties: {
        dayIndex: current.index,
        from: fromId,
        to: toId,
        mode: 'transit',
        label: '',
        dashed: true,
        intercity: true,
      },
    })
  }

  return {
    stops: { type: 'FeatureCollection', features: stopFeatures },
    legs: { type: 'FeatureCollection', features: legFeatures },
    overlayPoints,
  }
}
