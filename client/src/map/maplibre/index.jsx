/**
 * MapLibre GL renderer for the Roam Planner map panel.
 *
 * Contract: see `client/src/contracts.js` (MapRendererProps). The component
 * exports `MapLibreMap(props)` and is a drop-in swap for the Leaflet renderer:
 *
 *   { view, selectedDay, selectedStopId, theme, onSelectStop, onViewChanged }
 *
 * Optional extras (the shell may ignore them, nothing else changes):
 *   styleUrl  — a full MapLibre style URL, used verbatim.
 *   mapStyle  — a full MapLibre style object, used verbatim.
 *   className — extra class on the sizing wrapper.
 *
 * Design notes
 * ------------
 * Basemap. The default is a self-contained raster style object built from OSM
 * tiles: keyless, no account, no glyph server (style.js). `theme: 'dark'` is
 * derived from the same tiles with raster paint, which leaves overlay colours
 * untouched and keeps the comparison with the Leaflet raster renderer fair.
 * Attribution is carried by the source and drawn by the AttributionControl.
 *
 * Day numbers. MapLibre draws `text-field` only from glyph PBFs; v5 has no
 * offline/inline glyph fallback (`localIdeographFontFamily` covers CJK glyphs,
 * not digits). Since the default style deliberately has no `glyphs` URL, a
 * symbol layer would render nothing offline, so the numbers live in a DOM
 * overlay positioned with `map.project()` on every camera move. The stop layer
 * itself stays a normal GeoJSON circle layer.
 *
 * `onViewChanged({ bounds })` reports `[[south, west], [north, east]]` — lat,
 * lng order, the same order as `Leg.geometry` — rounded to 5 decimals.
 */

const React = require('react')
const maplibreNamespace = require('maplibre-gl')

// The shared client build emits no separate stylesheet, so the MapLibre
// stylesheet is vendored as a string (./maplibreCss.js) and injected by the
// <style> element rendered below. Importing the package .css file would depend
// on a CSS loader the shared build does not configure.
import { MAPLIBRE_CSS } from './maplibreCss.js'

import { buildGeometry, EMPTY_COLLECTION } from './geometry.js'
import {
  SRC_STOPS,
  SRC_LEGS,
  LYR_BG,
  LYR_BASE,
  LYR_LEGS,
  LYR_LEGS_DASHED,
  LYR_STOPS,
  LYR_STOPS_SELECTED,
  overlayLayers,
  selectionFilter,
  dayFilter,
  rasterPaint,
  backgroundColor,
  resolveStyle,
  styleKeyOf,
  isDarkTheme,
} from './style.js'

const maplibregl =
  maplibreNamespace && maplibreNamespace.default ? maplibreNamespace.default : maplibreNamespace

const FIT_PADDING = { top: 56, bottom: 56, left: 56, right: 56 }
const FIT_MAX_ZOOM = 14

const OVERLAY_CSS = [
  '.roam-maplibre-number{position:absolute;left:0;top:0;display:none;',
  'font:600 10px/1 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;',
  'color:#fff;letter-spacing:0;text-align:center;',
  'text-shadow:0 1px 1px rgba(15,23,42,.55);',
  'user-select:none;pointer-events:none;will-change:transform;}',
].join('')

/* ------------------------------------------------------------------ */
/* Map helpers                                                         */
/* ------------------------------------------------------------------ */

function boundsForDay(geometry, dayIndex) {
  const features = geometry && geometry.stops ? geometry.stops.features : []
  let west = Infinity
  let south = Infinity
  let east = -Infinity
  let north = -Infinity
  let count = 0
  for (const feature of features) {
    if (!feature || !feature.geometry || !Array.isArray(feature.geometry.coordinates)) continue
    if (dayIndex !== null && feature.properties && Number(feature.properties.dayIndex) !== dayIndex) continue
    const [lng, lat] = feature.geometry.coordinates
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue
    west = Math.min(west, lng)
    east = Math.max(east, lng)
    south = Math.min(south, lat)
    north = Math.max(north, lat)
    count += 1
  }
  return count === 0 ? null : [[west, south], [east, north]]
}

