import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { MapLibreMap } from '../map/maplibre/index.jsx'
import { BASEMAPS, normalizeBasemapList, resolveBasemap } from '../basemaps.js'
import { AmapKeyPrompt } from './AmapKey.jsx'
import { StopEditor } from './StopEditor.jsx'
import { subscribeTrips } from './poll.js'
import { STRINGS } from './strings.js'

/** The chosen basemap is a local viewing preference, not trip data. */
const BASEMAP_STORAGE_KEY = 'dsh-roam-planner.basemap'

function readStoredBasemap() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null
    const stored = window.localStorage.getItem(BASEMAP_STORAGE_KEY)
    return stored && BASEMAPS.some((entry) => entry.id === stored) ? stored : null
  } catch (_error) {
    return null
  }
}

function normalizeBasemapId(payload) {
  const value = payload && typeof payload === 'object' && payload.value !== undefined ? payload.value : payload
  const raw = value && typeof value === 'object' ? value.basemapId : ''
  return typeof raw === 'string' ? raw : null
}

/**
 * The provider catalogue is deployment config; which one is currently shown is
 * interaction state and stays in localStorage.
 */
function readBasemapList(payload) {
  const value = payload && typeof payload === 'object' && payload.value !== undefined ? payload.value : payload
  const list = value && typeof value === 'object' ? value.basemaps : null
  return normalizeBasemapList(list)
}

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */

async function readJsonBody(response) {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch (_error) {
    return null
  }
}

/** Accept either `{ ok, value }` envelopes or bare JSON payloads. */
function unwrapPayload(payload) {
  if (payload && typeof payload === 'object' && payload.value !== undefined) return payload.value
  return payload
}

function isTripLike(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return typeof value.tripId === 'string' || Array.isArray(value.days)
}

/**
 * The host may answer with a bare array, `{ trips: [...] }`, a single trip
 * object, or any of those inside `{ ok, value }`. Normalise all four.
 */
function normalizeTrips(payload) {
  const value = unwrapPayload(payload)
  if (Array.isArray(value)) return value.filter(isTripLike)
  if (!value || typeof value !== 'object') return []
  if (Array.isArray(value.trips)) return value.trips.filter(isTripLike)
  if (Array.isArray(value.items)) return value.items.filter(isTripLike)
  if (isTripLike(value.trip)) return [value.trip]
  if (isTripLike(value)) return [value]
  return []
}

async function fetchJson(url, signal) {
  const response = await fetch(url, {
    method: 'GET',
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
    signal,
  })
  const payload = await readJsonBody(response)
  if (!response.ok) {
    const message =
      payload && typeof payload === 'object'
        ? payload.message || payload.error || payload.detail
        : ''
    throw new Error(typeof message === 'string' && message ? message : response.status === 404 || response.status === 405 ? STRINGS.hostUnavailable : `HTTP ${response.status}`)
  }
  return payload
}

async function postJson(url, body, signal) {
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal,
  })
  const payload = await readJsonBody(response)
  if (!response.ok) {
    const message =
      payload && typeof payload === 'object'
        ? payload.message || payload.error || payload.detail
        : ''
    throw new Error(typeof message === 'string' && message ? message : response.status === 404 || response.status === 405 ? STRINGS.hostUnavailable : `HTTP ${response.status}`)
  }
  return payload
}

/* ------------------------------------------------------------------ */
/* Small data helpers                                                  */
/* ------------------------------------------------------------------ */

function countLabel(count, one, many) {
  return `${count} ${count === 1 ? one : many}`
}

function stopCountOf(day) {
  return day && Array.isArray(day.stops) ? day.stops.length : 0
}

/** One-line summary of a plan diff, e.g. "2 added · 1 moved". */
function diffSummary(counts) {
  const parts = []
  if (!counts) return ''
  if (counts.added) parts.push(`${counts.added} ${STRINGS.added}`)
  if (counts.removed) parts.push(`${counts.removed} ${STRINGS.removed}`)
  if (counts.moved) parts.push(`${counts.moved} ${STRINGS.moved}`)
  if (counts.retimed) parts.push(`${counts.retimed} ${STRINGS.retimed}`)
  if (counts.daysAdded) parts.push(`+${counts.daysAdded} ${STRINGS.dayLower}`)
  if (counts.daysRemoved) parts.push(`−${counts.daysRemoved} ${STRINGS.dayLower}`)
  if (counts.datesChanged) parts.push(`${counts.datesChanged} ${STRINGS.reDated}`)
  if (counts.titleChanged) parts.push(STRINGS.renamed)
  return parts.join(' · ')
}

/** Sum of the leg durations the host filled in, or 0 when none are known. */
function travelMinutesOf(day) {
  const legs = day && Array.isArray(day.legs) ? day.legs : []
  return legs.reduce(
    (sum, leg) => sum + (leg && Number.isFinite(leg.minutes) ? leg.minutes : 0),
    0,
  )
}

/** Normalise the day array without touching the host's stored shape. */
function normalizeDays(trip) {
  const raw = trip && Array.isArray(trip.days) ? trip.days : []
  const days = []
  raw.forEach((day, position) => {
    if (!day || typeof day !== 'object') return
    days.push({
      ...day,
      index: Number.isFinite(day.index) ? day.index : position,
      stops: Array.isArray(day.stops) ? day.stops : [],
      legs: Array.isArray(day.legs) ? day.legs : [],
    })
  })
  return days
}

