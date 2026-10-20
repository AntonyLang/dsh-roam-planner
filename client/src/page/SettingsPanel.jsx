/**
 * Settings surface for the plugin: the Amap Web-service key.
 *
 * The key is a secret, so it is written to the host credential service and
 * never read back into this page; the page only learns whether it is set and
 * which provider each capability currently uses.
 */
import React, { useCallback, useEffect, useState } from 'react'
import { STRINGS } from './strings.js'

async function request(method) {
  const response = await fetch('/roam/api/settings', {
    method,
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  })
  const text = await response.text()
  const payload = text ? JSON.parse(text) : null
  if (!response.ok) {
    const detail = payload && payload.error
    const fallback =
      response.status === 404 || response.status === 405
        ? STRINGS.hostUnavailable
        : `HTTP ${response.status}`
    throw new Error(detail || fallback)
  }
  return payload
}

const CSS = `
.rp-settings { display: flex; flex-direction: column; gap: 10px; max-width: 560px; padding: 4px 2px; color: var(--dsw-alias-label-primary, inherit); font-size: 13px; }
.rp-settings h2 { margin: 0; font-size: 16px; font-weight: 600; }
.rp-settings .muted { color: var(--dsw-alias-label-tertiary, currentColor); line-height: 1.5; margin: 0; }
.rp-settings label { font-size: 12px; color: var(--dsw-alias-label-secondary, currentColor); }
.rp-settings input {
  font: inherit; padding: 8px 10px; border-radius: var(--dsw-radius-md, 8px);
  border: 1px solid var(--dsw-alias-border-l1, currentColor);
  background: var(--dsw-alias-bg-layer-1, transparent);
  color: var(--dsw-alias-label-primary, inherit);
}
.rp-settings input:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, currentColor); outline-offset: 1px; }
.rp-settings .row { display: flex; gap: 8px; flex-wrap: wrap; }
.rp-settings button {
  font: inherit; padding: 6px 12px; cursor: pointer;
  border-radius: var(--dsw-radius-md, 8px);
  border: 1px solid var(--dsw-alias-border-l1, currentColor);
  background: var(--dsw-alias-bg-layer-1, transparent);
  color: var(--dsw-alias-label-primary, inherit);
}
.rp-settings button.primary { background: var(--dsw-alias-state-success-primary, transparent); border-color: transparent; color: var(--dsw-alias-bg-base, white); font-weight: 600; }
.rp-settings button:disabled { opacity: .55; cursor: default; }
.rp-settings .status { margin: 0; padding: 8px 10px; border-radius: var(--dsw-radius-sm, 6px); background: var(--dsw-alias-bg-layer-2, transparent); }
.rp-settings .status.ok { color: var(--dsw-alias-state-success-primary, inherit); }
.rp-settings .status.warn { color: var(--dsw-alias-label-tertiary, inherit); }
.rp-settings .status.error { color: var(--dsw-alias-label-error, inherit); }
`