function addSourcesAndLayers(map, geometry) {
  if (!map.getSource(SRC_STOPS)) {
    map.addSource(SRC_STOPS, { type: 'geojson', data: geometry.stops })
  } else {
    map.getSource(SRC_STOPS).setData(geometry.stops)
  }
  if (!map.getSource(SRC_LEGS)) {
    map.addSource(SRC_LEGS, { type: 'geojson', data: geometry.legs })
  } else {
    map.getSource(SRC_LEGS).setData(geometry.legs)
  }

  overlayLayers(null).forEach((layer) => {
    if (!map.getLayer(layer.id)) map.addLayer(layer)
  })

  // Keep legs under stops, and stops under the enlarged selection, also when a
  // custom style ships its own layers.
  try {
    if (map.getLayer(LYR_LEGS)) map.moveLayer(LYR_LEGS)
    if (map.getLayer(LYR_LEGS_DASHED)) map.moveLayer(LYR_LEGS_DASHED)
    if (map.getLayer(LYR_STOPS)) map.moveLayer(LYR_STOPS)
    if (map.getLayer(LYR_STOPS_SELECTED)) map.moveLayer(LYR_STOPS_SELECTED)
  } catch (_err) {
    /* cosmetic; an unusual style state must not break the renderer. */
  }
}

function applyBasePaint(map, theme, basemap) {
  if (map.getLayer(LYR_BASE)) {
    // An already-dark provider keeps its neutral paint instead of being
    // darkened a second time.
    const paint = basemap && basemap.preDark ? rasterPaint('light') : rasterPaint(theme)
    Object.keys(paint).forEach((property) => {
      try {
        map.setPaintProperty(LYR_BASE, property, paint[property])
      } catch (_err) {
        /* property unsupported by this style; keep the rest. */
      }
    })
  }
  if (map.getLayer(LYR_BG)) {
    try {
      map.setPaintProperty(LYR_BG, 'background-color', backgroundColor(theme))
    } catch (_err) {
      /* background is cosmetic. */
    }
  }
}

function applyOverlayFilters(map, selectedDay, selectedStopId) {
  const day = dayFilter(selectedDay)
  if (map.getLayer(LYR_STOPS)) map.setFilter(LYR_STOPS, day)
  if (map.getLayer(LYR_LEGS)) map.setFilter(LYR_LEGS, day)
  if (map.getLayer(LYR_LEGS_DASHED)) map.setFilter(LYR_LEGS_DASHED, day)
  if (map.getLayer(LYR_STOPS_SELECTED)) {
    const selection = selectionFilter(selectedStopId)
    map.setFilter(LYR_STOPS_SELECTED, day ? ['all', day, selection] : selection)
  }
}

function fitGeometry(map, geometry) {
  if (!map || !geometry) return false
  const bounds = new maplibregl.LngLatBounds()
  let hasPoint = false
  geometry.stops.features.forEach((feature) => {
    bounds.extend(feature.geometry.coordinates)
    hasPoint = true
  })
  geometry.legs.features.forEach((feature) => {
    feature.geometry.coordinates.forEach((coordinate) => bounds.extend(coordinate))
  })
  if (!hasPoint) return false
  try {
    map.resize()
  } catch (_err) {
    /* the container may be detached during teardown. */
  }
  map.fitBounds(bounds, { padding: FIT_PADDING, maxZoom: FIT_MAX_ZOOM, animate: false })
  return true
}

