/**
 * Model-facing `roam_*` tools.
 *
 * Every tool keys its trip by `exec.agent.id` (the Session), so a later turn
 * resumes the same trip without the user restating it. Parameter schemas are
 * strict (`additionalProperties: false`) and every definition carries an
 * `output` schema plus a `render()` that returns text content blocks.
 */

import { STATUSES } from './trips.js'

const stopSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Stable stop id. Generated when omitted; reference it from legs.' },
    name: {
      type: 'string',
      description: 'Place name as a person would say it, e.g. "拙政园". The host geocodes it.',
    },
    lat: {
      type: 'number',
      description:
        'Optional. Omit it: the host resolves the name to coordinates. Send it only when you have a verified coordinate.',
    },
    lng: {
      type: 'number',
      description: 'Optional, see lat. Omit unless the coordinate was verified outside this tool.',
    },
    start: { type: 'string', description: 'Wall clock start time, "09:30".' },
    stayMinutes: { type: 'integer', description: 'Minutes spent at the stop.' },
    note: { type: 'string', description: 'Short free-form note.' },
    category: { type: 'string', enum: ['sight', 'food', 'stay', 'transit'] },
  },
  required: ['name'],
  additionalProperties: false,
}

const legSchema = {
  type: 'object',
  properties: {
    from: { type: 'string', description: 'Stop id the leg starts at.' },
    to: { type: 'string', description: 'Stop id the leg ends at.' },
    mode: { type: 'string', enum: ['walk', 'transit', 'drive'] },
    minutes: { type: 'integer' },
    geometry: {
      type: 'array',
      description: 'Polyline as [lat, lng] pairs.',
      items: { type: 'array', items: { type: 'number' } },
    },
  },
  required: ['from', 'to', 'mode'],
  additionalProperties: false,
}

const daySchema = {
  type: 'object',
  properties: {
    index: { type: 'integer', description: '0-based day index. Defaults to array position.' },
    date: { type: 'string', description: 'Calendar date, "YYYY-MM-DD".' },
    stops: { type: 'array', items: stopSchema },
    legs: { type: 'array', items: legSchema },
  },
  required: ['index', 'date', 'stops', 'legs'],
  additionalProperties: false,
}

const statusSchema = { type: 'string', enum: STATUSES }

const tripIdProperty = {
  type: 'string',
  description: 'Trip id from roam_get_snapshot.',
}

function textBlock(text) {
  return [{ type: 'text', text }]
}

function sessionKey(exec) {
  const id = exec?.agent?.id
  if (typeof id === 'string' && id !== '') return id
  return 'anonymous-session'
}

function requireTripId(args) {
  const tripId = args?.tripId
  if (typeof tripId !== 'string' || tripId.trim() === '') {
    throw new Error('tripId is required; read it from roam_get_snapshot')
  }
  return tripId.trim()
}

function stopLine(stop) {
  const parts = []
  if (stop.start) parts.push(stop.start)
  parts.push(stop.name || stop.id)
  const details = []
  if (stop.category) details.push(stop.category)
  if (stop.stayMinutes !== undefined) details.push(`${stop.stayMinutes} min`)
  return `  - ${parts.join(' ')}${details.length ? ` (${details.join(', ')})` : ''}`
}

function renderDays(days) {
  if (!Array.isArray(days) || days.length === 0) return ['No days planned yet.']
  const lines = []
  for (const day of days) {
    const stops = Array.isArray(day.stops) ? day.stops : []
    lines.push(`Day ${Number(day.index) + 1} (${day.date || 'undated'}): ${stops.length} stop(s), ${(day.legs ?? []).length} leg(s)`)
    for (const stop of stops) lines.push(stopLine(stop))
  }
  return lines
}

/**
 * Resolve every stop that arrived without coordinates.
 *
 * A stop may legally carry only a name; the geocoder fills lat/lng. The report
 * is returned to the model so it can see exactly where each name landed.
 */
/** How far a resolved stop may sit from its city before we distrust it. */
const MAX_CITY_DISTANCE_KM = 80

function distanceKm(a, b) {
  if (!a || !b) return 0
  const rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad
  const dLng = (b.lng - a.lng) * rad
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))
}

