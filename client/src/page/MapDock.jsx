/**
 * Side map dock for the conversation page.
 *
 * Registered into `shell.overlay`, so the map is available while chatting
 * instead of replacing the conversation. The overlay layer does not let a
 * plugin shrink the chat column, so this is a right-hand drawer: resizable from
 * its left edge, collapsible back to a pill, and gated to chosen workspaces.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MapLibreMap } from '../map/maplibre/index.jsx'
import { subscribeTrips } from './poll.js'
import { DEFAULT_BASEMAP_ID, resolveBasemap } from '../basemaps.js'
import { STRINGS } from './strings.js'

const WIDTH_KEY = 'dsh-roam-planner.dockWidth'
const MIN_WIDTH = 320
const MAX_WIDTH = 760

const CSS = `
.rp-dock-toggle { position: fixed; right: 16px; bottom: 88px; z-index: 45; display: inline-flex; align-items: center; gap: 6px; padding: 8px 12px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.2)); background: var(--dsw-alias-bg-layer-1, #1b1b1b); color: var(--dsw-alias-label-primary, #eee); font: inherit; font-size: 12px; cursor: pointer; box-shadow: var(--dsw-elevation-soft, 0 6px 20px rgba(0,0,0,.35)); z-index: 62; }
.rp-dock { position: fixed; top: 36px; right: 0; bottom: 0; z-index: 46; display: flex; flex-direction: column; border-left: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.2)); background: var(--dsw-alias-bg-base, #141414); color: var(--dsw-alias-label-primary, #eee); box-shadow: var(--dsw-elevation-soft, -8px 0 32px rgba(0,0,0,.35)); }
.rp-dock-grip { position: absolute; left: -3px; top: 0; bottom: 0; width: 8px; cursor: col-resize; z-index: 2; }
.rp-dock-grip:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08)); }
.rp-dock-head { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.12)); }
.rp-dock-title { flex: 1; min-width: 0; font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rp-dock-head button { font: inherit; font-size: 11px; padding: 2px 8px; border-radius: var(--dsw-radius-sm, 6px); border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.2)); background: transparent; color: inherit; cursor: pointer; white-space: nowrap; }
.rp-dock-head button:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08)); }
.rp-dock-days { display: flex; gap: 4px; flex-wrap: wrap; padding: 6px 10px; border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.12)); }
.rp-dock-days button { font: inherit; font-size: 11px; padding: 2px 9px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.15)); background: transparent; color: inherit; cursor: pointer; }
.rp-dock-days button[aria-pressed="true"] { background: var(--dsw-alias-interactive-bg-active, rgba(255,255,255,.16)); border-color: transparent; }
.rp-dock-map { position: relative; flex: 1; min-height: 0; }
.rp-dock-map > * { width: 100%; height: 100%; }
.rp-dock-foot { padding: 6px 10px; border-top: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.12)); font-size: 11px; color: var(--dsw-alias-label-secondary, currentColor); min-height: 16px; }
`

function readTheme() {
  if (typeof document === 'undefined') return 'light'
  if (document.body && document.body.hasAttribute('data-ds-dark-theme')) return 'dark'
  const source = document.documentElement && document.documentElement.getAttribute('data-ds-theme-source')
  return source === 'dark' ? 'dark' : 'light'
}

function readWidth() {
  try {
    const stored = typeof window !== 'undefined' && window.localStorage ? Number(window.localStorage.getItem(WIDTH_KEY)) : NaN
    return Number.isFinite(stored) && stored >= MIN_WIDTH ? Math.min(MAX_WIDTH, stored) : 440
  } catch (_error) {
    return 440
  }
}

function storeWidth(value) {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(WIDTH_KEY, String(Math.round(value)))
    }
  } catch (_error) {
    /* a blocked storage only loses the remembered width. */
  }
}

function tripsOf(payload) {
  const value = payload && payload.value !== undefined ? payload.value : payload
  if (Array.isArray(value)) return value
  if (value && Array.isArray(value.trips)) return value.trips
  return []
}

/**
 * Current workspace title, when the host's selector hook exposes it.
 * The hook's snapshot shape is not part of the public contract we can assert at
 * build time, so every step is defensive: an unknown shape means "show the
 * dock", never a crash and never a silently hidden panel.
 */
function useWorkspaceTitle(useWorkspaces) {
  const snapshot = useWorkspaces((value) => value)
  if (!snapshot || typeof snapshot !== 'object') return ''
  const list =
    (Array.isArray(snapshot.workspaces) && snapshot.workspaces) ||
    (Array.isArray(snapshot.items) && snapshot.items) ||
    (Array.isArray(snapshot.list) && snapshot.list) ||
    []
  const activeId =
    snapshot.activeId ?? snapshot.activeWorkspaceId ?? snapshot.selectedId ?? snapshot.currentId ?? null
  const active =
    (activeId !== null && list.find((row) => row && row.workspaceId === activeId)) ||
    snapshot.active ||
    null
  return active && typeof active.title === 'string' ? active.title : ''
}

