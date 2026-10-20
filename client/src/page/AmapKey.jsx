/**
 * First-run Amap key prompt.
 *
 * One prominent card the first time the panel is opened without a key; after
 * that it collapses to a thin bar, and can be dismissed entirely. The key is
 * posted to the host, which stores it in the credential service — this module
 * never reads it back.
 */
import React, { useCallback, useEffect, useState } from 'react'
import { STRINGS } from './strings.js'

const DISMISS_KEY = 'dsh-roam-planner.amapPrompt'

function readDismissed() {
  try {
    return typeof window !== 'undefined' && window.localStorage
      ? window.localStorage.getItem(DISMISS_KEY) === 'seen'
      : false
  } catch (_error) {
    return false
  }
}

function markDismissed() {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(DISMISS_KEY, 'seen')
    }
  } catch (_error) {
    /* a blocked storage only costs one extra prompt. */
  }
}

const CSS = `
.rp-key-gate { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center; background: color-mix(in srgb, var(--dsw-alias-bg-base, #000) 55%, transparent); }
.rp-key-card { width: min(460px, calc(100vw - 48px)); display: flex; flex-direction: column; gap: 10px; padding: 18px; border-radius: var(--dsw-radius-lg, 12px); background: var(--dsw-alias-bg-layer-1, #1b1b1b); border: 1px solid var(--dsw-alias-border-l1, transparent); box-shadow: var(--dsw-elevation-soft, 0 12px 32px rgba(0,0,0,.35)); color: var(--dsw-alias-label-primary, inherit); font-size: 13px; }
.rp-key-card h3 { margin: 0; font-size: 16px; }
.rp-key-card p { margin: 0; line-height: 1.55; color: var(--dsw-alias-label-secondary, currentColor); }
.rp-key-card input { font: inherit; padding: 8px 10px; border-radius: var(--dsw-radius-md, 8px); border: 1px solid var(--dsw-alias-border-l1, currentColor); background: var(--dsw-alias-bg-layer-2, transparent); color: inherit; }
.rp-key-card .row { display: flex; gap: 8px; align-items: center; }
.rp-key-card button { font: inherit; padding: 6px 12px; border-radius: var(--dsw-radius-md, 8px); border: 1px solid var(--dsw-alias-border-l1, currentColor); background: var(--dsw-alias-bg-layer-2, transparent); color: inherit; cursor: pointer; }
.rp-key-card button.primary { background: var(--dsw-alias-state-success-primary, #16803c); border-color: transparent; color: var(--dsw-alias-bg-base, #fff); font-weight: 600; }
.rp-key-card button:disabled { opacity: .55; cursor: default; }
.rp-key-card .error { color: var(--dsw-alias-label-error, #e5484d); }
.rp-key-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 6px 10px; border-bottom: 1px solid var(--dsw-alias-border-l2, transparent); background: var(--dsw-alias-bg-layer-2, transparent); color: var(--dsw-alias-label-secondary, currentColor); font-size: 12px; }
.rp-key-bar button { font: inherit; padding: 3px 8px; border-radius: var(--dsw-radius-sm, 6px); border: 1px solid var(--dsw-alias-border-l1, currentColor); background: transparent; color: inherit; cursor: pointer; }
.rp-key-bar input { font: inherit; padding: 3px 8px; border-radius: var(--dsw-radius-sm, 6px); border: 1px solid var(--dsw-alias-border-l1, currentColor); background: var(--dsw-alias-bg-layer-1, transparent); color: var(--dsw-alias-label-primary, inherit); }
`

async function readSettings() {
  const response = await fetch('/roam/api/settings', {
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

async function saveKey(value) {
  const response = await fetch('/roam/api/settings', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ amapKey: value }),
  })
  const text = await response.text()
  const payload = text ? JSON.parse(text) : null
  if (!response.ok) throw new Error((payload && payload.error) || `HTTP ${response.status}`)
  return payload
}

export function AmapKeyPrompt() {
  const [configured, setConfigured] = useState(null)
  const [dismissed, setDismissed] = useState(readDismissed)
  const [expanded, setExpanded] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    readSettings()
      .then((payload) => {
        if (!cancelled) setConfigured(Boolean(payload && payload.amapKey && payload.amapKey.configured))
      })
      .catch(() => {
        if (!cancelled) setConfigured(null) // unknown: show nothing rather than nagging
      })
    return () => {
      cancelled = true
    }
  }, [])

  const dismiss = useCallback(() => {
    markDismissed()
    setDismissed(true)
    setExpanded(false)
  }, [])

  const submit = useCallback(async () => {
    if (!draft.trim() || busy) return
    setBusy(true)
    setError('')
    try {
      await saveKey(draft)
      setConfigured(true)
      setDraft('')
      markDismissed()
      setDismissed(true)
    } catch (submitError) {
      setError(submitError.message || String(submitError))
    } finally {
      setBusy(false)
    }
  }, [draft, busy])

  if (configured !== false) return null

  const input = (
    <input
      type="password"
      autoComplete="off"
      spellCheck={false}
      placeholder={STRINGS.amapKeyPlaceholder}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') void submit()
      }}
    />
  )

  if (!dismissed) {
    return (
      <div className="rp-key-gate" role="dialog" aria-modal="true" aria-label={STRINGS.amapPromptTitle}>
        <style>{CSS}</style>
        <div className="rp-key-card">
          <h3>{STRINGS.amapPromptTitle}</h3>
          <p>{STRINGS.amapPromptBody}</p>
          {input}
          {error ? <p className="error">{error}</p> : null}
          <div className="row">
            <button type="button" className="primary" disabled={busy || !draft.trim()} onClick={() => void submit()}>
              {STRINGS.save}
            </button>
            <button type="button" disabled={busy} onClick={dismiss}>
              {STRINGS.amapPromptLater}
            </button>
          </div>
          <p>{STRINGS.amapKeyHint}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="rp-key-bar" role="status">
      <style>{CSS}</style>
      <span>{STRINGS.amapBarText}</span>
      {expanded ? (
        <>
          {input}
          <button type="button" disabled={busy || !draft.trim()} onClick={() => void submit()}>
            {STRINGS.save}
          </button>
          <button type="button" onClick={() => setExpanded(false)}>
            {STRINGS.amapPromptLater}
          </button>
        </>
      ) : (
        <button type="button" onClick={() => setExpanded(true)}>
          {STRINGS.amapBarAction}
        </button>
      )}
      {error ? <span className="error">{error}</span> : null}
    </div>
  )
}
