/**
 * One shared poller for every surface that shows trips.
 *
 * The panel, the conversation dock and the badge used to poll independently
 * (4 s + 6 s + 6 s). They now share one 5 s request while at least one of them
 * is mounted, and each subscriber gets the last payload immediately.
 */

const listeners = new Set()

let timer = null
let inFlight = false
let latest = null

async function tick() {
  if (inFlight || listeners.size === 0) return
  inFlight = true
  try {
    const response = await fetch('/roam/api/trips', { credentials: 'same-origin' })
    if (!response.ok) return
    latest = await response.json()
    for (const listener of [...listeners]) listener(latest)
  } catch (_error) {
    /* a failed poll keeps the last payload; the next tick retries */
  } finally {
    inFlight = false
  }
}

/**
 * @param {(payload: unknown) => void} listener Receives the `/roam/api/trips` payload.
 * @returns {() => void} unsubscribe
 */
export function subscribeTrips(listener) {
  listeners.add(listener)
  if (latest) listener(latest)
  if (!timer) {
    void tick()
    timer = setInterval(tick, 5000)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer) {
      clearInterval(timer)
      timer = null
    }
  }
}

/** Force a refresh on the next tick (after a local edit). */
export function nudgeTrips() {
  if (timer) void tick()
}
