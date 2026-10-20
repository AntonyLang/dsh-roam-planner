/**
 * Roam Planner host plugin.
 *
 * Responsibility: the trip store, the `roam_*` tools and the `/roam/api/*`
 * routes. The client half lives in client/src and is bundled to client.bundle.js.
 *
 * Everything is registered inside one `ctx.effect(...)`, so unloading the
 * plugin removes the tools and routes and closes the storage handle.
 */

import { createStore } from './server/store.js'
import { createTripService } from './server/trips.js'
import { registerTools } from './server/tools.js'
import { registerRoutes } from './server/routes.js'
import { createGeocoder } from './server/geocode.js'
import { createSources } from './server/sources.js'
import { createSettings } from './server/settings.js'
import { createMcpBridge } from './server/mcp.js'

const DEFAULTS = {
  basemapId: 'osm',
  basemaps: null,
  tileUrl: null,
  dataDir: null,
  geocoder: 'nominatim',
  amapKey: null,
  defaultCity: null,
  workspaces: [],
  mcpServers: [],
}

/** External MCP sidecars: `{ name, command, args, env, cwd }`. */
function normalizeMcpServers(value) {
  if (!Array.isArray(value)) return []
  const servers = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const name = typeof raw.name === 'string' ? raw.name.trim() : ''
    const transport = raw.transport === 'http' ? 'http' : 'stdio'
    if (!name) continue
    if (servers.some((entry) => entry.name === name)) continue

    const command = typeof raw.command === 'string' ? raw.command.trim() : ''
    const args = Array.isArray(raw.args) ? raw.args.filter((arg) => typeof arg === 'string') : []
    const env = raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env) ? raw.env : undefined
    const cwd = typeof raw.cwd === 'string' && raw.cwd ? raw.cwd : undefined

    if (transport === 'http') {
      const url = typeof raw.url === 'string' ? raw.url.trim() : ''
      if (!url) continue
      // Hybrid: an HTTP sidecar may also carry a command, which the bridge uses
      // to start it on demand when nothing is listening on the port.
      servers.push({
        name,
        transport,
        url,
        ...(command ? { command, args, env, cwd } : {}),
        ...(Number.isFinite(raw.startupTimeoutMs) ? { startupTimeoutMs: raw.startupTimeoutMs } : {}),
      })
      continue
    }

    if (!command) continue
    servers.push({ name, transport, command, args, env, cwd })
  }
  return servers
}

/** Workspace titles that opt the conversation dock in; empty means everywhere. */
function normalizeWorkspaces(value) {
  if (!Array.isArray(value)) return []
  return value
    .filter((name) => typeof name === 'string' && name.trim() !== '')
    .map((name) => name.trim())
}

/**
 * Deployment-owned basemap catalogue. Each entry needs an `id` and a tile
 * `url`; the client fills the rest. An unusable entry is dropped, and `null`
 * tells the client to use its built-in list.
 */
function normalizeBasemapsConfig(value) {
  if (!Array.isArray(value)) return null
  const entries = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const id = typeof raw.id === 'string' ? raw.id.trim() : ''
    const url = typeof raw.url === 'string' ? raw.url.trim() : ''
    if (!id || !url) continue
    if (entries.some((entry) => entry.id === id)) continue
    entries.push({ ...raw, id, url })
  }
  return entries.length > 0 ? entries : null
}

/** Defensive normalization: the host validates Config, tests may pass plain objects. */
function resolveConfig(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const basemapId =
    typeof input.basemapId === 'string' && input.basemapId !== ''
      ? input.basemapId
      : DEFAULTS.basemapId
  const basemaps = normalizeBasemapsConfig(input.basemaps)
  const tileUrl = typeof input.tileUrl === 'string' && input.tileUrl !== '' ? input.tileUrl : null
  const dataDir = typeof input.dataDir === 'string' && input.dataDir !== '' ? input.dataDir : null
  const geocoder = ['nominatim', 'amap', 'off'].includes(input.geocoder)
    ? input.geocoder
    : DEFAULTS.geocoder
  const amapKey = typeof input.amapKey === 'string' && input.amapKey !== '' ? input.amapKey : null
  const defaultCity =
    typeof input.defaultCity === 'string' && input.defaultCity.trim() !== ''
      ? input.defaultCity.trim()
      : null
  const workspaces = normalizeWorkspaces(input.workspaces)
  const mcpServers = normalizeMcpServers(input.mcpServers)
  return { basemapId, basemaps, tileUrl, dataDir, geocoder, amapKey, defaultCity, workspaces, mcpServers }
}

