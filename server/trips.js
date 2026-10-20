/**
 * The trip domain state machine for the roam planner host half.
 *
 * A trip is always exactly one of `draft`, `candidate`, or `adopted`:
 *   draft      -> the model (or the page) edits freely.
 *   candidate  -> a frozen copy the user can review; only a candidate is adoptable.
 *   adopted    -> committed; a second adoption fails, but editing reopens a draft.
 *
 * `revision` counts material changes (create, draft edit, adopt); `version`
 * counts candidate freezes. The HTTP contract (`client/src/contracts.js`)
 * exposes only `revision`, so `version` stays internal.
 *
 * All writes are plain JSON so both store backends can persist them verbatim.
 */

const STATUS_DRAFT = 'draft'
const STATUS_CANDIDATE = 'candidate'
const STATUS_ADOPTED = 'adopted'
export const STATUSES = [STATUS_DRAFT, STATUS_CANDIDATE, STATUS_ADOPTED]

const CRS_VALUES = ['WGS84', 'GCJ02']
const STOP_CATEGORIES = ['sight', 'food', 'stay', 'transit']
const LEG_MODES = ['walk', 'transit', 'drive']
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

/** Domain error carrying the HTTP status the routes should answer with. */
export class RoamError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'RoamError'
    this.code = code
    this.status = status
  }
}

