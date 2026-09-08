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

  if (mode === 'approval') {
    sendApprovalCompletion(response, requestBody)
    return
  }

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

// Deterministic approval flow: the first completion requests the
// request_approval tool; any completion that already carries a tool result
// streams a plain answer so the run can reach done(success). A brand-new user
// turn (phase 2) must request the tool again — the fake server is stateless.
function sendApprovalCompletion(response, requestBody) {
  const messages = Array.isArray(requestBody.messages) ? requestBody.messages : []
  const last = messages.at(-1) ?? {}
  const hasToolResult = messages.some((m) => m.role === 'tool')
  const followUp = last.role === 'tool' || (hasToolResult && last.role === 'user')

  if (!followUp) {
    const toolCallDelta = {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call-approval-e2e-1',
                type: 'function',
                function: {
                  name: 'request_approval',
                  arguments: JSON.stringify({ action: 'delete file', details: 'README.md' }),
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }
    const finishDelta = { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
    response.write(`data: ${JSON.stringify(toolCallDelta)}\n\n`)
    response.write(`data: ${JSON.stringify(finishDelta)}\n\n`)
    response.end('data: [DONE]\n\n')
    return
  }

  const chunks = ['Approval received. ', 'The requested action was approved by the user.']
  for (const content of chunks) {
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`)
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