function resolveLocaleTag(locale) {
  if (typeof locale === 'string') return locale
  if (!locale || typeof locale !== 'object') return ''
  try {
    if (typeof locale.getSnapshot === 'function') {
      const snapshot = locale.getSnapshot()
      const active = snapshot && (snapshot.active || snapshot.lang || snapshot.locale)
      if (typeof active === 'string') return active
    }
  } catch (_error) {
    /* an unavailable locale service must not break the panel. */
  }
  if (typeof locale.active === 'string') return locale.active
  return ''
}

/** DSH publishes the resolved palette as `body[data-ds-dark-theme]`. */
function readDocumentTheme() {
  if (typeof document === 'undefined') return 'light'
  if (document.body && document.body.hasAttribute('data-ds-dark-theme')) return 'dark'
  const root = document.documentElement
  if (root) {
    const source = root.getAttribute('data-ds-theme-source')
    if (source === 'dark' || source === 'light') return source
    if (root.style && root.style.colorScheme === 'dark') return 'dark'
  }
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    try {
      if (window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark'
    } catch (_error) {
      /* matchMedia is optional. */
    }
  }
  return 'light'
}

function useDocumentTheme() {
  const [theme, setTheme] = useState(readDocumentTheme)

  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    const update = () => setTheme(readDocumentTheme())
    const observer =
      typeof MutationObserver === 'function' ? new MutationObserver(update) : null
    if (observer && document.body) {
      observer.observe(document.body, {
        attributes: true,
        attributeFilter: ['data-ds-dark-theme'],
      })
    }
    if (observer) {
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-ds-theme-source', 'style', 'class'],
      })
    }
    let media = null
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      media = window.matchMedia('(prefers-color-scheme: dark)')
      if (media && typeof media.addEventListener === 'function') {
        media.addEventListener('change', update)
      }
    }
    update()
    return () => {
      if (observer) observer.disconnect()
      if (media && typeof media.removeEventListener === 'function') {
        media.removeEventListener('change', update)
      }
    }
  }, [])

  return theme
}

