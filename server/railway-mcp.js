/**
 * Railway MCP server (ours).
 *
 * The upstream `mcp-server-12306` package answers a whole day of trains and
 * only accepts from/to/date. Narrowing is railway business logic, so it lives
 * here rather than in the generic transport bridge: this server exposes one
 * tool with a time window, a station filter and a row cap, and forwards the
 * query to the upstream sidecar.
 *
 * It speaks MCP over stdio so any MCP client can mount it.
 *
 * Environment:
 *   RAILWAY_PYTHON   python executable that has mcp_server_12306 installed
 *   RAILWAY_PYTHONPATH  PYTHONPATH for that install
 */

import { createMcpBridge } from './mcp.js'
import { createInterface } from 'node:readline'

const PYTHON = process.env.RAILWAY_PYTHON || 'python'
const PYTHONPATH = process.env.RAILWAY_PYTHONPATH || ''

const upstream = createMcpBridge({
  config: {
    mcpServers: [
      {
        name: 'upstream',
        command: PYTHON,
        args: ['-c', 'from mcp_12306.stdio_server import main; main()'],
        // The upstream answers the whole day; it must reach the parser intact.
        maxTextChars: 0,
        env: PYTHONPATH ? { PYTHONPATH } : {},
      },
    ],
  },
  logger: { info() {}, warn: (message) => process.stderr.write(`[railway] ${message}\n`) },
})

const TOOL = {
  name: 'query_tickets',
  description:
    'Query 12306 trains between two stations on one date. Returns at most `limit` trains departing inside the time window, optionally only those serving a named station.',
  inputSchema: {
    type: 'object',
    properties: {
      from_station: { type: 'string', description: 'Departure city or station, e.g. 苏州.' },
      to_station: { type: 'string', description: 'Arrival city or station, e.g. 上海.' },
      date: { type: 'string', description: 'Travel date, YYYY-MM-DD.' },
      time_from: { type: 'string', description: 'Earliest departure, HH:MM. Default 00:00.' },
      time_to: { type: 'string', description: 'Latest departure, HH:MM. Default 23:59.' },
      station: { type: 'string', description: 'Keep only trains whose departure or arrival station contains this text.' },
      limit: { type: 'integer', description: 'Maximum trains to return. Default 10, max 50.' },
    },
    required: ['from_station', 'to_station', 'date'],
    additionalProperties: false,
  },
}

function textBlock(text) {
  return [{ type: 'text', text }]
}

async function queryTickets(args) {
  const date = String(args.date || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('date must be YYYY-MM-DD')
  const limit = Math.min(50, Math.max(1, Number.isInteger(args.limit) ? args.limit : 10))
  const from = typeof args.time_from === 'string' && args.time_from ? args.time_from : '00:00'
  const to = typeof args.time_to === 'string' && args.time_to ? args.time_to : '23:59'
  const station = typeof args.station === 'string' ? args.station.trim() : ''

  const raw = await upstream.callTool('upstream', 'query-tickets', {
    from_station: String(args.from_station || ''),
    to_station: String(args.to_station || ''),
    train_date: date,
  })
  if (raw.isError) throw new Error(raw.text || 'upstream query failed')

  let payload
  try {
    payload = JSON.parse(raw.text)
  } catch (_error) {
    return { text: raw.text, matched: null, returned: null }
  }

  const all = Array.isArray(payload.trains) ? payload.trains : []
  const kept = all.filter((train) => {
    const start = typeof train.start_time === 'string' ? train.start_time : ''
    if (start === '' || start < from || start > to) return false
    if (station !== '') {
      const haystack = `${train.from_station || ''} ${train.to_station || ''}`
      if (!haystack.includes(station)) return false
    }
    return true
  })

  const rows = kept.slice(0, limit)
  return {
    payload: {
      from_station: payload.from_station,
      to_station: payload.to_station,
      train_date: payload.train_date,
      matched: kept.length,
      returned: rows.length,
      trains: rows,
    },
    matched: kept.length,
    returned: rows.length,
  }
}

const SERVER_INFO = { name: 'roam-railway', version: '0.1.0' }

async function handle(message) {
  const { id, method, params } = message
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      },
    }
  }
  if (method === 'notifications/initialized') return null
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: [TOOL] } }
  }
  if (method === 'tools/call') {
    const name = params && params.name
    if (name !== TOOL.name) {
      return { jsonrpc: '2.0', id, result: { content: textBlock(`unknown tool: ${name}`), isError: true } }
    }
    try {
      const outcome = await queryTickets((params && params.arguments) || {})
      const body = outcome.payload
        ? JSON.stringify(outcome.payload, null, 1)
        : String(outcome.text || '')
      const head =
        outcome.matched === null
          ? ''
          : `${outcome.returned} of ${outcome.matched} train(s) between ${params.arguments.from_station} and ${params.arguments.to_station} on ${params.arguments.date} (${params.arguments.time_from || '00:00'}–${params.arguments.time_to || '23:59'}).\n\n`
      return { jsonrpc: '2.0', id, result: { content: textBlock(head + body) } }
    } catch (error) {
      return { jsonrpc: '2.0', id, result: { content: textBlock(`query failed: ${error.message}`), isError: true } }
    }
  }
  if (id !== undefined) {
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } }
  }
  return null
}

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const text = line.trim()
  if (!text) return
  let message
  try {
    message = JSON.parse(text)
  } catch (_error) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'invalid JSON' } })}\n`)
    return
  }
  void handle(message)
    .then((reply) => {
      if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`)
    })
    .catch((error) => {
      if (message.id !== undefined) {
        process.stdout.write(
          `${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error.message } })}\n`,
        )
      }
    })
})

process.on('SIGINT', () => {
  upstream.close()
  process.exit(0)
})
