import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'

const port = Number(process.env.XIHE_FAKE_OAUTH_PORT ?? 13640)
const accessToken = process.env.XIHE_FAKE_MCP_ACCESS_TOKEN ?? ''
const codes = new Map()
const tokens = new Map()

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(body))
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`)

  if (url.pathname === '/health') {
    return json(response, 200, { status: 'ok' })
  }

  if (url.pathname === '/.well-known/openid-configuration') {
    return json(response, 200, {
      authorization_endpoint: `http://127.0.0.1:${port}/authorize`,
      token_endpoint: `http://127.0.0.1:${port}/token`,
      revocation_endpoint: `http://127.0.0.1:${port}/revoke`,
      code_challenge_methods_supported: ['S256'],
    })
  }

  if (url.pathname === '/authorize') {
    const redirectUri = url.searchParams.get('redirect_uri')
    const state = url.searchParams.get('state')
    const codeChallenge = url.searchParams.get('code_challenge')
    if (!redirectUri || !state || !codeChallenge) {
      return json(response, 400, { error: 'invalid_request' })
    }
    const code = randomUUID()
    codes.set(code, {
      codeChallenge,
      clientId: url.searchParams.get('client_id'),
      redirectUri,
      scope: url.searchParams.get('scope') ?? '',
      createdAt: Date.now(),
    })
    const callback = new URL(redirectUri)
    callback.searchParams.set('code', code)
    callback.searchParams.set('state', state)
    response.writeHead(302, { Location: callback.toString() })
    return response.end()
  }

  if (url.pathname === '/token' && request.method === 'POST') {
    const body = await readBody(request)
    const params = new URLSearchParams(body)
    if (params.get('grant_type') === 'refresh_token') {
      if (!tokens.has(params.get('refresh_token'))) {
        return json(response, 400, { error: 'invalid_grant' })
      }
      tokens.delete(params.get('refresh_token'))
      const nextRefreshToken = `fake-refresh-${randomUUID()}`
      tokens.set(nextRefreshToken, true)
      return json(response, 200, {
        token_type: 'Bearer',
        access_token: accessToken,
        refresh_token: nextRefreshToken,
        expires_in: 300,
        scope: 'mcp:tools',
      })
    }

    const code = codes.get(params.get('code'))
    const verifier = params.get('code_verifier')
    const expectedChallenge = verifier
      ? createHash('sha256').update(verifier).digest('base64url')
      : ''
    if (!code || Date.now() - code.createdAt > 30_000 || !verifier || code.codeChallenge !== expectedChallenge
        || code.clientId !== params.get('client_id')
        || code.redirectUri !== params.get('redirect_uri')) {
      return json(response, 400, { error: 'invalid_grant' })
    }
    codes.delete(params.get('code'))
    const refreshToken = `fake-refresh-${randomUUID()}`
    tokens.set(refreshToken, true)
    return json(response, 200, {
      token_type: 'Bearer',
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 300,
      scope: code.scope,
    })
  }

  if (url.pathname === '/revoke' && request.method === 'POST') {
    const body = await readBody(request)
    tokens.delete(new URLSearchParams(body).get('token'))
    return response.end()
  }

  return json(response, 404, { error: 'not_found' })
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
  console.log(`[fake-oauth] listening on ${port}`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(() => process.exit(0)))
}
