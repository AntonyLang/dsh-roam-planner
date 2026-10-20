/**
 * Smoke test for the roam planner host half.
 *
 * Runs the plugin against fake Cordis registries:
 *   1. file backend in a temp directory: ping twice, reload, ping again;
 *   2. state machine: snapshot -> prepare draft -> candidate -> adopt -> reject;
 *   3. HTTP routes over mock IncomingMessage/ServerResponse objects;
 *   4. storage-domain backend over a fake domain facility.
 *
 * Any failed assertion rejects the top-level promise and sets exit code 1.
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, Config } from '../../index.js'

const SESSION = 'session-test'

function createFakeContext(services = {}) {
  const tools = new Map()
  const routes = []
  const effects = []
  const logger = { info() {}, warn() {}, error() {}, debug() {} }

  const ctx = {
    logger,
    tools: {
      register(definition) {
        if (tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`)
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {
          const at = routes.indexOf(route)
          if (at !== -1) routes.splice(at, 1)
        }
      },
    },
    get(name) {
      return services[name]
    },
    effect(callback) {
      const dispose = callback()
      effects.push(dispose)
      return dispose
    },
  }

  return { ctx, tools, routes, effects, services }
}

async function disposeAll(context) {
  for (const dispose of context.effects.splice(0)) {
    if (typeof dispose === 'function') await dispose()
  }
}

function toolExec(sessionId = SESSION) {
  return {
    agent: { id: sessionId },
    callId: 'call-smoke',
    signal: new AbortController().signal,
    deferContext() {},
    concludeTurn() {},
  }
}

async function callTool(context, name, args = {}) {
  const definition = context.tools.get(name)
  assert.ok(definition, `tool ${name} is registered`)
  const value = await definition.execute(args, toolExec())
  assert.ok(definition.output && definition.output.schema, `${name} declares an output schema`)
  const blocks = definition.output.render(args, value)
  assert.ok(Array.isArray(blocks) && blocks.length > 0, `${name} render() returns content blocks`)
  assert.equal(blocks[0].type, 'text')
  return value
}

/** Mock IncomingMessage. Body chunks are emitted after the handler subscribes. */
function makeRequest(method, path, body) {
  const req = new EventEmitter()
  req.method = method
  req.url = path
  req.headers = { host: '127.0.0.1', 'content-type': 'application/json' }
  req.destroy = () => {}
  req._body = body
  return req
}

function makeResponse() {
  return {
    statusCode: 0,
    headers: {},
    headersSent: false,
    body: '',
    finished: null,
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers ?? {}
      this.headersSent = true
    },
    end(text) {
      if (text !== undefined) this.body += String(text)
      this.finished?.()
    },
    destroy() {
      this.finished?.()
    },
  }
}

async function httpCall(context, method, path, body) {
  const route = context.routes.find((candidate) => path === candidate.path || path.startsWith(`${candidate.path}/`))
  assert.ok(route, `a route owns ${path}`)
  const req = makeRequest(method, path, body)
  const res = makeResponse()
  const done = new Promise((resolve) => {
    res.finished = resolve
  })
  Promise.resolve(route.handler(req, res)).catch(() => {})
  if (body !== undefined) {
    setImmediate(() => {
      req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8'))
      req.emit('end')
    })
  } else {
    setImmediate(() => req.emit('end'))
  }
  await done
  let json = null
  if (res.body !== '') {
    try {
      json = JSON.parse(res.body)
    } catch {
      json = null
    }
  }
  return { status: res.statusCode, headers: res.headers, json, text: res.body }
}

function sampleDays() {
  return [
    {
      index: 0,
      date: '2026-11-01',
      stops: [
        { id: 's-tokyo', name: 'Sensoji', lat: 35.7148, lng: 139.7967, start: '09:30', stayMinutes: 90, category: 'sight' },
        { id: 's-lunch', name: 'Ramen shop', lat: 35.712, lng: 139.79, category: 'food' },
      ],
      legs: [{ from: 's-tokyo', to: 's-lunch', mode: 'walk', minutes: 12 }],
    },
    {
      index: 1,
      date: '2026-11-02',
      stops: [{ id: 's-skytree', name: 'Skytree', lat: 35.7101, lng: 139.8107, category: 'sight' }],
      legs: [],
    },
  ]
}