/**
 * Standard-schema Config: no schema library import, so the plugin stays
 * dependency-free. Cordis calls `Config['~standard'].validate(raw)` and uses
 * the returned `value` (defaults applied).
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-roam-planner',
    validate(value) {
      const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
      const issues = []
      const tileUrl = input.tileUrl ?? null
      if (tileUrl !== null && typeof tileUrl !== 'string') {
        issues.push({ message: 'tileUrl must be a string or null', path: ['tileUrl'] })
      }
      const basemapId = input.basemapId ?? DEFAULTS.basemapId
      if (typeof basemapId !== 'string' || basemapId.trim() === '') {
        issues.push({ message: 'basemapId must be a non-empty string', path: ['basemapId'] })
      }
      const dataDir = input.dataDir ?? null
      if (dataDir !== null && (typeof dataDir !== 'string' || dataDir.trim() === '')) {
        issues.push({ message: 'dataDir must be a non-empty string or null', path: ['dataDir'] })
      }
      const geocoder = input.geocoder ?? DEFAULTS.geocoder
      if (!['nominatim', 'amap', 'off'].includes(geocoder)) {
        issues.push({ message: 'geocoder must be nominatim, amap or off', path: ['geocoder'] })
      }
      const amapKey = input.amapKey ?? null
      if (amapKey !== null && typeof amapKey !== 'string') {
        issues.push({ message: 'amapKey must be a string or null', path: ['amapKey'] })
      }
      const basemaps = input.basemaps ?? null
      if (basemaps !== null && !Array.isArray(basemaps)) {
        issues.push({ message: 'basemaps must be an array or null', path: ['basemaps'] })
      }
      const defaultCity = input.defaultCity ?? null
      if (defaultCity !== null && typeof defaultCity !== 'string') {
        issues.push({ message: 'defaultCity must be a string or null', path: ['defaultCity'] })
      }
      const workspaces = input.workspaces ?? []
      if (!Array.isArray(workspaces) || workspaces.some((name) => typeof name !== 'string')) {
        issues.push({ message: 'workspaces must be an array of strings', path: ['workspaces'] })
      }
      const mcpServers = input.mcpServers ?? []
      if (!Array.isArray(mcpServers)) {
        issues.push({ message: 'mcpServers must be an array', path: ['mcpServers'] })
      }
      if (issues.length > 0) return { issues }
      return {
        value: {
          basemapId: basemapId.trim(),
          basemaps: normalizeBasemapsConfig(basemaps),
          tileUrl: tileUrl === '' ? null : tileUrl,
          dataDir: dataDir === null ? null : dataDir.trim(),
          geocoder,
          amapKey: amapKey === '' ? null : amapKey,
          defaultCity: defaultCity === null ? null : defaultCity.trim(),
          workspaces: normalizeWorkspaces(workspaces),
          mcpServers: normalizeMcpServers(mcpServers),
        },
      }
    },
  },
}

export const inject = ['tools', 'webServer']

/** Resolve the fallback data directory for the JSON file store. */
function resolveDataDir(ctx) {
  try {
    const workingDirectory = ctx?.get?.('workingDirectory')
    const directory = workingDirectory?.defaultDirectory
    if (typeof directory === 'string' && directory !== '') return directory
  } catch {
    /* optional service; fall through to the process directory */
  }
  return process.cwd()
}

/**
 * @param {object} ctx Cordis plugin context.
 * @param {object} [rawConfig] Host-validated config (`basemapId`, `tileUrl`, `dataDir`).
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const dataDir = config.dataDir ?? resolveDataDir(ctx)
  const store = createStore({ ctx, dataDir, logger: ctx.logger })
  const trips = createTripService({ store, logger: ctx.logger })
  const settings = createSettings({ ctx, config, logger: ctx.logger })
  const geocoder = createGeocoder({ config, logger: ctx.logger, getAmapKey: settings.amapKey })
  const sources = createSources({
    logger: ctx.logger,
    getAmapKey: settings.amapKey,
    defaultCity: config.defaultCity,
  })

  const mcp = createMcpBridge({ config, logger: ctx.logger })

  ctx.effect(() => {
    const disposeTools = registerTools(ctx, trips, {
      geocoder,
      sources,
      mcp,
      defaultCity: config.defaultCity,
    })
    const disposeRoutes = registerRoutes(ctx, { trips, config, sources, settings, geocoder })
    return async () => {
      try {
        disposeRoutes()
      } finally {
        try {
          disposeTools()
        } finally {
          mcp.close()
          await store.close()
        }
      }
    }
  })

  ctx.logger?.info?.(`dsh-roam-planner: /roam/api mounted (basemap ${config.basemapId}, geocoder ${config.geocoder}, data dir ${dataDir})`)
}

