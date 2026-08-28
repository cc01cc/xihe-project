import { createServer } from 'node:http'

const port = Number(process.env.XIHE_FAKE_MCP_PORT ?? 13641)
const accessToken = process.env.XIHE_FAKE_MCP_ACCESS_TOKEN ?? ''
const sessions = new Set()
const disconnectedSessions = new Set()

function json(response, status, body, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json', ...headers })
  response.end(JSON.stringify(body))
}

function authorized(request) {
  return accessToken && request.headers.authorization === `Bearer ${accessToken}`
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`)
  if (url.pathname === '/health') return json(response, 200, { status: 'ok' })
  if (url.pathname !== '/mcp') return json(response, 404, { error: 'not_found' })
  if (!authorized(request)) return json(response, 401, { error: 'invalid_token' }, { 'WWW-Authenticate': 'Bearer' })

  if (request.method === 'GET') {
    if (request.headers['mcp-session-id'] && !sessions.has(request.headers['mcp-session-id'])) {
      return json(response, 404, { error: 'unknown_session' })
    }
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    response.write('id: ready-1\nevent: ready\ndata: {"protocolVersion":"2026-07-28"}\n\n')
    return response.end()
  }

  if (request.method === 'DELETE') {
    const sessionId = request.headers['mcp-session-id']
    sessions.delete(sessionId)
    disconnectedSessions.add(sessionId)
    return json(response, 200, { jsonrpc: '2.0', result: { disconnected: true } })
  }

  if (request.method !== 'POST') return json(response, 405, { error: 'method_not_allowed' })
  const body = JSON.parse(await readBody(request))
  if (!body.id) return response.end()
  const sessionId = request.headers['mcp-session-id'] ?? `fixture-${Date.now()}`
  if (body.method !== 'initialize' && !sessions.has(sessionId)) {
    return json(response, 404, { jsonrpc: '2.0', id: body.id, error: { code: -32001, message: 'session_required' } })
  }
  if (body.params?.arguments?.mode === 'timeout') {
    setTimeout(() => response.end(), 5000)
    return
  }
  sessions.add(sessionId)
  const result = body.method === 'initialize'
    ? { protocolVersion: '2026-07-28', capabilities: { tools: {} }, serverInfo: { name: 'fake-remote', version: '0.1.0' } }
    : body.method === 'tools/list'
      ? { tools: [{ name: 'remote_echo', description: 'Fake remote echo', inputSchema: { type: 'object' } }] }
      : body.method === 'tools/call'
        ? body.params?.arguments?.mode === 'input_required'
          ? { content: [{ type: 'text', text: 'input required' }], isError: true,
              requestState: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }
          : { content: [{ type: 'text', text: String(body.params?.arguments?.text ?? '') }], isError: false }
        : undefined
  if (!result) return json(response, 400, { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'method_not_found' } })
  return json(response, 200, { jsonrpc: '2.0', id: body.id, result }, { 'mcp-session-id': sessionId })
})

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => resolve(body))
    request.on('error', reject)
  })
}

server.listen(port, '0.0.0.0', () => {
  console.log(`[fake-mcp] listening on ${port}`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(() => process.exit(0)))
}
