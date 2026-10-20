/**
 * Persistence for the roam planner host half.
 *
 * The preferred backend is the DSH storage domain form (`ctx.storageDomain`),
 * which routes the `roam_planner` unit onto whichever storage backend the
 * profile mounted (the shipped Web profile mounts `json` under
 * `$DSH_HOME/storages`). A domain spec only needs a `valueSchema.parse`
 * function per table, so no third-party schema library is imported.
 *
 * When the domain form is absent, or opening it throws, the store falls back to
 * one JSON document at `<dataDir>/.roam/store.json` and logs one line saying
 * why. Both backends implement the same tiny interface:
 *
 *   load(): Promise<State>
 *   save(state): Promise<void>
 *   close(): Promise<void>
 *
 * State is plain JSON:
 *   { trips: {id: trip}, drafts: {tripId: draft}, candidates: {tripId: candidate},
 *     global: { pingCount: number, sessions: {sessionId: tripId} } }
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Tables the trip service owns. Declared once and derived everywhere. */
export const TABLES = ['trips', 'drafts', 'candidates']

/** Domain name: must match /^[a-z][a-z0-9_]*$/ because it becomes a file name. */
const DOMAIN_NAME = 'roam_planner'
const DOMAIN_VERSION = 1

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function describeError(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

/** Empty in-memory state; callers own the returned object. */
export function emptyState() {
  return {
    trips: {},
    drafts: {},
    candidates: {},
    global: { pingCount: 0, sessions: {} },
  }
}

/**
 * A stored record is opaque JSON to the domain layer; shape is enforced by the
 * trip service, which can turn a bad record into a 400 response instead of
 * refusing to open the whole domain. A non-object still fails loudly.
 */
function recordSchema(label) {
  return {
    parse(value) {
      if (!isObject(value)) throw new Error(`${label} record must be a JSON object`)
      return value
    },
  }
}

/** Global slot: the ping counter and the session -> trip map. */
const globalSchema = {
  parse(value) {
    if (!isObject(value)) throw new Error('roam_planner global record must be a JSON object')
    const pingCount = Number.isInteger(value.pingCount) && value.pingCount >= 0 ? value.pingCount : 0
    const sessions = isObject(value.sessions) ? value.sessions : {}
    return { pingCount, sessions: { ...sessions } }
  },
}

/** Project a domain spec for the storage domain form. */
function domainSpec() {
  const tables = {}
  for (const table of TABLES) tables[table] = { valueSchema: recordSchema(table) }
  return {
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    tables,
    global: { schema: globalSchema, initial: { pingCount: 0, sessions: {} } },
  }
}

function normalizeState(raw) {
  const state = emptyState()
  if (!isObject(raw)) return state
  for (const table of TABLES) {
    const source = isObject(raw[table]) ? raw[table] : {}
    for (const [key, value] of Object.entries(source)) {
      if (isObject(value)) state[table][key] = value
    }
  }
  if (isObject(raw.global)) {
    const global = globalSchema.parse(raw.global)
    state.global.pingCount = global.pingCount
    state.global.sessions = global.sessions
  }
  return state
}

/** Resolve the optional storage domain service without requiring it. */
function lookupDomainFacility(ctx) {
  try {
    const direct = ctx?.get?.('storageDomain')
    if (direct) return direct
  } catch {
    /* ctx.get may be absent on a reduced context; fall through. */
  }
  try {
    // `ctx.storage.domain` throws when the domain form is not mounted.
    return ctx?.storage?.domain ?? null
  } catch {
    return null
  }
}

/**
 * Create the swappable store.
 *
 * @param {object} options
 * @param {object|null} [options.ctx]    Plugin context; `get('storageDomain')` is probed.
 * @param {string|null} [options.dataDir] Directory holding `.roam/store.json` for the file backend.
 * @param {object|null} [options.logger] Cordis logger; one line per backend decision.
 */
/**
 * @param {any} [options]
 */
export function createStore(options = {}) {
  const { ctx = null, dataDir = null, logger = null } = options || {}
  let ready = null
  let domain = null
  let filePath = null
  let backend = null
  let savedGlobal = null
  const saved = new Map()
  let saveChain = Promise.resolve()

  async function initialize() {
    const facility = lookupDomainFacility(ctx)
    let reason = 'ctx.storageDomain is not mounted'

    if (facility && typeof facility.open === 'function') {
      try {
        let opened
        try {
          opened = await facility.open(domainSpec())
        } catch (error) {
          // A stale handle from an earlier plugin fiber can still own the name.
          if (error && error.code === 'already-open' && typeof facility.get === 'function') {
            opened = facility.get(DOMAIN_NAME)
            if (!opened) throw error
            logger?.warn?.(`dsh-roam-planner: domain '${DOMAIN_NAME}' was already open; reusing the live handle`)
          } else {
            throw error
          }
        }
        domain = opened
        backend = { name: 'storage-domain', detail: `domain '${DOMAIN_NAME}' v${DOMAIN_VERSION}` }
        logger?.info?.(`dsh-roam-planner: persisting through storageDomain (${backend.detail})`)
      } catch (error) {
        reason = `storageDomain.open threw ${describeError(error)}`
      }
    }

    if (!domain) {
      filePath = join(dataDir || process.cwd(), '.roam', 'store.json')
      backend = { name: 'file', detail: filePath }
      logger?.info?.(`dsh-roam-planner: ${reason} -> falling back to the JSON file store at ${filePath}`)
    }
    return backend
  }

  async function ensure() {
    if (ready === null) ready = initialize()
    await ready
  }

  async function loadFromDomain() {
    const raw = {}
    for (const table of TABLES) {
      const rows = {}
      const handle = domain.table(table)
      for (const [key, value] of handle.entries()) rows[key] = value
      raw[table] = rows
      const cache = new Map()
      for (const [key, value] of Object.entries(rows)) cache.set(key, JSON.stringify(value))
      saved.set(table, cache)
    }
    let global = { pingCount: 0, sessions: {} }
    try {
      const current = domain.global.get()
      if (isObject(current)) global = current
    } catch (error) {
      logger?.warn?.(`dsh-roam-planner: could not read the domain global slot: ${describeError(error)}`)
    }
    raw.global = global
    savedGlobal = JSON.stringify(globalSchema.parse(global))
    return raw
  }

  async function loadFromFile() {
    try {
      const text = await readFile(filePath, 'utf8')
      return JSON.parse(text)
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        logger?.warn?.(`dsh-roam-planner: could not read ${filePath} (${describeError(error)}); starting empty`)
      }
      return null
    }
  }

  async function load() {
    await ensure()
    const raw = domain ? await loadFromDomain() : await loadFromFile()
    return normalizeState(raw)
  }

  async function saveToDomain(state) {
    for (const table of TABLES) {
      const cache = saved.get(table) ?? new Map()
      const desired = isObject(state[table]) ? state[table] : {}
      const handle = domain.table(table)
      const seen = new Set()
      for (const [key, value] of Object.entries(desired)) {
        seen.add(key)
        const json = JSON.stringify(value)
        if (cache.get(key) === json) continue
        await handle.put(key, clone(value))
        cache.set(key, json)
      }
      for (const key of [...cache.keys()]) {
        if (seen.has(key)) continue
        await handle.delete(key)
        cache.delete(key)
      }
      saved.set(table, cache)
    }
    const global = isObject(state.global) ? state.global : { pingCount: 0, sessions: {} }
    const globalJson = JSON.stringify(global)
    if (globalJson !== savedGlobal) {
      await domain.global.set(clone(global))
      savedGlobal = globalJson
    }
  }

  async function saveToFile(state) {
    const document = {
      version: 1,
      trips: isObject(state.trips) ? state.trips : {},
      drafts: isObject(state.drafts) ? state.drafts : {},
      candidates: isObject(state.candidates) ? state.candidates : {},
      global: isObject(state.global) ? state.global : { pingCount: 0, sessions: {} },
    }
    const text = `${JSON.stringify(document, null, 2)}\n`
    await mkdir(dirname(filePath), { recursive: true })
    const tmp = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
    await writeFile(tmp, text, 'utf8')
    await rename(tmp, filePath)
  }

  async function save(state) {
    await ensure()
    const run = saveChain.then(async () => {
      if (domain) await saveToDomain(state)
      else await saveToFile(state)
    })
    // Keep the chain alive after a rejected write so one failure does not wedge
    // every later save; the caller still observes the rejection.
    saveChain = run.catch(() => {})
    return run
  }

  async function close() {
    // Let queued writes reach the medium before releasing it.
    await saveChain.catch(() => {})
    if (!domain) return
    const handle = domain
    domain = null
    try {
      await handle.close()
    } catch (error) {
      logger?.warn?.(`dsh-roam-planner: closing domain '${DOMAIN_NAME}' failed: ${describeError(error)}`)
    }
  }

  return {
    load,
    save,
    close,
    /** Backend name for diagnostics: `storage-domain`, `file`, or `uninitialized`. */
    backendName() {
      return backend ? backend.name : 'uninitialized'
    },
    /** Backend name plus a short location, safe to expose on the health route. */
    describe() {
      return backend ? { name: backend.name, detail: backend.detail } : { name: 'uninitialized', detail: null }
    },
    /** Resolve backend selection without reading or writing data. */
    async ready() {
      await ensure()
      return backend
    },
  }
}