export function SettingsPanel() {
  const [state, setState] = useState({ loading: true, data: null, error: '' })
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    try {
      const data = await request('GET')
      setState({ loading: false, data, error: '' })
    } catch (error) {
      setState({ loading: false, data: null, error: error.message || String(error) })
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Which external MCP sidecars this deployment already wired.
  const [mcpServers, setMcpServers] = useState(null)
  useEffect(() => {
    let cancelled = false
    fetch('/roam/api/config', { credentials: 'same-origin' })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        if (!cancelled) setMcpServers(Array.isArray(payload?.mcpServers) ? payload.mcpServers : [])
      })
      .catch(() => {
        if (!cancelled) setMcpServers([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  const send = useCallback(
    async (method, body) => {
      setBusy(true)
      setNotice('')
      try {
        const response = await fetch('/roam/api/settings', {
          method,
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: body ? JSON.stringify(body) : undefined,
        })
        const text = await response.text()
        const payload = text ? JSON.parse(text) : null
        if (!response.ok) {
          const detail = payload && payload.error
          const fallback =
            response.status === 404 || response.status === 405
              ? STRINGS.hostUnavailable
              : `HTTP ${response.status}`
          throw new Error(detail || fallback)
        }
        setState({ loading: false, data: payload, error: '' })
        setDraft('')
        setNotice(method === 'DELETE' ? STRINGS.amapKeyCleared : STRINGS.amapKeySaved)
      } catch (error) {
        setNotice(error.message || String(error))
      } finally {
        setBusy(false)
      }
    },
    [],
  )

  const data = state.data
  const amap = data && data.amapKey ? data.amapKey : null
  const configured = Boolean(amap && amap.configured)
  // Recommendations are per integration: configuring one hides only its card.
  const configuredNames = Array.isArray(mcpServers) ? mcpServers.map((name) => String(name).toLowerCase()) : []
  const showRailway =
    mcpServers !== null && !configuredNames.some((name) => name.includes('rail') || name.includes('12306'))
  const showXhs =
    mcpServers !== null && !configuredNames.some((name) => name.includes('xhs') || name.includes('xiaohongshu'))
  const provider = (name) => (name === 'amap' ? 'Amap' : name === 'osrm' ? 'OSRM' : name === 'nominatim' ? 'OpenStreetMap' : name === 'off' ? 'off' : '?')

  let statusText = STRINGS.settingsLoading
  if (state.error) statusText = state.error
  else if (data) {
    statusText = configured
      ? `${STRINGS.amapKeyConfigured}${amap.source ? ` (${amap.source})` : ''} · ${STRINGS.routingLabel}: ${provider(data.routing)} · ${STRINGS.geocodingLabel}: ${provider(data.geocoding)}`
      : `${STRINGS.amapKeyMissing} · ${STRINGS.routingLabel}: ${provider(data.routing)} · ${STRINGS.geocodingLabel}: ${provider(data.geocoding)}`
  }

  return (
    <section className="rp-settings" aria-label={STRINGS.settingsTitle}>
      <style>{CSS}</style>
      <h2>{STRINGS.settingsTitle}</h2>
      <p className="muted">{STRINGS.settingsIntro}</p>

      <label htmlFor="roam-amap-key">{STRINGS.amapKeyLabel}</label>
      <input
        id="roam-amap-key"
        type="password"
        autoComplete="off"
        spellCheck={false}
        placeholder={STRINGS.amapKeyPlaceholder}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        disabled={busy}
      />

      <div className="row">
        <button
          type="button"
          className="primary"
          disabled={busy || draft.trim() === ''}
          onClick={() => void send('POST', { amapKey: draft })}
        >
          {STRINGS.save}
        </button>
        <button type="button" disabled={busy || !configured} onClick={() => void send('DELETE')}>
          {STRINGS.clear}
        </button>
      </div>

      <p className={`status ${state.error ? 'error' : configured ? 'ok' : 'warn'}`}>{statusText}</p>
      {notice ? <p className="muted">{notice}</p> : null}
      <p className="muted">{STRINGS.amapKeyHint}</p>

      <hr className="rp-sep" />
      <h3>{STRINGS.mcpTitle}</h3>
      {mcpServers === null ? (
        <p className="muted">{STRINGS.mcpLoading}</p>
      ) : (
        <>
          <p className="muted">
            {mcpServers.length > 0
              ? `${STRINGS.mcpConfigured}: ${mcpServers.join(', ')}`
              : STRINGS.mcpEmpty}
          </p>
          {showRailway ? (
            <>
              <ul className="rp-mcp-list">
                <li>
                  <a href="https://github.com/drfccv/mcp-server-12306" target="_blank" rel="noreferrer">
                    12306 车票
                  </a>
                  <span className="muted"> — {STRINGS.mcpRailwayHint}</span>
                </li>
              </ul>
              <pre className="rp-mcp-snippet">{STRINGS.mcpSnippet}</pre>
            </>
          ) : null}
          {showXhs ? (
            <>
              <ul className="rp-mcp-list">
                <li>
                  <a href="https://github.com/xpzouying/xiaohongshu-mcp" target="_blank" rel="noreferrer">
                    小红书笔记
                  </a>
                  <span className="muted"> — {STRINGS.mcpXhsHint}</span>
                </li>
              </ul>
              <pre className="rp-mcp-snippet">{STRINGS.mcpXhsSnippet}</pre>
            </>
          ) : null}
        </>
      )}
    </section>
  )
}
