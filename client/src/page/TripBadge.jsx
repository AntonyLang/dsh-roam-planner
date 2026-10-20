/**
 * "Current trip" strip above the composer.
 *
 * The host binds one trip per conversation, so this badge answers "which trip
 * would this conversation edit" — the one thing the panel cannot tell you when
 * it is showing some other trip.
 *
 * `sessionId` arrives as a standard slot prop for `conversation.input.dock`.
 */
import React, { useEffect, useState } from 'react'
import { STRINGS } from './strings.js'

const CSS = `
.rp-trip-badge {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  /* Track the composer's width instead of spanning the whole conversation. */
  width: min(100%, 48rem); margin: 0 auto 6px; padding: 5px 10px;
  border-radius: var(--dsw-radius-sm, 6px);
  border: 1px solid var(--dsw-alias-border-l2, transparent);
  background: var(--dsw-alias-bg-layer-1, transparent);
  color: var(--dsw-alias-label-primary, inherit);
  font-size: 12px;
}
.rp-trip-badge .label { color: var(--dsw-alias-label-tertiary, currentColor); }
.rp-trip-badge strong { font-weight: 600; max-width: 40ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rp-trip-badge .meta { margin-left: auto; color: var(--dsw-alias-label-secondary, currentColor); font-size: 11px; }
`

export function TripBadge(props) {
  const sessionId = props && props.sessionId != null ? String(props.sessionId) : ''
  const [trip, setTrip] = useState(null)

  useEffect(() => {
    if (!sessionId) return undefined
    let cancelled = false
    const load = () => {
      fetch(`/roam/api/binding?session=${encodeURIComponent(sessionId)}`, { credentials: 'same-origin' })
        .then((response) => (response.ok ? response.json() : null))
        .then((payload) => {
          if (!cancelled) setTrip(payload && payload.trip ? payload.trip : null)
        })
        .catch(() => {})
    }
    load()
    const timer = setInterval(load, 6000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [sessionId])

  if (!trip) return null

  const status = STRINGS.status[trip.status] || trip.status || ''

  return (
    <div className="rp-trip-badge" role="status">
      <style>{CSS}</style>
      <span className="label">{STRINGS.currentTrip}</span>
      <strong title={trip.tripId}>{trip.title || STRINGS.untitledTrip}</strong>
      <span className="meta">
        {status}
        {Number.isFinite(trip.revision) ? ` · Rev ${trip.revision}` : ''}
      </span>
    </div>
  )
}