function assertTripView(view, label) {
  assert.ok(view && typeof view === 'object', `${label} is an object`)
  assert.deepEqual(
    Object.keys(view).sort(),
    ['crs', 'days', 'revision', 'status', 'title', 'tripId', 'updatedAt'],
    `${label} matches the TripView shape exactly`,
  )
  assert.equal(typeof view.tripId, 'string')
  assert.equal(typeof view.title, 'string')
  assert.ok(['WGS84', 'GCJ02'].includes(view.crs))
  assert.ok(['draft', 'candidate', 'adopted'].includes(view.status))
  assert.equal(typeof view.revision, 'number')
  assert.ok(Array.isArray(view.days))
}

function assertStrictToolSchemas(context) {
  for (const name of ['roam_get_snapshot', 'roam_prepare_draft', 'roam_save_candidate', 'roam_adopt', 'roam_ping']) {
    const definition = context.tools.get(name)
    assert.ok(definition, `${name} is registered`)
    assert.equal(definition.parameters.type, 'object', `${name} parameters are an object schema`)
    assert.equal(definition.parameters.additionalProperties, false, `${name} rejects unknown parameters`)
    assert.ok(Array.isArray(definition.parameters.required), `${name} declares required`)
    assert.equal(typeof definition.description, 'string')
    assert.ok(definition.output.render instanceof Function)
  }
}

function createFakeDomainFacility() {
  const tables = { trips: new Map(), drafts: new Map(), candidates: new Map() }
  const counters = { opens: 0, closes: 0, globalWrites: 0 }
  let globalValue = null
  let specSeen = null

  function tableHandle(name) {
    const map = tables[name]
    return {
      get: (key) => map.get(key),
      keys: () => map.keys(),
      entries: () => map.entries(),
      get size() {
        return map.size
      },
      async put(key, value) {
        map.set(key, value)
      },
      async delete(key) {
        return map.delete(key)
      },
      async update(key, update) {
        const next = update(map.get(key))
        map.set(key, next)
        return next
      },
    }
  }

  const facility = {
    counters,
    tables,
    spec() {
      return specSeen
    },
    getGlobal() {
      return globalValue
    },
    async open(spec) {
      counters.opens += 1
      specSeen = spec
      for (const table of ['trips', 'drafts', 'candidates']) {
        assert.ok(spec.tables[table], `domain spec declares table ${table}`)
        assert.equal(typeof spec.tables[table].valueSchema.parse, 'function')
      }
      return {
        name: spec.name,
        get global() {
          return {
            get: () => globalValue ?? spec.global.initial,
            set: async (value) => {
              counters.globalWrites += 1
              globalValue = value
            },
          }
        },
        table: (name) => tableHandle(name),
        close: async () => {
          counters.closes += 1
        },
      }
    },
    get() {
      return undefined
    },
    async closeAll() {},
  }
  return facility
}

async function testConfigSchema() {
  const defaults = Config['~standard'].validate({})
  assert.ok(!defaults.issues, 'empty config validates')
  assert.deepEqual(defaults.value, { basemapId: 'osm', basemaps: null, tileUrl: null, dataDir: null, geocoder: 'nominatim', amapKey: null, defaultCity: null, workspaces: [], mcpServers: [] })

  const full = Config['~standard'].validate({ basemapId: 'amap', tileUrl: 'https://tiles/{z}/{x}/{y}.png', dataDir: 'C:/tmp' })
  assert.ok(!full.issues, 'explicit config validates')
  assert.equal(full.value.basemapId, 'amap')

  const invalid = Config['~standard'].validate({ basemapId: '' })
  assert.ok(Array.isArray(invalid.issues) && invalid.issues.length === 1, 'empty basemapId reports an issue')
}

