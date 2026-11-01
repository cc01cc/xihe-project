#!/usr/bin/env node
/**
 * PLAN-0622 A5 preflight: ensure the A5 account sees a READY chat connection on a
 * mock-LLM stack. Mirrors `packages/ui/e2e/real/helpers/tool-capable-chat.ts`
 * (built-in `openai` provider row + fake LLM base URL), without inventing a new path.
 *
 *   node scripts/xihe-cli/prepare-agent-e2e-connection.mjs \
 *     --cp http://127.0.0.1:<cp> --workspace <wsId> \
 *     --fake-llm-port <port> [--model fake-openai] [--email <acct>] \
 *     [--password-env XIHE_DEV_ADMIN_PASSWORD] [--json]
 *
 * Exit codes: 0 ready · 1 failure · 2 usage error. Never prints tokens or the apiKey.
 */
import { pathToFileURL } from 'node:url';
import { CliError } from './provider.mjs';

function usageError(message) {
  return new CliError('INVALID_ARGUMENT', message, {}, 2);
}

function createClient({ apiBase, fetchImpl, token, workspaceId }) {
  return {
    async call(method, pathname, { body } = {}) {
      const headers = {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Workspace-Id': workspaceId,
      };
      let response;
      try {
        response = await fetchImpl(`${apiBase}${pathname}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (error) {
        const aborted = error?.name === 'AbortError' || error?.name === 'TimeoutError';
        throw new CliError(aborted ? 'REQUEST_TIMEOUT' : 'CONNECTION_FAILED', `Could not reach CP for ${method} ${pathname}.`, {}, 1);
      }
      const text = await response.text().catch(() => '');
      let parsed = null;
      if (text.trim() !== '') {
        try { parsed = JSON.parse(text); } catch { parsed = null; }
      }
      return {
        status: response.status,
        body: parsed,
        code: typeof parsed?.code === 'string' ? parsed.code : null,
      };
    },
  };
}

async function login({ apiBase, fetchImpl, email, password }) {
  const response = await fetchImpl(`${apiBase}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: email, password }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json().catch(() => null);
  if (response.status !== 200 || typeof body?.accessToken !== 'string') {
    throw new CliError(body?.code ?? 'LOGIN_FAILED', `Login failed (HTTP ${response.status}).`, {}, 1);
  }
  return body.accessToken;
}

function expectOk(response, action) {
  if (response.status >= 200 && response.status < 300) return response;
  throw new CliError(response.code ?? `HTTP_${response.status}`, `CP rejected ${action} (HTTP ${response.status}${response.code ? ` ${response.code}` : ''}).`, {}, 1);
}

export async function prepareConnection({ env, fetchImpl = fetch, options }) {
  const apiBase = String(options['--cp'] ?? '').trim().replace(/\/$/, '');
  if (!apiBase) throw usageError('--cp <url> is required.');
  const workspaceId = String(options['--workspace'] ?? '').trim();
  if (!workspaceId) throw usageError('--workspace <wsId> is required.');
  const fakeLlmPort = String(options['--fake-llm-port'] ?? '').trim();
  if (!fakeLlmPort) throw usageError('--fake-llm-port <port> is required (persistent-stack.json ports.fakeLlm).');
  const email = String(options['--email'] ?? 'admin@xihe.local').trim();
  const passwordEnv = String(options['--password-env'] ?? 'XIHE_DEV_ADMIN_PASSWORD').trim();
  const password = env[passwordEnv];
  if (typeof password !== 'string' || password === '') {
    throw usageError(`请设置环境变量 ${passwordEnv}（密码不进 argv；可用 persistent-stack.json 的 goldpathAccount.password）。`);
  }
  const model = String(options['--model'] ?? 'fake-openai').trim();

  const token = await login({ apiBase, fetchImpl, email, password });
  const client = createClient({ apiBase, fetchImpl, token, workspaceId });
  const baseUrl = `http://127.0.0.1:${fakeLlmPort}/openai/v1`;

  const listed = expectOk(await client.call('GET', '/api/v1/provider-connections'), 'connection listing');
  const connections = Array.isArray(listed.body?.connections) ? listed.body.connections : [];
  let connection = connections.find((item) => item?.enabled && item?.status === 'READY'
    && item?.operation === 'chat' && item?.providerId === 'openai');
  let created = false;
  if (!connection) {
    const createdResponse = expectOk(await client.call('POST', '/api/v1/provider-connections', {
      body: {
        providerId: 'openai',
        apiTypeId: 'openai-chat-completions',
        apiTypeVersion: 1,
        apiKey: 'sk-fake-openai-key',
        connectionKey: `agent-e2e-${workspaceId.slice(0, 8)}`,
        label: 'Agent E2E chat',
        scope: 'USER',
        modelDiscovery: 'manual',
        manualModels: [model],
        baseUrl,
      },
    }), 'connection creation');
    created = true;
    const verified = expectOk(await client.call('POST', `/api/v1/provider-connections/${encodeURIComponent(createdResponse.body.id)}/verify`), 'connection verify');
    connection = verified.body?.connection ?? verified.body;
    if (connection?.status !== 'READY') {
      throw new CliError('CONNECTION_NOT_READY', `Connection ${connection?.id ?? '?'} is ${connection?.status ?? 'unknown'}, expected READY.`, {}, 1);
    }
  }
  if (!(connection.manualModels ?? []).includes(model)) {
    const patched = expectOk(await client.call('PATCH', `/api/v1/provider-connections/${encodeURIComponent(connection.id)}`, {
      body: { manualModels: [...(connection.manualModels ?? []), model], expectedRevision: connection.revision },
    }), 'connection model patch');
    connection = patched.body?.connection ?? patched.body;
  }
  return {
    connectionId: connection.id,
    status: connection.status,
    providerId: connection.providerId,
    model,
    baseUrl,
    created,
    workspaceId,
  };
}

export async function main(argv = process.argv.slice(2), { env = process.env, fetchImpl = fetch } = {}) {
  let json = false;
  const args = [];
  for (const arg of argv) {
    if (arg === '--json') json = true;
    else args.push(arg);
  }
  const valueFlags = ['--cp', '--workspace', '--fake-llm-port', '--model', '--email', '--password-env'];
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!valueFlags.includes(token)) throw usageError(`Unknown argument ${token}.`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) throw usageError(`${token} requires a value.`);
    values[token] = value;
    index += 1;
  }
  try {
    const data = await prepareConnection({ env, fetchImpl, options: values });
    if (json) process.stdout.write(`${JSON.stringify({ ok: true, data }, null, 2)}\n`);
    else process.stdout.write(`[agent-e2e] connection=${data.connectionId} status=${data.status} model=${data.model} created=${data.created}\n`);
    return 0;
  } catch (error) {
    const cliError = error instanceof CliError ? error : new CliError('UNEXPECTED_ERROR', 'Connection preparation failed unexpectedly.');
    if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: { code: cliError.code, message: cliError.message } }, null, 2)}\n`);
    else process.stderr.write(`[${cliError.code}] ${cliError.message}\n`);
    return cliError.exitCode ?? 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