export function MapDock(props) {
  const useWorkspaces = props && props.useWorkspaces
  const [open, setOpen] = useState(false)
  const [trips, setTrips] = useState([])
  const [tripId, setTripId] = useState(null)
  const [selectedDay, setSelectedDay] = useState(null)
  const [selectedStop, setSelectedStop] = useState(null)
  const [basemapId, setBasemapId] = useState(DEFAULT_BASEMAP_ID)
  const [workspaceAllow, setWorkspaceAllow] = useState(null)
  const [theme, setTheme] = useState(readTheme)
  const [width, setWidth] = useState(readWidth)
  const abortRef = useRef(null)
  const dragRef = useRef(null)

  // A configured allowlist hides the dock outside the planning workspace.
  const workspaceTitle = typeof useWorkspaces === 'function' ? useWorkspaceTitle(useWorkspaces) : ''
  const allowed =
    !Array.isArray(workspaceAllow) || workspaceAllow.length === 0
      ? true
      : workspaceTitle === ''
        ? true // unknown workspace: show rather than hide the user's map
        : workspaceAllow.some((name) => String(name).trim() === workspaceTitle)

  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    const observer = typeof MutationObserver === 'function' ? new MutationObserver(() => setTheme(readTheme())) : null
    if (observer && document.body) {
      observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
    }
    return () => observer && observer.disconnect()
  }, [])

  useEffect(() => {
    let cancelled = false
    fetch('/roam/api/config', { credentials: 'same-origin' })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        if (cancelled) return
        if (payload && typeof payload.basemapId === 'string') setBasemapId(payload.basemapId)
        if (payload && Array.isArray(payload.workspaces)) setWorkspaceAllow(payload.workspaces)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  // The shared poller feeds the panel and this dock from one request.
  useEffect(() => {
    if (!open) return undefined
    return subscribeTrips((payload) => {
      const rows = tripsOf(payload)
      setTrips(rows)
      setTripId((current) => {
        if (current && rows.some((row) => row.tripId === current)) return current
        return rows.length > 0 ? rows[0].tripId : null
      })
    })
  }, [open])

  // Drag the left edge to resize; the width survives a reload.
  const startDrag = useCallback(
    (event) => {
      event.preventDefault()
      dragRef.current = { startX: event.clientX, startWidth: width }
      const move = (moveEvent) => {
        const drag = dragRef.current
        if (!drag) return
        const next = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, drag.startWidth + (drag.startX - moveEvent.clientX)))
        setWidth(next)
      }
      const stop = () => {
        dragRef.current = null
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', stop)
        setWidth((value) => {
          storeWidth(value)
          return value
        })
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', stop)
    },
    [width],
  )

  const trip = useMemo(() => trips.find((row) => row.tripId === tripId) || trips[0] || null, [trips, tripId])
  const days = useMemo(() => (trip && Array.isArray(trip.days) ? trip.days : []), [trip])
  const stopName = useMemo(() => {
    if (!trip || !selectedStop) return ''
    for (const day of days) {
      for (const stop of day.stops || []) {
        if (String(stop.id) === String(selectedStop)) return stop.name || ''
      }
    }
    return ''
  }, [trip, days, selectedStop])

  // One toggle, always at the same screen position: it opens the drawer and the
  // same button collapses it. It sits above the drawer (z-index) so the drawer
  // can never swallow it.
  const toggle = (
    <button
      type="button"
      className="rp-dock-toggle"
      onClick={() => setOpen(!open)}
      aria-expanded={open}
    >
      {open ? `▸ ${STRINGS.hide}` : `🗺 ${STRINGS.panelTitle}`}
    </button>
  )

  if (!allowed) return null

  if (!open) {
    return (
      <>
        <style>{CSS}</style>
        {toggle}
      </>
    )
  }

  return (
    <>
      <style>{CSS}</style>
      {toggle}
      <section className="rp-dock" style={{ width: `${width}px` }} aria-label={STRINGS.mapLabel}>
        <div className="rp-dock-grip" onMouseDown={startDrag} role="separator" aria-label={STRINGS.resizeDock} />
        <div className="rp-dock-head">
          <span className="rp-dock-title">{trip ? trip.title || STRINGS.untitledTrip : STRINGS.panelTitle}</span>
          <button type="button" onClick={() => setOpen(false)} aria-label={STRINGS.hide} title={STRINGS.hide}>
            ✕
          </button>
        </div>
        {days.length > 0 ? (
          <div className="rp-dock-days">
            <button type="button" aria-pressed={selectedDay === null} onClick={() => setSelectedDay(null)}>
              {STRINGS.allDays}
            </button>
            {days.map((day) => (
              <button
                key={`dock-day-${day.index}`}
                type="button"
                aria-pressed={selectedDay === day.index}
                onClick={() => setSelectedDay(day.index)}
              >
                {STRINGS.day}{day.index + 1} {STRINGS.daySuffix}
              </button>
            ))}
          </div>
        ) : null}
        <div className="rp-dock-map">
          {trip ? (
            <MapLibreMap
              view={trip}
              selectedDay={selectedDay}
              selectedStopId={selectedStop}
              theme={theme}
              basemap={resolveBasemap(basemapId)}
              onSelectStop={setSelectedStop}
            />
          ) : (
            <p style={{ padding: 12, fontSize: 12 }}>{STRINGS.emptyBody}</p>
          )}
        </div>
        <div className="rp-dock-foot">{stopName || STRINGS.dockHint}</div>
      </section>
    </>
  )
}