async function testFileBackendAndStateMachine() {
  const dir = await mkdtemp(join(tmpdir(), 'roam-planner-file-'))
  try {
    const first = createFakeContext()
    apply(first.ctx, { dataDir: dir, geocoder: 'off' })
    assertStrictToolSchemas(first)

    // ping twice, then reload the plugin against the same directory
    const ping1 = await callTool(first, 'roam_ping')
    const ping2 = await callTool(first, 'roam_ping')
    assert.deepEqual([ping1.count, ping2.count], [1, 2], 'counter increments')

    const persisted = JSON.parse(await readFile(join(dir, '.roam', 'store.json'), 'utf8'))
    assert.equal(persisted.global.pingCount, 2, 'counter reached the JSON file')

    await disposeAll(first)
    assert.equal(first.tools.size, 0, 'tools are removed on dispose')
    assert.equal(first.routes.length, 0, 'routes are removed on dispose')

    const second = createFakeContext()
    apply(second.ctx, { dataDir: dir, geocoder: 'off' })
    const ping3 = await callTool(second, 'roam_ping')
    assert.equal(ping3.count, 3, 'counter survives a plugin reload')

    // snapshot creates an empty draft for the session
    const snapshot = await callTool(second, 'roam_get_snapshot')
    assert.equal(snapshot.status, 'draft')
    assert.equal(snapshot.revision, 1)
    assert.deepEqual(snapshot.days, [])
    assert.equal(typeof snapshot.tripId, 'string')
    const tripId = snapshot.tripId

    // a second snapshot for the same session resumes the same trip
    const again = await callTool(second, 'roam_get_snapshot')
    assert.equal(again.tripId, tripId, 'session binding resumes the same trip')

    // prepare a real draft
    const prepared = await callTool(second, 'roam_prepare_draft', { tripId, title: 'Tokyo weekend', days: sampleDays() })
    assert.equal(prepared.revision, 2, 'draft edit bumps revision')
    assert.equal(prepared.status, 'draft')

    const drafted = await callTool(second, 'roam_get_snapshot', { tripId })
    assert.equal(drafted.title, 'Tokyo weekend')
    assert.equal(drafted.days.length, 2)

    // adopting a draft must fail
    await assert.rejects(
      () => callTool(second, 'roam_adopt', { tripId }),
      /not a candidate|only a candidate/i,
      'a draft cannot be adopted',
    )

    // candidate, then adopt
    const candidate = await callTool(second, 'roam_save_candidate', { tripId })
    assert.equal(candidate.status, 'candidate')
    assert.equal(candidate.version, 1, 'candidate version increments')
    assert.equal(candidate.revision, 2, 'saving a candidate does not bump revision')

    await assert.rejects(
      () => callTool(second, 'roam_save_candidate', { tripId }),
      /already a candidate/i,
      'a candidate cannot be saved twice',
    )

    const adopted = await callTool(second, 'roam_adopt', { tripId })
    assert.equal(adopted.status, 'adopted')
    assert.equal(adopted.revision, 3, 'adoption bumps revision')

    await assert.rejects(
      () => callTool(second, 'roam_adopt', { tripId }),
      /only a candidate can be adopted/i,
      'adopting twice is rejected',
    )
    await assert.rejects(
      () => callTool(second, 'roam_save_candidate', { tripId }),
      /adopted/i,
      'an adopted trip cannot become a candidate',
    )
    const replanned = await callTool(second, 'roam_prepare_draft', { tripId, title: 'Replanned' })
    assert.equal(replanned.status, 'draft', 'editing an adopted trip reopens a draft')
    assert.ok(replanned.revision > adopted.revision, 'replanning bumps the revision')

    // HTTP surface
    const health = await httpCall(second, 'GET', '/roam/api/health')
    assert.equal(health.status, 200)
    assert.deepEqual(health.json, { ok: true, store: 'file' })

    const config = await httpCall(second, 'GET', '/roam/api/config')
    assert.equal(config.status, 200)
    assert.deepEqual(config.json, { basemapId: 'osm', basemaps: null, defaultCity: null, workspaces: [], mcpServers: [], tileUrl: null })

    const created = await httpCall(second, 'POST', '/roam/api/trips', {
      title: 'Osaka',
      days: [{ index: 0, date: '2026-12-01', stops: [], legs: [] }],
    })
    assert.equal(created.status, 201, 'POST /trips creates')
    assertTripView(created.json, 'created TripView')
    assert.equal(created.json.status, 'draft')

    const listed = await httpCall(second, 'GET', '/roam/api/trips')
    assert.equal(listed.status, 200)
    assert.equal(listed.json.trips.length, 2, 'list includes the session trip and the created trip')
    for (const view of listed.json.trips) assertTripView(view, 'listed TripView')

    const fetched = await httpCall(second, 'GET', `/roam/api/trips/${created.json.tripId}`)
    assert.equal(fetched.status, 200)
    assertTripView(fetched.json, 'fetched TripView')
    assert.equal(fetched.json.tripId, created.json.tripId)

    const missing = await httpCall(second, 'GET', '/roam/api/trips/trip_missing')
    assert.equal(missing.status, 404)
    assert.equal(typeof missing.json.error, 'string')

    const adoptDraft = await httpCall(second, 'POST', `/roam/api/trips/${created.json.tripId}/adopt`)
    assert.equal(adoptDraft.status, 409, 'adopting a draft over HTTP is a 409')
    assert.equal(typeof adoptDraft.json.error, 'string')

    // Editing after a candidate invalidates it: the trip returns to draft and
    // the stale candidate can no longer be adopted.
    const candidateForEdit = await httpCall(second, 'POST', `/roam/api/trips/${created.json.tripId}/candidate`)
    assert.equal(candidateForEdit.status, 200)
    const edited = await httpCall(second, 'POST', `/roam/api/trips/${created.json.tripId}/draft`, { title: 'Osaka revised' })
    assert.equal(edited.status, 200)
    assert.equal(edited.json.status, 'draft', 'editing a candidate returns the trip to draft')
    assert.equal(edited.json.revision, 2, 'the draft edit bumped revision')
    const adoptStale = await httpCall(second, 'POST', `/roam/api/trips/${created.json.tripId}/adopt`)
    assert.equal(adoptStale.status, 409, 'a stale candidate cannot be adopted after an edit')

    const candidateHttp = await httpCall(second, 'POST', `/roam/api/trips/${created.json.tripId}/candidate`)
    assert.equal(candidateHttp.status, 200)
    assert.equal(candidateHttp.json.status, 'candidate')
    assert.equal(candidateHttp.json.version, 2, 'candidate version increments across freezes')
    const adoptHttp = await httpCall(second, 'POST', `/roam/api/trips/${created.json.tripId}/adopt`)
    assert.equal(adoptHttp.status, 200)
    assertTripView(adoptHttp.json, 'adopted TripView')
    assert.equal(adoptHttp.json.status, 'adopted')

    const adoptTwice = await httpCall(second, 'POST', `/roam/api/trips/${created.json.tripId}/adopt`)
    assert.equal(adoptTwice.status, 409, 'adopting twice over HTTP is a 409')

    const unknown = await httpCall(second, 'GET', '/roam/api/nope')
    assert.equal(unknown.status, 404)

    const badJson = await httpCall(second, 'POST', '/roam/api/trips', '{not json')
    assert.equal(badJson.status, 400, 'invalid JSON is a 400')
    assert.equal(typeof badJson.json.error, 'string')

    const badDays = await httpCall(second, 'POST', '/roam/api/trips', { days: [{ date: 'nope' }] })
    assert.equal(badDays.status, 400, 'invalid days are a 400')

    await disposeAll(second)
    assert.equal(second.routes.length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function testDomainBackend() {
  const dir = await mkdtemp(join(tmpdir(), 'roam-planner-domain-'))
  try {
    const facility = createFakeDomainFacility()
    const context = createFakeContext({ storageDomain: facility })
    apply(context.ctx, { dataDir: dir, geocoder: 'off' })

    const first = await callTool(context, 'roam_ping')
    const second = await callTool(context, 'roam_ping')
    assert.deepEqual([first.count, second.count], [1, 2], 'domain-backed counter increments')
    assert.equal(facility.counters.opens, 1, 'the domain is opened once')
    assert.equal(facility.counters.globalWrites, 2, 'each ping writes the global slot')
    assert.equal(facility.getGlobal().pingCount, 2, 'the counter is in the domain global slot')

    const health = await httpCall(context, 'GET', '/roam/api/health')
    assert.equal(health.json.store, 'storage-domain', 'health reports the domain backend')

    const created = await httpCall(context, 'POST', '/roam/api/trips', {
      title: 'Kyoto',
      days: [{ index: 0, date: '2026-12-02', stops: [], legs: [] }],
    })
    assert.equal(created.status, 201)
    const tripId = created.json.tripId
    assert.ok(facility.tables.trips.has(tripId), 'the trip record reached the domain table')
    assert.ok(facility.tables.drafts.has(tripId), 'the draft record reached the domain table')
    assert.equal(facility.spec().name, 'roam_planner')
    assert.equal(facility.spec().version, 1)

    await disposeAll(context)
    assert.equal(facility.counters.closes, 1, 'disposal closes the domain')

    // Reopen over the same facility: records must load back.
    const reopened = createFakeContext({ storageDomain: facility })
    apply(reopened.ctx, { dataDir: dir, geocoder: 'off' })
    const fetched = await httpCall(reopened, 'GET', `/roam/api/trips/${tripId}`)
    assert.equal(fetched.status, 200)
    assert.equal(fetched.json.title, 'Kyoto')
    assert.equal(facility.counters.opens, 2, 'reload opens the domain again')

    const ping3 = await callTool(reopened, 'roam_ping')
    assert.equal(ping3.count, 3, 'the domain global survives a reload')
    await disposeAll(reopened)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function main() {
  await testConfigSchema()
  console.log('ok config schema')
  await testFileBackendAndStateMachine()
  console.log('ok file backend, state machine, routes')
  await testDomainBackend()
  console.log('ok storage-domain backend')
  console.log('smoke: all checks passed')
}

main().catch((error) => {
  console.error('smoke: FAILED')
  console.error(error)
  process.exitCode = 1
})