async function resolveStopCoordinates(days, { city, geocoder, sources }) {
  const report = []
  const resolvedDays = []
  const needsGeocoding = days.some((day) =>
    (Array.isArray(day.stops) ? day.stops : []).some(
      (stop) => !(Number.isFinite(stop.lat) && Number.isFinite(stop.lng)),
    ),
  )
  // Without a city the provider matches names country-wide; refuse rather than
  // silently dropping stops in the wrong province.
  if (needsGeocoding && !city) {
    throw new Error(
      'geocoding needs a city: pass "city" (e.g. 苏州) for every call that introduces places without coordinates',
    )
  }

  let centerCache
  const center = async () => {
    if (centerCache !== undefined) return centerCache
    centerCache = null
    const remember = (row) => {
      if (row && Number.isFinite(row.lat) && Number.isFinite(row.lng)) {
        centerCache = { lat: row.lat, lng: row.lng }
      }
    }
    try {
      if (sources && typeof sources.searchPlaces === 'function') {
        const places = await sources.searchPlaces({ keywords: city, city, limit: 1 })
        remember(Array.isArray(places) ? places[0] : null)
      }
    } catch (_error) {
      /* the centre is a safety net, not a requirement */
    }
    if (!centerCache && geocoder) {
      try {
        remember(await geocoder.geocode(city))
      } catch (_error) {
        /* ignore */
      }
    }
    return centerCache
  }

  const searchPoi = async (name) => {
    if (!sources || typeof sources.searchPlaces !== 'function') return null
    try {
      const places = await sources.searchPlaces({ keywords: name, city, limit: 1 })
      const first = Array.isArray(places) ? places[0] : null
      if (!first || !Number.isFinite(first.lat) || !Number.isFinite(first.lng)) return null
      return {
        lat: first.lat,
        lng: first.lng,
        label: first.name || first.address || '',
        provider: 'amap-poi',
        warning: '',
      }
    } catch (_error) {
      return null
    }
  }

  for (const day of days) {
    const stops = []
    for (const stop of Array.isArray(day.stops) ? day.stops : []) {
      const hasCoordinates = Number.isFinite(stop.lat) && Number.isFinite(stop.lng)
      if (hasCoordinates) {
        stops.push(stop)
        continue
      }
      if (!geocoder) {
        throw new Error(`stop "${stop.name}" has no coordinates and geocoding is disabled`)
      }
      let hit = await geocoder.geocode(stop.name, { city })
      if (!hit) {
        throw new Error(
          `could not locate "${stop.name}" in ${city}; add verified lat/lng or a clearer name`,
        )
      }

      // A hit hundreds of kilometres away means the provider matched the name
      // somewhere else. Prefer a city-scoped POI lookup, then fail loudly.
      const anchor = await center()
      if (anchor) {
        const away = distanceKm(hit, anchor)
        if (away > MAX_CITY_DISTANCE_KM) {
          const poi = await searchPoi(stop.name)
          if (poi) {
            hit = poi
          } else {
            throw new Error(
              `"${stop.name}" resolved ${Math.round(away)} km from ${city} (${hit.lat}, ${hit.lng}); send verified lat/lng or a name that is unique in that city`,
            )
          }
        }
      }

      stops.push({ ...stop, lat: hit.lat, lng: hit.lng })
      report.push({
        name: stop.name,
        lat: hit.lat,
        lng: hit.lng,
        provider: hit.provider,
        label: hit.label || '',
        warning: hit.warning || '',
      })
    }
    resolvedDays.push({ ...day, stops })
  }
  return { days: resolvedDays, report }
}

/**
 * Register every tool against the host registry.
 * @param {any} ctx
 * @param {any} trips
 * @param {any} [options]
 * @returns {() => void} disposer removing the tools again.
 */
