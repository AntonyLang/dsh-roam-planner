/**
 * `/roam/api/*` routes for the map page.
 *
 * One `prefix` route owns the whole namespace (the host web server matches a
 * prefix on a path-segment boundary and gives the handler the raw
 * `IncomingMessage`/`ServerResponse`). Dispatch is manual so a path parameter
 * (`/trips/:id`) needs no router dependency.
 *
 * Every handler answers JSON and never lets an exception escape: known domain
 * failures map to their status (400/404/409/413), anything else to 500.
 */

import { RoamError } from './trips.js'
import { diffPlans } from './diff.js'

const BODY_LIMIT_BYTES = 1024 * 1024

function sendJson(res, status, payload) {
  if (res.headersSent) {
    res.destroy?.()
    return
  }
  const text = JSON.stringify(payload)
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  }
  res.writeHead(status, headers)
  res.end(text)
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false

    function fail(error) {
      if (settled) return
      settled = true
      reject(error)
    }

    req.on('data', (chunk) => {
      if (settled) return
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > BODY_LIMIT_BYTES) {
        // Keep draining so the 413 response can still reach the client.
        fail(new RoamError('payload-too-large', `request body exceeds ${BODY_LIMIT_BYTES} bytes`, 413))
        return
      }
      chunks.push(buffer)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      if (chunks.length === 0) {
        resolve({})
        return
      }
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') {
        resolve({})
        return
      }
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        reject(new RoamError('invalid-json', 'request body is not valid JSON', 400))
        return
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        reject(new RoamError('invalid-body', 'request body must be a JSON object', 400))
        return
      }
      resolve(parsed)
    })
    req.on('error', (error) => fail(error instanceof Error ? error : new Error(String(error))))
  })
}

function segmentsOf(req) {
  let pathname
  try {
    pathname = new URL(req.url ?? '/', 'http://localhost').pathname
  } catch {
    pathname = '/'
  }
  const parts = pathname.split('/').filter((part) => part !== '')
  if (parts[0] !== 'roam' || parts[1] !== 'api') return null
  return parts.slice(2)
}

/**
 * @param {object} ctx Plugin context with `ctx.webServer`.
 * @param {object} options
 * @param {object} options.trips Trip service.
 * @param {{basemapId: string, tileUrl: string|null}} options.config
 */
/**
 * @param {any} [options]
 * @param {any} [ctx]
 */
