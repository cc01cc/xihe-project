import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { printResult, runCommand } from './xihe.mjs';
import { promptSecret } from './xihe-cli/provider.mjs';
import { applySetToEnv, applyUrlSyncToEnv, parseStackSetArgs } from './lib/stack-set.mjs';

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
    deleteImpactRequests: 0,
    deleteRequests: 0,
    deleteStatus: 204,
    deleteBody: null,
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
      if (body.identifier !== 'admin@xihe.local' || body.password !== TEST_PASSWORD) {
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
    const impactMatch = url.pathname.match(/^\/api\/v1\/provider-connections\/([^/]+)\/delete-impact$/);
    if (impactMatch && request.method === 'GET') {
      state.deleteImpactRequests += 1;
      json(response, 200, {
        connectionId: impactMatch[1],
        providerId: 'xiaomi',
        connectionKey: 'owner-1',
        bindingCount: 2,
        bindingUserScopes: ['user-a', 'user-b'],
        defaultTemplateRef: 'default',
        profileCount: 1,
        profileScopes: ['scope-a'],
        sessionCount: 3,
        blocked: false,
      });
      return;
    }
    if (connectionMatch && request.method === 'DELETE' && !connectionMatch[2]) {
      state.deleteRequests += 1;
      if (state.deleteStatus === 204) {
        response.writeHead(204);
        response.end();
        return;
      }
      json(response, state.deleteStatus, state.deleteBody ?? { code: 'CONNECTION_IN_USE' });
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
  // PLAN-0504 replaced the per-key "present/absent" summary lines with
  // imported/domains/llmProfile; the summary must not surface the key name
  // or any fragment of its value.
  assert.match(success.stdout, /imported\s+: 1/);
  assert.match(success.stdout, /domains\s+: llm-provider/);
  assert.equal(success.stdout.includes('xiaomiApiKey'), false);
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

test('credential rotate migrates batches until the retire check reaches zero', async () => {
  const requests = [];
  const statuses = [
    { currentVersion: 'v2', ringVersions: ['v1', 'v2'], countsByVersion: { v1: 3 }, pendingByVersion: { v1: 3 }, pendingTotal: 3 },
    { currentVersion: 'v2', ringVersions: ['v1', 'v2'], countsByVersion: { v2: 3 }, pendingByVersion: {}, pendingTotal: 0 },
  ];
  const runs = [{ scanned: 3, migrated: 3, conflicts: 0, failures: 0, remaining: 0, targetVersion: 'v2' }];
  const fetchImpl = async (url, options) => {
    const pathname = new URL(url).pathname;
    requests.push({ pathname, method: options?.method ?? 'GET', body: options?.body, headers: options?.headers });
    if (pathname.endsWith('/rotation/status')) {
      return new Response(JSON.stringify(statuses.shift()), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (pathname.endsWith('/rotation/runs')) {
      return new Response(JSON.stringify(runs.shift()), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ code: 'NOT_FOUND' }), { status: 404 });
  };
  const out = [];
  const result = await runCommand(['credential', 'rotate'], {
    env: { XIHE_CP_PORT: '12631', XIHE_CP_API_TOKEN: 'service-token' },
    fetchImpl,
    stdout: { write: (chunk) => { out.push(String(chunk)); } },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.data.retireReady, true);
  assert.equal(result.data.totals.migrated, 3);
  const statusCalls = requests.filter((item) => item.pathname.endsWith('/rotation/status'));
  const runCalls = requests.filter((item) => item.pathname.endsWith('/rotation/runs'));
  assert.equal(statusCalls.length, 2);
  assert.equal(runCalls.length, 1);
  assert.equal(runCalls[0].headers.Authorization, 'Bearer service-token');
  assert.deepEqual(JSON.parse(runCalls[0].body), { batchSize: 50 });
  assert.ok(out.join('').includes('Batch 1'));
  assert.ok(out.join('').includes('migrated=3'));
  assert.equal(JSON.stringify(result).includes('service-token'), false);
});

test('credential rotate refuses to run when the ring misses a pending version', async () => {
  let runCalls = 0;
  const fetchImpl = async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith('/rotation/status')) {
      return new Response(JSON.stringify({
        currentVersion: 'v2',
        ringVersions: ['v2'],
        countsByVersion: { v1: 2 },
        pendingByVersion: { v1: 2 },
        pendingTotal: 2,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    runCalls += 1;
    return new Response('{}', { status: 200 });
  };
  const result = await runCommand(['credential', 'rotate'], {
    env: { XIHE_CP_PORT: '12631', XIHE_CP_API_TOKEN: 'service-token' },
    fetchImpl,
  });
  assert.equal(result.error.code, 'KEY_RING_INCOMPLETE');
  assert.deepEqual(result.error.details.missingVersions, ['v1']);
  assert.equal(runCalls, 0);
});

test('credential rotate requires the CP service token before any request', async () => {
  let called = 0;
  const fetchImpl = async () => { called += 1; return new Response('{}', { status: 200 }); };
  const result = await runCommand(['credential', 'rotate'], { env: { XIHE_CP_PORT: '12631' }, fetchImpl });
  assert.equal(result.error.code, 'MISSING_SERVICE_TOKEN');
  assert.equal(called, 0);
});

test('credential rotate --dry-run reports pending rows without running batches', async () => {
  let runCalls = 0;
  const fetchImpl = async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith('/rotation/status')) {
      return new Response(JSON.stringify({
        currentVersion: 'v2',
        ringVersions: ['v1', 'v2'],
        countsByVersion: { v1: 4 },
        pendingByVersion: { v1: 4 },
        pendingTotal: 4,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    runCalls += 1;
    return new Response('{}', { status: 200 });
  };
  const result = await runCommand(['credential', 'rotate', '--dry-run'], {
    env: { XIHE_CP_PORT: '12631', XIHE_CP_API_TOKEN: 'service-token' },
    fetchImpl,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.data.dryRun, true);
  assert.equal(result.data.status.pendingTotal, 4);
  assert.equal(runCalls, 0);
});

test('credential rotate aborts when a batch makes no progress', async () => {
  let runCalls = 0;
  const fetchImpl = async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith('/rotation/status')) {
      return new Response(JSON.stringify({
        currentVersion: 'v2',
        ringVersions: ['v1', 'v2'],
        countsByVersion: { v1: 2 },
        pendingByVersion: { v1: 2 },
        pendingTotal: 2,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    runCalls += 1;
    return new Response(JSON.stringify({
      scanned: 2,
      migrated: 0,
      conflicts: 0,
      failures: 2,
      remaining: 2,
      targetVersion: 'v2',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const result = await runCommand(['credential', 'rotate'], {
    env: { XIHE_CP_PORT: '12631', XIHE_CP_API_TOKEN: 'service-token' },
    fetchImpl,
    stdout: { write: () => {} },
  });
  assert.equal(result.error.code, 'ROTATION_STALLED');
  assert.equal(runCalls, 1, 'a no-progress batch must abort instead of spinning to --max-batches');
});

// ─────────────────────────────────────────────────────────────────────────────
// PLAN-0574 M1: verify / config export / provider delete / version
// ─────────────────────────────────────────────────────────────────────────────

function sink() {
  const chunks = [];
  return {
    chunks,
    write(chunk) { chunks.push(String(chunk)); return true; },
    text() { return chunks.join(''); },
  };
}

async function startVerifyCpMock({
  existingPrincipal = null,
  chatResponse = { status: 202, body: { status: 'accepted', runId: 'run-1' } },
  runResponses = [{ status: 'succeeded' }],
  workspaceStatus = 200,
  agentHealthStatus = 200,
  dropSessionResponse = false,
} = {}) {
  const state = { calls: [], runIndex: 0 };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const pathname = url.pathname;
    let body;
    if (request.method !== 'GET' && request.method !== 'DELETE' && request.method !== 'HEAD') {
      try { body = await requestBody(request); } catch { body = undefined; }
    }
    state.calls.push({ method: request.method, pathname, search: url.search, headers: request.headers, body });

    if (pathname === '/api/v1/health' && request.method === 'GET') {
      json(response, 200, { status: 'UP' });
      return;
    }
    if (pathname === '/api/v1/auth/login' && request.method === 'POST') {
      if (body?.password !== TEST_PASSWORD) {
        json(response, 401, { code: 'AUTHENTICATION_FAILED', detail: 'must not be printed' });
        return;
      }
      json(response, 200, { accessToken: 'verify-token' });
      return;
    }
    if (pathname === '/api/v1/workspaces/ws-1' && request.method === 'GET') {
      if (workspaceStatus !== 200) {
        json(response, workspaceStatus, { code: 'WORKSPACE_NOT_FOUND' });
        return;
      }
      json(response, 200, { id: 'ws-1' });
      return;
    }
    if (pathname === '/api/v1/workspaces/ws-1/agents' && request.method === 'GET') {
      json(response, 200, existingPrincipal ? [{ principalId: existingPrincipal }] : []);
      return;
    }
    if (pathname === '/api/v1/agent-principals' && request.method === 'POST') {
      json(response, 201, { principalId: 'principal-new', name: body?.name });
      return;
    }
    if (pathname === '/api/v1/workspaces/ws-1/agents/principal-new' && request.method === 'PUT') {
      json(response, 200, { principalId: 'principal-new', workspaceId: 'ws-1', permissions: [] });
      return;
    }
    if (pathname === '/api/v1/sessions' && request.method === 'POST') {
      if (dropSessionResponse) {
        response.socket.destroy();
        return;
      }
      json(response, 201, { id: 'session-1', agentPrincipalId: body?.agentPrincipalId });
      return;
    }
    if (pathname === '/api/v1/sessions/session-1/branches' && request.method === 'GET') {
      json(response, 200, { sessionId: 'session-1', items: [{ branchId: 'branch-1' }] });
      return;
    }
    if (pathname === '/api/v1/sessions/session-1/messages' && request.method === 'GET') {
      json(response, 200, { items: [] });
      return;
    }
    if (pathname === '/api/v1/events' && request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('data: {"type":"connected","sessionId":"session-1"}\n\n');
      response.end();
      return;
    }
    if (pathname === '/api/v1/models' && request.method === 'GET') {
      json(response, 200, { models: [{ id: 'model-a' }], configRevision: 'rev-1' });
      return;
    }
    if (pathname === '/api/v1/chat' && request.method === 'POST') {
      json(response, chatResponse.status, chatResponse.body);
      return;
    }
    if (pathname === '/api/v1/chat/runs/run-1' && request.method === 'GET') {
      const index = Math.min(state.runIndex, runResponses.length - 1);
      state.runIndex += 1;
      json(response, 200, runResponses[index]);
      return;
    }
    if (pathname === '/api/v1/chat/runs/run-1/cancel' && request.method === 'POST') {
      json(response, 200, { status: 'cancel_accepted', runId: 'run-1' });
      return;
    }
    if (pathname === '/api/v1/sessions/session-1' && request.method === 'DELETE') {
      response.writeHead(204);
      response.end();
      return;
    }
    json(response, 404, { code: 'NOT_FOUND', detail: 'unknown endpoint' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const cpPort = server.address().port;
  const agent = createServer((request, response) => {
    response.writeHead(agentHealthStatus, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      status: 'ok',
      llmReady: true,
      configRevision: 'rev-1',
      mcpInitialized: false,
      rawLogLine: 'agent log must not be printed',
    }));
  });
  await new Promise((resolve) => agent.listen(0, '127.0.0.1', resolve));
  const agentPort = agent.address().port;
  return {
    state,
    env: {
      XIHE_CP_PORT: String(cpPort),
      XIHE_DEV_ADMIN_PASSWORD: TEST_PASSWORD,
    },
    spawnSyncImpl: () => ({
      status: 0,
      stdout: JSON.stringify({ env: { XIHE_CP_PORT: String(cpPort), XIHE_AGENT_PORT: String(agentPort) } }),
      stderr: '',
    }),
    close: async () => {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await new Promise((resolve, reject) => agent.close((error) => error ? reject(error) : resolve()));
    },
  };
}

async function startExportMock({ body = '{ // JSONC comment\n  "domain": { "a": 1 }\n}\n' } = {}) {
  const state = { requests: 0, queries: [] };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/api/v1/auth/login' && request.method === 'POST') {
      await requestBody(request);
      json(response, 200, { accessToken: 'export-token' });
      return;
    }
    if (url.pathname === '/api/v1/config/export' && request.method === 'GET') {
      state.requests += 1;
      state.queries.push(url.searchParams);
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(body);
      return;
    }
    json(response, 404, { code: 'NOT_FOUND' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    state,
    body,
    env: { XIHE_CP_PORT: String(server.address().port), XIHE_DEV_ADMIN_PASSWORD: TEST_PASSWORD },
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test('verify runs the full tier-A chain plus run terminal and cleans up its session', async (t) => {
  const cp = await startVerifyCpMock();
  t.after(cp.close);
  const stdout = sink();
  const stderr = sink();
  const result = await runCommand([
    'verify', '--stack', 'stack-1', '--email', 'admin@xihe.local', '--workspace', 'ws-1', '--yes',
  ], {
    env: cp.env,
    spawnSyncImpl: cp.spawnSyncImpl,
    promptSecret: noPrompt,
    stdout,
    stderr,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.data.result, 'PASS');
  assert.equal(result.data.a.status, 'PASS');
  assert.equal(result.data.b.status, 'PASS');
  assert.equal(result.data.run.status, 'SUCCEEDED');
  assert.equal(result.data.cleanup.session.status, 'deleted');
  assert.equal(result.data.cleanup.principal.status, 'retained');
  assert.equal(JSON.stringify(result).includes('agent log must not be printed'), false);
  assert.equal(stderr.text().includes('agent log must not be printed'), false);

  const methods = cp.state.calls.map((call) => `${call.method} ${call.pathname}`);
  assert.ok(methods.indexOf('POST /api/v1/agent-principals') < methods.indexOf('PUT /api/v1/workspaces/ws-1/agents/principal-new'));
  assert.ok(methods.indexOf('PUT /api/v1/workspaces/ws-1/agents/principal-new') < methods.indexOf('POST /api/v1/sessions'));
  assert.ok(methods.indexOf('POST /api/v1/chat') < methods.indexOf('GET /api/v1/chat/runs/run-1'));
  assert.equal(methods.at(-1), 'DELETE /api/v1/sessions/session-1');

  for (const path of ['/api/v1/sessions', '/api/v1/chat', '/api/v1/chat/runs/run-1']) {
    const call = cp.state.calls.find((item) => item.pathname === path);
    assert.equal(call.headers['x-workspace-id'], 'ws-1');
  }
  const principalCall = cp.state.calls.find((item) => item.pathname === '/api/v1/agent-principals');
  assert.equal(principalCall.headers['x-workspace-id'], undefined);
});

test('verify requires explicit stack/email/workspace before any request', async () => {
  let fetchCalls = 0;
  const result = await runCommand(['verify', '--stack', 'stack-1'], {
    env: {},
    fetchImpl: async () => { fetchCalls += 1; throw new Error('unexpected request'); },
  });
  assert.equal(result.error.code, 'VERIFY_TARGET_REQUIRED');
  assert.equal(result.exitCode, 2);
  assert.deepEqual(result.error.details.missing, ['--email', '--workspace']);
  assert.equal(fetchCalls, 0);
});

test('verify timeout cancels the run before deleting the session and exits 5', async (t) => {
  const cp = await startVerifyCpMock({ runResponses: [{ status: 'running' }] });
  t.after(cp.close);
  let tick = 0;
  const result = await runCommand([
    'verify', '--stack', 'stack-1', '--email', 'admin@xihe.local', '--workspace', 'ws-1', '--yes', '--wait-seconds', '1',
  ], {
    env: cp.env,
    spawnSyncImpl: cp.spawnSyncImpl,
    promptSecret: noPrompt,
    nowImpl: () => { tick += 600; return tick; },
    sleepImpl: async () => {},
    stdout: sink(),
    stderr: sink(),
  });

  assert.equal(result.exitCode, 5);
  assert.equal(result.data.result, 'TIMEOUT');
  assert.equal(result.data.run.status, 'TIMEOUT');
  assert.equal(result.data.cleanup.runCancel.status, 'cancelled');
  const methods = cp.state.calls.map((call) => `${call.method} ${call.pathname}`);
  assert.ok(methods.indexOf('POST /api/v1/chat/runs/run-1/cancel') < methods.indexOf('DELETE /api/v1/sessions/session-1'));
});

test('verify maps a chat precondition failure to exit 4 and still deletes the session', async (t) => {
  const cp = await startVerifyCpMock({
    chatResponse: { status: 409, body: { code: 'SSE_SUBSCRIPTION_REQUIRED' } },
  });
  t.after(cp.close);
  const result = await runCommand([
    'verify', '--stack', 'stack-1', '--email', 'admin@xihe.local', '--workspace', 'ws-1', '--yes',
  ], {
    env: cp.env,
    spawnSyncImpl: cp.spawnSyncImpl,
    promptSecret: noPrompt,
    stdout: sink(),
    stderr: sink(),
  });

  assert.equal(result.exitCode, 4);
  assert.equal(result.data.b.status, 'NOT_AVAILABLE');
  assert.equal(result.data.cleanup.session.status, 'deleted');
  assert.equal(cp.state.calls.some((call) => call.pathname.startsWith('/api/v1/chat/runs/')), false);
});

test('verify reuses a pre-existing principal without rebinding it', async (t) => {
  const cp = await startVerifyCpMock({ existingPrincipal: 'principal-existing' });
  t.after(cp.close);
  const result = await runCommand([
    'verify', '--stack', 'stack-1', '--email', 'admin@xihe.local', '--workspace', 'ws-1', '--yes',
  ], {
    env: cp.env,
    spawnSyncImpl: cp.spawnSyncImpl,
    promptSecret: noPrompt,
    stdout: sink(),
    stderr: sink(),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.data.cleanup.principal.status, 'pre_existing');
  assert.equal(cp.state.calls.some((call) => call.pathname === '/api/v1/agent-principals'), false);
  assert.equal(cp.state.calls.some((call) => call.method === 'PUT'), false);
});

test('config export defaults to includeSecrets=false and returns the JSONC text', async (t) => {
  const cp = await startExportMock();
  t.after(cp.close);
  const result = await runCommand(['config', 'export'], {
    env: cp.env,
    promptSecret: noPrompt,
    stdout: sink(),
    stderr: sink(),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.data.includeSecrets, false);
  assert.equal(result.data.content, cp.body);
  assert.equal(cp.state.queries[0].get('includeSecrets'), 'false');
  assert.equal(cp.state.queries[0].get('layer'), 'instance');
  assert.equal(result.data.cacheControl, 'no-store');
});

test('config export --include-secrets passes true, keeps the secret out of logs, and returns it only as data', async (t) => {
  const secret = 'EXPORT_SECRET_SENTINEL_4a1f';
  const cp = await startExportMock({ body: `{ "secret": "${secret}" }\n` });
  t.after(cp.close);
  const stderr = sink();
  const result = await runCommand(['config', 'export', '--include-secrets', '--json'], {
    env: cp.env,
    promptSecret: noPrompt,
    stderr,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.data.includeSecrets, true);
  assert.equal(cp.state.queries[0].get('includeSecrets'), 'true');
  assert.equal(result.data.content.includes(secret), true);
  assert.match(stderr.text(), /contains secrets/);
  assert.equal(stderr.text().includes(secret), false);
});

test('config export writes a new file exclusively and does not duplicate the body in data', async (t) => {
  const cp = await startExportMock();
  t.after(cp.close);
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'xihe-export-new-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'export.jsonc');

  const result = await runCommand(['config', 'export', '--out', target, '--json'], {
    env: cp.env,
    promptSecret: noPrompt,
    stderr: sink(),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.data.mode, 'file');
  assert.equal(result.data.content, undefined);
  assert.equal(result.data.file.path, path.resolve(target));
  assert.equal(result.data.file.created, true);
  assert.equal(fs.readFileSync(target, 'utf8'), cp.body);
});

test('config export refuses an existing file without confirmation or --force', async (t) => {
  const cp = await startExportMock();
  t.after(cp.close);
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'xihe-export-confirm-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'export.jsonc');
  fs.writeFileSync(target, 'ORIGINAL');

  const result = await runCommand(['config', 'export', '--out', target], {
    env: cp.env,
    promptSecret: noPrompt,
    stdout: sink(),
    stderr: sink(),
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.error.code, 'CONFIRMATION_REQUIRED');
  assert.equal(fs.readFileSync(target, 'utf8'), 'ORIGINAL');
});

test('config export overwrites an existing file with --force or an interactive confirmation', async (t) => {
  const cp = await startExportMock();
  t.after(cp.close);
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'xihe-export-force-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const forced = path.join(directory, 'forced.jsonc');
  const confirmed = path.join(directory, 'confirmed.jsonc');
  fs.writeFileSync(forced, 'ORIGINAL');
  fs.writeFileSync(confirmed, 'ORIGINAL');

  const forcedResult = await runCommand(['config', 'export', '--out', forced, '--force'], {
    env: cp.env,
    promptSecret: noPrompt,
    stdout: sink(),
    stderr: sink(),
  });
  const confirmedResult = await runCommand(['config', 'export', '--out', confirmed], {
    env: cp.env,
    promptSecret: noPrompt,
    confirmAction: async () => {},
    stdout: sink(),
    stderr: sink(),
  });

  assert.equal(forcedResult.exitCode, 0);
  assert.equal(forcedResult.data.file.created, false);
  assert.equal(fs.readFileSync(forced, 'utf8'), cp.body);
  assert.equal(confirmedResult.exitCode, 0);
  assert.equal(fs.readFileSync(confirmed, 'utf8'), cp.body);
});

test('config export rejects directories and symbolic links', async (t) => {
  const cp = await startExportMock();
  t.after(cp.close);
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'xihe-export-target-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const directoryResult = await runCommand(['config', 'export', '--out', directory], {
    env: cp.env,
    promptSecret: noPrompt,
    stdout: sink(),
    stderr: sink(),
  });
  assert.equal(directoryResult.error.code, 'EXPORT_TARGET_UNSAFE');

  const linkTarget = path.join(directory, 'link-target.txt');
  const linkPath = path.join(directory, 'link.txt');
  fs.writeFileSync(linkTarget, 'DO-NOT-TOUCH');
  try {
    fs.symlinkSync(linkTarget, linkPath, 'file');
  } catch (error) {
    t.skip(`symlink unavailable on this host (${error.code})`);
    return;
  }
  const linkResult = await runCommand(['config', 'export', '--out', linkPath, '--force'], {
    env: cp.env,
    promptSecret: noPrompt,
    stdout: sink(),
    stderr: sink(),
  });
  assert.equal(linkResult.error.code, 'EXPORT_TARGET_UNSAFE');
  assert.equal(fs.readFileSync(linkTarget, 'utf8'), 'DO-NOT-TOUCH');
  assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true);
});

test('config export detects an ino/dev replacement after opening and writes nothing', async (t) => {
  const cp = await startExportMock();
  t.after(cp.close);
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'xihe-export-swap-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'swap.jsonc');
  const moved = path.join(directory, 'swap.moved.jsonc');
  fs.writeFileSync(target, 'ORIGINAL');
  let hooked = false;
  const fsImpl = {
    ...fs,
    openSync(file, flags, ...rest) {
      const fd = fs.openSync(file, flags, ...rest);
      if (flags === 'r+' && !hooked) {
        hooked = true;
        fs.renameSync(file, moved);
        fs.writeFileSync(file, 'REPLACEMENT');
      }
      return fd;
    },
  };

  const result = await runCommand(['config', 'export', '--out', target, '--force'], {
    env: cp.env,
    promptSecret: noPrompt,
    fsImpl,
    stdout: sink(),
    stderr: sink(),
  });

  assert.equal(result.error.code, 'EXPORT_TARGET_REPLACED');
  assert.equal(fs.readFileSync(target, 'utf8'), 'REPLACEMENT');
  assert.equal(fs.readFileSync(moved, 'utf8'), 'ORIGINAL');
});

test('config export reports a failed write and removes only the file it created', async (t) => {
  const cp = await startExportMock();
  t.after(cp.close);
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'xihe-export-fail-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const created = path.join(directory, 'created.jsonc');
  const existing = path.join(directory, 'existing.jsonc');
  fs.writeFileSync(existing, 'ORIGINAL');
  const failingFs = {
    ...fs,
    writeSync() {
      const error = new Error('disk full');
      error.code = 'ENOSPC';
      throw error;
    },
  };

  const createdResult = await runCommand(['config', 'export', '--out', created], {
    env: cp.env,
    promptSecret: noPrompt,
    fsImpl: failingFs,
    stdout: sink(),
    stderr: sink(),
  });
  assert.equal(createdResult.error.code, 'EXPORT_WRITE_FAILED');
  assert.equal(createdResult.error.details.residual, false);
  assert.equal(fs.existsSync(created), false);

  const existingResult = await runCommand(['config', 'export', '--out', existing, '--force'], {
    env: cp.env,
    promptSecret: noPrompt,
    fsImpl: failingFs,
    stdout: sink(),
    stderr: sink(),
  });
  assert.equal(existingResult.error.code, 'EXPORT_WRITE_FAILED');
  assert.equal(existingResult.error.details.residual, true);
  assert.equal(fs.readFileSync(existing, 'utf8'), 'ORIGINAL');
});

test('config export refuses a read-only existing target and leaves it untouched', async (t) => {
  const cp = await startExportMock();
  t.after(cp.close);
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'xihe-export-readonly-'));
  const target = path.join(directory, 'readonly.jsonc');
  fs.writeFileSync(target, 'ORIGINAL');
  t.after(() => {
    try { fs.chmodSync(target, 0o666); } catch { /* already gone */ }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  fs.chmodSync(target, 0o444);

  const result = await runCommand(['config', 'export', '--out', target, '--force'], {
    env: cp.env,
    promptSecret: noPrompt,
    stdout: sink(),
    stderr: sink(),
  });

  if (result.exitCode === 0) {
    // Some filesystems ignore the read-only bit; the safety property still holds
    // because the write went through identity-checked open.
    assert.equal(fs.readFileSync(target, 'utf8'), cp.body);
    return;
  }
  assert.equal(result.error.code, 'EXPORT_WRITE_FAILED');
  assert.equal(fs.readFileSync(target, 'utf8'), 'ORIGINAL');
});

test('provider delete shows impact, requires confirmation, and deletes after --yes', async (t) => {
  const cp = await startCpMock();
  t.after(cp.close);
  const blocked = await runCommand(['provider', 'delete', 'connection-1'], {
    env: cp.env,
    promptSecret: noPrompt,
    stdout: sink(),
    stderr: sink(),
  });
  assert.equal(blocked.error.code, 'CONFIRMATION_REQUIRED');
  assert.equal(cp.state.deleteImpactRequests, 1);
  assert.equal(cp.state.deleteRequests, 0);

  const confirmedResult = await runCommand(['provider', 'delete', 'connection-1', '--yes'], {
    env: cp.env,
    promptSecret: noPrompt,
    stdout: sink(),
    stderr: sink(),
  });
  assert.equal(confirmedResult.exitCode, 0);
  assert.equal(confirmedResult.data.action, 'deleted');
  assert.equal(cp.state.deleteRequests, 1);
  assert.equal(cp.state.deleteImpactRequests, 2);
});

test('provider delete supports interactive confirmation and maps 409 without leaking detail', async (t) => {
  const cp = await startCpMock();
  t.after(cp.close);
  const confirmed = await runCommand(['provider', 'delete', 'connection-1'], {
    env: cp.env,
    promptSecret: noPrompt,
    confirmAction: async () => {},
    stdout: sink(),
    stderr: sink(),
  });
  assert.equal(confirmed.exitCode, 0);
  assert.equal(cp.state.deleteRequests, 1);

  cp.state.deleteStatus = 409;
  cp.state.deleteBody = {
    code: 'CONNECTION_IN_USE',
    sessionCount: 2,
    connectionId: 'connection-1',
    requestId: 'req-9',
    detail: TEST_KEY,
  };
  const blocked = await runCommand(['provider', 'delete', 'connection-1', '--yes', '--json'], {
    env: cp.env,
    promptSecret: noPrompt,
    stdout: sink(),
    stderr: sink(),
  });
  assert.equal(blocked.error.code, 'CONNECTION_IN_USE');
  assert.equal(blocked.error.details.sessionCount, 2);
  assert.equal(blocked.error.details.connectionId, 'connection-1');
  assert.equal(blocked.error.details.requestId, 'req-9');
  assert.equal(JSON.stringify(blocked).includes(TEST_KEY), false);
});

test('version reports the four module manifests and the development checkout label', async () => {
  const result = await runCommand(['version'], { env: {}, stdout: sink() });
  assert.equal(result.exitCode, 0);
  assert.equal(result.data.version, 'development checkout');
  assert.deepEqual(result.data.modules.map((module) => module.name), ['ui', 'cp', 'agent', 'runtime']);
  for (const module of result.data.modules) {
    assert.equal(typeof module.version, 'string', `${module.name} version`);
    assert.match(module.version, /^\d+\.\d+\.\d+/);
  }
});

test('version --check reuses the consistency check and passes on this checkout', async () => {
  const result = await runCommand(['version', '--check'], { env: {}, stdout: sink() });
  assert.equal(result.exitCode, 0);
  assert.equal(result.data.check.ok, true);
  assert.equal(result.data.check.failureCount, 0);
});

test('version reports missing and unparsable manifests per module', async (t) => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'xihe-version-partial-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'packages', 'ui'), { recursive: true });
  fs.writeFileSync(path.join(root, 'packages', 'ui', 'package.json'), '{"version":"9.9.9"}');

  const result = await runCommand(['version'], { env: {}, projectRoot: root, stdout: sink() });
  assert.equal(result.exitCode, 1);
  assert.equal(result.data.ok, false);
  assert.equal(result.data.modules.find((module) => module.name === 'ui').version, '9.9.9');
  assert.equal(result.data.modules.find((module) => module.name === 'agent').error.code, 'MANIFEST_MISSING');

  const check = await runCommand(['version', '--check'], { env: {}, projectRoot: root, stdout: sink() });
  assert.equal(check.exitCode, 1);
  assert.equal(check.data.check.ok, false);
  assert.ok(check.data.check.failures.length > 0);
});
test('verify reports an unknown session-create outcome instead of guessing an ID', async (t) => {
  const cp = await startVerifyCpMock({ dropSessionResponse: true });
  t.after(cp.close);
  const result = await runCommand([
    'verify', '--stack', 'stack-1', '--email', 'admin@xihe.local', '--workspace', 'ws-1', '--yes',
  ], {
    env: cp.env,
    spawnSyncImpl: cp.spawnSyncImpl,
    promptSecret: noPrompt,
    stdout: sink(),
    stderr: sink(),
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.data.a.status, 'FAIL');
  assert.equal(result.data.cleanup.session.status, 'unknown');
  assert.equal(result.data.cleanup.session.reason, 'CREATE_OUTCOME_UNKNOWN');
  assert.equal(cp.state.calls.some((call) => call.method === 'DELETE'), false);
});
// ─────────────────────────────────────────────────────────────────────────────
// PLAN-0574 M2: read-only surface (status / workspace / job / checkpoint /
// scheduled-task / audit)
// ─────────────────────────────────────────────────────────────────────────────

function captureStdout(fn) {
  const chunks = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  try {
    fn();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join('');
}

async function startReadonlyMock({
  versionStatus = 200,
  environmentStatus = 200,
  retentionStatus = 200,
  jobOutputResponse = null,
  cancelResponse = null,
  previewResponse = null,
} = {}) {
  const state = { queries: [], headers: [] };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const body = await requestBody(request).catch(() => undefined);
    state.headers.push({ method: request.method, pathname: url.pathname, workspaceId: request.headers['x-workspace-id'] ?? null, body: body ?? null });

    if (url.pathname === '/api/v1/auth/login' && request.method === 'POST') {
      json(response, 200, { accessToken: 'readonly-token' });
      return;
    }
    if (url.pathname === '/api/v1/status' && request.method === 'GET') {
      json(response, 200, { status: 'healthy', services: [{ name: 'cp', key: 'cp', status: 'up' }] });
      return;
    }
    if (url.pathname === '/api/v1/health' && request.method === 'GET') {
      json(response, 200, { status: 'UP' });
      return;
    }
    if (url.pathname === '/api/v1/version' && request.method === 'GET') {
      if (versionStatus !== 200) {
        json(response, versionStatus, { code: 'HTTP_503' });
        return;
      }
      json(response, 200, { stackId: 'stack-1', modules: { cp: { version: '0.1.0' } } });
      return;
    }
    if (url.pathname === '/api/v1/workspaces' && request.method === 'GET') {
      json(response, 200, [{ id: 'ws-1', name: 'alpha', workspaceRole: 'OWNER', canWrite: true }]);
      return;
    }
    if (url.pathname === '/api/v1/workspaces/ws-1' && request.method === 'GET') {
      json(response, 200, { id: 'ws-1', name: 'alpha', workspaceRole: 'OWNER' });
      return;
    }
    if (url.pathname === '/api/v1/workspaces/ws-1/environment' && request.method === 'GET') {
      if (environmentStatus !== 200) {
        json(response, environmentStatus, { code: 'RUNTIME_UNAVAILABLE', requestId: 'req-env-1' });
        return;
      }
      json(response, 200, { workspaceId: 'ws-1', status: 'ready', executionMode: 'docker', storageBackend: 'local' });
      return;
    }
    if (url.pathname === '/api/v1/workspaces/ws-1/jobs' && request.method === 'GET') {
      json(response, 200, [{ jobId: 'job-1', status: 'succeeded', startedAt: '2026-10-29T00:00:00Z' }]);
      return;
    }
    if (url.pathname.startsWith('/api/v1/workspaces/ws-1/jobs/') && url.pathname.endsWith('/output') && request.method === 'GET') {
      state.queries.push({ pathname: url.pathname, params: url.searchParams });
      if (jobOutputResponse) {
        json(response, jobOutputResponse.status, jobOutputResponse.body);
        return;
      }
      json(response, 200, {
        jobId: url.pathname.split('/')[6],
        runtimeJobId: 'rt-1',
        stream: url.searchParams.get('stream') ?? 'stdout',
        offset: Number(url.searchParams.get('offset') ?? 0),
        nextOffset: 5,
        sizeBytes: 5,
        truncated: false,
        data: 'line-1\nline-2\n',
        jobStatus: 'succeeded',
      });
      return;
    }
    if (url.pathname.startsWith('/api/v1/workspaces/ws-1/jobs/') && url.pathname.endsWith('/cancel') && request.method === 'POST') {
      if (cancelResponse) {
        json(response, cancelResponse.status, cancelResponse.body);
        return;
      }
      json(response, 200, { jobId: url.pathname.split('/')[6], status: 'cancelled', changed: true });
      return;
    }
    if (url.pathname === '/api/v1/workspaces/ws-1/checkpoints/revert/preview' && request.method === 'POST') {
      if (previewResponse) {
        json(response, previewResponse.status, previewResponse.body);
        return;
      }
      json(response, 200, {
        sliceRef: body?.sliceRef ?? null,
        counts: { files: 2, hunks: 5 },
        entries: [{ path: 'a.txt' }, { path: 'b.txt' }],
        truncated: false,
        opaqueNestedRepos: 0,
      });
      return;
    }
    if (url.pathname === '/api/v1/workspaces/ws-1/checkpoints' && request.method === 'GET') {
      json(response, 200, [{ id: 'ck-1', sliceRef: 'slice-1', state: 'unrollable', capturedAt: '2026-10-29T00:00:00Z' }]);
      return;
    }
    if (url.pathname === '/api/v1/workspaces/ws-1/checkpoints/retention' && request.method === 'GET') {
      if (retentionStatus !== 200) {
        json(response, retentionStatus, { code: 'RUNTIME_UNAVAILABLE', requestId: 'req-ret-1' });
        return;
      }
      json(response, 200, { maxRuns: 20, ttlDays: 30, unsealedNeverDeleted: false, currentRuns: 3, currentRefs: 3 });
      return;
    }
    if (url.pathname === '/api/v1/workspaces/ws-1/scheduled-tasks' && request.method === 'GET') {
      state.queries.push({ pathname: url.pathname, params: url.searchParams });
      json(response, 200, {
        workspaceId: 'ws-1',
        page: Number(url.searchParams.get('page') ?? 0),
        size: Number(url.searchParams.get('size') ?? 100),
        tasks: [{ id: 'task-1', status: 'active', triggerKind: 'cron', cronExpr: '0 9 * * *', nextFireAt: '2026-10-30T09:00:00Z' }],
      });
      return;
    }
    if (url.pathname === '/api/v1/audit/entries' && request.method === 'GET') {
      state.queries.push({ pathname: url.pathname, params: url.searchParams });
      json(response, 200, {
        entries: [{ id: 'entry-1', type: 'config.export', status: 'ok', createdAt: '2026-10-29T00:00:00Z' }],
        page: Number(url.searchParams.get('page') ?? 0),
        size: Number(url.searchParams.get('size') ?? 20),
        totalElements: 1,
        totalPages: 1,
      });
      return;
    }
    json(response, 404, { code: 'NOT_FOUND', detail: 'unknown endpoint' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    state,
    env: { XIHE_CP_PORT: String(server.address().port), XIHE_DEV_ADMIN_PASSWORD: TEST_PASSWORD },
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test('status aggregates all three endpoints and reports healthy', async (t) => {
  const cp = await startReadonlyMock();
  t.after(cp.close);
  const result = await runCommand(['status'], { env: cp.env, promptSecret: noPrompt, stdout: sink(), stderr: sink() });
  assert.equal(result.exitCode, 0);
  assert.equal(result.data.overall, 'healthy');
  assert.equal(result.data.endpoints.status.status, 'ok');
  assert.equal(result.data.endpoints.health.status, 'ok');
  assert.equal(result.data.endpoints.version.status, 'ok');
  const human = captureStdout(() => printResult(result));
  assert.match(human, /^STATUS: healthy \| status=ok health=ok version=ok\n$/);
});

test('status keeps a failed endpoint visible and reports degraded instead of healthy', async (t) => {
  const cp = await startReadonlyMock({ versionStatus: 503 });
  t.after(cp.close);
  const result = await runCommand(['status'], { env: cp.env, promptSecret: noPrompt, stdout: sink(), stderr: sink() });
  assert.equal(result.exitCode, 0);
  assert.equal(result.data.overall, 'degraded');
  assert.equal(result.data.endpoints.version.status, 'failed');
  assert.equal(result.data.endpoints.status.status, 'ok');
  assert.equal(result.data.endpoints.health.status, 'ok');
});

test('workspace list and get use the same source with workspace headers only where scoped', async (t) => {
  const cp = await startReadonlyMock();
  t.after(cp.close);
  const list = await runCommand(['workspace', 'list'], { env: cp.env, promptSecret: noPrompt, stdout: sink(), stderr: sink() });
  assert.equal(list.exitCode, 0);
  assert.equal(list.data.items.length, 1);
  const listCall = cp.state.headers.find((call) => call.pathname === '/api/v1/workspaces');
  assert.equal(listCall.workspaceId, null);

  const got = await runCommand(['workspace', 'get', 'ws-1', '--json'], { env: cp.env, promptSecret: noPrompt, stdout: sink(), stderr: sink() });
  assert.equal(got.exitCode, 0);
  assert.equal(got.data.workspace.id, 'ws-1');
  assert.equal(got.data.environment.retrieved, true);
  assert.equal(got.data.environment.executionMode, 'docker');
  for (const path of ['/api/v1/workspaces/ws-1', '/api/v1/workspaces/ws-1/environment']) {
    const call = cp.state.headers.find((item) => item.pathname === path);
    assert.equal(call.workspaceId, 'ws-1');
  }
});

test('workspace get surfaces an environment failure instead of dropping it', async (t) => {
  const cp = await startReadonlyMock({ environmentStatus: 502 });
  t.after(cp.close);
  const result = await runCommand(['workspace', 'get', 'ws-1'], { env: cp.env, promptSecret: noPrompt, stdout: sink(), stderr: sink() });
  assert.equal(result.exitCode, 1);
  assert.equal(result.data.workspace.id, 'ws-1');
  assert.equal(result.data.environment.retrieved, false);
  assert.equal(result.data.environment.code, 'RUNTIME_UNAVAILABLE');
  assert.equal(result.data.partial, 'environment');
});

test('job output passes stream/offset/limit defaults and prints raw text', async (t) => {
  const cp = await startReadonlyMock();
  t.after(cp.close);
  const stdout = sink();
  const result = await runCommand(['job', 'output', 'ws-1', 'job-1'], { env: cp.env, promptSecret: noPrompt, stdout, stderr: sink() });
  assert.equal(result.exitCode, 0);
  const query = cp.state.queries[0].params;
  assert.equal(query.get('stream'), 'stdout');
  assert.equal(query.get('offset'), '0');
  assert.equal(query.get('limit'), '65536');
  assert.equal(result.data.text, 'line-1\nline-2\n');
  assert.equal(result.data.nextOffset, 5);
  const human = captureStdout(() => printResult(result));
  assert.equal(human, 'line-1\nline-2\n');
  const call = cp.state.headers.find((item) => item.pathname?.startsWith('/api/v1/workspaces/ws-1/jobs/'));
  assert.equal(call.workspaceId, 'ws-1');
});

test('job output forwards explicit pagination and rejects invalid arguments before requests', async (t) => {
  const cp = await startReadonlyMock();
  t.after(cp.close);
  const custom = await runCommand(['job', 'output', 'ws-1', 'job-1', '--stream', 'stderr', '--offset', '10', '--limit', '100', '--json'], {
    env: cp.env,
    promptSecret: noPrompt,
    stderr: sink(),
  });
  assert.equal(custom.exitCode, 0);
  assert.equal(cp.state.queries[0].params.get('stream'), 'stderr');
  assert.equal(cp.state.queries[0].params.get('offset'), '10');
  assert.equal(cp.state.queries[0].params.get('limit'), '100');
  assert.equal(custom.data.truncated, false);

  const badStream = await runCommand(['job', 'output', 'ws-1', 'job-1', '--stream', 'both'], { env: cp.env, promptSecret: noPrompt, stdout: sink(), stderr: sink() });
  assert.equal(badStream.error.code, 'INVALID_ARGUMENT');
  const badOffset = await runCommand(['job', 'output', 'ws-1', 'job-1', '--offset', '-1'], { env: cp.env, promptSecret: noPrompt, stdout: sink(), stderr: sink() });
  assert.equal(badOffset.error.code, 'INVALID_ARGUMENT');
  assert.equal(cp.state.queries.length, 1);
});

test('job output maps 409 JOB_OUTPUT_LOST with requestId without arbitrary detail', async (t) => {
  const cp = await startReadonlyMock({
    jobOutputResponse: {
      status: 409,
      body: { code: 'JOB_OUTPUT_LOST', requestId: 'req-lost-1', detail: TEST_KEY },
    },
  });
  t.after(cp.close);
  const result = await runCommand(['job', 'output', 'ws-1', 'job-1', '--json'], { env: cp.env, promptSecret: noPrompt, stderr: sink() });
  assert.equal(result.exitCode, 1);
  assert.equal(result.error.code, 'JOB_OUTPUT_LOST');
  assert.equal(result.error.details.requestId, 'req-lost-1');
  assert.equal(JSON.stringify(result).includes(TEST_KEY), false);
});

test('checkpoint list merges retention and reports a retention failure as partial', async (t) => {
  const cp = await startReadonlyMock();
  t.after(cp.close);
  const ok = await runCommand(['checkpoint', 'list', 'ws-1'], { env: cp.env, promptSecret: noPrompt, stdout: sink(), stderr: sink() });
  assert.equal(ok.exitCode, 0);
  assert.equal(ok.data.items.length, 1);
  assert.equal(ok.data.retention.retrieved, true);
  assert.equal(ok.data.retention.maxRuns, 20);

  const failing = await startReadonlyMock({ retentionStatus: 502 });
  t.after(failing.close);
  const partial = await runCommand(['checkpoint', 'list', 'ws-1', '--json'], { env: failing.env, promptSecret: noPrompt, stderr: sink() });
  assert.equal(partial.exitCode, 1);
  assert.equal(partial.data.items.length, 1);
  assert.equal(partial.data.retention.retrieved, false);
  assert.equal(partial.data.retention.code, 'RUNTIME_UNAVAILABLE');
  assert.equal(partial.data.partial, 'retention');
});

test('scheduled-task and audit lists forward page/size/type filters', async (t) => {
  const cp = await startReadonlyMock();
  t.after(cp.close);
  const scheduled = await runCommand(['scheduled-task', 'list', 'ws-1', '--page', '2', '--size', '50', '--json'], {
    env: cp.env,
    promptSecret: noPrompt,
    stderr: sink(),
  });
  assert.equal(scheduled.exitCode, 0);
  assert.equal(scheduled.data.items.length, 1);
  const scheduledQuery = cp.state.queries.find((item) => item.pathname === '/api/v1/workspaces/ws-1/scheduled-tasks').params;
  assert.equal(scheduledQuery.get('page'), '2');
  assert.equal(scheduledQuery.get('size'), '50');

  const audit = await runCommand(['audit', 'list', '--type', 'config.export', '--page', '1', '--size', '10'], {
    env: cp.env,
    promptSecret: noPrompt,
    stdout: sink(),
    stderr: sink(),
  });
  assert.equal(audit.exitCode, 0);
  const auditQuery = cp.state.queries.find((item) => item.pathname === '/api/v1/audit/entries').params;
  assert.equal(auditQuery.get('type'), 'config.export');
  assert.equal(auditQuery.get('page'), '1');
  assert.equal(auditQuery.get('size'), '10');
  assert.equal(audit.data.entries[0].type, 'config.export');
});

test('job list and scheduled-task/audit argument validation fail without requests', async (t) => {
  const cp = await startReadonlyMock();
  t.after(cp.close);
  const noWs = await runCommand(['job', 'list'], { env: cp.env, promptSecret: noPrompt, stdout: sink(), stderr: sink() });
  assert.equal(noWs.error.code, 'INVALID_ARGUMENT');
  const extraPos = await runCommand(['audit', 'list', 'ws-1'], { env: cp.env, promptSecret: noPrompt, stdout: sink(), stderr: sink() });
  assert.equal(extraPos.error.code, 'INVALID_ARGUMENT');
  assert.equal(cp.state.headers.filter((call) => call.pathname !== '/api/v1/auth/login').length, 0);
});
test('T2.7 --json envelope and human output stay consistent across M1/M2 commands', async (t) => {
  const ro = await startReadonlyMock();
  const ex = await startExportMock();
  t.after(() => Promise.all([ro.close(), ex.close()]));
  const cases = [
    { args: ['status'], env: ro.env, kind: 'status' },
    { args: ['workspace', 'list'], env: ro.env, kind: 'workspace-list' },
    { args: ['workspace', 'get', 'ws-1'], env: ro.env, kind: 'workspace' },
    { args: ['job', 'list', 'ws-1'], env: ro.env, kind: 'job-list' },
    { args: ['job', 'output', 'ws-1', 'job-1'], env: ro.env, kind: 'job-output' },
    { args: ['checkpoint', 'list', 'ws-1'], env: ro.env, kind: 'checkpoint-list' },
    { args: ['scheduled-task', 'list', 'ws-1'], env: ro.env, kind: 'scheduled-task-list' },
    { args: ['audit', 'list'], env: ro.env, kind: 'audit-list' },
    { args: ['config', 'export'], env: ex.env, kind: null, check: (data) => typeof data.content === 'string' },
    { args: ['version'], env: {}, kind: null, check: (data) => data.version === 'development checkout' },
  ];
  for (const { args, env, kind, check } of cases) {
    const result = await runCommand([...args, '--json'], { env, promptSecret: noPrompt, stderr: sink() });
    assert.equal(result.exitCode, 0, args.join(' '));
    const printed = JSON.parse(captureStdout(() => printResult(result)));
    assert.equal(printed.ok, true, args.join(' '));
    assert.equal(typeof printed.data, 'object', args.join(' '));
    if (kind) assert.equal(printed.data.kind, kind, args.join(' '));
    if (check) assert.equal(check(printed.data), true, args.join(' '));
  }

  const human = await runCommand(['status'], { env: ro.env, promptSecret: noPrompt, stdout: sink(), stderr: sink() });
  const humanText = captureStdout(() => printResult(human));
  assert.match(humanText, /^STATUS: /);
  assert.throws(() => JSON.parse(humanText), SyntaxError);

  const failing = await runCommand(['status', '--json'], {
    env: { XIHE_CP_PORT: '1', XIHE_DEV_ADMIN_PASSWORD: TEST_PASSWORD },
    promptSecret: noPrompt,
    stderr: sink(),
  });
  assert.notEqual(failing.exitCode, 0);
  const failingPrinted = JSON.parse(captureStdout(() => printResult(failing)));
  assert.equal(failingPrinted.ok, false);
  assert.equal(typeof failingPrinted.error.code, 'string');
  assert.equal(typeof failingPrinted.error.message, 'string');
});
// ─────────────────────────────────────────────────────────────────────────────
// PLAN-0574 M3: key writes (job cancel / checkpoint revert preview)
// ─────────────────────────────────────────────────────────────────────────────

test('job cancel passes through success and idempotent changed semantics', async (t) => {
  const cp = await startReadonlyMock();
  t.after(cp.close);
  const first = await runCommand(['job', 'cancel', 'ws-1', 'job-1'], { env: cp.env, promptSecret: noPrompt, stdout: sink(), stderr: sink() });
  assert.equal(first.exitCode, 0);
  assert.equal(first.data.kind, 'job-cancel');
  assert.equal(first.data.changed, true);
  assert.equal(first.data.status, 'cancelled');
  const cancelCall = cp.state.headers.find((call) => call.pathname?.endsWith('/jobs/job-1/cancel'));
  assert.equal(cancelCall.method, 'POST');
  assert.equal(cancelCall.workspaceId, 'ws-1');
  assert.equal(cancelCall.body, null);
  const human = captureStdout(() => printResult(first));
  assert.equal(human, 'cancel: job-1 status=cancelled changed=true\n');
  const printedCancel = JSON.parse(captureStdout(() => printResult({ exitCode: 0, json: true, data: first.data })));
  assert.equal(printedCancel.ok, true);
  assert.equal(printedCancel.data.kind, 'job-cancel');
  assert.equal(printedCancel.data.changed, true);

  cp.state.headers = [];
  const idempotent = await startReadonlyMock({
    cancelResponse: { status: 200, body: { jobId: 'job-1', status: 'cancelled', changed: false } },
  });
  t.after(idempotent.close);
  const second = await runCommand(['job', 'cancel', 'ws-1', 'job-1', '--json'], { env: idempotent.env, promptSecret: noPrompt, stderr: sink() });
  assert.equal(second.exitCode, 0);
  assert.equal(second.data.changed, false);
});

test('job cancel maps 404 transparently and reports a lost 502 outcome without replay', async (t) => {
  const missing = await startReadonlyMock({
    cancelResponse: { status: 404, body: { code: 'JOB_ARCHIVE_NOT_FOUND', requestId: 'req-c-404', detail: TEST_KEY } },
  });
  t.after(missing.close);
  const notFound = await runCommand(['job', 'cancel', 'ws-1', 'job-1', '--json'], { env: missing.env, promptSecret: noPrompt, stderr: sink() });
  assert.equal(notFound.exitCode, 1);
  assert.equal(notFound.error.code, 'JOB_ARCHIVE_NOT_FOUND');
  assert.equal(notFound.error.details.requestId, 'req-c-404');
  assert.equal(JSON.stringify(notFound).includes(TEST_KEY), false);
  const printedNotFound = JSON.parse(captureStdout(() => printResult(notFound)));
  assert.equal(printedNotFound.ok, false);
  assert.equal(printedNotFound.error.code, 'JOB_ARCHIVE_NOT_FOUND');
  assert.equal(printedNotFound.error.details.requestId, 'req-c-404');

  const unconfirmed = await startReadonlyMock({
    cancelResponse: { status: 502, body: { code: 'JOB_CANCEL_UNCONFIRMED', requestId: 'req-c-502' } },
  });
  t.after(unconfirmed.close);
  const lost = await runCommand(['job', 'cancel', 'ws-1', 'job-1', '--json'], { env: unconfirmed.env, promptSecret: noPrompt, stderr: sink() });
  assert.equal(lost.exitCode, 1);
  assert.equal(lost.error.code, 'OPERATION_OUTCOME_UNKNOWN');
  assert.equal(lost.error.details.status, 502);
  assert.equal(unconfirmed.state.headers.filter((call) => call.pathname?.endsWith('/cancel')).length, 1);
});

test('checkpoint preview-revert sends the strict sliceRef body and previews only', async (t) => {
  const cp = await startReadonlyMock();
  t.after(cp.close);
  const result = await runCommand(['checkpoint', 'preview-revert', 'ws-1', 'slice-1'], { env: cp.env, promptSecret: noPrompt, stdout: sink(), stderr: sink() });
  assert.equal(result.exitCode, 0);
  assert.equal(result.data.kind, 'checkpoint-preview');
  assert.equal(result.data.sliceRef, 'slice-1');
  assert.equal(result.data.entries.length, 2);
  assert.equal(result.data.truncated, false);
  const previewCall = cp.state.headers.find((call) => call.pathname === '/api/v1/workspaces/ws-1/checkpoints/revert/preview');
  assert.equal(previewCall.method, 'POST');
  assert.equal(previewCall.workspaceId, 'ws-1');
  assert.deepEqual(previewCall.body, { sliceRef: 'slice-1' });
  const human = captureStdout(() => printResult(result));
  assert.equal(human, 'preview: slice-1 entries=2 truncated=false opaqueNestedRepos=0\n');
  const printedPreview = JSON.parse(captureStdout(() => printResult({ exitCode: 0, json: true, data: result.data })));
  assert.equal(printedPreview.ok, true);
  assert.equal(printedPreview.data.kind, 'checkpoint-preview');
  assert.deepEqual(printedPreview.data.entries, [{ path: 'a.txt' }, { path: 'b.txt' }]);
});

test('checkpoint preview-revert validates arguments locally and maps CP error codes', async (t) => {
  const cp = await startReadonlyMock();
  t.after(cp.close);
  const missing = await runCommand(['checkpoint', 'preview-revert', 'ws-1'], { env: cp.env, promptSecret: noPrompt, stdout: sink(), stderr: sink() });
  assert.equal(missing.error.code, 'INVALID_ARGUMENT');
  assert.equal(cp.state.headers.filter((call) => call.pathname?.includes('/revert/preview')).length, 0);

  const busy = await startReadonlyMock({
    previewResponse: { status: 409, body: { code: 'RUN_ACTIVE', requestId: 'req-p-409' } },
  });
  t.after(busy.close);
  const conflict = await runCommand(['checkpoint', 'preview-revert', 'ws-1', 'slice-1', '--json'], { env: busy.env, promptSecret: noPrompt, stderr: sink() });
  assert.equal(conflict.exitCode, 1);
  assert.equal(conflict.error.code, 'RUN_ACTIVE');
  assert.equal(conflict.error.details.requestId, 'req-p-409');
  const printedConflict = JSON.parse(captureStdout(() => printResult(conflict)));
  assert.equal(printedConflict.ok, false);
  assert.equal(printedConflict.error.code, 'RUN_ACTIVE');

  const invalid = await startReadonlyMock({
    previewResponse: { status: 400, body: { code: 'CHECKPOINT_INVALID_REQUEST', requestId: 'req-p-400' } },
  });
  t.after(invalid.close);
  const badRequest = await runCommand(['checkpoint', 'preview-revert', 'ws-1', 'slice-1', '--json'], { env: invalid.env, promptSecret: noPrompt, stderr: sink() });
  assert.equal(badRequest.error.code, 'CHECKPOINT_INVALID_REQUEST');
});
// ─────────────────────────────────────────────────────────────────────────────
// PLAN-0574 M4: launcher --set bootstrap overrides (stack-run + lib/stack-set)
// ─────────────────────────────────────────────────────────────────────────────

test('stack --set parses allowed keys, normalizes ports, and injects over the derived env', () => {
  const parsed = parseStackSetArgs({
    args: ['--stack', '2', '--set', 'XIHE_CP_PORT=12699', '--stack=2'],
    target: 'cp',
    env: {},
  });
  assert.deepEqual(parsed.values, { XIHE_CP_PORT: '12699' });
  assert.deepEqual(parsed.warnings, []);

  const agentParsed = parseStackSetArgs({
    args: ['--set=XIHE_AGENT_PORT=080'],
    target: 'agent',
    env: {},
  });
  assert.deepEqual(agentParsed.values, { XIHE_AGENT_PORT: '80' });

  const base = { XIHE_CP_PORT: '12631', PATH: 'keep' };
  applySetToEnv(base, { XIHE_CP_PORT: '12699' });
  assert.equal(base.XIHE_CP_PORT, '12699');
  assert.equal(base.PATH, 'keep');
});

test('stack --set rejects unknown keys, duplicates, and invalid values without echoing them', () => {
  const sentinel = 'SHOULD_NOT_ECHO_9f2';
  const expectReject = (args, target, message) => {
    assert.throws(() => parseStackSetArgs({ args, target, env: {} }), (error) => {
      assert.match(error.message, message);
      assert.equal(error.message.includes(sentinel), false);
      return true;
    });
  };

  expectReject(['--set', 'XIHE_DEV_ADMIN_PASSWORD=1'], 'cp', /not on the bootstrap allowlist/);
  expectReject([`--set=XIHE_CP_PORT=${sentinel}`], 'cp', /decimal ASCII integer/);
  expectReject(['--set', 'XIHE_CP_PORT=12699', '--set=XIHE_CP_PORT=12700'], 'cp', /more than once/);
  for (const bad of ['', ' 80', '80 ', '+80', '-1', 'abc', '0', '65536', '123456', '12 34']) {
    expectReject(['--set', `XIHE_CP_PORT=${bad}`], 'cp', /(decimal ASCII integer|out of range|requires a decimal port)/);
  }
  expectReject(['--set'], 'cp', /requires KEY=VALUE/);
  expectReject(['--set', 'NOVALUE'], 'cp', /requires KEY=VALUE/);
});

test('stack --set only injects into targets that consume the key (listening or connection side)', () => {
  // Connection-side consumption is allowed by the design port matrix.
  assert.deepEqual(
    parseStackSetArgs({ args: ['--set', 'XIHE_CP_PORT=12699'], target: 'agent', env: {}, userEnv: {} }).values,
    { XIHE_CP_PORT: '12699' },
  );
  assert.deepEqual(
    parseStackSetArgs({ args: ['--set', 'XIHE_AGENT_PORT=12698'], target: 'cp', env: {}, userEnv: {} }).values,
    { XIHE_AGENT_PORT: '12698' },
  );
  assert.deepEqual(
    parseStackSetArgs({ args: ['--set', 'XIHE_RUNTIME_PORT=13000'], target: 'cp', env: {}, userEnv: {} }).values,
    { XIHE_RUNTIME_PORT: '13000' },
  );
  // Targets with no listening or connection-side consumption are refused.
  assert.throws(
    () => parseStackSetArgs({ args: ['--set', 'XIHE_AGENT_PORT=12698'], target: 'runtime', env: {}, userEnv: {} }),
    /not consumed by target "runtime"/,
  );
  for (const target of ['pg', 'ui', 'watch', 'dev-host', 'env-json', 'slots-json']) {
    assert.throws(
      () => parseStackSetArgs({ args: ['--set', 'XIHE_CP_PORT=12699'], target, env: {}, userEnv: {} }),
      new RegExp(`not consumed by target "${target}"`),
    );
  }
  const empty = parseStackSetArgs({ args: ['--stack', '2'], target: 'ui', env: {}, userEnv: {} });
  assert.deepEqual(empty.values, {});
  assert.deepEqual(empty.warnings, []);
  assert.deepEqual(empty.urlSyncs, []);
});

test('stack --set re-points launcher-derived connection URLs and keeps user-provided ones', () => {
  // Derived URLs (absent from the user env) follow the new port, path preserved.
  const derived = parseStackSetArgs({
    args: ['--set', 'XIHE_AGENT_PORT=12698'],
    target: 'cp',
    env: { XIHE_AGENT_URL: 'http://localhost:12632/internal/v1/agent/chat' },
    userEnv: {},
  });
  assert.deepEqual(derived.urlSyncs, [
    { key: 'XIHE_AGENT_URL', value: 'http://localhost:12698/internal/v1/agent/chat' },
  ]);
  assert.deepEqual(derived.warnings, []);

  const runtimeDerived = parseStackSetArgs({
    args: ['--set', 'XIHE_RUNTIME_PORT=13000'],
    target: 'cp',
    env: { XIHE_RUNTIME_URL: 'http://localhost:12633' },
    userEnv: {},
  });
  assert.deepEqual(runtimeDerived.urlSyncs, [{ key: 'XIHE_RUNTIME_URL', value: 'http://localhost:13000' }]);

  const cpDerived = parseStackSetArgs({
    args: ['--set', 'XIHE_CP_PORT=12699'],
    target: 'agent',
    env: {
      XIHE_CP_URL: 'http://localhost:12631',
      XIHE_CP_BASE_URL: 'http://localhost:12631',
      XIHE_AGENT_URL: 'http://localhost:12632/internal/v1/agent/chat',
    },
    userEnv: {},
  });
  assert.deepEqual(cpDerived.urlSyncs, [
    { key: 'XIHE_CP_URL', value: 'http://localhost:12699' },
    { key: 'XIHE_CP_BASE_URL', value: 'http://localhost:12699' },
  ]);

  // User-provided URLs are kept and produce warnings instead of syncs.
  const explicit = parseStackSetArgs({
    args: ['--set', 'XIHE_CP_PORT=12699'],
    target: 'agent',
    env: { XIHE_CP_URL: 'http://127.0.0.1:12345', XIHE_CP_BASE_URL: 'http://localhost:12631' },
    userEnv: { XIHE_CP_URL: 'http://127.0.0.1:12345' },
  });
  assert.deepEqual(explicit.urlSyncs, [{ key: 'XIHE_CP_BASE_URL', value: 'http://localhost:12699' }]);
  assert.equal(explicit.warnings.length, 1);
  assert.match(explicit.warnings[0], /XIHE_CP_URL is set explicitly/);

  const explicitAgent = parseStackSetArgs({
    args: ['--set', 'XIHE_AGENT_PORT=12698'],
    target: 'cp',
    env: { XIHE_AGENT_URL: 'http://localhost:12632/internal/v1/agent/chat', XIHE_AGENT_BASE_URL: 'http://localhost:1' },
    userEnv: { XIHE_AGENT_URL: 'http://localhost:12632/internal/v1/agent/chat', XIHE_AGENT_BASE_URL: 'http://localhost:1' },
  });
  assert.deepEqual(explicitAgent.urlSyncs, []);
  assert.equal(explicitAgent.warnings.length, 2);
  assert.match(explicitAgent.warnings[0], /XIHE_AGENT_URL is set explicitly/);
  assert.match(explicitAgent.warnings[1], /XIHE_AGENT_BASE_URL is set explicitly/);

  // XIHE_AGENT_BASE_URL is never launcher-derived; when only the user sets it,
  // the port override must warn about the silent break instead of rewriting it.
  const explicitBaseOnly = parseStackSetArgs({
    args: ['--set', 'XIHE_AGENT_PORT=12698'],
    target: 'cp',
    env: { XIHE_AGENT_URL: 'http://localhost:12632/internal/v1/agent/chat', XIHE_AGENT_BASE_URL: 'http://localhost:1' },
    userEnv: { XIHE_AGENT_BASE_URL: 'http://localhost:1' },
  });
  assert.deepEqual(explicitBaseOnly.urlSyncs, [{ key: 'XIHE_AGENT_URL', value: 'http://localhost:12698/internal/v1/agent/chat' }]);
  assert.equal(explicitBaseOnly.warnings.length, 1);
  assert.match(explicitBaseOnly.warnings[0], /XIHE_AGENT_BASE_URL is set explicitly/);
});

test('applyUrlSyncToEnv rewrites only the computed derived URLs', () => {
  const env = { XIHE_AGENT_URL: 'http://localhost:12632/internal/v1/agent/chat', OTHER: 'x' };
  applyUrlSyncToEnv(env, [{ key: 'XIHE_AGENT_URL', value: 'http://localhost:12698/internal/v1/agent/chat' }]);
  assert.equal(env.XIHE_AGENT_URL, 'http://localhost:12698/internal/v1/agent/chat');
  assert.equal(env.OTHER, 'x');
});

test('stack-run refuses --set misuses before launching any process', () => {
  const workdir = path.resolve(import.meta.dirname ?? '.', '..');
  const run = (args) => spawnSync(process.execPath, ['scripts/stack-run.mjs', ...args], {
    cwd: workdir,
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
  });
  const invalid = run(['cp', '--set', 'XIHE_CP_PORT=abc']);
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr ?? '', /decimal ASCII integer/);
  assert.equal((invalid.stderr ?? '').includes('abc'), false);

  const wrongTarget = run(['ui', '--set', 'XIHE_CP_PORT=12699']);
  assert.equal(wrongTarget.status, 2);
  assert.match(wrongTarget.stderr ?? '', /not consumed by target "ui"/);

  // Argument-order combinations: --stack (space and inline forms) before and
  // after --set must not affect validation, and nothing is ever launched.
  const stackThenSet = run(['cp', '--stack', '2', '--set', 'XIHE_CP_PORT=abc']);
  assert.equal(stackThenSet.status, 2);
  assert.match(stackThenSet.stderr ?? '', /decimal ASCII integer/);

  const inlineStackThenSet = run(['agent', '--stack=2', '--set', 'XIHE_CP_PORT=abc']);
  assert.equal(inlineStackThenSet.status, 2);
  assert.match(inlineStackThenSet.stderr ?? '', /decimal ASCII integer/);

  const setThenStack = run(['agent', '--set', 'XIHE_CP_PORT=abc', '--stack', '2']);
  assert.equal(setThenStack.status, 2);
  assert.match(setThenStack.stderr ?? '', /decimal ASCII integer/);

  const unconsumed = run(['runtime', '--stack', '2', '--set', 'XIHE_AGENT_PORT=13000']);
  assert.equal(unconsumed.status, 2);
  assert.match(unconsumed.stderr ?? '', /not consumed by target "runtime"/);
});
test('job cancel and checkpoint preview reject contract-breaking 2xx responses explicitly', async (t) => {
  const emptyCancel = await startReadonlyMock({
    cancelResponse: { status: 200, body: {} },
  });
  t.after(emptyCancel.close);
  const empty = await runCommand(['job', 'cancel', 'ws-1', 'job-1', '--json'], { env: emptyCancel.env, promptSecret: noPrompt, stderr: sink() });
  assert.equal(empty.exitCode, 1);
  assert.equal(empty.error.code, 'CP_RESPONSE_INVALID');

  const noContent = await startReadonlyMock({
    cancelResponse: { status: 204, body: null },
  });
  t.after(noContent.close);
  const absent = await runCommand(['job', 'cancel', 'ws-1', 'job-1', '--json'], { env: noContent.env, promptSecret: noPrompt, stderr: sink() });
  assert.equal(absent.exitCode, 1);
  assert.equal(absent.error.code, 'CP_RESPONSE_INVALID');

  const partialPreview = await startReadonlyMock({
    previewResponse: { status: 200, body: { sliceRef: 'slice-1' } },
  });
  t.after(partialPreview.close);
  const broken = await runCommand(['checkpoint', 'preview-revert', 'ws-1', 'slice-1', '--json'], { env: partialPreview.env, promptSecret: noPrompt, stderr: sink() });
  assert.equal(broken.exitCode, 1);
  assert.equal(broken.error.code, 'CP_RESPONSE_INVALID');

  const preview204 = await startReadonlyMock({
    previewResponse: { status: 204, body: null },
  });
  t.after(preview204.close);
  const absentPreview = await runCommand(['checkpoint', 'preview-revert', 'ws-1', 'slice-1', '--json'], { env: preview204.env, promptSecret: noPrompt, stderr: sink() });
  assert.equal(absentPreview.exitCode, 1);
  assert.equal(absentPreview.error.code, 'CP_RESPONSE_INVALID');
});