/**
 * Minimal MCP bridge: stdio and streamable HTTP.
 *
 * The host's in-box `@deepseek-ai/dsh-mcp-client` is not part of this DSH build,
 * so the plugin speaks the protocol itself. Servers start lazily on the first
 * call and are kept until the plugin unloads; nothing is spawned at activation,
 * so a missing binary can never break startup.
 *
 * Only `initialize`, `tools/list` and `tools/call` are used — the whole surface
 * a trip planner needs from a sidecar.
 */

import { spawn as nodeSpawn } from 'node:child_process'
import net from 'node:net'

const PROTOCOL_VERSION = '2024-11-05'
const CALL_TIMEOUT_MS = 30000
const INIT_TIMEOUT_MS = 20000
/** A sidecar can return hundreds of kilobytes; the model gets the head only. */
const MAX_TEXT_CHARS = 12000
/** How long a spawned HTTP sidecar may take to start listening. */
const STARTUP_TIMEOUT_MS = 45000

function endpointOf(url) {
  try {
    const parsed = new URL(url)
    const port = Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80)
    return { host: parsed.hostname, port }
  } catch (_error) {
    return null
  }
}

/** Resolve once something accepts a TCP connection on host:port. */
function waitForPort(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const attempt = () => {
      const socket = net.connect({ host, port })
      const retry = (error) => {
        socket.destroy()
        if (Date.now() > deadline) reject(error || new Error(`port ${host}:${port} did not open`))
        else setTimeout(attempt, 300)
      }
      socket.once('connect', () => {
        socket.destroy()
        resolve()
      })
      socket.once('error', retry)
    }
    attempt()
  })
}

function envelopeError(message) {
  return new Error(message?.error?.message || 'MCP error')
}

/** Parse one Server-Sent-Events body until a response with `id` arrives. */
async function readSse(response, id, timeoutMs) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const deadline = Date.now() + timeoutMs

  try {
    while (Date.now() < deadline) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const event = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        for (const line of event.split('\n')) {
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (!payload || payload === '[DONE]') continue
          let message
          try {
            message = JSON.parse(payload)
          } catch {
            continue
          }
          if (message && message.id === id) {
            if (message.error) throw envelopeError(message)
            return message.result
          }
        }
      }
    }
  } finally {
    try {
      await reader.cancel()
    } catch (_error) {
      /* already closed. */
    }
  }
  throw new Error('MCP HTTP stream ended without a response')
}

