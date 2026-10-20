/**
 * MCP bridge checks: stdio framing, HTTP/SSE transport, error paths and the
 * transport-level cap. No real sidecar is started.
 *
 * Run: node server/__tests__/mcp.test.mjs
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createMcpBridge } from '../mcp.js'

let failed = 0
async function check(name, fn) {
  try {
    await fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${name}: ${error.message}`)
  }
}

/** A fake stdio server answering initialize, tools/list and tools/call. */
function fakeSpawn(text = 'called') {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new PassThrough()
  child.killed = false
  child.kill = () => {
    child.killed = true
    child.emit('exit', 0)
  }

  let buffer = ''
  child.stdin.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (!line.trim()) continue
      const message = JSON.parse(line)
      const reply = (result) => child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`)
      if (message.method === 'initialize') reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} } })
      else if (message.method === 'tools/list') {
        reply({
          tools: [
            { name: 'query_tickets', description: 'Query train tickets', inputSchema: { type: 'object' } },
            { name: 'note_search', description: 'Search notes', inputSchema: { type: 'object' } },
          ],
        })
      } else if (message.method === 'tools/call') {
        reply({ content: [{ type: 'text', text: `${text} ${message.params.name}` }] })
      }
    }
  })
  return child
}

const stdioBridge = createMcpBridge({
  config: {
    mcpServers: [
      { name: 'railway', command: 'fake-railway', args: ['--stdio'] },
      { name: 'xhs', transport: 'http', url: 'http://127.0.0.1:18060/mcp' },
    ],
  },
  spawnImpl: () => fakeSpawn(),
})

await check('servers are listed without starting anything', () => {
  const servers = stdioBridge.listServers()
  assert.equal(servers.length, 2)
  assert.equal(servers[0].name, 'railway')
  assert.equal(servers[0].transport, 'stdio')
  assert.equal(servers[0].started, false)
  assert.ok(servers[0].target.includes('fake-railway'))
  assert.equal(servers[1].transport, 'http')
  assert.equal(servers[1].target, 'http://127.0.0.1:18060/mcp')
})

const tools = await stdioBridge.listTools('railway')
await check('tools/list is parsed over stdio', () => {
  assert.equal(tools.length, 2)
  assert.equal(tools[0].name, 'query_tickets')
})
await check('a started server reports as running', () => {
  assert.equal(stdioBridge.listServers().find((server) => server.name === 'railway').started, true)
})
await check('tools/call returns the text blocks', async () => {
  const result = await stdioBridge.callTool('railway', 'query_tickets', { from: 'VNP' })
  assert.equal(result.isError, false)
  assert.equal(result.text, 'called query_tickets')
})
await check('an unknown server rejects with a readable message', async () => {
  await assert.rejects(() => stdioBridge.listTools('nope'), /unknown MCP server/)
})

/* --- a huge answer is capped ----------------------------------------- */
{
  const bridge = createMcpBridge({
    config: { mcpServers: [{ name: 'big', command: 'x' }] },
    spawnImpl: () => fakeSpawn('y'.repeat(50000)),
  })
  const result = await bridge.callTool('big', 'dump', {})
  await check('a huge answer is truncated for the model', () => {
    assert.ok(result.text.length < 13000)
    assert.ok(result.text.includes('truncated'))
  })
}

/* --- maxTextChars: 0 keeps the payload intact for a proxy ------------- */
{
  const bridge = createMcpBridge({
    config: { mcpServers: [{ name: 'raw', command: 'x', maxTextChars: 0 }] },
    spawnImpl: () => fakeSpawn('z'.repeat(50000)),
  })
  const result = await bridge.callTool('raw', 'dump', {})
  await check('an internal proxy can request the untruncated answer', () => {
    assert.ok(result.text.length > 50000)
    assert.ok(!result.text.includes('truncated'))
  })
}

/* --- HTTP transport, JSON response ---------------------------------- */
{
  let seen = null
  const bridge = createMcpBridge({
    config: { mcpServers: [{ name: 'xhs', transport: 'http', url: 'http://127.0.0.1:9/mcp' }] },
    fetchImpl: async (url, init) => {
      const message = JSON.parse(init.body)
      seen = { url, headers: init.headers, message }
      const result =
        message.method === 'initialize'
          ? { protocolVersion: '2024-11-05', capabilities: {} }
          : message.method === 'tools/list'
            ? { tools: [{ name: 'search_notes', description: 'Search notes' }] }
            : { content: [{ type: 'text', text: 'note body' }] }
      return {
        ok: true,
        headers: new Headers({ 'content-type': 'application/json', 'mcp-session-id': 'session-1' }),
        text: async () => JSON.stringify({ jsonrpc: '2.0', id: message.id, result }),
      }
    },
  })

  const httpTools = await bridge.listTools('xhs')
  await check('HTTP transport lists tools and keeps the session header', () => {
    assert.equal(httpTools.length, 1)
    assert.equal(httpTools[0].name, 'search_notes')
    assert.equal(seen.url, 'http://127.0.0.1:9/mcp')
    assert.equal(seen.headers['mcp-session-id'], 'session-1')
  })
  await check('HTTP tools/call returns the text', async () => {
    const result = await bridge.callTool('xhs', 'search_notes', { q: '苏州' })
    assert.equal(result.text, 'note body')
  })
}

/* --- HTTP transport, SSE response ----------------------------------- */
{
  const bridge = createMcpBridge({
    config: { mcpServers: [{ name: 'sse', transport: 'http', url: 'http://127.0.0.1:9/mcp' }] },
    fetchImpl: async (_url, init) => {
      const message = JSON.parse(init.body)
      const result =
        message.method === 'initialize'
          ? { protocolVersion: '2024-11-05', capabilities: {} }
          : message.method === 'tools/list'
            ? { tools: [{ name: 'ping_tool', description: 'Ping' }] }
            : null
      const payload = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n\n`
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(payload))
          controller.close()
        },
      })
      return { ok: true, headers: new Headers({ 'content-type': 'text/event-stream' }), body: stream }
    },
  })
  const sseTools = await bridge.listTools('sse')
  await check('an SSE response is parsed', () => {
    assert.equal(sseTools.length, 1)
    assert.equal(sseTools[0].name, 'ping_tool')
  })
}