function pointIsInView(map, lngLat, margin) {
  const container = map.getContainer()
  const width = container.clientWidth
  const height = container.clientHeight
  if (!width || !height) return true
  const point = map.project(lngLat)
  return (
    point.x >= margin && point.y >= margin && point.x <= width - margin && point.y <= height - margin
  )
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export function MapLibreMap(props) {
  const { view, selectedDay, selectedStopId, theme, className } = props || {}
  const isDark = isDarkTheme(theme)

  const containerRef = React.useRef(null)
  const overlayRef = React.useRef(null)
  const mapRef = React.useRef(null)
  const readyRef = React.useRef(false)
  const propsRef = React.useRef(props || {})
  const geometryRef = React.useRef({
    stops: EMPTY_COLLECTION,
    legs: EMPTY_COLLECTION,
    overlayPoints: [],
  })
  const apiRef = React.useRef({ rebuild: function noop() {}, update: function noop() {} })
  const numbersRef = React.useRef([])
  const rafRef = React.useRef(0)
  const boundsKeyRef = React.useRef('')
  const tripKeyRef = React.useRef('')
  const styleKeyRef = React.useRef('default')

  const [renderError, setRenderError] = React.useState(null)

  propsRef.current = props || {}

  const geometry = React.useMemo(
    () => buildGeometry(view, props && props.basemap ? props.basemap.crs : undefined),
    // The shell hands over a new TripView per revision; these fields are what
    // actually change the geometry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      view && view.tripId,
      view && view.revision,
      view && view.days,
      view && view.crs,
      props && props.basemap && props.basemap.id,
    ]
  )

  /* --- create the map exactly once ---------------------------------- */
  React.useEffect(() => {
    const container = containerRef.current
    if (!container) return undefined

    const initialProps = propsRef.current
    const initialTheme = isDarkTheme(initialProps.theme) ? 'dark' : 'light'

    let map
    try {
      map = new maplibregl.Map({
        container,
        style: resolveStyle(initialProps, initialTheme),
        center: [10, 25],
        zoom: 1.6,
        minZoom: 1,
        attributionControl: { compact: true },
        dragRotate: false,
      })
    } catch (err) {
      setRenderError(err && err.message ? err.message : String(err))
      return undefined
    }

    mapRef.current = map
    styleKeyRef.current = styleKeyOf(initialProps)
    setRenderError(null)

    try {
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
    } catch (_err) {
      /* controls are optional. */
    }
    try {
      if (map.touchZoomRotate) map.touchZoomRotate.disableRotation()
    } catch (_err) {
      /* no rotation gestures in this build. */
    }

    const overlayHost = overlayRef.current

    const placeNumbers = () => {
      if (!overlayHost) return
      overlayHost.textContent = ''
      const elements = []
      geometryRef.current.overlayPoints.forEach((entry) => {
        const element = document.createElement('span')
        element.className = 'roam-maplibre-number'
        element.textContent = entry.label
        overlayHost.appendChild(element)
        elements.push({
          element,
          coordinates: entry.coordinates,
          dayIndex: entry.dayIndex,
          stopId: entry.stopId,
        })
      })
      numbersRef.current = elements
    }

    const updateNumbers = () => {
      const currentMap = mapRef.current
      if (!currentMap || !overlayHost || !readyRef.current) return
      const currentProps = propsRef.current
      const activeDay = currentProps.selectedDay == null ? null : Number(currentProps.selectedDay)
      const activeStop =
        currentProps.selectedStopId == null ? null : String(currentProps.selectedStopId)
      // Below ~zoom 5 the circles are too small to hold a digit.
      const showNumbers = currentMap.getZoom() >= 5
      const width = overlayHost.clientWidth
      const height = overlayHost.clientHeight
      numbersRef.current.forEach((item) => {
        const { element, coordinates, dayIndex, stopId } = item
        if (!showNumbers || (activeDay != null && dayIndex !== activeDay)) {
          element.style.display = 'none'
          return
        }
        const point = currentMap.project(coordinates)
        if (point.x < -24 || point.y < -24 || point.x > width + 24 || point.y > height + 24) {
          element.style.display = 'none'
          return
        }
        element.style.display = 'block'
        element.style.transform =
          'translate3d(' +
          Math.round(point.x) +
          'px,' +
          Math.round(point.y) +
          'px,0) translate(-50%,-50%)'
        element.style.fontWeight = stopId === activeStop ? '700' : '600'
      })
    }

    const scheduleNumbers = () => {
      if (rafRef.current) return
      rafRef.current = window.requestAnimationFrame(() => {
        rafRef.current = 0
        updateNumbers()
      })
    }

    apiRef.current = { rebuild: placeNumbers, update: updateNumbers }

    const emitView = () => {
      const currentProps = propsRef.current
      if (typeof currentProps.onViewChanged !== 'function' || !readyRef.current) return
      let bounds = null
      try {
        const current = map.getBounds()
        bounds = [
          [Number(current.getSouth().toFixed(5)), Number(current.getWest().toFixed(5))],
          [Number(current.getNorth().toFixed(5)), Number(current.getEast().toFixed(5))],
        ]
      } catch (_err) {
        bounds = null
      }
      const key = bounds ? JSON.stringify(bounds) : ''
      if (key === boundsKeyRef.current) return
      boundsKeyRef.current = key
      currentProps.onViewChanged({ bounds })
    }

    const install = () => {
      addSourcesAndLayers(map, geometryRef.current)
      applyOverlayFilters(
        map,
        propsRef.current.selectedDay,
        propsRef.current.selectedStopId
      )
      applyBasePaint(map, propsRef.current.theme, propsRef.current.basemap)
      placeNumbers()
      updateNumbers()
    }

    const onLoad = () => {
      readyRef.current = true
      install()
      fitGeometry(map, geometryRef.current)
      emitView()
      scheduleNumbers()
    }

    // setStyle (when a custom style prop changes) wipes sources and layers.
    const onStyleLoad = () => {
      if (!readyRef.current) return
      install()
      scheduleNumbers()
    }

    const onClickStop = (event) => {
      const feature = event && event.features && event.features[0]
      if (!feature || !feature.properties) return
      const stopId = feature.properties.stopId
      if (stopId == null) return
      const handler = propsRef.current.onSelectStop
      if (typeof handler === 'function') handler(String(stopId))
    }

    const onEnterStop = () => {
      map.getCanvas().style.cursor = 'pointer'
    }
    const onLeaveStop = () => {
      map.getCanvas().style.cursor = ''
    }

    map.on('load', onLoad)
    map.on('style.load', onStyleLoad)
    map.on('click', LYR_STOPS, onClickStop)
    map.on('mouseenter', LYR_STOPS, onEnterStop)
    map.on('mouseleave', LYR_STOPS, onLeaveStop)
    map.on('moveend', emitView)
    map.on('move', scheduleNumbers)
    map.on('resize', scheduleNumbers)

    return () => {
      apiRef.current = { rebuild: function noop() {}, update: function noop() {} }
      readyRef.current = false
      numbersRef.current = []
      if (rafRef.current) {
        window.cancelAnimationFrame(rafRef.current)
        rafRef.current = 0
      }
      if (overlayHost) overlayHost.textContent = ''
      mapRef.current = null
      try {
        map.remove()
      } catch (_err) {
        /* already torn down. */
      }
    }
  }, [])

  /* --- data: sources, numbers, first fit ---------------------------- */
  React.useEffect(() => {
    geometryRef.current = geometry
    const map = mapRef.current
    if (map && readyRef.current) {
      if (map.getSource(SRC_STOPS)) map.getSource(SRC_STOPS).setData(geometry.stops)
      if (map.getSource(SRC_LEGS)) map.getSource(SRC_LEGS).setData(geometry.legs)
      apiRef.current.rebuild()
      apiRef.current.update()
    }
    const tripKey =
      (view && view.tripId ? view.tripId : '') +
      '@' +
      (view && view.revision != null ? view.revision : '')
    if (tripKey === tripKeyRef.current) return
    tripKeyRef.current = tripKey
    if (map && readyRef.current) {
      fitGeometry(map, geometry)
      apiRef.current.update()
    }
  }, [geometry, view && view.tripId, view && view.revision])

  /* --- selected day: filter the overlay layers and frame that day ---- */
  React.useEffect(() => {
    const map = mapRef.current
    if (!map || !readyRef.current) return
    applyOverlayFilters(map, selectedDay, propsRef.current.selectedStopId)
    apiRef.current.update()
    // A selected stop wins: the stop effect owns the camera in that case.
    if (propsRef.current.selectedStopId) return
    const bounds = boundsForDay(geometryRef.current, selectedDay == null ? null : Number(selectedDay))
    if (!bounds) return
    const [[west, south], [east, north]] = bounds
    if (west === east && south === north) {
      map.easeTo({ center: [west, south], zoom: 14.5, duration: 700, essential: true })
      return
    }
    map.fitBounds(bounds, { padding: FIT_PADDING, maxZoom: 13, duration: 700 })
  }, [selectedDay])

  /* --- selected stop: enlarge + fly to it --------------------------- */
  React.useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (readyRef.current) {
      applyOverlayFilters(map, propsRef.current.selectedDay, selectedStopId)
    }
    apiRef.current.update()
    if (!selectedStopId || !readyRef.current) return
    const feature = geometryRef.current.stops.features.find(
      (item) => item.properties && item.properties.stopId === String(selectedStopId)
    )
    if (!feature) return
    const lngLat = feature.geometry.coordinates
    map.easeTo({
      center: lngLat,
      zoom: Math.max(map.getZoom(), 15),
      duration: 600,
      essential: true,
    })
  }, [selectedStopId])

  /* --- theme and custom style --------------------------------------- */
  React.useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const nextKey = styleKeyOf(propsRef.current)
    if (nextKey !== styleKeyRef.current) {
      styleKeyRef.current = nextKey
      try {
        map.setStyle(resolveStyle(propsRef.current, propsRef.current.theme))
      } catch (_err) {
        /* a malformed custom style keeps the previous map. */
      }
      return
    }
    if (readyRef.current) applyBasePaint(map, propsRef.current.theme, propsRef.current.basemap)
  }, [theme, props.styleUrl, props.mapStyle, props.basemap])

  const cssText = MAPLIBRE_CSS + OVERLAY_CSS

  return (
    <div
      className={'roam-maplibre' + (className ? ' ' + className : '')}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        minHeight: 240,
        overflow: 'hidden',
        background: backgroundColor(theme),
      }}
    >
      {/* No separate stylesheet is emitted: MapLibre CSS is inlined here. */}
      <style dangerouslySetInnerHTML={{ __html: cssText }} />
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
      <div
        ref={overlayRef}
        aria-hidden="true"
        style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}
      />
      {renderError ? (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
            color: isDark ? '#e2e8f0' : '#334155',
            font: '13px/1.4 ui-sans-serif,system-ui,sans-serif',
            textAlign: 'center',
          }}
        >
          {'Map unavailable (WebGL required): ' + renderError}
        </div>
      ) : null}
    </div>
  )
}