function bad(code, message, status = 400) {
  return new RoamError(code, message, status)
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

let idCounter = 0
function newId(prefix) {
  idCounter += 1
  const time = Date.now().toString(36)
  const random = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${time}${idCounter.toString(36)}${random}`
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw bad('invalid-string', `${label} must be a non-empty string`)
  return value.trim()
}

function optionalString(value, label) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw bad('invalid-string', `${label} must be a string`)
  return value
}

function finiteNumber(value, label) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (typeof number !== 'number' || !Number.isFinite(number)) throw bad('invalid-number', `${label} must be a finite number`)
  return number
}

function nonNegativeInteger(value, label) {
  const number = finiteNumber(value, label)
  if (!Number.isInteger(number) || number < 0) throw bad('invalid-number', `${label} must be a non-negative integer`)
  return number
}

function normalizeTitle(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw bad('invalid-title', 'title must be a string')
  const title = value.trim()
  if (title === '') return 'Untitled trip'
  return title.length > 200 ? title.slice(0, 200) : title
}

function normalizeCrs(value) {
  if (value === undefined || value === null) return 'WGS84'
  if (typeof value !== 'string' || !CRS_VALUES.includes(value)) {
    throw bad('invalid-crs', `crs must be one of ${CRS_VALUES.join(', ')}`)
  }
  return value
}

function normalizeStop(raw, context, usedIds) {
  if (!isObject(raw)) throw bad('invalid-stop', `${context}: stop must be an object`)
  const lat = finiteNumber(raw.lat, `${context}.lat`)
  const lng = finiteNumber(raw.lng, `${context}.lng`)
  if (lat < -90 || lat > 90) throw bad('invalid-stop', `${context}.lat must be within [-90, 90]`)
  if (lng < -180 || lng > 180) throw bad('invalid-stop', `${context}.lng must be within [-180, 180]`)

  let id = raw.id === undefined || raw.id === null || raw.id === '' ? newId('stop') : requireString(raw.id, `${context}.id`)
  while (usedIds.has(id)) id = newId('stop')
  usedIds.add(id)

  const stop = {
    id,
    name: raw.name === undefined || raw.name === null ? '' : requireString(raw.name, `${context}.name`),
    lat,
    lng,
  }
  if (raw.start !== undefined && raw.start !== null) {
    if (typeof raw.start !== 'string' || !TIME_PATTERN.test(raw.start)) {
      throw bad('invalid-stop', `${context}.start must be a wall clock string like "09:30"`)
    }
    stop.start = raw.start
  }
  if (raw.stayMinutes !== undefined && raw.stayMinutes !== null) {
    stop.stayMinutes = nonNegativeInteger(raw.stayMinutes, `${context}.stayMinutes`)
  }
  if (raw.note !== undefined && raw.note !== null) {
    stop.note = optionalString(raw.note, `${context}.note`)
  }
  if (raw.category !== undefined && raw.category !== null) {
    if (typeof raw.category !== 'string' || !STOP_CATEGORIES.includes(raw.category)) {
      throw bad('invalid-stop', `${context}.category must be one of ${STOP_CATEGORIES.join(', ')}`)
    }
    stop.category = raw.category
  }
  return stop
}

function normalizeLeg(raw, context, stopIds) {
  if (!isObject(raw)) throw bad('invalid-leg', `${context}: leg must be an object`)
  const from = requireString(raw.from, `${context}.from`)
  const to = requireString(raw.to, `${context}.to`)
  if (!stopIds.has(from) || !stopIds.has(to)) {
    throw bad('invalid-leg', `${context} references an unknown stop id (from '${from}', to '${to}')`)
  }
  if (typeof raw.mode !== 'string' || !LEG_MODES.includes(raw.mode)) {
    throw bad('invalid-leg', `${context}.mode must be one of ${LEG_MODES.join(', ')}`)
  }
  const leg = { from, to, mode: raw.mode }
  if (raw.minutes !== undefined && raw.minutes !== null) {
    leg.minutes = nonNegativeInteger(raw.minutes, `${context}.minutes`)
  }
  if (raw.geometry !== undefined && raw.geometry !== null) {
    if (!Array.isArray(raw.geometry)) throw bad('invalid-leg', `${context}.geometry must be an array of [lat, lng] pairs`)
    leg.geometry = raw.geometry.map((point, index) => {
      if (!Array.isArray(point) || point.length !== 2) {
        throw bad('invalid-leg', `${context}.geometry[${index}] must be a [lat, lng] pair`)
      }
      return [
        finiteNumber(point[0], `${context}.geometry[${index}][0]`),
        finiteNumber(point[1], `${context}.geometry[${index}][1]`),
      ]
    })
  }
  return leg
}

function normalizeDays(raw) {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw bad('invalid-days', 'days must be an array')
  if (raw.length > 60) throw bad('invalid-days', 'days may contain at most 60 entries')

  const usedStopIds = new Set()
  return raw.map((day, index) => {
    const context = `days[${index}]`
    if (!isObject(day)) throw bad('invalid-day', `${context} must be an object`)

    let date = ''
    if (day.date !== undefined && day.date !== null) {
      if (typeof day.date !== 'string' || (day.date !== '' && !DATE_PATTERN.test(day.date))) {
        throw bad('invalid-day', `${context}.date must be "YYYY-MM-DD"`)
      }
      date = day.date
    }
    const dayIndex = day.index === undefined || day.index === null ? index : nonNegativeInteger(day.index, `${context}.index`)

    if (day.stops !== undefined && day.stops !== null && !Array.isArray(day.stops)) {
      throw bad('invalid-day', `${context}.stops must be an array`)
    }
    const stops = (day.stops ?? []).map((stop, stopIndex) => normalizeStop(stop, `${context}.stops[${stopIndex}]`, usedStopIds))
    const stopIds = new Set(stops.map((stop) => stop.id))

    if (day.legs !== undefined && day.legs !== null && !Array.isArray(day.legs)) {
      throw bad('invalid-day', `${context}.legs must be an array`)
    }
    const legs = (day.legs ?? []).map((leg, legIndex) => normalizeLeg(leg, `${context}.legs[${legIndex}]`, stopIds))

    return { index: dayIndex, date, stops, legs }
  })
}

/** Build the public TripView exactly as client/src/contracts.js declares it. */
function toView(record) {
  if (!isObject(record)) throw bad('invalid-trip', 'stored trip record is not an object', 500)
  return {
    tripId: record.tripId,
    title: record.title,
    crs: record.crs,
    status: record.status,
    revision: record.revision,
    days: clone(record.days ?? []),
    updatedAt: record.updatedAt,
  }
}

function assertStoredTrip(record, tripId) {
  if (!isObject(record) || record.tripId !== tripId || !STATUSES.includes(record.status)) {
    throw bad('invalid-trip', `stored trip '${tripId}' is malformed`, 500)
  }
}

/**
 * @param {object} options
 * @param {{ load(): Promise<object>, save(state: object): Promise<void>, describe(): object }} options.store
 * @param {object|null} [options.logger]
 * @param {() => string} [options.clock] ISO timestamp source.
 */
/**
 * @param {any} [options]
 */
export function createTripService(options = {}) {
  const { store, logger = null, clock = () => new Date().toISOString() } = options || {}
  if (!store || typeof store.load !== 'function' || typeof store.save !== 'function') {
    throw new Error('createTripService requires a store with load() and save()')
  }

  let state = null
  let loading = null
  let writeChain = Promise.resolve()

  async function ensure() {
    if (state) return state
    if (loading === null) {
      loading = Promise.resolve(store.load()).then((loaded) => {
        state = loaded
        return loaded
      })
    }
    return loading
  }

  /** Persist the current in-memory state, serialized behind the previous write. */
  function persist() {
    const run = writeChain.then(() => store.save(state))
    writeChain = run.catch(() => {})
    return run
  }

  function sessionOf(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') throw bad('invalid-session', 'a session id is required', 500)
    return sessionId
  }

  function bindSession(sessionId, tripId) {
    if (state.global.sessions[sessionId] === tripId) return false
    state.global.sessions[sessionId] = tripId
    return true
  }

  async function createTrip(rawInput = {}) {
    await ensure()
    const input = isObject(rawInput) ? rawInput : {}
    const title = normalizeTitle(input.title) ?? 'Untitled trip'
    const days = normalizeDays(input.days)
    const crs = normalizeCrs(input.crs)
    const now = clock()
    const tripId = typeof input.tripId === 'string' && input.tripId !== '' ? input.tripId : newId('trip')
    if (state.trips[tripId]) throw bad('trip-exists', `trip '${tripId}' already exists`, 409)

    const record = {
      tripId,
      title,
      crs,
      status: STATUS_DRAFT,
      revision: 1,
      version: 0,
      days,
      createdAt: now,
      updatedAt: now,
    }
    state.trips[tripId] = record
    state.drafts[tripId] = { tripId, title, days: clone(days), revision: 1, updatedAt: now }

    let dirty = true
    if (typeof input.sessionId === 'string' && input.sessionId !== '') {
      dirty = bindSession(sessionOf(input.sessionId), tripId) || dirty
    }
    if (dirty) await persist()
    return toView(record)
  }

  async function getTrip(tripId) {
    await ensure()
    const id = requireString(tripId, 'tripId')
    const record = state.trips[id]
    if (!record) throw bad('trip-not-found', `trip '${id}' was not found`, 404)
    assertStoredTrip(record, id)
    return toView(record)
  }

  async function listTrips() {
    await ensure()
    return Object.keys(state.trips)
      .map((id) => state.trips[id])
      .filter((record) => isObject(record) && STATUSES.includes(record.status))
      .sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')))
      .map(toView)
  }

  /**
   * Apply `{ title?, days? }` to the working draft. A material edit returns the
   * trip to `draft` status and discards any stale candidate.
   */
  async function updateDraft(tripId, patch = {}) {
    await ensure()
    const id = requireString(tripId, 'tripId')
    const record = state.trips[id]
    if (!record) throw bad('trip-not-found', `trip '${id}' was not found`, 404)
    assertStoredTrip(record, id)
    // An adopted trip can be replanned: a trip is never finished in practice.
    // Editing it opens a new draft revision; adoption stays a one-way gate that
    // only a candidate can pass again.
    if (!isObject(patch)) throw bad('invalid-patch', 'patch must be an object')

    const hasTitle = Object.prototype.hasOwnProperty.call(patch, 'title') && patch.title !== undefined
    const hasDays = Object.prototype.hasOwnProperty.call(patch, 'days') && patch.days !== undefined
    if (!hasTitle && !hasDays) throw bad('empty-patch', 'patch must contain title or days')

    const title = hasTitle ? normalizeTitle(patch.title) ?? record.title : record.title
    const days = hasDays ? normalizeDays(patch.days) : record.days
    const material = title !== record.title || JSON.stringify(days) !== JSON.stringify(record.days)
    const candidateDropped = state.candidates[id] !== undefined
    if (!material && record.status === STATUS_DRAFT && !candidateDropped) {
      return { tripId: id, revision: record.revision, status: record.status }
    }

    const now = clock()
    const next = {
      ...record,
      title,
      days,
      status: STATUS_DRAFT,
      revision: record.revision + 1,
      updatedAt: now,
    }
    state.trips[id] = next
    state.drafts[id] = { tripId: id, title, days: clone(days), revision: next.revision, updatedAt: now }
    delete state.candidates[id]
    await persist()
    return { tripId: id, revision: next.revision, status: next.status }
  }

  /** Freeze the draft into a candidate (`version` increments, `revision` does not). */
  async function saveCandidate(tripId) {
    await ensure()
    const id = requireString(tripId, 'tripId')
    const record = state.trips[id]
    if (!record) throw bad('trip-not-found', `trip '${id}' was not found`, 404)
    assertStoredTrip(record, id)
    if (record.status === STATUS_ADOPTED) throw bad('trip-adopted', `trip '${id}' is adopted; a candidate can no longer be saved`, 409)
    if (record.status === STATUS_CANDIDATE) throw bad('already-candidate', `trip '${id}' is already a candidate`, 409)

    const now = clock()
    const version = record.version + 1
    state.candidates[id] = {
      tripId: id,
      title: record.title,
      days: clone(record.days ?? []),
      version,
      revision: record.revision,
      createdAt: now,
    }
    const next = { ...record, status: STATUS_CANDIDATE, version, updatedAt: now }
    state.trips[id] = next
    await persist()
    return { tripId: id, status: next.status, version, revision: next.revision }
  }

  /** Commit the candidate. Only a candidate can be adopted, exactly once. */
  async function adoptCandidate(tripId) {
    await ensure()
    const id = requireString(tripId, 'tripId')
    const record = state.trips[id]
    if (!record) throw bad('trip-not-found', `trip '${id}' was not found`, 404)
    assertStoredTrip(record, id)
    if (record.status !== STATUS_CANDIDATE) {
      throw bad('not-candidate', `trip '${id}' is '${record.status}'; only a candidate can be adopted`, 409)
    }
    const candidate = state.candidates[id]
    if (!isObject(candidate)) throw bad('candidate-missing', `trip '${id}' has no candidate snapshot`, 409)

    const now = clock()
    const next = {
      ...record,
      title: candidate.title,
      days: clone(candidate.days ?? []),
      status: STATUS_ADOPTED,
      revision: record.revision + 1,
      updatedAt: now,
      // The last committed plan, kept so a later draft can be compared with it.
      baseline: {
        title: candidate.title,
        days: clone(candidate.days ?? []),
        at: now,
      },
    }
    state.trips[id] = next
    delete state.candidates[id]
    delete state.drafts[id]
    await persist()
    return toView(next)
  }

  /** The session's trip, creating an empty draft when the session has none. */
  async function ensureSessionTrip(sessionId) {
    await ensure()
    const key = sessionOf(sessionId)
    const bound = state.global.sessions[key]
    if (typeof bound === 'string' && state.trips[bound]) return toView(state.trips[bound])
    return createTrip({ title: 'Untitled trip', days: [], sessionId: key })
  }

  /**
   * Resolve a tool call's target trip: an explicit id wins and is bound to the
   * session, otherwise the session's bound trip (created on demand).
   */
  async function resolveTrip(sessionId, tripId) {
    await ensure()
    const key = sessionOf(sessionId)
    if (tripId !== undefined && tripId !== null && tripId !== '') {
      const id = requireString(tripId, 'tripId')
      const record = state.trips[id]
      if (!record) throw bad('trip-not-found', `trip '${id}' was not found`, 404)
      assertStoredTrip(record, id)
      if (bindSession(key, id)) await persist()
      return toView(record)
    }
    return ensureSessionTrip(key)
  }

  /** The trip bound to one session, without creating one. */
  async function getSessionTrip(sessionId) {
    await ensure()
    const key = sessionOf(sessionId)
    const bound = state.global.sessions[key]
    if (typeof bound === 'string' && state.trips[bound]) return toView(state.trips[bound])
    return null
  }

  /** The last adopted plan for a trip, or null when it was never adopted. */
  async function getBaseline(tripId) {
    await ensure()
    const id = requireString(tripId, 'tripId')
    const record = state.trips[id]
    if (!record) throw bad('trip-not-found', `trip '${id}' was not found`, 404)
    const baseline = record.baseline
    if (!isObject(baseline)) return null
    return {
      title: typeof baseline.title === 'string' ? baseline.title : '',
      days: Array.isArray(baseline.days) ? clone(baseline.days) : [],
      at: typeof baseline.at === 'string' ? baseline.at : null,
    }
  }

  /** Debug counter used to prove persistence survives a plugin reload. */
  async function ping() {
    await ensure()
    state.global.pingCount = (Number.isInteger(state.global.pingCount) ? state.global.pingCount : 0) + 1
    await persist()
    return state.global.pingCount
  }

  return {
    ready: () => ensure().then(() => undefined),
    describeStore: () => store.describe(),
    createTrip,
    getTrip,
    listTrips,
    updateDraft,
    saveCandidate,
    adoptCandidate,
    getBaseline,
    getSessionTrip,
    ensureSessionTrip,
    resolveTrip,
    ping,
  }
}





