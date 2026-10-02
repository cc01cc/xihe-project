import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { runCommand } from './xihe.mjs';
import { promptSecret } from './xihe-cli/provider.mjs';

const TEST_KEY = 'test-provider-secret-value';
const TEST_PASSWORD = 'test-admin-password';

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
}

function createView(id, patch = {}) {
  return {
    id,
    providerId: 'xiaomi',
    label: 'XH local MiMo',
    scope: 'USER',
    ownerId: 'user-1',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    hasKey: true,
    maskedKey: '****alue',
    enabled: true,
    status: 'verifying',
    lastVerifiedAt: null,
    lastErrorCode: null,
    revision: 1,
    ...patch,
  };
}

async function startCpMock({ barrierFirstTwoLists = false, dropCreateResponse = false, dropPatchResponse = false, dropVerifyResponse = false } = {}) {
  const state = {
    connections: [],
    lastCreateBody: null,
    dropCreateResponse,
    dropPatchResponse,
    dropVerifyResponse,
    createRequests: 0,
    patchRequests: 0,
    verifyRequests: 0,
    loginRequests: 0,
    catalogRequests: 0,
    listRequests: 0,
    configImportRequests: 0,
    configImportStatus: 200,
    importedConfig: null,
  };
  let releaseLists;
  const firstListsReleased = new Promise((resolve) => { releaseLists = resolve; });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/actuator/health' && request.method === 'GET') {
      json(response, 200, { status: 'UP' });
      return;
    }
    if (url.pathname === '/api/v1/auth/login' && request.method === 'POST') {
      state.loginRequests += 1;
      const body = await requestBody(request);
      if (body.email !== 'admin@xihe.local' || body.password !== TEST_PASSWORD) {
        json(response, 401, { code: 'AUTHENTICATION_FAILED', detail: 'must not be printed' });
        return;
      }
      json(response, 200, { accessToken: 'test-access-token' });
      return;
    }
    if (url.pathname === '/api/v1/config/import' && request.method === 'POST') {
      state.configImportRequests += 1;
      state.importedConfig = await requestBody(request);
      json(response, state.configImportStatus, state.configImportStatus >= 500
        ? { code: 'INTERNAL_ERROR', detail: 'must not be printed' }
        : { imported: ['llm-provider'] });
      return;
    }
    if (url.pathname === '/api/v1/provider-catalog' && request.method === 'GET') {
      state.catalogRequests += 1;
      json(response, 200, {
      providers: [{
          id: 'xiaomi',
          displayName: 'Xiaomi MiMo',
          defaultBaseUrl: 'https://api.xiaomimimo.com/v1',
          modelDiscovery: 'remote-models',
          credential: { required: true },
        }, {
          id: 'volcengine-ark',
          displayName: 'Volcengine Ark',
          defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
          modelDiscovery: 'manual',
          credential: { required: true },
          supports: { customBaseUrl: true },
        }],
      });
      return;
    }
    if (url.pathname === '/api/v1/provider-connections' && request.method === 'GET') {
      state.listRequests += 1;
      if (barrierFirstTwoLists && state.listRequests <= 2) {
        if (state.listRequests === 2) releaseLists();
        await firstListsReleased;
      }
      json(response, 200, { connections: state.connections.map((connection) => ({ ...connection })) });
      return;
    }
    if (url.pathname === '/api/v1/provider-connections' && request.method === 'POST') {
      state.createRequests += 1;
      const body = await requestBody(request);
      if (state.connections.some((item) => item.providerId === body.providerId && item.scope === body.scope)) {
        json(response, 400, { code: 'PROVIDER_CONNECTION_INVALID', detail: 'A connection already exists; must not be printed' });
        return;
      }
      if (body.apiKey !== TEST_KEY) {
        json(response, 400, { code: 'PROVIDER_CONNECTION_INVALID', detail: 'Invalid key; must not be printed' });
        return;
      }
      const catalogDefaults = { xiaomi: 'remote-models', 'volcengine-ark': 'manual' };
      state.lastCreateBody = body;
      const connection = createView('connection-1', {
        providerId: body.providerId,
        label: body.label,
        modelDiscovery: body.modelDiscovery ?? catalogDefaults[body.providerId],
        manualModels: body.manualModels,
        status: 'verifying',
      });
      state.connections.push(connection);
      if (state.dropCreateResponse) {
        response.socket.destroy();
        return;
      }
      json(response, 201, connection);
      return;
    }
    const connectionMatch = url.pathname.match(/^\/api\/v1\/provider-connections\/([^/]+)(?:\/(verify))?$/);
    if (connectionMatch && request.method === 'PATCH' && !connectionMatch[2]) {
      state.patchRequests += 1;
      const body = await requestBody(request);
      const connection = state.connections.find((item) => item.id === connectionMatch[1]);
      if (!connection) {
        json(response, 404, { code: 'NOT_FOUND', detail: 'not found' });
        return;
      }
      if (body.apiKey && body.apiKey !== TEST_KEY) {
        json(response, 400, { code: 'PROVIDER_CONNECTION_INVALID', detail: 'Invalid key; must not be printed' });
        return;
      }
      Object.assign(connection, body, { revision: connection.revision + 1, status: 'verifying' });
      if (state.dropPatchResponse) {
        response.socket.destroy();
        return;
      }
      json(response, 200, connection);
      return;
    }
    if (connectionMatch && request.method === 'POST' && connectionMatch[2] === 'verify') {
      state.verifyRequests += 1;
      const connection = state.connections.find((item) => item.id === connectionMatch[1]);
      if (!connection) {
        json(response, 404, { code: 'NOT_FOUND', detail: 'not found' });
        return;
      }
      if (connection.modelDiscovery === 'manual' && (!connection.manualModels || connection.manualModels.length === 0)) {
        Object.assign(connection, { status: 'failed', lastErrorCode: 'LLM_MODEL_CATALOG_INVALID' });
        json(response, 200, { connection, models: [] });
        return;
      }
      Object.assign(connection, { status: 'ready', lastErrorCode: null, lastVerifiedAt: '2026-10-02T00:00:00Z' });
      if (state.dropVerifyResponse) {
        response.socket.destroy();
        return;
      }
      json(response, 200, { connection, models: [] });
      return;
    }
    json(response, 404, { code: 'NOT_FOUND', detail: 'unknown endpoint' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    server,
    state,
    env: {
      XIHE_CP_PORT: String(port),
      XIHE_DEV_ADMIN_PASSWORD: TEST_PASSWORD,
      XIHE_XIAOMI_API_KEY: TEST_KEY,
    },
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function runImportHelper(configPath, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/dev-host-import-config.mjs'], {
      cwd: process.cwd(),
      env: { ...env, XIHE_DEV_IMPORT_CONFIG_PATH: configPath },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

const noPrompt = async () => {
  throw new Error('unexpected secure prompt');
};

test('provider add creates through CP, verifies, and never returns the key', async (t) => {
  const cp = await startCpMock();
  t.after(cp.close);
  const result = await runCommand([
    'provider', 'add', 'xiaomi', '--scope', 'USER', '--label', 'XH local MiMo', '--api-key-env', 'XIHE_XIAOMI_API_KEY',
  ], { env: cp.env, promptSecret: noPrompt });

  assert.equal(result.exitCode, 0);
  assert.equal(result.data.action, 'created-and-verified');
  assert.equal(result.data.connection.status, 'ready');
  assert.equal(cp.state.createRequests, 1);
  assert.equal(cp.state.verifyRequests, 1);
  assert.equal(JSON.stringify(result).includes(TEST_KEY), false);

  const listed = await runCommand(['provider', 'list', '--scope', 'USER'], { env: cp.env, promptSecret: noPrompt });
  assert.equal(listed.exitCode, 0);
  assert.equal(listed.data.connections[0].id, 'connection-1');
  assert.equal(JSON.stringify(listed).includes(TEST_KEY), false);

  const verified = await runCommand(['provider', 'verify', 'connection-1'], { env: cp.env, promptSecret: noPrompt });
  assert.equal(verified.exitCode, 0);
  assert.equal(verified.data.connection.status, 'ready');
  assert.equal(cp.state.verifyRequests, 2);
});

test('dev init reuses an existing connection and does not update its key', async (t) => {
  const cp = await startCpMock();
  t.after(cp.close);
  let helperSpawnCount = 0;
  const options = ['dev', 'init', '--provider', 'xiaomi', '--scope', 'USER', '--label', 'XH local MiMo', '--api-key-env', 'XIHE_XIAOMI_API_KEY'];
  const first = await runCommand(options, { env: cp.env, promptSecret: noPrompt, spawnSyncImpl: () => { helperSpawnCount += 1; } });
  const second = await runCommand(options, { env: cp.env, promptSecret: noPrompt, spawnSyncImpl: () => { helperSpawnCount += 1; } });

  assert.equal(first.exitCode, 0);
  assert.equal(second.exitCode, 0);
  assert.equal(second.data.action, 'reused-and-verified');
  assert.equal(second.data.warnings.length, 1);
  assert.equal(cp.state.createRequests, 1);
  assert.equal(cp.state.patchRequests, 0);
  assert.equal(cp.state.connections.length, 1);
  assert.equal(helperSpawnCount, 0);
});

test('concurrent dev init reconciles create conflict without duplicate records', async (t) => {
  const cp = await startCpMock({ barrierFirstTwoLists: true });
  t.after(cp.close);
  cp.state.connections.push(createView('workspace-connection', { scope: 'WORKSPACE', label: 'Do not modify' }));
  const args = ['dev', 'init', '--provider', 'xiaomi', '--scope', 'USER', '--label', 'XH local MiMo', '--api-key-env', 'XIHE_XIAOMI_API_KEY'];
  const [left, right] = await Promise.all([
    runCommand(args, { env: cp.env, promptSecret: noPrompt }),
    runCommand(args, { env: cp.env, promptSecret: noPrompt }),
  ]);

  assert.equal(left.exitCode, 0);
  assert.equal(right.exitCode, 0);
  assert.equal(cp.state.createRequests, 2);
  assert.equal(cp.state.connections.length, 2);
  assert.equal(cp.state.connections.filter((item) => item.scope === 'USER').length, 1);
  assert.equal(cp.state.connections.find((item) => item.id === 'workspace-connection').label, 'Do not modify');
  assert.equal(cp.state.verifyRequests, 2);
});

test('dev init reconciles a lost create response and does not replay POST', async (t) => {
  const cp = await startCpMock({ dropCreateResponse: true });
  t.after(cp.close);
  const result = await runCommand([
    'dev', 'init', '--provider', 'xiaomi', '--scope', 'USER', '--label', 'XH local MiMo', '--api-key-env', 'XIHE_XIAOMI_API_KEY',
  ], { env: cp.env, promptSecret: noPrompt });

  assert.equal(result.exitCode, 0);
  assert.equal(result.data.connection.id, 'connection-1');
  assert.equal(cp.state.createRequests, 1);
  assert.equal(cp.state.connections.length, 1);
  assert.equal(cp.state.verifyRequests, 1);
});

test('dev init reconciles an HTTP 5xx after create without replaying POST', async (t) => {
  const cp = await startCpMock();
  t.after(cp.close);
  const fetchImpl = async (url, options) => {
    if (String(url).endsWith('/api/v1/provider-connections') && options.method === 'POST') {
      cp.state.createRequests += 1;
      cp.state.connections.push(createView('connection-1'));
      return new Response(JSON.stringify({ code: 'INTERNAL_ERROR', detail: TEST_KEY }), {
        status: 500,
        headers: { 'Content-Type': 'application/problem+json' },
      });
    }
    return fetch(url, options);
  };
  const result = await runCommand([
    'dev', 'init', '--provider', 'xiaomi', '--scope', 'USER', '--label', 'XH local MiMo', '--api-key-env', 'XIHE_XIAOMI_API_KEY',
  ], { env: cp.env, fetchImpl, promptSecret: noPrompt });

  assert.equal(result.exitCode, 0);
  assert.equal(result.data.action, 'reused-after-create-conflict');
  assert.equal(cp.state.createRequests, 1);
  assert.equal(cp.state.connections.length, 1);
  assert.equal(JSON.stringify(result).includes(TEST_KEY), false);
});

test('provider update reports an HTTP 5xx as unknown and does not replay PATCH', async (t) => {
  const cp = await startCpMock();
  t.after(cp.close);
  await runCommand([
    'provider', 'add', 'xiaomi', '--scope', 'USER', '--label', 'XH local MiMo', '--api-key-env', 'XIHE_XIAOMI_API_KEY',
  ], { env: cp.env, promptSecret: noPrompt });
  const fetchImpl = async (url, options) => {
    if (String(url).endsWith('/provider-connections/connection-1') && options.method === 'PATCH') {
      cp.state.patchRequests += 1;
      Object.assign(cp.state.connections[0], JSON.parse(options.body));
      return new Response(JSON.stringify({ code: 'INTERNAL_ERROR', detail: TEST_KEY }), {
        status: 500,
        headers: { 'Content-Type': 'application/problem+json' },
      });
    }
    return fetch(url, options);
  };
  const result = await runCommand(['provider', 'update', 'connection-1', '--label', 'Updated'], {
    env: cp.env,
    fetchImpl,
    promptSecret: noPrompt,
  });

  assert.equal(result.error.code, 'OPERATION_OUTCOME_UNKNOWN');
  assert.equal(cp.state.patchRequests, 1);
  assert.equal(cp.state.connections[0].label, 'Updated');
  assert.equal(JSON.stringify(result).includes(TEST_KEY), false);
});

test('provider update reports an unknown outcome without replaying PATCH', async (t) => {
  const cp = await startCpMock();
  t.after(cp.close);
  await runCommand([
    'provider', 'add', 'xiaomi', '--scope', 'USER', '--label', 'XH local MiMo', '--api-key-env', 'XIHE_XIAOMI_API_KEY',
  ], { env: cp.env, promptSecret: noPrompt });
  cp.state.dropPatchResponse = true;
  const result = await runCommand([
    'provider', 'update', 'connection-1', '--api-key-env', 'XIHE_XIAOMI_API_KEY',
  ], { env: { ...cp.env, XIHE_DROP_PATCH_RESPONSE: '1' }, promptSecret: noPrompt });

  assert.equal(cp.state.patchRequests, 1);
  assert.equal(result.exitCode, 1);
  assert.equal(result.error.code, 'OPERATION_OUTCOME_UNKNOWN');
});

test('provider verify reconciles a lost response without replaying POST', async (t) => {
  const cp = await startCpMock();
  t.after(cp.close);
  await runCommand([
    'provider', 'add', 'xiaomi', '--scope', 'USER', '--label', 'XH local MiMo', '--api-key-env', 'XIHE_XIAOMI_API_KEY',
  ], { env: cp.env, promptSecret: noPrompt });
  cp.state.dropVerifyResponse = true;

  const result = await runCommand(['provider', 'verify', 'connection-1'], { env: cp.env, promptSecret: noPrompt });

  assert.equal(result.error.code, 'OPERATION_OUTCOME_UNKNOWN');
  assert.equal(cp.state.verifyRequests, 2);
  assert.equal(cp.state.connections[0].status, 'ready');
});

test('provider update requires an explicit field before login or prompting', async () => {
  let fetchCount = 0;
  let promptCount = 0;
  const result = await runCommand(['provider', 'update', 'connection-1'], {
    env: {},
    fetchImpl: async () => { fetchCount += 1; throw new Error('unexpected request'); },
    promptSecret: async () => { promptCount += 1; throw new Error('unexpected prompt'); },
  });

  assert.equal(result.error.code, 'INVALID_ARGUMENT');
  assert.equal(fetchCount, 0);
  assert.equal(promptCount, 0);
});

test('invalid provider arguments fail before login', async () => {
  let fetchCount = 0;
  let promptCount = 0;
  const result = await runCommand(['provider', 'add', 'xiaomi', '--label', 'local'], {
    env: {},
    fetchImpl: async () => { fetchCount += 1; throw new Error('unexpected request'); },
    promptSecret: async () => { promptCount += 1; throw new Error('unexpected prompt'); },
  });

  assert.equal(result.error.code, 'INVALID_ARGUMENT');
  assert.equal(fetchCount, 0);
  assert.equal(promptCount, 0);
});

test('successful create with invalid JSON is reconciled without replay', async () => {
  const cp = await startCpMock();
  try {
    const fetchImpl = async (url, options) => {
      if (String(url).endsWith('/api/v1/provider-connections') && options.method === 'POST') {
        cp.state.createRequests += 1;
        cp.state.connections.push(createView('connection-1'));
        return new Response('not-json', { status: 201, headers: { 'Content-Type': 'application/json' } });
      }
      return fetch(url, options);
    };
    const result = await runCommand([
      'dev', 'init', '--provider', 'xiaomi', '--scope', 'USER', '--label', 'XH local MiMo', '--api-key-env', 'XIHE_XIAOMI_API_KEY',
    ], { env: cp.env, fetchImpl, promptSecret: noPrompt });

    assert.equal(result.exitCode, 0);
    assert.equal(result.data.action, 'reused-after-create-conflict');
    assert.equal(cp.state.createRequests, 1);
    assert.equal(cp.state.connections.length, 1);
  } finally {
    await cp.close();
  }
});

test('provider update changes only the explicit connection and verifies it', async (t) => {
  const cp = await startCpMock();
  t.after(cp.close);
  await runCommand([
    'provider', 'add', 'xiaomi', '--scope', 'USER', '--label', 'XH local MiMo', '--api-key-env', 'XIHE_XIAOMI_API_KEY',
  ], { env: cp.env, promptSecret: noPrompt });
  const result = await runCommand([
    'provider', 'update', 'connection-1', '--label', 'XH updated MiMo', '--api-key-env', 'XIHE_XIAOMI_API_KEY',
  ], { env: cp.env, promptSecret: noPrompt });

  assert.equal(result.exitCode, 0);
  assert.equal(result.data.connection.label, 'XH updated MiMo');
  assert.equal(result.data.connection.status, 'ready');
  assert.equal(cp.state.patchRequests, 1);
  assert.equal(cp.state.connections.length, 1);
  assert.equal(JSON.stringify(result).includes(TEST_KEY), false);
});

test('create-only add does not silently reuse an existing connection', async (t) => {
  const cp = await startCpMock();
  t.after(cp.close);
  const addArgs = ['provider', 'add', 'xiaomi', '--scope', 'USER', '--label', 'XH local MiMo', '--api-key-env', 'XIHE_XIAOMI_API_KEY'];
  await runCommand(addArgs, { env: cp.env, promptSecret: noPrompt });
  const duplicate = await runCommand(addArgs, { env: cp.env, promptSecret: noPrompt });

  assert.equal(duplicate.exitCode, 1);
  assert.equal(duplicate.error.code, 'PROVIDER_CONNECTION_CREATE_REJECTED');
  assert.equal(cp.state.connections.length, 1);
  assert.equal(cp.state.patchRequests, 0);
});

test('provider add rejects a custom base URL not allowed by the catalog', async (t) => {
  const cp = await startCpMock();
  t.after(cp.close);
  const result = await runCommand([
    'provider', 'add', 'xiaomi', '--scope', 'USER', '--label', 'XH local MiMo',
    '--api-key-env', 'XIHE_XIAOMI_API_KEY', '--base-url', 'https://custom.invalid/v1',
  ], { env: cp.env, promptSecret: noPrompt });
  assert.equal(result.error.code, 'CUSTOM_BASE_URL_UNSUPPORTED');
  assert.equal(cp.state.createRequests, 0);
});

test('secret values are rejected in argv and are not echoed in parser errors', async () => {
  const result = await runCommand([
    'provider', 'add', 'xiaomi', '--scope', 'USER', '--label', 'XH local MiMo', `--api-key=${TEST_KEY}`,
  ], { env: {}, promptSecret: noPrompt });
  assert.equal(result.error.code, 'INVALID_ARGUMENT');
  assert.equal(JSON.stringify(result).includes(TEST_KEY), false);
});

test('manual-discovery providers require explicit, unique model IDs', async (t) => {
  const cp = await startCpMock();
  t.after(cp.close);
  const missing = await runCommand([
    'provider', 'add', 'volcengine-ark', '--scope', 'USER', '--label', 'Ark', '--api-key-env', 'XIHE_XIAOMI_API_KEY',
  ], { env: cp.env, promptSecret: noPrompt });
  assert.equal(missing.error.code, 'MANUAL_MODELS_REQUIRED');
  assert.equal(cp.state.createRequests, 0);
  const duplicate = await runCommand([
    'provider', 'add', 'volcengine-ark', '--scope', 'USER', '--label', 'Ark',
    '--api-key-env', 'XIHE_XIAOMI_API_KEY', '--models', 'doubao-pro,doubao-pro',
  ], { env: cp.env, promptSecret: noPrompt });
  assert.equal(duplicate.error.code, 'INVALID_ARGUMENT');
  assert.equal(cp.state.createRequests, 0);

  const added = await runCommand([
    'provider', 'add', 'volcengine-ark', '--scope', 'USER', '--label', 'Ark',
    '--api-key-env', 'XIHE_XIAOMI_API_KEY', '--models', 'doubao-pro,deepseek-v3',
  ], { env: cp.env, promptSecret: noPrompt });
  assert.equal(added.exitCode, 0);
  assert.equal(added.data.connection.providerId, 'volcengine-ark');
  assert.equal(cp.state.lastCreateBody.modelDiscovery, undefined);
  assert.deepEqual(cp.state.connections[0].manualModels, ['doubao-pro', 'deepseek-v3']);
  assert.equal(JSON.stringify(added).includes(TEST_KEY), false);

  const updated = await runCommand([
    'provider', 'update', 'connection-1', '--models', 'ark-pro,ark-lite', '--label', 'Ark updated',
  ], { env: cp.env, promptSecret: noPrompt });
  assert.equal(updated.exitCode, 0);
  assert.equal(cp.state.connections[0].modelDiscovery, 'manual');
  assert.deepEqual(cp.state.connections[0].manualModels, ['ark-pro', 'ark-lite']);
});

test('model discovery strictly follows the CP Catalog', async (t) => {
  const cp = await startCpMock();
  t.after(cp.close);
  const override = await runCommand([
    'provider', 'add', 'xiaomi', '--scope', 'USER', '--label', 'XH local MiMo',
    '--api-key-env', 'XIHE_XIAOMI_API_KEY', '--model-discovery', 'manual',
  ], { env: cp.env, promptSecret: noPrompt });
  assert.equal(override.error.code, 'INVALID_ARGUMENT');
  assert.equal(cp.state.createRequests, 0);

  const remoteModels = await runCommand([
    'provider', 'add', 'xiaomi', '--scope', 'USER', '--label', 'XH local MiMo',
    '--api-key-env', 'XIHE_XIAOMI_API_KEY', '--models', 'mimo-v2.5',
  ], { env: cp.env, promptSecret: noPrompt });
  assert.equal(remoteModels.error.code, 'INVALID_ARGUMENT');
  assert.equal(cp.state.createRequests, 0);

  const created = await runCommand([
    'provider', 'add', 'xiaomi', '--scope', 'USER', '--label', 'XH local MiMo',
    '--api-key-env', 'XIHE_XIAOMI_API_KEY',
  ], { env: cp.env, promptSecret: noPrompt });
  assert.equal(created.exitCode, 0);
  assert.equal(cp.state.lastCreateBody.modelDiscovery, undefined);
  assert.equal(cp.state.connections[0].modelDiscovery, 'remote-models');
});

test('dev check does not create the host root or print environment secrets', async (t) => {
  const cp = await startCpMock();
  t.after(cp.close);
  const absentRoot = path.join(tmpdir(), `xihe-cli-check-${process.pid}-absent`);
  const result = await runCommand(['dev', 'check', '--json'], {
    env: { ...cp.env, XIHE_WORKSPACE_HOST_ROOT: absentRoot, XIHE_XIAOMI_API_KEY: TEST_KEY },
    spawnSyncImpl: () => ({ status: 0, stdout: 'tool version\n', stderr: '' }),
    portProbeFn: async () => ({ free: true }),
    promptSecret: noPrompt,
  });

  assert.equal(fs.existsSync(absentRoot), false);
  assert.equal(result.data.checks.find((check) => check.name === 'Xiaomi API key in current process').status, 'present');
  assert.equal(JSON.stringify(result).includes(TEST_KEY), false);
});

test('CP connection refusal is retried once before sending the request', async (t) => {
  const cp = await startCpMock();
  t.after(cp.close);
  let failOnce = true;
  const fetchImpl = async (url, options) => {
    if (failOnce) {
      failOnce = false;
      const error = new TypeError('fetch failed');
      error.cause = { code: 'ECONNREFUSED' };
      throw error;
    }
    return fetch(url, options);
  };
  const result = await runCommand(['provider', 'list'], { env: cp.env, fetchImpl, promptSecret: noPrompt });
  assert.equal(result.exitCode, 0);
  assert.equal(cp.state.loginRequests, 1);
});

test('config import invokes the existing helper without putting the password in argv', async (t) => {
  const cp = await startCpMock();
  t.after(cp.close);
  let invocation;
  const result = await runCommand(['config', 'import', 'mise.toml'], {
    env: cp.env,
    promptSecret: noPrompt,
    spawnSyncImpl: (command, args, options) => {
      invocation = { command, args, options };
      return { status: 0, stdout: '', stderr: '' };
    },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.data.importedFile, 'mise.toml');
  assert.equal(invocation.args.includes(TEST_PASSWORD), false);
  assert.equal(invocation.options.env.XIHE_DEV_ADMIN_PASSWORD, TEST_PASSWORD);
});

test('config import maps an ambiguous helper outcome without retrying', async () => {
  let helperCalls = 0;
  const result = await runCommand(['config', 'import', 'mise.toml'], {
    env: { XIHE_DEV_ADMIN_PASSWORD: TEST_PASSWORD },
    spawnSyncImpl: () => { helperCalls += 1; return { status: 70, stdout: '', stderr: 'OPERATION_OUTCOME_UNKNOWN' }; },
  });
  assert.equal(result.error.code, 'OPERATION_OUTCOME_UNKNOWN');
  assert.equal(helperCalls, 1);
});

test('config import timeout reports unknown outcome and is not replayed', async (t) => {
  const cp = await startCpMock();
  t.after(cp.close);
  let calls = 0;
  const result = await runCommand(['config', 'import', 'mise.toml'], {
    env: cp.env,
    promptSecret: noPrompt,
    spawnSyncImpl: () => {
      calls += 1;
      return { error: { code: 'ETIMEDOUT' }, status: null, stdout: '', stderr: '' };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.error.code, 'OPERATION_OUTCOME_UNKNOWN');
  assert.equal(JSON.stringify(result).includes(TEST_PASSWORD), false);
});

test('config import helper omits API key fragments and reports ambiguous 5xx outcomes', async (t) => {
  const cp = await startCpMock();
  const tempDirectory = fs.mkdtempSync(path.join(tmpdir(), 'xihe-config-import-'));
  const configPath = path.join(tempDirectory, 'config.jsonc');
  const configSecret = 'APIKEY_SECRET_SENTINEL_29bf71';
  fs.writeFileSync(configPath, JSON.stringify({ 'llm-provider': { xiaomiApiKey: configSecret } }));
  t.after(async () => {
    await cp.close();
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  });

  const success = await runImportHelper(configPath, cp.env);
  assert.equal(success.code, 0);
  assert.equal(cp.state.configImportRequests, 1);
  assert.equal(cp.state.importedConfig['llm-provider'].xiaomiApiKey, configSecret);
  assert.match(success.stdout, /xiaomiApiKey\s+: present/);
  assert.equal(success.stdout.includes(configSecret), false);
  assert.equal(success.stdout.includes(configSecret.slice(0, 6)), false);
  assert.equal(success.stdout.includes(configSecret.slice(-6)), false);

  cp.state.configImportStatus = 500;
  const ambiguous = await runImportHelper(configPath, cp.env);
  assert.equal(ambiguous.code, 70);
  assert.match(ambiguous.stderr, /OPERATION_OUTCOME_UNKNOWN/);
  assert.equal(cp.state.configImportRequests, 2);
  assert.equal(ambiguous.stderr.includes(configSecret), false);
});

test('real test preflight refuses missing key without starting runner', async () => {
  let spawnCount = 0;
  const result = await runCommand(['test', 'real', 'e2e/real/real-tool-roundtrip.spec.ts'], {
    env: { XIHE_E2E_REAL_ROUTE: 'openai-compat' },
    spawnImpl: () => { spawnCount += 1; throw new Error('should not spawn'); },
  });
  assert.equal(result.error.code, 'REAL_PROVIDER_KEY_REQUIRED');
  assert.equal(spawnCount, 0);
});

test('real test forwards explicit real mode and disables Playwright retries', async () => {
  let spawnArgs;
  let stdout = '';
  const stdoutSink = { write: (chunk) => { stdout += chunk.toString(); return true; } };
  const stderrSink = { write: () => true };
  const spawnImpl = (_command, args, options) => {
    spawnArgs = args;
    assert.equal(options.env.XIHE_E2E_LLM_MODE, 'real');
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    setImmediate(() => {
      child.stdout.write('output: test-provider-');
      child.stdout.write('secret-value\n');
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit('close', 0, null));
    });
    return child;
  };
  const result = await runCommand(['test', 'real', 'e2e/real/real-tool-roundtrip.spec.ts', '--route', 'openai-compat'], {
    env: { XIHE_E2E_REAL_XIAOMI_KEY: 'test-provider-secret-value', XIHE_E2E_REAL_ROUTE: 'openai-compat' },
    spawnImpl,
    stdout: stdoutSink,
    stderr: stderrSink,
  });
  assert.equal(result.exitCode, 0);
  assert.ok(spawnArgs.includes('--llm-mode=real'));
  assert.ok(spawnArgs.includes('--retries=0'));
  assert.match(stdout, /Real test preflight: spec=e2e\/real\/real-tool-roundtrip\.spec\.ts route=openai-compat mode=real retries=0/);
  assert.equal(stdout.includes('test-provider-secret-value'), false);
});

test('real runner failure is returned without replaying the spec', async () => {
  let spawnCount = 0;
  const spawnImpl = () => {
    spawnCount += 1;
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    setImmediate(() => {
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit('close', 1, null));
    });
    return child;
  };
  const result = await runCommand(['test', 'real', 'e2e/real/real-tool-roundtrip.spec.ts'], {
    env: { XIHE_E2E_REAL_XIAOMI_KEY: TEST_KEY, XIHE_E2E_REAL_ROUTE: 'openai-compat' },
    spawnImpl,
    stdout: { write: () => true },
    stderr: { write: () => true },
  });
  assert.equal(result.exitCode, 1);
  assert.equal(spawnCount, 1);
});

test('TTY secret prompt does not echo the entered value', async () => {
  class FakeTty extends EventEmitter {
    isTTY = true;
    isRaw = false;
    setRawMode(value) { this.isRaw = value; }
    resume() {}
    pause() {}
  }
  const stdin = new FakeTty();
  let output = '';
  const stdout = { write(value) { output += value; return true; } };
  const pending = promptSecret('Provider key', { stdin, stdout });
  stdin.emit('data', Buffer.from(`${TEST_KEY}\r`));
  assert.equal(await pending, TEST_KEY);
  assert.equal(output.includes(TEST_KEY), false);
  assert.equal(stdin.isRaw, false);
});

test('CP error details never enter CLI error output', async (t) => {
  const cp = await startCpMock();
  t.after(cp.close);
  const fetchImpl = async (url, options) => {
    const response = await fetch(url, options);
    if (String(url).endsWith('/api/v1/provider-connections')) {
      return new Response(JSON.stringify({ code: 'ACCESS_DENIED', detail: TEST_KEY }), {
        status: 403,
        headers: { 'Content-Type': 'application/problem+json' },
      });
    }
    return response;
  };
  const result = await runCommand(['provider', 'list'], { env: cp.env, fetchImpl, promptSecret: noPrompt });
  assert.equal(result.error.code, 'ACCESS_DENIED');
  assert.equal(JSON.stringify(result).includes(TEST_KEY), false);
});

test('CP 401 and 403 map to stable CLI errors without exposing response details', async (t) => {
  const cp = await startCpMock();
  t.after(cp.close);
  for (const [status, code] of [[401, 'AUTHENTICATION_FAILED'], [403, 'ACCESS_DENIED']]) {
    const fetchImpl = async (url, options) => {
      if (String(url).endsWith('/api/v1/provider-connections')) {
        return new Response(JSON.stringify({ code, detail: TEST_KEY }), {
          status,
          headers: { 'Content-Type': 'application/problem+json' },
        });
      }
      return fetch(url, options);
    };
    const result = await runCommand(['provider', 'list'], { env: cp.env, fetchImpl, promptSecret: noPrompt });
    assert.equal(result.error.code, code);
    assert.equal(JSON.stringify(result).includes(TEST_KEY), false);
  }
});

test('provider verification reports provider credential and reachability failures', async (t) => {
  const cp = await startCpMock();
  t.after(cp.close);
  await runCommand([
    'provider', 'add', 'xiaomi', '--scope', 'USER', '--label', 'XH local MiMo', '--api-key-env', 'XIHE_XIAOMI_API_KEY',
  ], { env: cp.env, promptSecret: noPrompt });

  for (const providerErrorCode of ['LLM_PROVIDER_UNAUTHORIZED', 'LLM_PROVIDER_UNAVAILABLE']) {
    const fetchImpl = async (url, options) => {
      if (String(url).endsWith('/connection-1/verify') && options.method === 'POST') {
        return new Response(JSON.stringify({
          connection: createView('connection-1', { status: 'failed', lastErrorCode: providerErrorCode }),
          models: [],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return fetch(url, options);
    };
    const result = await runCommand(['provider', 'verify', 'connection-1'], { env: cp.env, fetchImpl, promptSecret: noPrompt });
    assert.equal(result.error.code, 'PROVIDER_VERIFY_FAILED');
    assert.equal(result.error.details.providerErrorCode, providerErrorCode);
  }
});

test('invalid CP JSON is reported without exposing the response body', async (t) => {
  const cp = await startCpMock();
  t.after(cp.close);
  const fetchImpl = async (url, options) => {
    if (String(url).endsWith('/api/v1/provider-catalog')) {
      return new Response(TEST_KEY, { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return fetch(url, options);
  };
  const result = await runCommand(['provider', 'add', 'xiaomi', '--scope', 'USER', '--label', 'local'], {
    env: cp.env,
    fetchImpl,
    promptSecret: noPrompt,
  });
  assert.equal(result.error.code, 'CP_RESPONSE_INVALID');
  assert.equal(JSON.stringify(result).includes(TEST_KEY), false);
  assert.equal(cp.state.createRequests, 0);
});

test('invalid real route fails preflight without starting the host runner', async () => {
  let spawnCount = 0;
  const result = await runCommand(['test', 'real', 'e2e/real/real-tool-roundtrip.spec.ts', '--route', 'unknown'], {
    env: { XIHE_E2E_REAL_XIAOMI_KEY: TEST_KEY },
    spawnImpl: () => { spawnCount += 1; throw new Error('should not spawn'); },
  });
  assert.equal(result.error.code, 'REAL_PROVIDER_ROUTE_REQUIRED');
  assert.equal(spawnCount, 0);
});