export function registerTools(ctx, trips, options = {}) {
  if (!ctx?.tools || typeof ctx.tools.register !== 'function') throw new Error('registerTools requires ctx.tools')
  const geocoder = options.geocoder || null
  const defaultCity = typeof options.defaultCity === 'string' && options.defaultCity ? options.defaultCity : null
  const sources = options.sources || null
  const mcp = options.mcp || null
  const disposers = []

  function register(definition) {
    const dispose = ctx.tools.register(definition)
    if (typeof dispose === 'function') disposers.push(dispose)
  }

  register({
    name: 'roam_get_snapshot',
    description:
      'Read the roam trip bound to this session (creates an empty draft when the session has none). Returns tripId, title, status, revision and the full days array, plus a short readable itinerary.',
    parameters: {
      type: 'object',
      properties: {
        tripId: { ...tripIdProperty, description: 'Optional trip id; omit to use the session trip.' },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          tripId: { type: 'string' },
          title: { type: 'string' },
          status: statusSchema,
          revision: { type: 'number' },
          days: { type: 'array', items: daySchema },
        },
        required: ['tripId', 'title', 'status', 'revision', 'days'],
        additionalProperties: false,
      },
      render(_args, value) {
        const lines = [
          `Trip: ${value?.title ?? 'Untitled trip'}`,
          `Id: ${value?.tripId ?? '?'} | status: ${value?.status ?? '?'} | revision: ${value?.revision ?? '?'}`,
          ...renderDays(value?.days),
        ]
        return textBlock(lines.join('\n'))
      },
    },
    async execute(args, exec) {
      const view = await trips.resolveTrip(sessionKey(exec), args?.tripId)
      return {
        tripId: view.tripId,
        title: view.title,
        status: view.status,
        revision: view.revision,
        days: view.days,
      }
    },
  })

  register({
    name: 'roam_prepare_draft',
    description:
      'Apply a change set to the trip draft: an optional new title and an optional full replacement days array. Stops need only a name — omit lat/lng and the host resolves them by geocoding. Editing returns the trip to draft status and discards any existing candidate. Returns the new revision plus the coordinates each name resolved to.',
    parameters: {
      type: 'object',
      properties: {
        tripId: tripIdProperty,
        title: { type: 'string', description: 'Replacement trip title.' },
        city: {
          type: 'string',
          description: 'City used to disambiguate names, e.g. "苏州". Strongly recommended.',
        },
        days: { type: 'array', description: 'Full replacement itinerary; omitted means leave days unchanged.', items: daySchema },
      },
      required: ['tripId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          tripId: { type: 'string' },
          revision: { type: 'number' },
          status: statusSchema,
          title: { type: 'string' },
          geocoded: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                lat: { type: 'number' },
                lng: { type: 'number' },
                provider: { type: 'string' },
                label: { type: 'string' },
                warning: { type: 'string' },
              },
              required: ['name', 'lat', 'lng', 'provider', 'label', 'warning'],
              additionalProperties: false,
            },
          },
        },
        required: ['tripId', 'revision', 'status', 'title', 'geocoded'],
        additionalProperties: false,
      },
      render(_args, value) {
        const lines = [
          `Draft updated for "${value?.title || 'Untitled trip'}" (revision ${value?.revision ?? '?'}, status ${value?.status ?? '?'}).`,
        ]
        const hits = Array.isArray(value?.geocoded) ? value.geocoded : []
        if (hits.length > 0) {
          lines.push('Resolved place names:')
          for (const hit of hits) {
            lines.push(`  ${hit.name} -> ${hit.lat}, ${hit.lng} (${hit.provider})`)
            if (hit.warning) lines.push(`    warning: ${hit.warning}`)
          }
        }
        return textBlock(lines.join('\n'))
      },
    },
    async execute(args, exec) {
      const key = sessionKey(exec)
      const tripId = requireTripId(args)
      if (args.title === undefined && args.days === undefined) {
        throw new Error('provide title and/or days; an empty change set does nothing')
      }
      const view = await trips.resolveTrip(key, tripId)
      const patch = {}
      if (args.title !== undefined) patch.title = args.title
      let geocoded = []
      if (args.days !== undefined) {
        const resolved = await resolveStopCoordinates(args.days, {
          city: args.city ?? defaultCity,
          geocoder,
          sources,
        })
        patch.days = resolved.days
        geocoded = resolved.report
      }
      const result = await trips.updateDraft(view.tripId, patch)
      return { ...result, title: patch.title ?? view.title, geocoded }
    },
  })

  register({
    name: 'roam_update_day',
    description:
      'Replace ONE day of the trip. Unlike roam_prepare_draft it leaves the other days untouched, so two writers can work on different days without clobbering each other. Use it for incremental edits; stops without coordinates are geocoded in the given city.',
    parameters: {
      type: 'object',
      properties: {
        tripId: { type: 'string', description: 'Trip id from roam_get_snapshot.' },
        city: { type: 'string', description: 'City used to disambiguate the names in this day.' },
        day: {
          type: 'object',
          properties: {
            index: { type: 'number', description: '0-based day index; existing day is replaced, a new index is appended.' },
            date: { type: 'string', description: 'Calendar date, YYYY-MM-DD.' },
            stops: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  lat: { type: 'number' },
                  lng: { type: 'number' },
                  start: { type: 'string' },
                  stayMinutes: { type: 'number' },
                  category: { type: 'string', enum: ['sight', 'food', 'stay', 'transit'] },
                  note: { type: 'string' },
                },
                required: ['name'],
                additionalProperties: false,
              },
            },
            legs: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  from: { type: 'string' },
                  to: { type: 'string' },
                  mode: { type: 'string', enum: ['walk', 'transit', 'drive'] },
                  minutes: { type: 'number' },
                },
                required: ['from', 'to', 'mode'],
                additionalProperties: false,
              },
            },
          },
          required: ['index', 'date', 'stops', 'legs'],
          additionalProperties: false,
        },
      },
      required: ['tripId', 'day'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          tripId: { type: 'string' },
          revision: { type: 'number' },
          status: statusSchema,
          title: { type: 'string' },
          index: { type: 'number' },
          geocoded: { type: 'array', items: { type: 'object', properties: {}, additionalProperties: true } },
        },
        required: ['tripId', 'revision', 'status', 'title', 'index', 'geocoded'],
        additionalProperties: false,
      },
      render(_args, value) {
        const lines = [
          `Day ${(value?.index ?? 0) + 1} replaced in "${value?.title || 'Untitled trip'}" (revision ${value?.revision ?? '?'}).`,
        ]
        const hits = Array.isArray(value?.geocoded) ? value.geocoded : []
        for (const hit of hits) lines.push(`  ${hit.name} -> ${hit.lat}, ${hit.lng} (${hit.provider})`)
        return textBlock(lines.join('\n'))
      },
    },
    async execute(args, exec) {
      const key = sessionKey(exec)
      const tripId = requireTripId(args)
      const day = args?.day && typeof args.day === 'object' ? args.day : null
      if (!day || !Number.isFinite(day.index)) throw new Error('day.index is required')
      const view = await trips.resolveTrip(key, tripId)
      const resolved = await resolveStopCoordinates([day], {
        city: args.city ?? defaultCity,
        geocoder,
        sources,
      })
      const nextDay = resolved.days[0]
      const days = Array.isArray(view.days) ? view.days.map((row) => JSON.parse(JSON.stringify(row))) : []
      const at = days.findIndex((row) => Number(row.index) === Number(nextDay.index))
      if (at >= 0) days[at] = nextDay
      else days.push(nextDay)
      const result = await trips.updateDraft(view.tripId, { days })
      return {
        ...result,
        title: view.title,
        index: Number(nextDay.index),
        geocoded: resolved.report,
      }
    },
  })

  register({
    name: 'roam_save_candidate',
    description:
      'Freeze the current draft into a candidate so the user can review it on the map page. Only a draft can become a candidate; the candidate version increments.',
    parameters: {
      type: 'object',
      properties: { tripId: tripIdProperty },
      required: ['tripId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          tripId: { type: 'string' },
          status: statusSchema,
          version: { type: 'number' },
          revision: { type: 'number' },
        },
        required: ['tripId', 'status', 'version', 'revision'],
        additionalProperties: false,
      },
      render(_args, value) {
        return textBlock(
          `Candidate v${value?.version ?? '?'} saved for ${value?.tripId ?? '?'}. Review it on the map page, then adopt with roam_adopt.`,
        )
      },
    },
    async execute(args, exec) {
      const view = await trips.resolveTrip(sessionKey(exec), requireTripId(args))
      return trips.saveCandidate(view.tripId)
    },
  })

  register({
    name: 'roam_adopt',
    description:
      'Commit the current candidate into the adopted trip. Only a candidate can be adopted, and a trip can be adopted once; a second call fails.',
    parameters: {
      type: 'object',
      properties: { tripId: tripIdProperty },
      required: ['tripId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          tripId: { type: 'string' },
          status: statusSchema,
          revision: { type: 'number' },
        },
        required: ['tripId', 'status', 'revision'],
        additionalProperties: false,
      },
      render(_args, value) {
        return textBlock(`Trip ${value?.tripId ?? '?'} adopted at revision ${value?.revision ?? '?'}.`)
      },
    },
    async execute(args, exec) {
      const view = await trips.resolveTrip(sessionKey(exec), requireTripId(args))
      const adopted = await trips.adoptCandidate(view.tripId)
      return { tripId: adopted.tripId, status: adopted.status, revision: adopted.revision }
    },
  })

  register({
    name: 'roam_fill_routes',
    description:
      'Fill real road geometry for every leg that has none, using OSRM. Each filled leg gets a polyline and a duration; legs that already carry geometry are left untouched. Returns what changed.',
    parameters: {
      type: 'object',
      properties: { tripId: tripIdProperty },
      required: ['tripId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          tripId: { type: 'string' },
          revision: { type: 'number' },
          status: statusSchema,
          filled: { type: 'number' },
          legs: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                from: { type: 'string' },
                to: { type: 'string' },
                ok: { type: 'boolean' },
                points: { type: 'number' },
                minutes: { type: 'number' },
                meters: { type: 'number' },
              },
              required: ['from', 'to', 'ok', 'points', 'minutes', 'meters'],
              additionalProperties: false,
            },
          },
        },
        required: ['tripId', 'revision', 'status', 'filled', 'legs'],
        additionalProperties: false,
      },
      render(_args, value) {
        const lines = [
          `Routes for ${value?.tripId ?? '?'}: ${value?.filled ?? 0} filled (revision ${value?.revision ?? '?'}).`,
        ]
        for (const leg of value?.legs ?? []) {
          lines.push(
            leg.ok
              ? `  ${leg.from} -> ${leg.to}: ${leg.minutes} min, ${leg.meters} m, ${leg.points} points`
              : `  ${leg.from} -> ${leg.to}: not routed`,
          )
        }
        return textBlock(lines.join('\n'))
      },
    },
    async execute(args, exec) {
      if (!sources) throw new Error('the routing source is not configured')
      const key = sessionKey(exec)
      const tripId = requireTripId(args)
      const view = await trips.resolveTrip(key, tripId)
      const stopsById = new Map()
      for (const day of view.days) {
        for (const stop of day.stops || []) stopsById.set(String(stop.id), stop)
      }

      const report = []
      let filled = 0
      const days = []
      for (const day of view.days) {
        const legs = []
        for (const leg of day.legs || []) {
          if (Array.isArray(leg.geometry) && leg.geometry.length >= 2) {
            legs.push(leg)
            continue
          }
          const from = stopsById.get(String(leg.from))
          const to = stopsById.get(String(leg.to))
          if (!from || !to) {
            legs.push(leg)
            report.push({ from: String(leg.from), to: String(leg.to), ok: false, points: 0, minutes: 0, meters: 0 })
            continue
          }
          const route = await sources.routeLeg(from, to, leg.mode)
          if (!route) {
            legs.push(leg)
            report.push({ from: String(leg.from), to: String(leg.to), ok: false, points: 0, minutes: 0, meters: 0 })
            continue
          }
          legs.push({ ...leg, geometry: route.geometry, minutes: route.minutes })
          report.push({
            from: String(leg.from),
            to: String(leg.to),
            ok: true,
            points: route.geometry.length,
            minutes: route.minutes,
            meters: route.meters,
          })
          filled += 1
        }
        days.push({ ...day, legs })
      }

      if (filled === 0) {
        return { tripId: view.tripId, revision: view.revision, status: view.status, filled: 0, legs: report }
      }
      const updated = await trips.updateDraft(view.tripId, { days })
      return { ...updated, filled, legs: report }
    },
  })

  register({
    name: 'roam_forecast',
    description:
      "Daily weather for each day of the trip, taken at the day's first stop. Read-only: it changes no trip state. Values are null when the provider has no data for that date.",
    parameters: {
      type: 'object',
      properties: { tripId: tripIdProperty },
      required: ['tripId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          tripId: { type: 'string' },
          provider: { type: 'string' },
          days: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                date: { type: 'string' },
                place: { type: 'string' },
                // The harness accepts one scalar `type` per property, so an
                // unknown value is an omitted property rather than null.
                tMax: { type: 'number' },
                tMin: { type: 'number' },
                precip: { type: 'number' },
              },
              required: ['date', 'place'],
              additionalProperties: false,
            },
          },
        },
        required: ['tripId', 'provider', 'days'],
        additionalProperties: false,
      },
      render(_args, value) {
        const lines = [`Weather for ${value?.tripId ?? '?'} (${value?.provider ?? '?'}):`]
        for (const day of value?.days ?? []) {
          const hasRange = typeof day.tMax === 'number' && typeof day.tMin === 'number'
          const range = hasRange ? `${day.tMin}–${day.tMax}°C` : 'no data'
          const rain = typeof day.precip === 'number' ? `${day.precip}% rain` : 'rain n/a'
          lines.push(`  ${day.date} ${day.place ? day.place + ': ' : ''}${range}, ${rain}`)
        }
        return textBlock(lines.join('\n'))
      },
    },
    async execute(args, exec) {
      if (!sources) throw new Error('the weather source is not configured')
      const key = sessionKey(exec)
      const tripId = requireTripId(args)
      const view = await trips.resolveTrip(key, tripId)
      const days = []
      for (const day of view.days) {
        const stop = (day.stops || []).find(
          (candidate) => Number.isFinite(candidate.lat) && Number.isFinite(candidate.lng),
        )
        const row = { date: day.date, place: stop ? stop.name || '' : '' }
        if (stop) {
          const weather = await sources.dailyWeather(stop.lat, stop.lng, day.date, day.date)
          const hit = weather?.days?.find((entry) => entry.date === day.date) || weather?.days?.[0] || null
          if (hit && Number.isFinite(hit.tMax)) row.tMax = hit.tMax
          if (hit && Number.isFinite(hit.tMin)) row.tMin = hit.tMin
          if (hit && Number.isFinite(hit.precip)) row.precip = hit.precip
        }
        days.push(row)
      }
      return { tripId: view.tripId, provider: 'open-meteo', days }
    },
  })

  register({
    name: 'roam_search_places',
    description:
      'Search real places by keyword through Amap (restaurants, sights, stations). Use it to find candidates before putting them into a draft. Requires an Amap key in Settings.',
    parameters: {
      type: 'object',
      properties: {
        keywords: { type: 'string', description: 'What to look for, e.g. "评弹 茶馆" or "苏州博物馆".' },
        city: { type: 'string', description: 'City to search in; defaults to the configured city.' },
        limit: { type: 'integer', description: 'Maximum results, 1-20. Defaults to 8.' },
      },
      required: ['keywords'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          places: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                address: { type: 'string' },
                type: { type: 'string' },
                lat: { type: 'number' },
                lng: { type: 'number' },
              },
              required: ['name', 'address', 'type', 'lat', 'lng'],
              additionalProperties: false,
            },
          },
        },
        required: ['places'],
        additionalProperties: false,
      },
      render(_args, value) {
        const places = Array.isArray(value?.places) ? value.places : []
        if (places.length === 0) return textBlock('No places matched.')
        const lines = ['Places:']
        for (const place of places) {
          lines.push(`  ${place.name}${place.address ? ' — ' + place.address : ''} (${place.lat}, ${place.lng})`)
        }
        return textBlock(lines.join('\n'))
      },
    },
    async execute(args) {
      if (!sources || typeof sources.searchPlaces !== 'function') {
        throw new Error('place search is not configured')
      }
      const keywords = String(args?.keywords || '').trim()
      if (keywords === '') throw new Error('keywords are required')
      const places = await sources.searchPlaces({
        keywords,
        city: args.city || defaultCity || undefined,
        limit: Number.isInteger(args.limit) ? args.limit : 8,
      })
      if (!places) {
        throw new Error('place search needs an Amap key; add one in Settings → Roam Planner')
      }
      return { places }
    },
  })

  register({
    name: 'roam_mcp_servers',
    description:
      'List the external MCP sidecars this plugin can reach (railway tickets, Xiaohongshu notes, ...). Configured in the plugin config; nothing starts until a tool is called.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          servers: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                transport: { type: 'string' },
                target: { type: 'string' },
                started: { type: 'boolean' },
              },
              required: ['name', 'transport', 'target', 'started'],
              additionalProperties: false,
            },
          },
        },
        required: ['servers'],
        additionalProperties: false,
      },
      render(_args, value) {
        const servers = Array.isArray(value?.servers) ? value.servers : []
        if (servers.length === 0) return textBlock('No MCP servers are configured.')
        return textBlock(
          ['MCP servers:']
            .concat(
              servers.map(
                (server) =>
                  `  ${server.name} [${server.transport}] ${server.target} ${server.started ? 'running' : 'idle'}`,
              ),
            )
            .join('\n'),
        )
      },
    },
    async execute() {
      if (!mcp) throw new Error('the MCP bridge is not configured')
      return { servers: mcp.listServers() }
    },
  })

  register({
    name: 'roam_mcp_tools',
    description:
      'List the tools one MCP sidecar exposes. Call this before roam_mcp_call to learn exact tool names and parameters.',
    parameters: {
      type: 'object',
      properties: { server: { type: 'string', description: 'Server name from roam_mcp_servers.' } },
      required: ['server'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          tools: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                description: { type: 'string' },
                // The argument shape, compacted: without it a caller would have
                // to guess parameter names such as from_station or time_from.
                schema: { type: 'string' },
              },
              required: ['name', 'description', 'schema'],
              additionalProperties: false,
            },
          },
        },
        required: ['tools'],
        additionalProperties: false,
      },
      render(_args, value) {
        const tools = Array.isArray(value?.tools) ? value.tools : []
        if (tools.length === 0) return textBlock('That server exposes no tools.')
        const lines = ['Tools:']
        for (const tool of tools) {
          lines.push(`  ${tool.name} — ${tool.description}`)
          if (tool.schema) lines.push(`    arguments: ${tool.schema}`)
        }
        return textBlock(lines.join('\n'))
      },
    },
    async execute(args) {
      if (!mcp) throw new Error('the MCP bridge is not configured')
      const server = String(args?.server || '').trim()
      if (server === '') throw new Error('server is required')
      const tools = await mcp.listTools(server)
      return {
        tools: tools.map((tool) => {
          let schema = ''
          try {
            schema = tool.inputSchema ? JSON.stringify(tool.inputSchema) : ''
          } catch (_error) {
            schema = ''
          }
          if (schema.length > 1200) schema = `${schema.slice(0, 1200)}…`
          return { name: tool.name, description: tool.description, schema }
        }),
      }
    },
  })

  register({
    name: 'roam_mcp_call',
    description:
      'Call one tool on an MCP sidecar and return its text. Use roam_mcp_tools first to learn the tool name and its argument shape. Very long answers are truncated, so prefer a sidecar tool that accepts narrowing parameters.',
    parameters: {
      type: 'object',
      properties: {
        server: { type: 'string' },
        tool: { type: 'string' },
        arguments: { type: 'object', description: 'Arguments for that tool, matching its input schema.' },
      },
      required: ['server', 'tool'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          isError: { type: 'boolean' },
        },
        required: ['text', 'isError'],
        additionalProperties: false,
      },
      render(_args, value) {
        return textBlock(String(value?.text || (value?.isError ? 'The tool reported an error.' : '')))
      },
    },
    async execute(args) {
      if (!mcp) throw new Error('the MCP bridge is not configured')
      const server = String(args?.server || '').trim()
      const tool = String(args?.tool || '').trim()
      if (server === '' || tool === '') throw new Error('server and tool are required')
      const result = await mcp.callTool(server, tool, args.arguments || {})
      return { text: result.text || '', isError: Boolean(result.isError) }
    },
  })

  register({
    name: 'roam_ping',
    description: 'Debug: increment the persisted roam counter and return its new value. Proves the store survives a plugin reload.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { count: { type: 'number' } },
        required: ['count'],
        additionalProperties: false,
      },
      render(_args, value) {
        return textBlock(`Store is alive. Counter: ${value?.count ?? '?'}.`)
      },
    },
    async execute() {
      const count = await trips.ping()
      return { count }
    },
  })

  return () => {
    for (const dispose of disposers.splice(0).reverse()) {
      try {
        dispose()
      } catch {
        /* Disposal must not fail plugin unload. */
      }
    }
  }
}