export function createMcpBridge(options = {}) {
  const { config = {}, logger, spawnImpl, fetchImpl } = options || {}
  const definitions = Array.isArray(config.mcpServers)
    ? config.mcpServers.filter((entry) => entry && typeof entry.name === 'string' && entry.name.trim())
    : []
  const sessions = new Map()
  const doFetch = fetchImpl || globalThis.fetch

  function definitionOf(name) {
    return definitions.find((entry) => entry.name === name) || null
  }

  /* ------------------------------------------------------------------ */
  /* stdio                                                               */
  /* ------------------------------------------------------------------ */

  function startStdioSession(def, onDead) {
    const spawner = spawnImpl || nodeSpawn
    if (typeof spawner !== 'function') throw new Error('no process spawner is available')
    const child = spawner(def.command, Array.isArray(def.args) ? def.args : [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(def.env && typeof def.env === 'object' ? def.env : {}) },
      cwd: typeof def.cwd === 'string' && def.cwd ? def.cwd : undefined,
    })

    const pending = new Map()
    let nextId = 1
    let buffer = ''
    let stderr = ''
    let closed = false

    function settle(id, error, value) {
      const entry = pending.get(id)
      if (!entry) return
      pending.delete(id)
      clearTimeout(entry.timer)
      if (error) entry.reject(error)
      else entry.resolve(value)
    }

    function handleLine(line) {
      const text = line.trim()
      if (!text) return
      let message
      try {
        message = JSON.parse(text)
      } catch {
        return // servers sometimes log prose on stdout
      }
      if (message && message.id !== undefined && pending.has(message.id)) {
        if (message.error) settle(message.id, envelopeError(message))
        else settle(message.id, null, message.result)
      }
    }

    child.stdout?.setEncoding?.('utf8')
    child.stdout?.on?.('data', (chunk) => {
      buffer += chunk
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        handleLine(line)
      }
    })
    child.stderr?.setEncoding?.('utf8')
    child.stderr?.on?.('data', (chunk) => {
      stderr = (stderr + chunk).slice(-2000)
    })

    const failAll = (reason) => {
      closed = true
      for (const [id, entry] of pending) {
        clearTimeout(entry.timer)
        entry.reject(new Error(reason))
        pending.delete(id)
      }
      // Drop the cached session so the next call starts a fresh process
      // instead of talking to a dead one forever.
      onDead?.()
    }
    child.on?.('exit', (code) =>
      failAll(`MCP server "${def.name}" exited (code ${code})${stderr ? ': ' + stderr.slice(-300) : ''}`),
    )
    child.on?.('error', (error) => failAll(`MCP server "${def.name}" failed to start: ${error.message}`))

    function request(method, params, timeoutMs = CALL_TIMEOUT_MS) {
      if (closed) return Promise.reject(new Error(`MCP server "${def.name}" is not running`))
      const id = nextId++
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`MCP server "${def.name}" timed out on ${method}`))
        }, timeoutMs)
        pending.set(id, { resolve, reject, timer })
        try {
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} })}\n`)
        } catch (error) {
          clearTimeout(timer)
          pending.delete(id)
          reject(error)
        }
      })
    }

    function notify(method, params) {
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params: params || {} })}\n`)
      } catch (_error) {
        /* the exit handler reports the real failure. */
      }
    }

    const ready = (async () => {
      await request(
        'initialize',
        {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'dsh-roam-planner', version: '0.1.0' },
        },
        INIT_TIMEOUT_MS,
      )
      notify('notifications/initialized')
    })()

    return {
      name: def.name,
      request,
      ready,
      close() {
        closed = true
        try {
          child.kill()
        } catch (_error) {
          /* already gone. */
        }
      },
    }
  }

  /* ------------------------------------------------------------------ */
  /* streamable HTTP                                                     */
  /* ------------------------------------------------------------------ */

  function startHttpSession(def, onDead) {
    let sessionId = null
    let nextId = 1
    let closed = false
    let child = null

    /**
     * Hybrid mode: an HTTP sidecar that also carries `command` is started on
     * demand. If the port already answers, someone else owns it and we leave it
     * alone.
     */
    async function ensureStarted() {
      if (!def.command) return
      const endpoint = endpointOf(def.url)
      if (!endpoint) throw new Error(`MCP server "${def.name}" has an invalid url`)

      try {
        await waitForPort(endpoint.host, endpoint.port, 600)
        return
      } catch (_error) {
        /* nothing listening yet: start it */
      }

      const spawner = spawnImpl || nodeSpawn
      let stderr = ''
      child = spawner(def.command, Array.isArray(def.args) ? def.args : [], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...(def.env && typeof def.env === 'object' ? def.env : {}) },
        cwd: typeof def.cwd === 'string' && def.cwd ? def.cwd : undefined,
        windowsHide: true,
      })
      child.stderr?.setEncoding?.('utf8')
      child.stderr?.on?.('data', (chunk) => {
        stderr = (stderr + chunk).slice(-2000)
      })
      child.on?.('exit', (code) => {
        closed = true
        child = null
        onDead?.()
        logger?.warn?.(`dsh-roam-planner: MCP server "${def.name}" exited (code ${code})${stderr ? ': ' + stderr.slice(-300) : ''}`)
      })

      try {
        await waitForPort(endpoint.host, endpoint.port, Number(def.startupTimeoutMs) || STARTUP_TIMEOUT_MS)
      } catch (error) {
        closed = true
        try {
          child.kill()
        } catch (_killError) {
          /* already gone */
        }
        child = null
        onDead?.()
        throw new Error(
          `MCP server "${def.name}" did not start listening on ${endpoint.host}:${endpoint.port}${stderr ? ': ' + stderr.slice(-300) : ''}`,
        )
      }
    }

    async function post(message, timeoutMs = CALL_TIMEOUT_MS) {
      if (closed) throw new Error(`MCP server "${def.name}" is closed`)
      const headers = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      }
      if (sessionId) headers['mcp-session-id'] = sessionId
      let response
      try {
        response = await doFetch(def.url, {
          method: 'POST',
          headers,
          body: JSON.stringify(message),
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (error) {
        // The sidecar went away: drop the cached session so the next call
        // reconnects instead of reusing a dead one.
        closed = true
        onDead?.()
        throw new Error(`MCP server "${def.name}" is unreachable: ${error.message}`)
      }
      const assigned = response.headers.get('mcp-session-id')
      if (assigned) sessionId = assigned
      if (!response.ok) throw new Error(`MCP server "${def.name}" answered HTTP ${response.status}`)

      const contentType = response.headers.get('content-type') || ''
      if (contentType.includes('text/event-stream')) {
        return readSse(response, message.id, timeoutMs)
      }
      const text = await response.text()
      if (!text) return null
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        return null
      }
      if (parsed && parsed.error) throw envelopeError(parsed)
      return parsed ? parsed.result : null
    }

    function request(method, params, timeoutMs = CALL_TIMEOUT_MS) {
      const id = nextId++
      return post({ jsonrpc: '2.0', id, method, params: params || {} }, timeoutMs)
    }

    function notify(method, params) {
      void post({ jsonrpc: '2.0', method, params: params || {} }).catch(() => {})
    }

    const ready = (async () => {
      await ensureStarted()
      await request(
        'initialize',
        {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'dsh-roam-planner', version: '0.1.0' },
        },
        INIT_TIMEOUT_MS,
      )
      notify('notifications/initialized')
    })()

    return {
      name: def.name,
      request,
      ready,
      close() {
        closed = true
        try {
          child?.kill()
        } catch (_error) {
          /* already gone */
        }
        child = null
      },
    }
  }

  /* ------------------------------------------------------------------ */

  async function sessionFor(name) {
    const existing = sessions.get(name)
    if (existing) return existing
    const def = definitionOf(name)
    if (!def) {
      throw new Error(
        `unknown MCP server "${name}"; configured: ${definitions.map((entry) => entry.name).join(', ') || '(none)'}`,
      )
    }
    const session = def.transport === 'http'
      ? startHttpSession(def, () => sessions.delete(name))
      : startStdioSession(def, () => sessions.delete(name))
    sessions.set(name, session)
    try {
      await session.ready
    } catch (error) {
      sessions.delete(name)
      session.close()
      throw error
    }
    return session
  }

  /** Configured servers, without starting them. */
  function listServers() {
    return definitions.map((entry) => ({
      name: entry.name,
      transport: entry.transport === 'http' ? 'http' : 'stdio',
      target:
        entry.transport === 'http'
          ? String(entry.url || '')
          : [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])].join(' '),
      started: sessions.has(entry.name),
    }))
  }

  async function listTools(name) {
    const session = await sessionFor(name)
    const result = await session.request('tools/list', {})
    return Array.isArray(result?.tools)
      ? result.tools.map((tool) => ({
          name: String(tool.name || ''),
          description: String(tool.description || ''),
          inputSchema: tool.inputSchema || tool.input_schema || null,
        }))
      : []
  }

  async function callTool(name, tool, args) {
    const session = await sessionFor(name)
    const result = await session.request('tools/call', { name: tool, arguments: args || {} })
    const blocks = Array.isArray(result?.content) ? result.content : []
    const raw = blocks
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')

    // Transport-level safety only: business narrowing belongs to the server.
    // An internal proxy may ask for the untruncated answer (maxTextChars: 0) so
    // it can parse and narrow it itself.
    const def = definitionOf(name)
    const cap = def && Number.isFinite(def.maxTextChars) ? def.maxTextChars : MAX_TEXT_CHARS
    const text =
      cap > 0 && raw.length > cap
        ? `${raw.slice(0, cap)}\n… [truncated: ${raw.length} characters in total]`
        : raw
    return { text, isError: Boolean(result?.isError) }
  }

  function close() {
    for (const session of sessions.values()) session.close()
    sessions.clear()
  }

  logger?.info?.(`dsh-roam-planner: MCP bridge ready (${definitions.length} server(s) configured)`)

  return { listServers, listTools, callTool, close }
}