/** Use the host locale for the document language; restore it on unmount. */
function useLocaleTag(locale) {
  const tag = resolveLocaleTag(locale)

  useEffect(() => {
    if (!tag || typeof document === 'undefined') return undefined
    const root = document.documentElement
    const previous = root.getAttribute('lang')
    root.setAttribute('lang', tag)
    return () => {
      if (previous === null) root.removeAttribute('lang')
      else root.setAttribute('lang', previous)
    }
  }, [tag])

  return tag
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export function Panel({ locale }) {
  const [tripState, setTripState] = useState({ status: 'loading', trips: [], error: '' })
  const [selectedTripId, setSelectedTripId] = useState(null)
  const [selectedDay, setSelectedDay] = useState(null)
  const [selectedStopId, setSelectedStopId] = useState(null)
  const [basemapId, setBasemapId] = useState(readStoredBasemap)
  const [basemapList, setBasemapList] = useState(BASEMAPS)

  const abortRef = useRef(null)
  const viewBoundsRef = useRef(null)

  const localeTag = useLocaleTag(locale)
  const theme = useDocumentTheme()

  const loadTrips = useCallback(async (options = {}) => {
    const silent = options === true || options?.silent === true
    if (abortRef.current) abortRef.current.abort()
    const controller = new AbortController()
    abortRef.current = controller
    if (!silent) setTripState((current) => ({ ...current, status: 'loading', error: '' }))
    try {
      const payload = await fetchJson('/roam/api/trips', controller.signal)
      const trips = normalizeTrips(payload)
      setTripState({
        status: trips.length > 0 ? 'ready' : 'empty',
        trips,
        error: '',
      })
    } catch (error) {
      if (error && error.name === 'AbortError') return
      if (silent) return // polling never replaces good data with an error banner
      setTripState({
        status: 'error',
        trips: [],
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }, [])

  useEffect(() => {
    void loadTrips()
    return () => {
      if (abortRef.current) abortRef.current.abort()
    }
  }, [loadTrips])

  // One shared poller feeds the panel, the conversation dock and the badge, so
  // the agent's edits arrive without three independent requests.
  useEffect(
    () =>
      subscribeTrips((payload) => {
        const rows = normalizeTrips(payload)
        setTripState({
          status: rows.length > 0 ? 'ready' : 'empty',
          trips: rows,
          error: '',
        })
      }),
    [],
  )

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    fetchJson('/roam/api/config', controller.signal)
      .then((payload) => {
        if (cancelled) return
        setBasemapList(readBasemapList(payload))
        const nextBasemap = normalizeBasemapId(payload)
        if (nextBasemap) setBasemapId((current) => current || nextBasemap)
      })
      .catch((_error) => {
        /* Keep the default basemap when the config route is unavailable. */
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [])

  const trips = tripState.trips

  const trip = useMemo(() => {
    if (trips.length === 0) return null
    if (selectedTripId !== null) {
      const selected = trips.find((row) => row && row.tripId === selectedTripId)
      if (selected) return selected
    }
    // No explicit choice: follow the trip that changed most recently, which is
    // usually the one the conversation is editing.
    return [...trips].sort((a, b) =>
      String((b && b.updatedAt) || '').localeCompare(String((a && a.updatedAt) || '')),
    )[0]
  }, [trips, selectedTripId])

  const activeBasemap = useMemo(
    () => resolveBasemap(basemapId, basemapList),
    [basemapId, basemapList]
  )

  const days = useMemo(() => normalizeDays(trip), [trip])

  const [adopting, setAdopting] = useState(false)

  const adoptTrip = useCallback(async () => {
    if (!trip || trip.status !== 'candidate' || adopting) return
    setAdopting(true)
    try {
      await postJson(`/roam/api/trips/${encodeURIComponent(trip.tripId)}/adopt`, {})
      await loadTrips({ silent: true })
    } catch (error) {
      setTripState((current) => ({
        ...current,
        error: error instanceof Error ? error.message : String(error),
      }))
    } finally {
      setAdopting(false)
    }
  }, [trip, adopting, loadTrips])

  // Direct edits from the page. Each one is a small atomic operation on the
  // host, so an agent edit in the conversation is never overwritten by a stale
  // whole-itinerary copy.
  const [editingBusy, setEditingBusy] = useState(false)
  const [newStopName, setNewStopName] = useState('')

  const applyOps = useCallback(
    async (ops) => {
      if (!trip) return
      setEditingBusy(true)
      try {
        const response = await fetch(`/roam/api/trips/${encodeURIComponent(trip.tripId)}/ops`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ops }),
        })
        const payload = await readJsonBody(response)
        if (!response.ok) throw new Error((payload && payload.error) || `HTTP ${response.status}`)
        await loadTrips({ silent: true })
      } catch (error) {
        setTripState((current) => ({
          ...current,
          error: error instanceof Error ? error.message : String(error),
        }))
      } finally {
        setEditingBusy(false)
      }
    },
    [trip, loadTrips],
  )

  const addStop = useCallback(
    (dayIndex) => {
      const name = newStopName.trim()
      if (!name) return
      setNewStopName('')
      void applyOps([{ op: 'addStop', dayIndex, stop: { name } }])
    },
    [newStopName, applyOps],
  )

  const [titleDraft, setTitleDraft] = useState(null)

  const createTrip = useCallback(async () => {
    setEditingBusy(true)
    try {
      const response = await fetch('/roam/api/trips', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: STRINGS.newTripTitle }),
      })
      const payload = await readJsonBody(response)
      if (!response.ok) throw new Error((payload && payload.error) || `HTTP ${response.status}`)
      if (payload && payload.tripId) setSelectedTripId(payload.tripId)
      await loadTrips({ silent: true })
    } catch (error) {
      setTripState((current) => ({
        ...current,
        error: error instanceof Error ? error.message : String(error),
      }))
    } finally {
      setEditingBusy(false)
    }
  }, [loadTrips])

  const moveStop = useCallback(
    (stopId, dayIndex, toIndex) => {
      void applyOps([{ op: 'moveStop', stopId, toDay: dayIndex, toIndex }])
    },
    [applyOps],
  )

  const mapView = useMemo(() => (trip ? { ...trip, days } : null), [trip, days])

  // Weather is presentation only: a missing forecast must never block the map.
  const [weather, setWeather] = useState(null)
  useEffect(() => {
    if (!trip || !trip.tripId) {
      setWeather(null)
      return undefined
    }
    let cancelled = false
    const controller = new AbortController()
    fetchJson(`/roam/api/trips/${encodeURIComponent(trip.tripId)}/weather`, controller.signal)
      .then((payload) => {
        if (!cancelled) setWeather(payload && Array.isArray(payload.days) ? payload : null)
      })
      .catch(() => {
        if (!cancelled) setWeather(null)
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [trip && trip.tripId, trip && trip.revision])

  const weatherFor = useCallback(
    (date) => {
      const rows = weather && Array.isArray(weather.days) ? weather.days : []
      return rows.find((row) => row && row.date === date) || null
    },
    [weather],
  )

  // What changed since the last adopted plan, so a candidate can be reviewed
  // before it is committed.
  const [diff, setDiff] = useState(null)
  useEffect(() => {
    if (!trip || !trip.tripId) {
      setDiff(null)
      return undefined
    }
    let cancelled = false
    const controller = new AbortController()
    fetchJson(`/roam/api/trips/${encodeURIComponent(trip.tripId)}/diff`, controller.signal)
      .then((payload) => {
        if (!cancelled) setDiff(payload && typeof payload === 'object' ? payload : null)
      })
      .catch(() => {
        if (!cancelled) setDiff(null)
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [trip && trip.tripId, trip && trip.revision])

  const totalStops = useMemo(
    () => days.reduce((sum, day) => sum + stopCountOf(day), 0),
    [days],
  )

  const selectedStop = useMemo(() => {
    if (selectedStopId === null || selectedStopId === '') return null
    const wanted = String(selectedStopId)
    for (const day of days) {
      for (const stop of day.stops) {
        if (stop && stop.id !== undefined && String(stop.id) === wanted) return { stop, day }
      }
    }
    return null
  }, [days, selectedStopId])

  const chooseTrip = useCallback((tripId) => {
    setSelectedTripId(tripId)
    setSelectedDay(null)
    setSelectedStopId(null)
  }, [])

  const chooseAllDays = useCallback(() => {
    setSelectedDay(null)
    setSelectedStopId(null)
  }, [])

  const chooseDay = useCallback((index) => {
    setSelectedDay(index)
    setSelectedStopId(null)
  }, [])

  const chooseBasemap = useCallback((id) => {
    setBasemapId(id)
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(BASEMAP_STORAGE_KEY, id)
      }
    } catch (_error) {
      /* a blocked storage must not break the map. */
    }
  }, [])

  const handleSelectStop = useCallback((stopId) => {
    if (stopId === undefined || stopId === null) return
    setSelectedStopId(String(stopId))
  }, [])

  const handleViewChanged = useCallback((detail) => {
    viewBoundsRef.current = detail && detail.bounds ? detail.bounds : null
  }, [])

  /** One day, expanded: each stop with its time, and the leg that follows it. */
  const renderDayDetail = (day) => {
    const stops = Array.isArray(day.stops) ? day.stops : []
    const legs = Array.isArray(day.legs) ? day.legs : []
    return (
      <>
        {stops.length === 0 ? <p className="rp-day-empty">{STRINGS.noStops}</p> : null}
        <ol className="rp-day-detail">
          {stops.map((stop, position) => {
            const leg = legs.find((row) => row && String(row.from) === String(stop.id))
            const hasNext = position < stops.length - 1
            return (
              <li key={`stop-${stop.id}`}>
                <div className="rp-stop-line">
                  <button
                    type="button"
                    className="rp-stop-row"
                    aria-pressed={selectedStopId === String(stop.id)}
                    onClick={() => handleSelectStop(String(stop.id))}
                  >
                    <span className="rp-stop-seq">{position + 1}</span>
                    <span className="rp-stop-time">{stop.start || '--:--'}</span>
                    <span className="rp-stop-name">{stop.name || STRINGS.unnamedStop}</span>
                    {Number.isFinite(stop.stayMinutes) ? (
                      <span className="rp-stop-stay">
                        {stop.stayMinutes} {STRINGS.minutes}
                      </span>
                    ) : null}
                  </button>
                  <span className="rp-stop-tools">
                    <button
                      type="button"
                      title={STRINGS.moveUp}
                      disabled={editingBusy || position === 0}
                      onClick={() => moveStop(stop.id, day.index, position - 1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      title={STRINGS.moveDown}
                      disabled={editingBusy || position === stops.length - 1}
                      onClick={() => moveStop(stop.id, day.index, position + 1)}
                    >
                      ↓
                    </button>
                  </span>
                </div>
                {leg && hasNext ? (
                  <div className="rp-leg-row">
                    <span>{STRINGS.modes[leg.mode] || leg.mode}</span>
                    <span>{Number.isFinite(leg.minutes) ? `${leg.minutes} ${STRINGS.minutes}` : '—'}</span>
                  </div>
                ) : null}
              </li>
            )
          })}
        </ol>
        <div className="rp-add-stop">
          <input
            value={newStopName}
            placeholder={STRINGS.addStopPlaceholder}
            disabled={editingBusy}
            onChange={(event) => setNewStopName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') addStop(day.index)
            }}
          />
          <button
            type="button"
            disabled={editingBusy || newStopName.trim() === ''}
            onClick={() => addStop(day.index)}
          >
            {STRINGS.add}
          </button>
        </div>
      </>
    )
  }

  const renderSidebar = () => {
    if (tripState.status === 'loading') {
      return (
        <p className="rp-note" role="status">
          {STRINGS.loading}
        </p>
      )
    }
    if (tripState.status === 'error') {
      return (
        <div className="rp-note rp-error" role="alert">
          <p className="rp-note-title">{STRINGS.errorTitle}</p>
          {tripState.error ? <p className="rp-error-detail">{tripState.error}</p> : null}
          <button type="button" className="rp-button" onClick={() => void loadTrips()}>
            {STRINGS.errorRetry}
          </button>
        </div>
      )
    }
    if (!trip) {
      return (
        <div className="rp-note">
          <p className="rp-note-title">{STRINGS.emptyTitle}</p>
          <p>{STRINGS.emptyBody}</p>
        </div>
      )
    }
    if (days.length === 0) {
      return <p className="rp-sidebar-empty">{STRINGS.noStops}</p>
    }
    return (
      <nav className="rp-day-list" aria-label={STRINGS.itinerary}>
        <button
          type="button"
          className="rp-day"
          aria-pressed={selectedDay === null}
          onClick={chooseAllDays}
        >
          <span className="rp-day-main">
            <span className="rp-day-title">{STRINGS.allDays}</span>
            <span className="rp-day-date">{STRINGS.wholeTrip}</span>
          </span>
          <span className="rp-day-count">
            {countLabel(totalStops, STRINGS.stopLower, STRINGS.stopsLower)}
          </span>
        </button>
        {days.map((day) => {
          const minutes = travelMinutesOf(day)
          const wx = weatherFor(day.date)
          const hasWeather = wx && wx.tMax !== null && wx.tMin !== null
          const open = selectedDay === day.index
          return (
            <div key={`day-${day.index}`} className="rp-day-block">
              <button
                type="button"
                className="rp-day"
                aria-pressed={open}
                aria-expanded={open}
                onClick={() => (open ? chooseAllDays() : chooseDay(day.index))}
              >
                <span className="rp-day-main">
                  <span className="rp-day-title">
                    {STRINGS.day}{day.index + 1} {STRINGS.daySuffix}
                  </span>
                  <span className="rp-day-date">
                    {typeof day.date === 'string' && day.date ? day.date : STRINGS.unknownDate}
                  </span>
                </span>
                <span className="rp-day-count">
                  {countLabel(stopCountOf(day), STRINGS.stopLower, STRINGS.stopsLower)}
                  {minutes > 0 ? (
                    <span className="rp-day-travel">
                      {' · '}
                      {minutes} {STRINGS.minutes}
                    </span>
                  ) : null}
                  {hasWeather ? (
                    <span className="rp-day-weather">
                      {' · '}
                      {Math.round(wx.tMin)}–{Math.round(wx.tMax)}°
                    </span>
                  ) : null}
                </span>
              </button>
              {open ? renderDayDetail(day) : null}
            </div>
          )
        })}
      </nav>
    )
  }

  const renderMapPlaceholder = () => {
    if (tripState.status === 'loading') {
      return (
        <div className="rp-placeholder" role="status">
          <p className="rp-placeholder-title">{STRINGS.loading}</p>
        </div>
      )
    }
    if (tripState.status === 'error') {
      return (
        <div className="rp-placeholder" role="alert">
          <p className="rp-placeholder-title">{STRINGS.errorTitle}</p>
          {tripState.error ? <p>{tripState.error}</p> : null}
        </div>
      )
    }
    return (
      <div className="rp-placeholder">
        <p className="rp-placeholder-title">{STRINGS.mapEmptyTitle}</p>
        <p>{STRINGS.mapEmptyBody}</p>
      </div>
    )
  }

  const MapRenderer = MapLibreMap
  const statusKey = trip && typeof trip.status === 'string' ? trip.status : 'draft'
  const statusLabel = STRINGS.status[statusKey] || statusKey

  return (
    <div className="rp-root" lang={localeTag || undefined}>
      <style>{PANEL_CSS}</style>

      <AmapKeyPrompt />

      <header className="rp-header">
        <div className="rp-brand">
          <h1 className="rp-title">{STRINGS.panelTitle}</h1>
          <p className="rp-tagline">{STRINGS.tagline}</p>
        </div>

        <div className="rp-trip">
          {trip && trips.length > 1 ? (
            <label className="rp-picker">
              <span>{STRINGS.tripPicker}</span>
              <select
                value={trip.tripId || ''}
                onChange={(event) => chooseTrip(event.target.value)}
              >
                {trips.map((row, position) => {
                  const value = row.tripId || `trip-${position}`
                  return (
                    <option key={value} value={value}>
                      {row.title || row.tripId || STRINGS.untitledTrip}
                    </option>
                  )
                })}
              </select>
            </label>
          ) : null}

          {trip ? (
            <div className="rp-trip-meta">
              {titleDraft === null ? (
                <button
                  type="button"
                  className="rp-trip-title rp-title-button"
                  title={STRINGS.rename}
                  onClick={() => setTitleDraft(trip.title || '')}
                >
                  {trip.title || STRINGS.untitledTrip}
                </button>
              ) : (
                <input
                  className="rp-title-input"
                  value={titleDraft}
                  autoFocus
                  onChange={(event) => setTitleDraft(event.target.value)}
                  onBlur={() => {
                    const next = titleDraft.trim()
                    setTitleDraft(null)
                    if (next && next !== trip.title) void applyOps([{ op: 'setTitle', title: next }])
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur()
                    if (event.key === 'Escape') setTitleDraft(null)
                  }}
                />
              )}
              <span className={`rp-status rp-status-${statusKey}`}>{statusLabel}</span>
              {trip.revision !== undefined && trip.revision !== null ? (
                <span className="rp-rev">
                  {STRINGS.revision} {trip.revision} {STRINGS.revisionSuffix}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="rp-actions">
          <label className="rp-select">
            <span className="rp-engine-label">{STRINGS.basemap}</span>
            <select
              aria-label={STRINGS.basemap}
              value={activeBasemap.id}
              onChange={(event) => chooseBasemap(event.target.value)}
            >
              {basemapList.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="rp-button" onClick={() => void loadTrips()}>
            {STRINGS.refresh}
          </button>
          <button type="button" className="rp-button" onClick={() => void createTrip()}>
            {STRINGS.newTrip}
          </button>
          {trip && trip.status === 'candidate' ? (
            <button
              type="button"
              className="rp-button rp-button-primary"
              disabled={adopting}
              title={STRINGS.candidateHint}
              onClick={() => void adoptTrip()}
            >
              {adopting ? STRINGS.adopting : STRINGS.adopt}
            </button>
          ) : null}
        </div>
      </header>

      <div className="rp-body">
        <aside className="rp-sidebar" aria-label={STRINGS.itinerary}>
          <div className="rp-sidebar-head">
            <span>{STRINGS.itinerary}</span>
            <span>{countLabel(days.length, STRINGS.dayLower, STRINGS.daysLower)}</span>
          </div>
          {diff && diff.hasBaseline && !diff.unchanged ? (
            <div className="rp-diff" role="status">
              <strong>{STRINGS.changesTitle}</strong>
              <span>{diffSummary(diff.counts)}</span>
            </div>
          ) : null}
          {renderSidebar()}
        </aside>

        <section className="rp-map-pane" aria-label={STRINGS.mapLabel}>
          {trip ? (
            <div className="rp-map-fill">
              <MapRenderer
                view={mapView}
                selectedDay={selectedDay}
                selectedStopId={selectedStopId}
                theme={theme}
                basemap={activeBasemap}
                onSelectStop={handleSelectStop}
                onViewChanged={handleViewChanged}
                className="rp-map"
              />
            </div>
          ) : (
            renderMapPlaceholder()
          )}

          {selectedStop ? (
            <div className="rp-inspector" role="status">
              <div className="rp-inspector-body">
                <span className="rp-inspector-label">{STRINGS.selectedStop}</span>
                <strong className="rp-inspector-name">
                  {selectedStop.stop.name || STRINGS.unnamedStop}
                </strong>
                <span className="rp-inspector-meta">
                  {STRINGS.day} {selectedStop.day.index + 1}
                  {selectedStop.stop.start
                    ? ` · ${STRINGS.starts} ${selectedStop.stop.start}`
                    : ''}
                  {Number.isFinite(selectedStop.stop.stayMinutes)
                    ? ` · ${STRINGS.stay} ${selectedStop.stop.stayMinutes} ${STRINGS.minutes}`
                    : ''}
                  {selectedStop.stop.category ? ` · ${selectedStop.stop.category}` : ''}
                </span>
                {selectedStop.stop.note ? (
                  <span className="rp-inspector-note">
                    {STRINGS.note}: {selectedStop.stop.note}
                  </span>
                ) : null}
                <StopEditor
                  stop={selectedStop.stop}
                  busy={editingBusy}
                  onSave={(patch) =>
                    void applyOps([{ op: 'updateStop', stopId: selectedStop.stop.id, patch }])
                  }
                  onDelete={() => {
                    setSelectedStopId(null)
                    void applyOps([{ op: 'removeStop', stopId: selectedStop.stop.id }])
                  }}
                />
                {days.length > 1 ? (
                  <label className="rp-move-day">
                    {STRINGS.moveToDay}
                    <select
                      value={selectedStop.day.index}
                      disabled={editingBusy}
                      onChange={(event) =>
                        void applyOps([
                          { op: 'moveStop', stopId: selectedStop.stop.id, toDay: Number(event.target.value) },
                        ])
                      }
                    >
                      {days.map((entry) => (
                        <option key={entry.index} value={entry.index}>
                          {STRINGS.day}
                          {entry.index + 1} {STRINGS.daySuffix}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
              </div>
              <button
                type="button"
                className="rp-button rp-inspector-close"
                onClick={() => setSelectedStopId(null)}
              >
                {STRINGS.clearSelection}
              </button>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Styles: DSH alias tokens only. Unknown tokens fall back to          */
/* `inherit`/`currentColor`/`transparent`, never to a literal colour.  */
/* ------------------------------------------------------------------ */

const PANEL_CSS = `
.rp-root {
  position: relative;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 420px;
  background: var(--dsw-alias-bg-base, transparent);
  color: var(--dsw-alias-label-primary, inherit);
  font-family: var(--dsw-font-family, inherit);
  font-size: 14px;
  line-height: 1.5;
}
.rp-root *,
.rp-root *::before,
.rp-root *::after { box-sizing: border-box; }

.rp-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 20px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, transparent);
  background: var(--dsw-alias-bg-layer-1, transparent);
}
.rp-brand { flex: 1 1 220px; min-width: 0; }
.rp-title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  letter-spacing: -0.01em;
  line-height: 1.25;
}
.rp-tagline {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, currentColor);
}
.rp-trip {
  display: flex;
  flex: 1 1 240px;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.rp-trip-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.rp-trip-title {
  max-width: 320px;
  overflow: hidden;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rp-status {
  padding: 1px 8px;
  border: 1px solid var(--dsw-alias-border-l2, transparent);
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2, transparent);
  color: var(--dsw-alias-label-secondary, currentColor);
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.rp-status-adopted {
  border-color: var(--dsw-alias-state-success-primary, transparent);
  color: var(--dsw-alias-state-success-primary, currentColor);
}
.rp-status-candidate {
  border-color: var(--dsw-alias-state-warn-primary, transparent);
  color: var(--dsw-alias-state-warn-primary, currentColor);
}
.rp-status-draft { color: var(--dsw-alias-label-secondary, currentColor); }
.rp-rev {
  color: var(--dsw-alias-label-tertiary, currentColor);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.rp-picker {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--dsw-alias-label-secondary, currentColor);
  font-size: 12px;
}
.rp-picker select {
  padding: 4px 6px;
  border: 1px solid var(--dsw-alias-border-l2, transparent);
  border-radius: var(--dsw-radius-sm, 6px);
  background: var(--dsw-alias-bg-layer-2, transparent);
  color: var(--dsw-alias-label-primary, inherit);
  font: inherit;
}

.rp-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.rp-engine {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px;
  border: 1px solid var(--dsw-alias-border-l2, transparent);
  border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-layer-2, transparent);
}
.rp-engine-label {
  padding-left: 6px;
  color: var(--dsw-alias-label-tertiary, currentColor);
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.rp-engine button {
  padding: 4px 8px;
  border: 1px solid transparent;
  border-radius: calc(var(--dsw-radius-md, 8px) - 2px);
  background: transparent;
  color: var(--dsw-alias-label-secondary, currentColor);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
}
.rp-engine button:hover { background: var(--dsw-alias-interactive-bg-hover, transparent); }
.rp-engine button[aria-pressed="true"] {
  border-color: var(--dsw-alias-border-l1, transparent);
  background: var(--dsw-alias-bg-layer-1, transparent);
  color: var(--dsw-alias-label-primary, inherit);
}
.rp-select {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px;
  border: 1px solid var(--dsw-alias-border-l2, transparent);
  border-radius: var(--dsw-radius-md, 8px);
}
.rp-select select {
  font: inherit;
  font-size: 12px;
  padding: 4px 6px;
  border: 1px solid transparent;
  border-radius: calc(var(--dsw-radius-md, 8px) - 2px);
  background: var(--dsw-alias-bg-layer-1, transparent);
  color: var(--dsw-alias-label-primary, inherit);
  cursor: pointer;
}
.rp-select select:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, currentColor);
  outline-offset: 1px;
}
.rp-button-primary {
  border-color: var(--dsw-alias-state-success-primary, transparent);
  background: var(--dsw-alias-state-success-primary, transparent);
  color: var(--dsw-alias-bg-base, white);
  font-weight: 600;
}
.rp-button:disabled {
  opacity: 0.55;
  cursor: default;
}
.rp-button {
  padding: 6px 10px;
  border: 1px solid var(--dsw-alias-border-l2, transparent);
  border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-layer-1, transparent);
  color: var(--dsw-alias-label-primary, inherit);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
}
.rp-button:hover { background: var(--dsw-alias-interactive-bg-hover, transparent); }
.rp-button:disabled { cursor: default; opacity: 0.5; }
.rp-root :focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, currentColor);
  outline-offset: 2px;
}

.rp-body {
  display: grid;
  flex: 1;
  grid-template-columns: 280px minmax(0, 1fr);
  min-height: 0;
}
.rp-sidebar {
  min-height: 0;
  padding: 12px;
  overflow: auto;
  border-right: 1px solid var(--dsw-alias-border-l1, transparent);
  background: var(--dsw-alias-bg-layer-1, transparent);
}
.rp-sidebar-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin: 0 2px 8px;
  color: var(--dsw-alias-label-tertiary, currentColor);
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.rp-day-list { display: flex; flex-direction: column; gap: 4px; }
.rp-day-block { display: flex; flex-direction: column; }
.rp-day-detail {
  list-style: none;
  margin: 2px 0 6px;
  padding: 0 0 0 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  border-left: 2px solid var(--dsw-alias-border-l2, transparent);
}
.rp-stop-row {
  display: grid;
  grid-template-columns: 16px 40px minmax(0, 1fr) auto;
  gap: 6px;
  align-items: baseline;
  width: 100%;
  text-align: left;
  font: inherit;
  font-size: 12px;
  padding: 3px 6px;
  border: 0;
  border-radius: var(--dsw-radius-sm, 6px);
  background: transparent;
  color: var(--dsw-alias-label-primary, inherit);
  cursor: pointer;
}
.rp-stop-row:hover { background: var(--dsw-alias-interactive-bg-hover, transparent); }
.rp-stop-row[aria-pressed="true"] { background: var(--dsw-alias-interactive-bg-active, transparent); }
.rp-stop-seq { color: var(--dsw-alias-label-tertiary, currentColor); font-variant-numeric: tabular-nums; }
.rp-stop-time { color: var(--dsw-alias-label-secondary, currentColor); font-variant-numeric: tabular-nums; }
.rp-stop-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rp-stop-stay { color: var(--dsw-alias-label-tertiary, currentColor); font-size: 11px; }
.rp-leg-row {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-left: 22px;
  padding: 1px 6px 1px 0;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, currentColor);
}
.rp-day-empty { margin: 4px 0 6px 8px; font-size: 12px; color: var(--dsw-alias-label-tertiary, currentColor); }
.rp-add-stop { display: flex; gap: 6px; margin: 2px 0 8px 8px; }
.rp-add-stop input {
  flex: 1; min-width: 0; font: inherit; font-size: 12px; padding: 4px 8px;
  border-radius: var(--dsw-radius-sm, 6px);
  border: 1px dashed var(--dsw-alias-border-l1, currentColor);
  background: transparent; color: var(--dsw-alias-label-primary, inherit);
}
.rp-add-stop button {
  font: inherit; font-size: 12px; padding: 4px 10px; cursor: pointer;
  border-radius: var(--dsw-radius-sm, 6px);
  border: 1px solid var(--dsw-alias-border-l1, currentColor);
  background: transparent; color: inherit;
}
.rp-add-stop button:disabled { opacity: .5; cursor: default; }
.rp-stop-line { display: flex; align-items: center; gap: 2px; }
.rp-stop-line .rp-stop-row { flex: 1; min-width: 0; }
.rp-stop-tools { display: inline-flex; gap: 1px; }
.rp-stop-tools button {
  font: inherit; font-size: 10px; line-height: 1; padding: 2px 5px; cursor: pointer;
  border-radius: var(--dsw-radius-sm, 6px); border: 1px solid transparent;
  background: transparent; color: var(--dsw-alias-label-tertiary, currentColor);
}
.rp-stop-tools button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, transparent); }
.rp-stop-tools button:disabled { opacity: .3; cursor: default; }
.rp-title-button {
  font: inherit; font-weight: 600; padding: 0; border: 0; background: transparent;
  color: inherit; cursor: text; text-align: left; max-width: 320px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.rp-title-button:hover { text-decoration: underline dotted; }
.rp-title-input {
  font: inherit; font-weight: 600; padding: 1px 6px; max-width: 320px;
  border-radius: var(--dsw-radius-sm, 6px);
  border: 1px solid var(--dsw-alias-border-l1, currentColor);
  background: var(--dsw-alias-bg-layer-2, transparent); color: inherit;
}
.rp-move-day { display: inline-flex; align-items: center; gap: 6px; margin-top: 8px; font-size: 11px; color: var(--dsw-alias-label-tertiary, currentColor); }
.rp-move-day select {
  font: inherit; font-size: 12px; padding: 3px 6px; border-radius: var(--dsw-radius-sm, 6px);
  border: 1px solid var(--dsw-alias-border-l1, currentColor);
  background: var(--dsw-alias-bg-layer-2, transparent); color: inherit;
}
.rp-diff {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0 2px 10px;
  padding: 8px 10px;
  border-radius: var(--dsw-radius-md, 8px);
  border: 1px solid var(--dsw-alias-state-warn-primary, transparent);
  background: var(--dsw-alias-bg-layer-2, transparent);
  font-size: 12px;
}
.rp-diff strong { font-weight: 600; color: var(--dsw-alias-label-primary, inherit); }
.rp-diff span { color: var(--dsw-alias-label-secondary, currentColor); }
.rp-day {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: var(--dsw-radius-md, 8px);
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
  text-align: left;
}
.rp-day:hover { background: var(--dsw-alias-interactive-bg-hover, transparent); }
.rp-day[aria-pressed="true"] {
  border-color: var(--dsw-alias-border-l2, transparent);
  background: var(--dsw-alias-interactive-bg-active, var(--dsw-alias-interactive-bg-hover, transparent));
}
.rp-day-main { display: flex; flex: 1; flex-direction: column; min-width: 0; }
.rp-day-title { font-size: 13px; font-weight: 600; }
.rp-day-date { color: var(--dsw-alias-label-secondary, currentColor); font-size: 12px; }
.rp-day-count {
  color: var(--dsw-alias-label-tertiary, currentColor);
  font-size: 11px;
  white-space: nowrap;
}
.rp-day-travel { color: var(--dsw-alias-label-secondary, currentColor); }
.rp-day-weather {
  color: var(--dsw-alias-state-warn-primary, currentColor);
  font-variant-numeric: tabular-nums;
}
.rp-note {
  margin: 8px 2px;
  color: var(--dsw-alias-label-secondary, currentColor);
  font-size: 13px;
}
.rp-note p { margin: 0 0 6px; }
.rp-note-title { color: var(--dsw-alias-label-primary, inherit); font-weight: 600; }
.rp-error { color: var(--dsw-alias-label-error, currentColor); }
.rp-error .rp-note-title { color: var(--dsw-alias-label-error, currentColor); }
.rp-error-detail { opacity: 0.85; overflow-wrap: anywhere; font-size: 12px; }
.rp-sidebar-empty {
  margin: 4px 2px;
  color: var(--dsw-alias-label-tertiary, currentColor);
  font-size: 12px;
}

.rp-map-pane {
  position: relative;
  min-height: 320px;
  overflow: hidden;
  background: var(--dsw-alias-bg-layer-2, transparent);
}
.rp-map-fill { position: absolute; inset: 0; }
.rp-map-fill > * { width: 100%; height: 100%; }
.rp-placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 24px;
  color: var(--dsw-alias-label-secondary, currentColor);
  text-align: center;
}
.rp-placeholder p { margin: 0; font-size: 13px; }
.rp-placeholder-title {
  color: var(--dsw-alias-label-primary, inherit);
  font-size: 15px;
  font-weight: 600;
}

.rp-inspector {
  position: absolute;
  right: 16px;
  bottom: 16px;
  left: 16px;
  z-index: 1200;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l2, transparent);
  border-radius: var(--dsw-radius-lg, 10px);
  background: var(--dsw-alias-bg-layer-1, transparent);
  box-shadow: var(--dsw-elevation-soft, none);
}
.rp-inspector-body { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.rp-inspector-label {
  color: var(--dsw-alias-label-tertiary, currentColor);
  font-size: 10px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.rp-inspector-name { font-size: 14px; }
.rp-inspector-meta { color: var(--dsw-alias-label-secondary, currentColor); font-size: 12px; }
.rp-inspector-note {
  color: var(--dsw-alias-label-secondary, currentColor);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.rp-inspector-close { flex: none; }

@media (max-width: 760px) {
  .rp-body {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(320px, 1fr);
  }
  .rp-sidebar {
    max-height: 42vh;
    border-right: 0;
    border-bottom: 1px solid var(--dsw-alias-border-l1, transparent);
  }
}
`








