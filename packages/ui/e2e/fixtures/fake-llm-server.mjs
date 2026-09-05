import { createServer } from 'node:http'

const port = Number(process.env.XIHE_FAKE_LLM_PORT ?? '13642')
const mode = process.env.XIHE_FAKE_LLM_MODE ?? 'success'

const providers = {
  openai: {
    key: 'sk-fake-openai-key',
    models: ['fake-openai', 'fake-openai-asr'],
  },
  deepseek: {
    key: 'fake-deepseek-key',
    models: ['fake-deepseek'],
  },
}

function providerFor(pathname) {
  if (pathname.startsWith('/openai/')) return 'openai'
  if (pathname.startsWith('/deepseek/')) return 'deepseek'
  return null
}

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(body))
}

function authorized(request, provider) {
  if (mode === 'invalid') return false
  return request.headers.authorization === `Bearer ${providers[provider].key}`
}

async function readBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

async function sendCompletion(response, provider, requestBody) {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })

  const lastMessage = requestBody.messages?.at(-1)?.content ?? 'empty'
  const chunks = [`${provider} fake`, ` response to: ${String(lastMessage).slice(0, 40)}`]
  for (const content of chunks) {
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`)
    if (mode === 'disconnect') {
      response.destroy()
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  response.end('data: [DONE]\n\n')
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
  if (url.pathname === '/health') {
    json(response, 200, { status: 'ok', mode })
    return
  }

  const provider = providerFor(url.pathname)
  if (!provider) {
    json(response, 404, { error: 'not found' })
    return
  }

  if (!authorized(request, provider)) {
    json(response, 401, { error: { message: 'invalid fake credentials', type: 'invalid_request_error' } })
    return
  }

  if (url.pathname.endsWith('/models') && request.method === 'GET') {
    json(response, 200, { object: 'list', data: providers[provider].models.map((id) => ({ id, object: 'model' })) })
    return
  }

  if ((url.pathname.endsWith('/chat/completions') || url.pathname.endsWith('/v1')) && request.method === 'POST') {
    let body
    try {
      body = JSON.parse(await readBody(request))
    } catch {
      json(response, 400, { error: { message: 'invalid JSON' } })
      return
    }
    console.log(`[fake-llm] provider=${provider} endpoint=chat/completions model=${body.model ?? 'unknown'}`)
    await sendCompletion(response, provider, body)
    return
  }

  json(response, 404, { error: 'not found' })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`[fake-llm] ready port=${port} mode=${mode}`)
})

function shutdown() {
  server.close(() => process.exit(0))
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