/* --- a server that dies surfaces the failure -------------------------- */
{
  const dying = createMcpBridge({
    config: { mcpServers: [{ name: 'gone', command: 'x' }] },
    spawnImpl: () => {
      const child = new EventEmitter()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.stdin = new PassThrough()
      child.kill = () => {}
      setTimeout(() => child.emit('exit', 1), 5)
      return child
    },
  })
  await check('a dying server rejects instead of hanging', async () => {
    await assert.rejects(() => dying.listTools('gone'), /exited/)
  })
}

/* --- configured headers reach the HTTP request ----------------------- */
{
  const seen = []
  const bridge = createMcpBridge({
    config: {
      mcpServers: [
        { name: 'web', transport: 'http', url: 'http://127.0.0.1:9/mcp', headers: { Authorization: 'Bearer t0k' } },
      ],
    },
    fetchImpl: async (url, options) => {
      seen.push(options.headers)
      return {
        ok: true,
        headers: new Map([['content-type', 'application/json']]),
        status: 200,
        text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } }),
      }
    },
  })
  await bridge.listTools('web').catch(() => {})
  await check('configured headers are sent with the request', () => {
    assert.ok(seen.length > 0, 'no request was made')
    assert.equal(seen[0].Authorization, 'Bearer t0k')
  })
}

/* --- a dead server is replaced on the next call ---------------------- */
{
  let spawns = 0
  const flaky = createMcpBridge({
    config: { mcpServers: [{ name: 'flaky', command: 'x' }] },
    spawnImpl: () => {
      spawns += 1
      if (spawns === 1) {
        const child = new EventEmitter()
        child.stdout = new PassThrough()
        child.stderr = new PassThrough()
        child.stdin = new PassThrough()
        child.kill = () => {}
        setImmediate(() => child.emit('exit', 1))
        return child
      }
      return fakeSpawn()
    },
  })
  await assert.rejects(() => flaky.listTools('flaky'), /exited/)
  const tools = await flaky.listTools('flaky')
  await check('a dead sidecar is respawned on the next call', () => {
    assert.equal(spawns, 2)
    assert.equal(tools.length, 2)
  })
}

stdioBridge.close()
console.log(failed === 0 ? '\nMCP bridge checks passed' : `\n${failed} failed`)
process.exit(failed === 0 ? 0 : 1)