export function registerRoutes(ctx, options) {
  const { trips, config, sources, settings, geocoder } = options || {}
  if (!ctx?.webServer || typeof ctx.webServer.register !== 'function') {
    throw new Error('registerRoutes requires ctx.webServer')
  }

  async function dispatch(req, res) {
    const method = String(req.method ?? 'GET').toUpperCase()
    const segments = segmentsOf(req)

    if (segments === null) {
      sendJson(res, 404, { error: 'not found' })
      return
    }

    // GET /roam/api/health
    if (segments.length === 1 && segments[0] === 'health') {
      if (method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
      await trips.ready()
      const description = trips.describeStore()
      sendJson(res, 200, { ok: true, store: description?.name ?? 'uninitialized' })
      return
    }

    // GET /roam/api/config
    if (segments.length === 1 && segments[0] === 'config') {
      if (method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
      sendJson(res, 200, {
        basemapId: config.basemapId ?? null,
        basemaps: config.basemaps ?? null,
        defaultCity: config.defaultCity ?? null,
        workspaces: Array.isArray(config.workspaces) ? config.workspaces : [],
        mcpServers: Array.isArray(config.mcpServers) ? config.mcpServers.map((entry) => entry.name) : [],
        tileUrl: config.tileUrl ?? null,
      })
      return
    }

    // /roam/api/settings — the user-facing place to store the Amap key.
    // The key itself never travels back to the client.
    if (segments.length === 1 && segments[0] === 'settings') {
      if (!settings) return sendJson(res, 503, { error: 'settings are unavailable' })

      async function describe() {
        const amap = await settings.describeAmapKey()
        const enabled = Boolean(amap.configured)
        return {
          amapKey: amap,
          routing: enabled ? 'amap' : 'osrm',
          geocoding: config.geocoder === 'off' ? 'off' : enabled ? 'amap' : 'nominatim',
        }
      }

      if (method === 'GET') {
        sendJson(res, 200, await describe())
        return
      }
      if (method === 'POST') {
        const body = await readJsonBody(req)
        const key = typeof body?.amapKey === 'string' ? body.amapKey : ''
        if (key.trim() === '') return sendJson(res, 400, { error: 'amapKey is required' })
        await settings.setAmapKey(key)
        sendJson(res, 200, await describe())
        return
      }
      if (method === 'DELETE') {
        await settings.clearAmapKey()
        sendJson(res, 200, await describe())
        return
      }
      return sendJson(res, 405, { error: 'method not allowed' })
    }

    // GET /roam/api/binding?session=<id> — which trip this conversation edits.
    if (segments.length === 1 && segments[0] === 'binding') {
      if (method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
      const url = new URL(req.url || '/', 'http://localhost')
      const session = url.searchParams.get('session') || ''
      if (session === '') return sendJson(res, 400, { error: 'session is required' })
      sendJson(res, 200, { trip: await trips.getSessionTrip(session) })
      return
    }

    // /roam/api/trips
    if (segments.length === 1 && segments[0] === 'trips') {
      if (method === 'GET') {
        sendJson(res, 200, { trips: await trips.listTrips() })
        return
      }
      if (method === 'POST') {
        const body = await readJsonBody(req)
        const view = await trips.createTrip(body)
        sendJson(res, 201, view)
        return
      }
      return sendJson(res, 405, { error: 'method not allowed' })
    }

    // /roam/api/trips/:id...
    if (segments.length >= 2 && segments[0] === 'trips') {
      let tripId
      try {
        tripId = decodeURIComponent(segments[1])
      } catch {
        return sendJson(res, 400, { error: 'trip id is not valid URL encoding' })
      }

      if (segments.length === 2) {
        if (method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
        sendJson(res, 200, await trips.getTrip(tripId))
        return
      }

      const action = segments[2]
      if (segments.length === 3 && action === 'adopt') {
        if (method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
        await readJsonBody(req).catch(() => ({}))
        sendJson(res, 200, await trips.adoptCandidate(tripId))
        return
      }
      // POST /roam/api/trips/:id/ops — atomic edits from the map page.
      if (segments.length === 3 && action === 'ops') {
        if (method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
        const body = await readJsonBody(req)
        const ops = Array.isArray(body?.ops) ? body.ops : []
        if (ops.length === 0) return sendJson(res, 400, { error: 'ops must be a non-empty array' })

        const view = await trips.getTrip(tripId)
        const days = JSON.parse(JSON.stringify(Array.isArray(view.days) ? view.days : []))
        let title = view.title
        const city = typeof body.city === 'string' && body.city ? body.city : config.defaultCity || undefined

        const dayOf = (index) => days.find((day) => Number(day.index) === Number(index))
        const stopOf = (stopId) =>
          days
            .flatMap((day) => (Array.isArray(day.stops) ? day.stops.map((stop) => ({ day, stop })) : []))
            .find((entry) => String(entry.stop.id) === String(stopId))

        for (const op of ops) {
          if (!op || typeof op !== 'object') continue
          if (op.op === 'setTitle') {
            if (typeof op.title === 'string' && op.title.trim() !== '') title = op.title.trim()
            continue
          }
          if (op.op === 'updateStop') {
            const found = stopOf(op.stopId)
            if (!found) throw new RoamError('stop-not-found', `stop '${op.stopId}' was not found`, 404)
            const patch = op.patch && typeof op.patch === 'object' ? op.patch : {}
            if (typeof patch.name === 'string' && patch.name.trim() !== '') found.stop.name = patch.name.trim()
            if (typeof patch.start === 'string') found.stop.start = patch.start
            if (patch.stayMinutes === null) delete found.stop.stayMinutes
            else if (Number.isFinite(patch.stayMinutes)) found.stop.stayMinutes = Math.max(0, Math.round(patch.stayMinutes))
            if (typeof patch.note === 'string') found.stop.note = patch.note
            continue
          }
          if (op.op === 'removeStop') {
            const found = stopOf(op.stopId)
            if (!found) throw new RoamError('stop-not-found', `stop '${op.stopId}' was not found`, 404)
            found.day.stops = found.day.stops.filter((stop) => String(stop.id) !== String(op.stopId))
            found.day.legs = (Array.isArray(found.day.legs) ? found.day.legs : []).filter(
              (leg) => String(leg.from) !== String(op.stopId) && String(leg.to) !== String(op.stopId),
            )
            continue
          }
          if (op.op === 'moveStop') {
            const found = stopOf(op.stopId)
            if (!found) throw new RoamError('stop-not-found', `stop '${op.stopId}' was not found`, 404)
            const target = op.toDay === undefined ? found.day : dayOf(op.toDay)
            if (!target) throw new RoamError('day-not-found', `day '${op.toDay}' was not found`, 404)
            const fromIndex = found.day.stops.findIndex((stop) => String(stop.id) === String(op.stopId))
            if (fromIndex >= 0) found.day.stops.splice(fromIndex, 1)
            if (found.day !== target) {
              // A stop leaving a day invalidates the legs that referenced it.
              found.day.legs = (Array.isArray(found.day.legs) ? found.day.legs : []).filter(
                (leg) => String(leg.from) !== String(op.stopId) && String(leg.to) !== String(op.stopId),
              )
            }
            target.stops = Array.isArray(target.stops) ? target.stops : []
            const insertAt = Number.isInteger(op.toIndex)
              ? Math.max(0, Math.min(target.stops.length, op.toIndex))
              : target.stops.length
            target.stops.splice(insertAt, 0, found.stop)
            continue
          }
          if (op.op === 'addStop') {
            const target = dayOf(op.dayIndex)
            if (!target) throw new RoamError('day-not-found', `day '${op.dayIndex}' was not found`, 404)
            const stop = op.stop && typeof op.stop === 'object' ? op.stop : {}
            const name = typeof stop.name === 'string' ? stop.name.trim() : ''
            if (name === '') throw new RoamError('invalid-stop', 'a stop needs a name', 400)
            let lat = Number(stop.lat)
            let lng = Number(stop.lng)
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
              if (!geocoder) throw new RoamError('geocoder-unavailable', 'no geocoder is configured', 503)
              const hit = await geocoder.geocode(name, { city })
              if (!hit) throw new RoamError('place-not-found', `could not locate "${name}"`, 422)
              lat = hit.lat
              lng = hit.lng
            }
            target.stops = Array.isArray(target.stops) ? target.stops : []
            target.stops.push({
              id: `s_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
              name,
              lat,
              lng,
              ...(typeof stop.start === 'string' ? { start: stop.start } : {}),
              ...(Number.isFinite(stop.stayMinutes) ? { stayMinutes: Math.round(stop.stayMinutes) } : {}),
            })
            continue
          }
        }

        await trips.updateDraft(tripId, { title, days })
        sendJson(res, 200, await trips.getTrip(tripId))
        return
      }
      // Convenience routes the map page may use; not required by the contract.
      if (segments.length === 3 && action === 'draft') {
        if (method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
        const body = await readJsonBody(req)
        sendJson(res, 200, await trips.updateDraft(tripId, body))
        return
      }
      if (segments.length === 3 && action === 'candidate') {
        if (method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
        sendJson(res, 200, await trips.saveCandidate(tripId))
        return
      }
      // GET /roam/api/trips/:id/diff — current plan versus the last adopted one.
      if (segments.length === 3 && action === 'diff') {
        if (method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
        const view = await trips.getTrip(tripId)
        const baseline = await trips.getBaseline(tripId)
        if (!baseline) {
          sendJson(res, 200, {
            tripId,
            hasBaseline: false,
            unchanged: true,
            counts: {
              added: 0,
              removed: 0,
              moved: 0,
              retimed: 0,
              daysAdded: 0,
              daysRemoved: 0,
              datesChanged: 0,
              titleChanged: 0,
            },
          })
          return
        }
        sendJson(res, 200, { tripId, ...diffPlans(baseline, view) })
        return
      }
      // GET /roam/api/trips/:id/weather — read-only, one entry per trip day.
      if (segments.length === 3 && action === 'weather') {
        if (method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
        if (!sources) return sendJson(res, 503, { error: 'weather source is not configured' })
        const view = await trips.getTrip(tripId)
        const days = []
        for (const day of view.days || []) {
          const stop = (day.stops || []).find(
            (candidate) => Number.isFinite(candidate.lat) && Number.isFinite(candidate.lng),
          )
          if (!stop) {
            days.push({ date: day.date, place: '', tMax: null, tMin: null, precip: null })
            continue
          }
          const weather = await sources.dailyWeather(stop.lat, stop.lng, day.date, day.date)
          const hit = weather?.days?.find((row) => row.date === day.date) || weather?.days?.[0] || null
          days.push({
            date: day.date,
            place: stop.name || '',
            tMax: hit?.tMax ?? null,
            tMin: hit?.tMin ?? null,
            precip: hit?.precip ?? null,
          })
        }
        sendJson(res, 200, { tripId, provider: 'open-meteo', days })
        return
      }
    }

    sendJson(res, 404, { error: 'not found' })
  }

  async function handler(req, res) {
    try {
      await dispatch(req, res)
    } catch (error) {
      const status = error instanceof RoamError ? error.status : 500
      const message = error instanceof Error ? error.message : String(error)
      if (status >= 500) {
        try {
          ctx.logger?.error?.(error instanceof Error ? error : new Error(String(error)))
        } catch {
          /* logging must not mask the response path */
        }
      }
      sendJson(res, status, { error: message })
    }
  }

  const dispose = ctx.webServer.register({ kind: 'prefix', path: '/roam/api', handler })
  return () => {
    if (typeof dispose === 'function') dispose()
  }
}





