/**
 * Inline editor for the selected stop: rename, retime, delete.
 *
 * Edits go through the host's atomic `/ops` route, so the page never rewrites
 * the whole itinerary and an agent edit in the conversation cannot be clobbered
 * by a stale copy.
 */
import React, { useEffect, useState } from 'react'
import { STRINGS } from './strings.js'

const CSS = `
.rp-stop-editor { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
.rp-stop-editor label { display: flex; flex-direction: column; gap: 3px; font-size: 11px; color: var(--dsw-alias-label-tertiary, currentColor); }
.rp-stop-editor input {
  font: inherit; font-size: 12px; padding: 5px 8px; border-radius: var(--dsw-radius-sm, 6px);
  border: 1px solid var(--dsw-alias-border-l1, currentColor);
  background: var(--dsw-alias-bg-layer-2, transparent);
  color: var(--dsw-alias-label-primary, inherit);
}
.rp-stop-editor input:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, currentColor); outline-offset: 1px; }
.rp-stop-editor .row { display: flex; gap: 8px; align-items: flex-end; flex-wrap: wrap; }
.rp-stop-editor .row label { flex: 1 1 90px; }
.rp-stop-editor button {
  font: inherit; font-size: 12px; padding: 5px 10px; border-radius: var(--dsw-radius-sm, 6px);
  border: 1px solid var(--dsw-alias-border-l1, currentColor); background: transparent; color: inherit; cursor: pointer;
}
.rp-stop-editor button.primary { background: var(--dsw-alias-state-success-primary, #16803c); border-color: transparent; color: var(--dsw-alias-bg-base, #fff); font-weight: 600; }
.rp-stop-editor button:disabled { opacity: .5; cursor: default; }
`

export function StopEditor({ stop, busy, onSave, onDelete }) {
  const initialName = stop.name || ''
  const initialStart = stop.start || ''
  const initialStay = Number.isFinite(stop.stayMinutes) ? String(stop.stayMinutes) : ''

  const [name, setName] = useState(initialName)
  const [start, setStart] = useState(initialStart)
  const [stay, setStay] = useState(initialStay)

  useEffect(() => {
    setName(stop.name || '')
    setStart(stop.start || '')
    setStay(Number.isFinite(stop.stayMinutes) ? String(stop.stayMinutes) : '')
  }, [stop.id, stop.name, stop.start, stop.stayMinutes])

  const dirty = name !== initialName || start !== initialStart || stay !== initialStay

  return (
    <div className="rp-stop-editor">
      <style>{CSS}</style>
      <label>
        {STRINGS.stopNameLabel}
        <input value={name} onChange={(event) => setName(event.target.value)} disabled={busy} />
      </label>
      <div className="row">
        <label>
          {STRINGS.startLabel}
          <input
            value={start}
            placeholder="09:30"
            onChange={(event) => setStart(event.target.value)}
            disabled={busy}
          />
        </label>
        <label>
          {STRINGS.stayLabel}
          <input
            type="number"
            min="0"
            value={stay}
            onChange={(event) => setStay(event.target.value)}
            disabled={busy}
          />
        </label>
      </div>
      <div className="row">
        <button
          type="button"
          className="primary"
          disabled={busy || !dirty || name.trim() === ''}
          onClick={() =>
            onSave({
              name: name.trim(),
              start,
              stayMinutes: stay === '' ? null : Number(stay),
            })
          }
        >
          {STRINGS.save}
        </button>
        <button type="button" disabled={busy} onClick={() => onDelete()}>
          {STRINGS.delete}
        </button>
      </div>
    </div>
  )
}
