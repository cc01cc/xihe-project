import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { PassThrough, Readable } from 'node:stream';
import { test } from 'node:test';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { printResult, runCommand } from './xihe.mjs';
import { promptSecret, readResponseText } from './xihe-cli/provider.mjs';
import { clearToken } from './xihe-cli/token-store.mjs';
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

test('dev check reports the frozen docker workspace backend by default (PLAN-0612 M4)', async (t) => {
  const cp = await startCpMock();
  t.after(cp.close);
  const result = await runCommand(['dev', 'check', '--json'], {
    env: { ...cp.env },
    spawnSyncImpl: () => ({ status: 0, stdout: 'tool version\n', stderr: '' }),
    portProbeFn: async () => ({ free: true }),
    promptSecret: noPrompt,
  });

  const backend = result.data.checks.find((check) => check.name === 'workspace-backend');
  assert.ok(backend, 'workspace-backend check must be present');
  assert.equal(backend.status, 'docker=disabled (frozen) / direct_attach=available');
  assert.deepEqual(result.data.workspaceBackend, {
    docker: 'disabled',
    dockerFrozen: true,
    directAttach: 'available',
  });
  assert.match(backend.hint, /direct_attach/);
});

test('dev check reports an enabled docker backend when explicitly injected (PLAN-0612 M4)', async (t) => {
  const cp = await startCpMock();
  t.after(cp.close);
  const result = await runCommand(['dev', 'check', '--json'], {
    env: { ...cp.env, XIHE_WORKSPACE_DOCKER_BACKEND: 'enabled' },
    spawnSyncImpl: () => ({ status: 0, stdout: 'tool version\n', stderr: '' }),
    portProbeFn: async () => ({ free: true }),
    promptSecret: noPrompt,
  });

  const backend = result.data.checks.find((check) => check.name === 'workspace-backend');
  assert.equal(backend.status, 'docker=enabled / direct_attach=available');
  assert.equal(result.data.workspaceBackend.dockerFrozen, false);
  assert.equal(backend.hint, undefined);
});

test('dev check reports an actionable owner hint for occupied ports (PLAN-0612 M3)', async (t) => {
  const cp = await startCpMock();
  t.after(cp.close);
  const result = await runCommand(['dev', 'check', '--json'], {
    env: { ...cp.env },
    spawnSyncImpl: (command) => {
      if (command === 'netstat') {
        return { status: 0, stdout: '  TCP    127.0.0.1:12630    0.0.0.0:0    LISTENING    4321\n', stderr: '' };
      }
      if (command === 'tasklist') {
        return { status: 0, stdout: '"node.exe","4321","Console","1","10,000 K"\n', stderr: '' };
      }
      return { status: 0, stdout: 'tool version\n', stderr: '' };
    },
    portProbeFn: async (port) => (port === 12630 ? { free: false, occupied: true } : { free: true }),
    httpProbeFn: async (url) => (url.includes(':12630/') ? 'unresponsive' : 'ready'),
    tcpProbeFn: async () => 'listening',
    promptSecret: noPrompt,
  });

  const ui = result.data.checks.find((check) => check.category === 'port' && check.name === 'UI');
  assert.equal(ui.status, 'occupied-unresponsive');
  assert.deepEqual(ui.owner, { pid: 4321, process: 'node.exe' });
  assert.match(ui.hint, /端口 12630 被 node\.exe \(pid 4321\) 占用/);
  assert.match(ui.hint, /XIHE_UI_PORT/);
  assert.equal(result.exitCode, 1, 'an occupied-unresponsive port keeps the preflight red');
});

test('dev check reports env key drift between .env.dev and .env.example (PLAN-0612 M3)', async (t) => {
  const cp = await startCpMock();
  t.after(cp.close);
  const result = await runCommand(['dev', 'check', '--json'], {
    env: { ...cp.env },
    spawnSyncImpl: () => ({ status: 0, stdout: 'tool version\n', stderr: '' }),
    portProbeFn: async () => ({ free: true }),
    promptSecret: noPrompt,
  });
  const keyCheck = result.data.checks.find((check) => check.name === 'env key set (.env.dev vs .env.example)');
  assert.ok(keyCheck, 'env key set check must be present');
  // 仓库内两侧当前一致；若新增/删除键未同步，此断言会变成 drift 并提示缺哪些键。
  assert.equal(keyCheck.status, 'ok');
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
  connections = [{
    id: 'conn-1',
    providerId: 'custom-openai-compatible',
    apiTypeId: 'openai-compatible',
    apiTypeVersion: 1,
    operation: 'chat',
    enabled: true,
    status: 'READY',
    connectionKey: 'default',
    manualModels: ['fake-openai'],
  }],
  templatesByLayer = {
    user: [{
      id: 'tpl-user',
      version: 2,
      status: 'published',
      apiTypeId: 'openai-compatible',
      apiTypeVersion: 1,
    }],
  },
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
      // PLAN-0612 M4: verify preflights the workspace execution backend; a direct_attach
      // workspace is not affected by the frozen docker backend.
      json(response, 200, { id: 'ws-1', storageMode: 'direct_attach', executionMode: 'windows-host' });
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
    if (pathname === '/api/v1/provider-connections' && request.method === 'GET') {
      json(response, 200, { connections });
      return;
    }
    if (pathname === '/api/v1/config/api-request-templates' && request.method === 'GET') {
      const layer = url.searchParams.get('layer') ?? 'user';
      const entries = templatesByLayer[layer] ?? [];
      json(response, 200, { templates: JSON.stringify(entries) });
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
    cpPort,
    agentPort,
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
  // D21：WORKSPACE 档创建必须带显式工作区上下文。
  assert.equal(principalCall.headers['x-workspace-id'], 'ws-1');

  // PLAN-0601: the Session must carry the explicit template + connection binding, otherwise CP
  // rejects chat with 409 API_TYPE_REBIND_REQUIRED.
  const sessionCall = cp.state.calls.find(
    (item) => item.method === 'POST' && item.pathname === '/api/v1/sessions',
  );
  assert.equal(sessionCall.body.providerConnectionId, 'conn-1');
  assert.equal(sessionCall.body.modelProvider, 'custom-openai-compatible');
  assert.equal(sessionCall.body.modelName, 'fake-openai');
  assert.equal(sessionCall.body.contextTemplateLayer, 'user');
  assert.equal(sessionCall.body.contextTemplateId, 'tpl-user');
  assert.equal(sessionCall.body.contextTemplateVersion, 2);
  assert.ok(
    methods.indexOf('GET /api/v1/config/api-request-templates') <
      methods.indexOf('POST /api/v1/sessions'),
  );
});

test('verify stops with an actionable error when no published api-request-template exists', async (t) => {
  const cp = await startVerifyCpMock({ templatesByLayer: {} });
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

  assert.equal(result.exitCode, 2);
  assert.equal(result.error.code, 'VERIFY_TEMPLATE_MISSING');
  assert.match(result.error.message, /No published api-request-template/);
  assert.match(result.error.message, /Publish one first/);
  assert.match(result.error.message, /API_TYPE_REBIND_REQUIRED/);
  assert.equal(cp.state.calls.some((call) => call.pathname === '/api/v1/sessions'), false);
  assert.equal(cp.state.calls.some((call) => call.pathname === '/api/v1/chat'), false);
});

test('verify stops with an actionable error when no READY chat connection exists', async (t) => {
  const cp = await startVerifyCpMock({ connections: [] });
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

  assert.equal(result.exitCode, 2);
  assert.equal(result.error.code, 'VERIFY_CONNECTION_MISSING');
  assert.match(result.error.message, /No READY chat provider connection/);
  assert.match(result.error.message, /provider verify/);
  assert.equal(cp.state.calls.some((call) => call.pathname === '/api/v1/sessions'), false);
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

test('verify prefers stack-derived ports when the env bag omits inherited port keys', async (t) => {
  const cp = await startVerifyCpMock();
  t.after(cp.close);
  const result = await runCommand([
    'verify', '--stack', 'stack-2', '--email', 'admin@xihe.local', '--workspace', 'ws-1', '--yes',
  ], {
    env: cp.env,
    // Real `stack-run env-json --stack 2` under an inherited XIHE_CP_PORT emits the
    // derived `ports` object but drops the port keys from the fill-gap `env` bag.
    spawnSyncImpl: () => ({
      status: 0,
      stdout: JSON.stringify({ ports: { cp: cp.cpPort, agent: cp.agentPort }, env: {} }),
      stderr: '',
    }),
    promptSecret: noPrompt,
    stdout: sink(),
    stderr: sink(),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.data.cpBase, `http://127.0.0.1:${cp.cpPort}`);
  assert.equal(result.data.agentPort, cp.agentPort);
  assert.ok(cp.state.calls.length > 0, 'verify must reach the stack-derived CP, not a default port');
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
  // PLAN-0622 A5: verify additionally probes a PERSONAL principal; this mock does not
  // echo scope, so the probe must stay provisional instead of pretending to pass.
  assert.equal(result.data.personal.status, 'SKIP_PROVISIONAL');
  const principalCreates = cp.state.calls.filter((call) => call.pathname === '/api/v1/agent-principals');
  assert.ok(principalCreates.length >= 1, 'A5 probe creates its own PERSONAL principal');
  assert.equal(cp.state.calls.some((call) => call.method === 'PUT'), false, 'reuses the pre-existing principal without rebinding');
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

// ── PLAN-0575: credential CLI (M1 read surface + M2 write surface) ──

const CREDENTIAL_ID = '11111111-2222-3333-4444-555555555555';
const CREDENTIAL_WORKSPACE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const CREDENTIAL_AGENT = '99999999-8888-7777-6666-555555555555';
const CREDENTIAL_AGENT_TWO = '77777777-6666-5555-4444-333333333333';
const CREDENTIAL_TOKEN = 'sk-test-credential-0575';
const CREDENTIAL_ACCESS_KEY = 'AK-test-access-0575';
const CREDENTIAL_SECRET_KEY = 'SK-test-secret-0575';
const CREDENTIAL_REVEAL_PASSWORD = 'step-up-password-0575';
const CREDENTIAL_REVEAL_VALUE = JSON.stringify({ token: 'sk-test-reveal-0575' });
const CREDENTIAL_SENTINEL = 'TEST_SENTINEL_DETAIL_0575';

function credentialBody(patch = {}) {
  return {
    id: CREDENTIAL_ID,
    label: 'ops-token',
    kind: 'token',
    deliveryTier: 'lease',
    ownerType: 'USER',
    ownerId: 'user-1',
    status: 'active',
    fingerprint: 'fp-abc123',
    revision: 1,
    referenceCount: 0,
    createdAt: '2026-10-29T00:00:00Z',
    replacedAt: null,
    ...patch,
  };
}

async function startCredentialMock(overrides = {}) {
  const state = {
    calls: [],
    listQueries: [],
    createBodies: [],
    replaceBodies: [],
    precheckBodies: [],
    bindingsBodies: [],
    revealBodies: [],
    deleteRequests: 0,
    listResponse: { credentials: [credentialBody()], count: 1 },
    referencesResponse: {
      references: [
        { source: 'grant', subjectType: 'agent_principal', subjectId: CREDENTIAL_AGENT, actionClass: 'credential_use', resource: `credential:${CREDENTIAL_ID}` },
      ],
    },
    eventsResponse: { events: [{ id: 'evt-1', eventType: 'created', actor: 'user-1', createdAt: '2026-10-29T00:00:00Z' }] },
    precheckResponse: { uncovered: ['credential_reveal@credential:*'] },
    createResponse: { status: 201, body: credentialBody() },
    replaceResponse: { status: 200, body: credentialBody({ revision: 2 }) },
    referencesResponseOverride: null,
    deleteResponse: { status: 200, body: { id: CREDENTIAL_ID, deleted: true, references: [] } },
    bindingsResponse: { status: 200, body: { credentialId: CREDENTIAL_ID, agentPrincipalIds: [CREDENTIAL_AGENT], bound: true } },
    revealResponse: { status: 200, body: { credentialId: CREDENTIAL_ID, revision: 3, value: CREDENTIAL_REVEAL_VALUE } },
    ...overrides,
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const method = request.method;
    const pathname = url.pathname;
    const workspaceHeader = request.headers['x-workspace-id'] ?? null;
    const note = (extra = {}) => state.calls.push({ method, pathname, workspaceHeader, ...extra });

    if (pathname === '/api/v1/auth/login' && method === 'POST') {
      await requestBody(request);
      json(response, 200, { accessToken: 'credential-access-token' });
      return;
    }
    if (pathname === '/api/v1/credentials' && method === 'GET') {
      state.listQueries.push(url.searchParams);
      note();
      json(response, 200, state.listResponse);
      return;
    }
    if (pathname === '/api/v1/credentials' && method === 'POST') {
      const body = await requestBody(request);
      state.createBodies.push(body);
      note();
      json(response, state.createResponse.status, state.createResponse.body);
      return;
    }
    if (pathname === '/api/v1/credentials/precheck' && method === 'POST') {
      const body = await requestBody(request);
      state.precheckBodies.push(body);
      note();
      json(response, 200, state.precheckResponse);
      return;
    }
    const references = pathname.match(/^\/api\/v1\/credentials\/([^/]+)\/references$/);
    if (references && method === 'GET') {
      note();
      json(response, 200, state.referencesResponseOverride ?? state.referencesResponse);
      return;
    }
    const events = pathname.match(/^\/api\/v1\/credentials\/([^/]+)\/events$/);
    if (events && method === 'GET') {
      note();
      json(response, 200, state.eventsResponse);
      return;
    }
    const replace = pathname.match(/^\/api\/v1\/credentials\/([^/]+)\/replace$/);
    if (replace && method === 'POST') {
      const body = await requestBody(request);
      state.replaceBodies.push(body);
      note();
      json(response, state.replaceResponse.status, state.replaceResponse.body);
      return;
    }
    const bindings = pathname.match(/^\/api\/v1\/credentials\/([^/]+)\/bindings$/);
    if (bindings && (method === 'POST' || method === 'DELETE')) {
      const body = await requestBody(request);
      state.bindingsBodies.push(body);
      note();
      const bound = method === 'POST';
      json(response, state.bindingsResponse.status, {
        ...state.bindingsResponse.body,
        bound,
        agentPrincipalIds: Array.isArray(body?.agentPrincipalIds) ? body.agentPrincipalIds : state.bindingsResponse.body.agentPrincipalIds,
      });
      return;
    }
    const reveal = pathname.match(/^\/api\/v1\/credentials\/([^/]+)\/reveal$/);
    if (reveal && method === 'POST') {
      const body = await requestBody(request);
      state.revealBodies.push(body);
      note();
      json(response, state.revealResponse.status, state.revealResponse.body);
      return;
    }
    const deletion = pathname.match(/^\/api\/v1\/credentials\/([^/]+)$/);
    if (deletion && method === 'DELETE') {
      state.deleteRequests += 1;
      note();
      json(response, state.deleteResponse.status, state.deleteResponse.body);
      return;
    }
    json(response, 404, { code: 'NOT_FOUND' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    state,
    env: { XIHE_CP_PORT: String(server.address().port), XIHE_DEV_ADMIN_PASSWORD: TEST_PASSWORD },
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function printedText(result) {
  return captureStdout(() => printResult(result));
}

test('credential list requires a paired owner filter and returns metadata only', async (t) => {
  const cp = await startCredentialMock();
  t.after(cp.close);

  const unpaired = await runCommand(['credential', 'list', '--owner-type', 'USER'], {
    env: cp.env, promptSecret: noPrompt, stdout: sink(),
  });
  assert.equal(unpaired.error.code, 'INVALID_ARGUMENT');
  assert.equal(cp.state.listQueries.length, 0);

  const badType = await runCommand(['credential', 'list', '--owner-type', 'TEAM', '--owner-id', 'x'], {
    env: cp.env, promptSecret: noPrompt, stdout: sink(),
  });
  assert.equal(badType.error.code, 'INVALID_ARGUMENT');

  const paired = await runCommand(['credential', 'list', '--owner-type', 'user', '--owner-id', 'user-1', '--json'], {
    env: cp.env, promptSecret: noPrompt, stdout: sink(),
  });
  assert.equal(paired.exitCode, 0);
  assert.equal(paired.data.kind, 'credential-list');
  assert.equal(paired.data.count, 1);
  assert.equal(paired.data.credentials[0].id, CREDENTIAL_ID);
  const query = cp.state.listQueries[0];
  assert.equal(query.get('ownerType'), 'USER');
  assert.equal(query.get('ownerId'), 'user-1');
  assert.equal(JSON.stringify(paired).includes(CREDENTIAL_TOKEN), false);

  cp.state.listResponse = { credentials: [], count: 0 };
  const empty = await runCommand(['credential', 'list', '--json'], { env: cp.env, promptSecret: noPrompt, stdout: sink() });
  assert.equal(empty.exitCode, 0);
  assert.equal(empty.data.count, 0);
  assert.deepEqual(empty.data.credentials, []);
});

test('credential references and events require an explicit workspace and keep CP codes', async (t) => {
  const cp = await startCredentialMock();
  t.after(cp.close);

  for (const command of ['references', 'events']) {
    const missing = await runCommand(['credential', command, CREDENTIAL_ID], {
      env: cp.env, promptSecret: noPrompt, stdout: sink(),
    });
    assert.equal(missing.error.code, 'INVALID_ARGUMENT');
  }
  assert.equal(cp.state.calls.filter((call) => call.pathname.includes('/references')).length, 0);

  const references = await runCommand(
    ['credential', 'references', CREDENTIAL_ID, '--workspace', CREDENTIAL_WORKSPACE, '--json'],
    { env: cp.env, promptSecret: noPrompt, stdout: sink() },
  );
  assert.equal(references.exitCode, 0);
  assert.equal(references.data.kind, 'credential-references');
  assert.equal(references.data.references[0].source, 'grant');
  assert.equal(cp.state.calls.find((call) => call.pathname.endsWith('/references')).workspaceHeader, CREDENTIAL_WORKSPACE);

  const events = await runCommand(
    ['credential', 'events', CREDENTIAL_ID, '--workspace', CREDENTIAL_WORKSPACE, '--json'],
    { env: cp.env, promptSecret: noPrompt, stdout: sink() },
  );
  assert.equal(events.exitCode, 0);
  assert.equal(events.data.events[0].eventType, 'created');

  cp.state.referencesResponseOverride = { references: 'not-a-list' };
  const invalid = await runCommand(
    ['credential', 'references', CREDENTIAL_ID, '--workspace', CREDENTIAL_WORKSPACE, '--json'],
    { env: cp.env, promptSecret: noPrompt, stdout: sink() },
  );
  assert.equal(invalid.error.code, 'CP_RESPONSE_INVALID');
});

test('credential precheck sends the permission atoms and returns uncovered entries', async (t) => {
  const cp = await startCredentialMock();
  t.after(cp.close);

  const missing = await runCommand(['credential', 'precheck'], { env: cp.env, promptSecret: noPrompt, stdout: sink() });
  assert.equal(missing.error.code, 'INVALID_ARGUMENT');
  assert.equal(cp.state.precheckBodies.length, 0);

  const result = await runCommand(
    ['credential', 'precheck', '--permissions', 'credential_reveal@credential:*, credential_use@credential:*', '--json'],
    { env: cp.env, promptSecret: noPrompt, stdout: sink() },
  );
  assert.equal(result.exitCode, 0);
  assert.deepEqual(cp.state.precheckBodies[0], {
    permissions: [
      { actionClass: 'credential_reveal', resource: 'credential:*' },
      { actionClass: 'credential_use', resource: 'credential:*' },
    ],
  });
  assert.deepEqual(result.data.uncovered, ['credential_reveal@credential:*']);
});

test('credential create injects token and key_pair only from environment names or TTY', async (t) => {
  const cp = await startCredentialMock();
  t.after(cp.close);
  const env = { ...cp.env, CRED_TOKEN_0575: CREDENTIAL_TOKEN, CRED_ACCESS_0575: CREDENTIAL_ACCESS_KEY, CRED_SECRET_0575: CREDENTIAL_SECRET_KEY };

  const tokenResult = await runCommand([
    'credential', 'create', '--kind', 'token', '--owner-type', 'USER', '--owner-id', 'user-1',
    '--label', 'ops-token', '--delivery-tier', 'lease', '--secret-env', 'CRED_TOKEN_0575', '--json',
  ], { env, promptSecret: noPrompt, stdout: sink() });
  assert.equal(tokenResult.exitCode, 0);
  assert.equal(tokenResult.data.kind, 'credential-created');
  assert.equal(cp.state.createBodies[0].token, CREDENTIAL_TOKEN);
  assert.equal(cp.state.createBodies[0].kind, 'token');
  assert.equal(cp.state.createBodies[0].label, 'ops-token');
  assert.equal(cp.state.createBodies[0].deliveryTier, 'lease');
  assert.equal(JSON.stringify(tokenResult).includes(CREDENTIAL_TOKEN), false);
  assert.equal(printedText(tokenResult).includes(CREDENTIAL_TOKEN), false);

  const pairResult = await runCommand([
    'credential', 'create', '--kind', 'key_pair', '--owner-type', 'USER', '--owner-id', 'user-1', '--label', 'ops-pair',
    '--access-key-env', 'CRED_ACCESS_0575', '--secret-key-env', 'CRED_SECRET_0575', '--json',
  ], { env, promptSecret: noPrompt, stdout: sink() });
  assert.equal(pairResult.exitCode, 0);
  assert.equal(cp.state.createBodies[1].accessKey, CREDENTIAL_ACCESS_KEY);
  assert.equal(cp.state.createBodies[1].secretKey, CREDENTIAL_SECRET_KEY);
  assert.equal(cp.state.createBodies[1].token, undefined);
  assert.equal(cp.state.createBodies[1].deliveryTier, 'lease', 'omitted delivery tier defaults to lease (UI parity)');

  const mixed = await runCommand([
    'credential', 'create', '--kind', 'token', '--owner-type', 'USER', '--owner-id', 'user-1', '--label', 'bad',
    '--secret-env', 'CRED_TOKEN_0575', '--access-key-env', 'CRED_ACCESS_0575',
  ], { env, promptSecret: noPrompt, stdout: sink() });
  assert.equal(mixed.error.code, 'INVALID_ARGUMENT');
  assert.equal(cp.state.createBodies.length, 2);

  const missingSecret = await runCommand([
    'credential', 'create', '--kind', 'token', '--owner-type', 'USER', '--owner-id', 'user-1', '--label', 'bad',
    '--secret-env', 'CRED_NOT_SET_0575',
  ], { env, promptSecret: noPrompt, stdout: sink() });
  assert.equal(missingSecret.error.code, 'SECRET_INPUT_REQUIRED');
  assert.equal(missingSecret.error.details.envVar, 'CRED_NOT_SET_0575');
  assert.equal(JSON.stringify(missingSecret).includes(CREDENTIAL_TOKEN), false);

  const ttyResult = await runCommand([
    'credential', 'create', '--kind', 'token', '--owner-type', 'USER', '--owner-id', 'user-1', '--label', 'tty-token',
  ], {
    env: cp.env,
    promptSecret: async () => CREDENTIAL_TOKEN,
    stdin: { isTTY: true },
    stdout: sink(),
  });
  assert.equal(ttyResult.exitCode, 0);
  assert.equal(cp.state.createBodies[2].token, CREDENTIAL_TOKEN);

  const workspaceMismatch = await runCommand([
    'credential', 'create', '--kind', 'token', '--owner-type', 'WORKSPACE', '--owner-id', CREDENTIAL_AGENT,
    '--label', 'ws-token', '--workspace', CREDENTIAL_WORKSPACE, '--secret-env', 'CRED_TOKEN_0575',
  ], { env, promptSecret: noPrompt, stdout: sink() });
  assert.equal(workspaceMismatch.error.code, 'INVALID_ARGUMENT');

  const workspaceScoped = await runCommand([
    'credential', 'create', '--kind', 'token', '--owner-type', 'WORKSPACE', '--owner-id', CREDENTIAL_WORKSPACE,
    '--label', 'ws-token', '--workspace', CREDENTIAL_WORKSPACE, '--secret-env', 'CRED_TOKEN_0575', '--json',
  ], { env, promptSecret: noPrompt, stdout: sink() });
  assert.equal(workspaceScoped.exitCode, 0);
  const workspaceCall = cp.state.calls.filter((call) => call.method === 'POST' && call.pathname === '/api/v1/credentials').at(-1);
  assert.equal(workspaceCall.workspaceHeader, CREDENTIAL_WORKSPACE);
});

test('credential replace sends only the shape fields and hints on mismatch', async (t) => {
  const cp = await startCredentialMock();
  t.after(cp.close);
  const env = { ...cp.env, CRED_TOKEN_0575: CREDENTIAL_TOKEN, CRED_ACCESS_0575: CREDENTIAL_ACCESS_KEY, CRED_SECRET_0575: CREDENTIAL_SECRET_KEY };

  const missingWorkspace = await runCommand(
    ['credential', 'replace', CREDENTIAL_ID, '--kind', 'token', '--secret-env', 'CRED_TOKEN_0575'],
    { env, promptSecret: noPrompt, stdout: sink() },
  );
  assert.equal(missingWorkspace.error.code, 'INVALID_ARGUMENT');
  assert.equal(cp.state.replaceBodies.length, 0);

  const tokenReplace = await runCommand([
    'credential', 'replace', CREDENTIAL_ID, '--kind', 'token', '--workspace', CREDENTIAL_WORKSPACE, '--secret-env', 'CRED_TOKEN_0575', '--json',
  ], { env, promptSecret: noPrompt, stdout: sink() });
  assert.equal(tokenReplace.exitCode, 0);
  assert.deepEqual(cp.state.replaceBodies[0], { token: CREDENTIAL_TOKEN });
  assert.equal(JSON.stringify(tokenReplace).includes(CREDENTIAL_TOKEN), false);

  const pairReplace = await runCommand([
    'credential', 'replace', CREDENTIAL_ID, '--kind', 'key_pair', '--workspace', CREDENTIAL_WORKSPACE,
    '--access-key-env', 'CRED_ACCESS_0575', '--secret-key-env', 'CRED_SECRET_0575', '--json',
  ], { env, promptSecret: noPrompt, stdout: sink() });
  assert.equal(pairReplace.exitCode, 0);
  assert.deepEqual(cp.state.replaceBodies[1], { accessKey: CREDENTIAL_ACCESS_KEY, secretKey: CREDENTIAL_SECRET_KEY });

  cp.state.replaceResponse = { status: 400, body: { code: 'INVALID_REQUEST', detail: CREDENTIAL_SENTINEL } };
  const mismatch = await runCommand([
    'credential', 'replace', CREDENTIAL_ID, '--kind', 'token', '--workspace', CREDENTIAL_WORKSPACE, '--secret-env', 'CRED_TOKEN_0575', '--json',
  ], { env, promptSecret: noPrompt, stdout: sink() });
  assert.equal(mismatch.error.code, 'INVALID_REQUEST');
  assert.match(mismatch.error.message, /credential list/);
  assert.equal(JSON.stringify(mismatch).includes(CREDENTIAL_SENTINEL), false);

  cp.state.replaceResponse = { status: 422, body: { code: 'CREDENTIAL_TIER_MISMATCH', detail: CREDENTIAL_SENTINEL } };
  const tier = await runCommand([
    'credential', 'replace', CREDENTIAL_ID, '--kind', 'token', '--workspace', CREDENTIAL_WORKSPACE, '--secret-env', 'CRED_TOKEN_0575', '--json',
  ], { env, promptSecret: noPrompt, stdout: sink() });
  assert.equal(tier.error.code, 'CREDENTIAL_TIER_MISMATCH');
  assert.equal(JSON.stringify(tier).includes(CREDENTIAL_SENTINEL), false);
});

test('credential delete previews references before confirmation and passes 409 through', async (t) => {
  const cp = await startCredentialMock();
  t.after(cp.close);

  const declined = await runCommand(
    ['credential', 'delete', CREDENTIAL_ID, '--workspace', CREDENTIAL_WORKSPACE],
    { env: cp.env, promptSecret: noPrompt, stderr: sink(), stdout: sink() },
  );
  assert.equal(declined.error.code, 'CONFIRMATION_REQUIRED');
  assert.equal(cp.state.deleteRequests, 0);

  cp.state.referencesResponseOverride = {
    references: [
      { source: 'grant', subjectType: 'agent_principal', subjectId: CREDENTIAL_AGENT, actionClass: 'credential_use', resource: `credential:${CREDENTIAL_ID}` },
      { source: 'provider_connection', subjectType: 'provider_connection', subjectId: 'conn-1', actionClass: 'credential_use', resource: `credential:${CREDENTIAL_ID}` },
    ],
  };
  cp.state.deleteResponse = {
    status: 200,
    body: { id: CREDENTIAL_ID, deleted: true, references: [{ source: 'grant', subjectType: 'agent_principal', subjectId: CREDENTIAL_AGENT, actionClass: 'credential_use', resource: `credential:${CREDENTIAL_ID}` }] },
  };
  const deleted = await runCommand(
    ['credential', 'delete', CREDENTIAL_ID, '--workspace', CREDENTIAL_WORKSPACE, '--yes', '--json'],
    { env: cp.env, promptSecret: noPrompt, stderr: sink(), stdout: sink() },
  );
  assert.equal(deleted.exitCode, 0);
  assert.equal(deleted.data.deleted, true);
  assert.equal(deleted.data.previewReferences.length, 2);
  assert.equal(deleted.data.references.length, 1);
  assert.equal(cp.state.deleteRequests, 1);

  cp.state.deleteResponse = { status: 409, body: { code: 'CREDENTIAL_IN_USE', detail: CREDENTIAL_SENTINEL } };
  const inUse = await runCommand(
    ['credential', 'delete', CREDENTIAL_ID, '--workspace', CREDENTIAL_WORKSPACE, '--yes', '--json'],
    { env: cp.env, promptSecret: noPrompt, stderr: sink(), stdout: sink() },
  );
  assert.equal(inUse.error.code, 'CREDENTIAL_IN_USE');
  assert.match(inUse.error.message, /credential references/);
  assert.equal(JSON.stringify(inUse).includes(CREDENTIAL_SENTINEL), false);
});

test('credential bind and unbind send the workspace plus principal list', async (t) => {
  const cp = await startCredentialMock();
  t.after(cp.close);
  const agents = `${CREDENTIAL_AGENT},${CREDENTIAL_AGENT_TWO}`;

  const bind = await runCommand(
    ['credential', 'bind', CREDENTIAL_ID, '--workspace', CREDENTIAL_WORKSPACE, '--agent', agents, '--json'],
    { env: cp.env, promptSecret: noPrompt, stdout: sink() },
  );
  assert.equal(bind.exitCode, 0);
  assert.deepEqual(cp.state.bindingsBodies[0], {
    workspaceId: CREDENTIAL_WORKSPACE,
    agentPrincipalIds: [CREDENTIAL_AGENT, CREDENTIAL_AGENT_TWO],
  });
  assert.equal(bind.data.bound, true);
  assert.equal(cp.state.calls.find((call) => call.pathname.endsWith('/bindings')).workspaceHeader, CREDENTIAL_WORKSPACE);

  const unbind = await runCommand(
    ['credential', 'unbind', CREDENTIAL_ID, '--workspace', CREDENTIAL_WORKSPACE, '--agent', agents, '--json'],
    { env: cp.env, promptSecret: noPrompt, stdout: sink() },
  );
  assert.equal(unbind.exitCode, 0);
  assert.equal(unbind.data.bound, false);
  const unbindCall = cp.state.calls.filter((call) => call.pathname.endsWith('/bindings')).at(-1);
  assert.equal(unbindCall.method, 'DELETE');
  assert.deepEqual(cp.state.bindingsBodies[1].agentPrincipalIds, [CREDENTIAL_AGENT, CREDENTIAL_AGENT_TWO]);

  const missingAgents = await runCommand(
    ['credential', 'bind', CREDENTIAL_ID, '--workspace', CREDENTIAL_WORKSPACE],
    { env: cp.env, promptSecret: noPrompt, stdout: sink() },
  );
  assert.equal(missingAgents.error.code, 'INVALID_ARGUMENT');
});

test('credential reveal enforces explicit workspace, secure password input, and output boundaries', async (t) => {
  const cp = await startCredentialMock();
  t.after(cp.close);
  const env = { ...cp.env, CRED_REVEAL_PW_0575: CREDENTIAL_REVEAL_PASSWORD };
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'xihe-reveal-0575-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const missingWorkspace = await runCommand(
    ['credential', 'reveal', CREDENTIAL_ID, '--password-env', 'CRED_REVEAL_PW_0575'],
    { env, promptSecret: noPrompt, stdout: sink(), stderr: sink() },
  );
  assert.equal(missingWorkspace.error.code, 'INVALID_ARGUMENT');
  assert.equal(cp.state.revealBodies.length, 0);

  const missingPassword = await runCommand(
    ['credential', 'reveal', CREDENTIAL_ID, '--workspace', CREDENTIAL_WORKSPACE],
    { env, promptSecret: noPrompt, stdout: sink(), stderr: sink() },
  );
  assert.equal(missingPassword.error.code, 'SECRET_INPUT_REQUIRED');
  assert.equal(cp.state.revealBodies.length, 0);

  const stdoutResult = await runCommand(
    ['credential', 'reveal', CREDENTIAL_ID, '--workspace', CREDENTIAL_WORKSPACE, '--password-env', 'CRED_REVEAL_PW_0575'],
    { env, promptSecret: noPrompt, stdout: sink(), stderr: sink() },
  );
  assert.equal(stdoutResult.exitCode, 0);
  assert.equal(stdoutResult.data.mode, 'stdout');
  assert.equal(stdoutResult.data.value, CREDENTIAL_REVEAL_VALUE);
  assert.deepEqual(cp.state.revealBodies[0], { password: CREDENTIAL_REVEAL_PASSWORD });
  assert.equal(cp.state.calls.find((call) => call.pathname.endsWith('/reveal')).workspaceHeader, CREDENTIAL_WORKSPACE);
  // The explicit terminal request is the one allowed plaintext output.
  assert.equal(printedText(stdoutResult).includes(CREDENTIAL_REVEAL_VALUE), true);

  const jsonResult = await runCommand(
    ['credential', 'reveal', CREDENTIAL_ID, '--workspace', CREDENTIAL_WORKSPACE, '--password-env', 'CRED_REVEAL_PW_0575', '--json'],
    { env, promptSecret: noPrompt, stdout: sink(), stderr: sink() },
  );
  assert.equal(jsonResult.data.mode, 'stdout');
  const parsedJson = JSON.parse(printedText(jsonResult));
  assert.equal(parsedJson.ok, true);
  assert.equal(parsedJson.data.value, CREDENTIAL_REVEAL_VALUE);

  const outFile = path.join(dir, 'revealed.txt');
  const fileResult = await runCommand(
    ['credential', 'reveal', CREDENTIAL_ID, '--workspace', CREDENTIAL_WORKSPACE, '--password-env', 'CRED_REVEAL_PW_0575', '--out', outFile, '--json'],
    { env, promptSecret: noPrompt, stdout: sink(), stderr: sink() },
  );
  assert.equal(fileResult.exitCode, 0);
  assert.equal(fileResult.data.mode, 'file');
  assert.equal(fileResult.data.value, undefined);
  assert.equal(fs.readFileSync(outFile, 'utf8'), CREDENTIAL_REVEAL_VALUE);
  assert.equal(JSON.stringify(fileResult).includes(CREDENTIAL_REVEAL_VALUE), false);

  const existing = await runCommand(
    ['credential', 'reveal', CREDENTIAL_ID, '--workspace', CREDENTIAL_WORKSPACE, '--password-env', 'CRED_REVEAL_PW_0575', '--out', outFile, '--json'],
    { env, promptSecret: noPrompt, stdout: sink(), stderr: sink() },
  );
  assert.equal(existing.error.code, 'CONFIRMATION_REQUIRED');
  assert.equal(fs.readFileSync(outFile, 'utf8'), CREDENTIAL_REVEAL_VALUE);

  const forced = await runCommand(
    ['credential', 'reveal', CREDENTIAL_ID, '--workspace', CREDENTIAL_WORKSPACE, '--password-env', 'CRED_REVEAL_PW_0575', '--out', outFile, '--force', '--json'],
    { env, promptSecret: noPrompt, stdout: sink(), stderr: sink() },
  );
  assert.equal(forced.exitCode, 0);
  assert.equal(fs.readFileSync(outFile, 'utf8'), CREDENTIAL_REVEAL_VALUE);

  const linkPath = path.join(dir, 'link.txt');
  fs.symlinkSync(outFile, linkPath);
  const linked = await runCommand(
    ['credential', 'reveal', CREDENTIAL_ID, '--workspace', CREDENTIAL_WORKSPACE, '--password-env', 'CRED_REVEAL_PW_0575', '--out', linkPath, '--force'],
    { env, promptSecret: noPrompt, stdout: sink(), stderr: sink() },
  );
  assert.equal(linked.error.code, 'REVEAL_TARGET_UNSAFE');

  const ttyResult = await runCommand(
    ['credential', 'reveal', CREDENTIAL_ID, '--workspace', CREDENTIAL_WORKSPACE],
    {
      env: cp.env,
      promptSecret: async () => CREDENTIAL_REVEAL_PASSWORD,
      stdin: { isTTY: true },
      stdout: sink(),
      stderr: sink(),
    },
  );
  assert.equal(ttyResult.exitCode, 0);
  assert.deepEqual(cp.state.revealBodies.at(-1), { password: CREDENTIAL_REVEAL_PASSWORD });
});

test('credential reveal maps every CP refusal branch without printing the value', async (t) => {
  const cp = await startCredentialMock();
  t.after(cp.close);
  const env = { ...cp.env, CRED_REVEAL_PW_0575: CREDENTIAL_REVEAL_PASSWORD };
  const branches = [
    { status: 401, code: 'CREDENTIAL_REVEAL_STEP_UP_FAILED' },
    { status: 403, code: 'CREDENTIAL_DISABLED' },
    { status: 404, code: 'CREDENTIAL_NOT_FOUND' },
    { status: 422, code: 'CREDENTIAL_TIER_MISMATCH' },
    { status: 429, code: 'CREDENTIAL_REVEAL_RATE_LIMITED' },
  ];
  for (const branch of branches) {
    cp.state.revealResponse = { status: branch.status, body: { code: branch.code, detail: CREDENTIAL_SENTINEL } };
    const result = await runCommand(
      ['credential', 'reveal', CREDENTIAL_ID, '--workspace', CREDENTIAL_WORKSPACE, '--password-env', 'CRED_REVEAL_PW_0575', '--json'],
      { env, promptSecret: noPrompt, stdout: sink(), stderr: sink() },
    );
    assert.equal(result.error.code, branch.code);
    assert.equal(JSON.stringify(result).includes(CREDENTIAL_SENTINEL), false);
    assert.equal(JSON.stringify(result).includes(CREDENTIAL_REVEAL_VALUE), false);
  }
  assert.equal(cp.state.revealBodies.every((body) => JSON.stringify(body) === JSON.stringify({ password: CREDENTIAL_REVEAL_PASSWORD })), true);
});

test('credential write failures are reported as unknown without replaying the request', async (t) => {
  const cp = await startCredentialMock();
  t.after(cp.close);
  const env = { ...cp.env, CRED_TOKEN_0575: CREDENTIAL_TOKEN };
  cp.state.createResponse = { status: 502, body: { code: 'INTERNAL_ERROR', detail: CREDENTIAL_SENTINEL } };

  const result = await runCommand([
    'credential', 'create', '--kind', 'token', '--owner-type', 'USER', '--owner-id', 'user-1', '--label', 'ops',
    '--secret-env', 'CRED_TOKEN_0575', '--json',
  ], { env, promptSecret: noPrompt, stdout: sink() });
  assert.equal(result.error.code, 'OPERATION_OUTCOME_UNKNOWN');
  assert.equal(cp.state.createBodies.length, 1);
  assert.equal(JSON.stringify(result).includes(CREDENTIAL_SENTINEL), false);
});

test('credential commands keep a single parseable --json envelope', async (t) => {
  const cp = await startCredentialMock();
  t.after(cp.close);
  const env = { ...cp.env, CRED_TOKEN_0575: CREDENTIAL_TOKEN };
  const invocations = [
    ['credential', 'list', '--json'],
    ['credential', 'references', CREDENTIAL_ID, '--workspace', CREDENTIAL_WORKSPACE, '--json'],
    ['credential', 'events', CREDENTIAL_ID, '--workspace', CREDENTIAL_WORKSPACE, '--json'],
    ['credential', 'precheck', '--permissions', 'credential_use@credential:*', '--json'],
    ['credential', 'create', '--kind', 'token', '--owner-type', 'USER', '--owner-id', 'user-1', '--label', 'ops', '--secret-env', 'CRED_TOKEN_0575', '--json'],
    ['credential', 'bind', CREDENTIAL_ID, '--workspace', CREDENTIAL_WORKSPACE, '--agent', CREDENTIAL_AGENT, '--json'],
  ];
  const expectedKinds = [
    'credential-list', 'credential-references', 'credential-events', 'credential-precheck',
    'credential-created', 'credential-bindings',
  ];
  for (const [index, argv] of invocations.entries()) {
    const result = await runCommand(argv, { env, promptSecret: noPrompt, stdout: sink(), stderr: sink() });
    assert.equal(result.exitCode, 0, argv.join(' '));
    const parsed = JSON.parse(printedText(result));
    assert.equal(parsed.ok, true, argv.join(' '));
    assert.equal(parsed.data.kind, expectedKinds[index], argv.join(' '));
  }
});

test('verify probes: PERSONAL lifecycle and limit 429 are provisional until CP delivers the contract', async () => {
  const { runPersonalLifecycleProbe, runResourceLimitProbe, runWorkspaceLifecycleProbe } = await import('./xihe-cli/verify.mjs');
  const calls = [];
  const fakeClient = (handler) => ({ call: async (method, pathname, options = {}) => {
    calls.push(`${method} ${pathname}`);
    return handler(method, pathname, options);
  } });

  const unsupported = await runPersonalLifecycleProbe({
    client: fakeClient(() => ({ status: 400, body: { code: 'INVALID_REQUEST' }, code: 'INVALID_REQUEST' })),
    workspaceId: 'ws-1',
  });
  assert.equal(unsupported.status, 'SKIP_PROVISIONAL');
  assert.equal(unsupported.code, 'SCOPE_UNSUPPORTED');

  const bindings = new Set();
  const lifecycle = await runPersonalLifecycleProbe({
    client: fakeClient((method, pathname) => {
      if (method === 'POST' && pathname === '/api/v1/agent-principals') {
        return { status: 201, body: { principalId: 'p-1', scope: 'PERSONAL' }, code: null };
      }
      if (method === 'PUT' && pathname.includes('/agents/p-1')) { bindings.add('p-1'); return { status: 200, body: {}, code: null }; }
      if (method === 'DELETE' && pathname.includes('/agents/p-1')) { bindings.delete('p-1'); return { status: 204, body: null, code: null }; }
      if (method === 'GET' && pathname.endsWith('/agents')) {
        // V4：PERSONAL 未绑定也可见（来源决定可见性）
        return { status: 200, body: { agents: [{ principalId: 'p-1', source: 'personal' }] }, code: null };
      }
      return { status: 404, body: { code: 'NOT_FOUND' }, code: 'NOT_FOUND' };
    }),
    workspaceId: 'ws-1',
  });
  assert.equal(lifecycle.status, 'PASS', JSON.stringify(lifecycle));
  assert.equal(lifecycle.principalId, 'p-1');

  // A5b WORKSPACE：绑定决定可见性（未绑不可见 → bind 后 source=workspace → unbind 后不可见）
  const boundWorkspace = new Set();
  const workspaceLifecycle = await runWorkspaceLifecycleProbe({
    client: fakeClient((method, pathname) => {
      if (method === 'POST' && pathname === '/api/v1/agent-principals') {
        return { status: 201, body: { principalId: 'p-2', scope: 'WORKSPACE' }, code: null };
      }
      if (method === 'PUT' && pathname.includes('/agents/p-2')) { boundWorkspace.add('p-2'); return { status: 200, body: {}, code: null }; }
      if (method === 'DELETE' && pathname.includes('/agents/p-2')) { boundWorkspace.delete('p-2'); return { status: 204, body: null, code: null }; }
      if (method === 'GET' && pathname.endsWith('/agents')) {
        return { status: 200, body: { agents: [...boundWorkspace].map((principalId) => ({ principalId, source: 'workspace' })) }, code: null };
      }
      return { status: 404, body: { code: 'NOT_FOUND' }, code: 'NOT_FOUND' };
    }),
    workspaceId: 'ws-1',
  });
  assert.equal(workspaceLifecycle.status, 'PASS', JSON.stringify(workspaceLifecycle));
  assert.equal(workspaceLifecycle.principalId, 'p-2');

  const workspaceUnboundVisible = await runWorkspaceLifecycleProbe({
    client: fakeClient((method, pathname) => {
      if (method === 'POST') return { status: 201, body: { principalId: 'p-2', scope: 'WORKSPACE' }, code: null };
      if (method === 'GET') return { status: 200, body: { agents: [{ principalId: 'p-2', source: 'workspace' }] }, code: null };
      return { status: 404, body: {}, code: 'NOT_FOUND' };
    }),
    workspaceId: 'ws-1',
  });
  assert.equal(workspaceUnboundVisible.status, 'FAIL');
  assert.equal(workspaceUnboundVisible.code, 'WORKSPACE_VISIBLE_UNBOUND');
  const wrongSource = await runPersonalLifecycleProbe({
    client: fakeClient((method, pathname) => {
      if (method === 'POST') return { status: 201, body: { principalId: 'p-1', scope: 'PERSONAL' }, code: null };
      if (method === 'PUT') return { status: 200, body: {}, code: null };
      if (method === 'GET') return { status: 200, body: { agents: [{ principalId: 'p-1', source: 'workspace' }] }, code: null };
      return { status: 404, body: {}, code: 'NOT_FOUND' };
    }),
    workspaceId: 'ws-1',
  });
  assert.equal(wrongSource.status, 'FAIL');
  assert.equal(wrongSource.code, 'PERSONAL_SOURCE_MISMATCH');

  const notPersisted = await runResourceLimitProbe({
    client: fakeClient((method) => {
      if (method === 'GET') return { status: 200, body: { connections: [{ id: 'c-1' }] }, code: null };
      if (method === 'PATCH') return { status: 200, body: { connection: { id: 'c-1' } }, code: null };
      return { status: 404, body: { code: 'NOT_FOUND' }, code: 'NOT_FOUND' };
    }),
    connectionId: 'c-1', sessionId: 's-1', branchId: 'b-1',
  });
  assert.equal(notPersisted.status, 'SKIP_PROVISIONAL');
  assert.equal(notPersisted.code, 'LIMIT_NOT_PERSISTED');
  assert.match(notPersisted.detail, /UNLIMITED/);
  const limitUnsupported = await runResourceLimitProbe({
    client: fakeClient((method, pathname) => {
      if (method === 'GET') return { status: 200, body: { connections: [{ id: 'c-1' }] }, code: null };
      return { status: 404, body: { code: 'NOT_FOUND' }, code: 'NOT_FOUND' };
    }),
    connectionId: 'c-1', sessionId: 's-1', branchId: 'b-1',
  });
  assert.equal(limitUnsupported.status, 'SKIP_PROVISIONAL');
  assert.equal(limitUnsupported.code, 'LIMIT_UNSUPPORTED');

  let chatCount = 0;
  let patchCount = 0;
  const trapCalls = [];
  const limited = await runResourceLimitProbe({
    client: fakeClient((method, pathname, options) => {
      if (method === 'GET') return { status: 200, body: { connections: [{ id: 'c-1', maxInflight: patchCount >= 1 ? 1 : undefined }] }, code: null };
      if (method === 'PATCH') {
        patchCount += 1;
        trapCalls.push(options.body);
        return { status: 200, body: { connection: { id: 'c-1', ...options.body } }, code: null };
      }
      if (method === 'POST' && pathname === '/api/v1/chat') {
        if (patchCount >= 2) return { status: 202, body: { runId: 'run-after' }, code: null };
        chatCount += 1;
        if (chatCount === 1) return { status: 202, body: { runId: 'run-1' }, code: null };
        return {
          status: 429,
          body: { code: 'RESOURCE_EXHAUSTED', retryAfterSeconds: 1, resourceKind: 'CONNECTION', scope: 'ws-1' },
          code: 'RESOURCE_EXHAUSTED',
          retryAfter: '1',
        };
      }
      if (method === 'POST' && pathname.includes('/cancel')) return { status: 200, body: {}, code: null };
      return { status: 404, body: {}, code: 'NOT_FOUND' };
    }),
    connectionId: 'c-1', sessionId: 's-1', branchId: 'b-1',
  });
  assert.equal(limited.status, 'PASS', JSON.stringify(limited));
  assert.equal(trapCalls.length, 2, 'the probe restores maxInflight');

  // A6 must reject a bare 429: code + retryAfterSeconds + resourceKind + scope + header.
  const bad429 = await runResourceLimitProbe({
    client: fakeClient((method, pathname, options) => {
      if (method === 'GET') return { status: 200, body: { connections: [{ id: 'c-1', maxInflight: 1 }] }, code: null };
      if (method === 'PATCH') return { status: 200, body: { connection: { id: 'c-1', ...options.body } }, code: null };
      if (method === 'POST' && pathname === '/api/v1/chat') {
        return { status: 429, body: { code: 'RESOURCE_EXHAUSTED' }, code: 'RESOURCE_EXHAUSTED', retryAfter: '1' };
      }
      if (method === 'POST' && pathname.includes('/cancel')) return { status: 200, body: {}, code: null };
      return { status: 404, body: {}, code: 'NOT_FOUND' };
    }),
    connectionId: 'c-1', sessionId: 's-1', branchId: 'b-1',
  });
  assert.equal(bad429.status, 'FAIL');
  assert.equal(bad429.code, 'LIMIT_NOT_ENFORCED');
  assert.match(bad429.detail, /resourceKind=none/);
});

test('agent CLI: create/list/bind/unbind/disable + provider limit are idempotent and machine readable', async () => {
  const state = {
    principals: [],
    bindings: new Map(),
    connections: [{ id: 'conn-1', providerId: 'openai', label: 'primary' }],
    createRequests: 0,
    patchBodies: [],
    disabled: new Set(),
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/actuator/health') { json(response, 200, { status: 'UP' }); return; }
    if (url.pathname === '/api/v1/auth/login' && request.method === 'POST') {
      json(response, 200, { accessToken: 'agent-cli-token', tokenType: 'Bearer', expiresIn: 900 });
      return;
    }
    if (url.pathname === '/api/v1/agent-principals' && request.method === 'GET') {
      const scope = url.searchParams.get('scope');
      const principals = scope
        ? state.principals.filter((item) => item.scope === scope)
        : state.principals;
      json(response, 200, { principals });
      return;
    }
    if (url.pathname === '/api/v1/agent-principals' && request.method === 'POST') {
      state.createRequests += 1;
      const body = await requestBody(request);
      const principal = { principalId: `p-${state.principals.length + 1}`, scope: 'WORKSPACE', ...body };
      state.principals.push(principal);
      json(response, 201, principal);
      return;
    }
    if (url.pathname === '/api/v1/agent-principals/disabled-missing/disable' && request.method === 'POST') {
      json(response, 404, { code: 'AGENT_PRINCIPAL_NOT_FOUND', detail: 'nope' });
      return;
    }
    const disableMatch = url.pathname.match(/^\/api\/v1\/agent-principals\/([^/]+)\/disable$/);
    if (disableMatch && request.method === 'POST') {
      const principalId = decodeURIComponent(disableMatch[1]);
      if (state.disabled.has(principalId)) {
        json(response, 409, { code: 'AGENT_PRINCIPAL_ALREADY_DISABLED' });
        return;
      }
      state.disabled.add(principalId);
      response.writeHead(204);
      response.end();
      return;
    }
    const workspaceAgentsMatch = url.pathname.match(/^\/api\/v1\/workspaces\/([^/]+)\/agents$/);
    if (workspaceAgentsMatch && request.method === 'GET') {
      const workspaceId = decodeURIComponent(workspaceAgentsMatch[1]);
      const agents = [...state.bindings.entries()]
        .filter(([key]) => key.startsWith(`${workspaceId}:`))
        .map(([, value]) => value);
      json(response, 200, { agents });
      return;
    }
    const bindMatch = url.pathname.match(/^\/api\/v1\/workspaces\/([^/]+)\/agents\/([^/]+)$/);
    if (bindMatch && (request.method === 'PUT' || request.method === 'DELETE')) {
      const workspaceId = decodeURIComponent(bindMatch[1]);
      const principalId = decodeURIComponent(bindMatch[2]);
      const key = `${workspaceId}:${principalId}`;
      if (request.method === 'PUT') {
        if (state.bindings.has(key)) {
          json(response, 409, { code: 'WORKSPACE_AGENT_ALREADY_BOUND' });
          return;
        }
        state.bindings.set(key, { principalId, name: 'cli-agent', source: 'personal' });
        json(response, 200, { principalId });
        return;
      }
      if (!state.bindings.has(key)) {
        json(response, 404, { code: 'WORKSPACE_AGENT_NOT_BOUND' });
        return;
      }
      state.bindings.delete(key);
      response.writeHead(204);
      response.end();
      return;
    }
    if (url.pathname === '/api/v1/provider-connections' && request.method === 'GET') {
      json(response, 200, { connections: state.connections });
      return;
    }
    const patchMatch = url.pathname.match(/^\/api\/v1\/provider-connections\/([^/]+)$/);
    if (patchMatch && request.method === 'PATCH') {
      const body = await requestBody(request);
      state.patchBodies.push(body);
      const index = state.connections.findIndex((item) => item.id === decodeURIComponent(patchMatch[1]));
      if (index === -1) { json(response, 404, { code: 'CONNECTION_NOT_FOUND' }); return; }
      state.connections[index] = { ...state.connections[index], ...body, modelLimits: body.modelLimits ?? state.connections[index].modelLimits };
      json(response, 200, { connection: state.connections[index] });
      return;
    }
    json(response, 404, { code: 'NOT_FOUND' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const env = {
    XIHE_CP_PORT: String(port),
    XIHE_CP_URL: `http://127.0.0.1:${port}`,
    XIHE_DEV_ADMIN_PASSWORD: TEST_PASSWORD,
  };
  const noPrompt = async () => { throw new Error('must not prompt'); };
  const run = (argv) => runCommand(argv, { env, promptSecret: noPrompt, stdout: sink(), stderr: sink() });
  try {
    const created = await run(['agent', 'create', '--scope', 'personal', '--name', 'cli-agent',
      '--template', 'tpl-1', '--default-model', 'openai:gpt-5', '--allow-model', 'openai:gpt-5',
      '--allow-model', 'openai:gpt-5-mini', '--json']);
    assert.equal(created.exitCode, 0);
    assert.equal(created.data.kind, 'agent-created');
    assert.equal(created.data.created, true);
    assert.equal(created.data.principalId, 'p-1');
    assert.equal(created.data.principal.scope, 'PERSONAL');
    assert.deepEqual(created.data.principal.allowedModels, [
      { provider: 'openai', model: 'gpt-5' },
      { provider: 'openai', model: 'gpt-5-mini' },
    ]);
    assert.deepEqual(created.data.principal.defaultModelProvider, 'openai');
    assert.equal(created.data.principal.defaultModelName, 'gpt-5');

    const again = await run(['agent', 'create', '--scope', 'personal', '--name', 'cli-agent',
      '--template', 'tpl-1', '--default-model', 'openai:gpt-5', '--allow-model', 'openai:gpt-5',
      '--allow-model', 'openai:gpt-5-mini', '--json']);
    assert.equal(again.exitCode, 0);
    assert.equal(again.data.created, false);
    assert.equal(again.data.idempotent, true);
    assert.equal(again.data.principalId, 'p-1');
    assert.equal(state.createRequests, 1, 'repeat create must not POST again');

    const listed = await run(['agent', 'list', '--json']);
    assert.equal(listed.exitCode, 0);
    assert.equal(listed.data.kind, 'agent-list');
    assert.equal(listed.data.principals.length, 1);
    assert.equal(listed.data.principals[0].principalId, 'p-1');

    const bound = await run(['agent', 'bind', '--principal', 'p-1', '--workspace', 'ws-1', '--json']);
    assert.equal(bound.exitCode, 0);
    assert.equal(bound.data.alreadyBound, false);
    const rebound = await run(['agent', 'bind', '--principal', 'p-1', '--workspace', 'ws-1', '--json']);
    assert.equal(rebound.exitCode, 0, 'repeat bind must be an idempotent success');
    assert.equal(rebound.data.alreadyBound, true);

    const wsAgents = await run(['agent', 'list', '--workspace', 'ws-1', '--json']);
    assert.equal(wsAgents.exitCode, 0);
    // PLAN-0622 contract v1: pass the {agents:[...]} envelope through unchanged.
    assert.ok(Array.isArray(wsAgents.data.agents), 'workspace list must keep the envelope');
    assert.equal(wsAgents.data.agents.length, 1);
    assert.equal(wsAgents.data.agents[0].source, 'personal');
    assert.equal(wsAgents.data.agents[0].permissionsSnapshot, undefined);

    const unbound = await run(['agent', 'unbind', '--principal', 'p-1', '--workspace', 'ws-1', '--json']);
    assert.equal(unbound.exitCode, 0);
    const unboundAgain = await run(['agent', 'unbind', '--principal', 'p-1', '--workspace', 'ws-1', '--json']);
    assert.equal(unboundAgain.exitCode, 0, 'repeat unbind must be an idempotent success');
    assert.equal(unboundAgain.data.alreadyUnbound, true);

    const disabled = await run(['agent', 'disable', '--principal', 'p-1', '--json']);
    assert.equal(disabled.exitCode, 0);
    assert.equal(disabled.data.alreadyDisabled, false);
    const disabledAgain = await run(['agent', 'disable', '--principal', 'p-1', '--json']);
    assert.equal(disabledAgain.exitCode, 0);
    assert.equal(disabledAgain.data.alreadyDisabled, true);

    const missing = await run(['agent', 'disable', '--principal', 'disabled-missing', '--json']);
    assert.equal(missing.exitCode, 1, 'CP 4xx is a business failure');
    assert.equal(missing.error.code, 'AGENT_PRINCIPAL_NOT_FOUND', 'CP code must pass through');

    const usage = await run(['agent', 'create', '--scope', 'bogus', '--name', 'x', '--json']);
    assert.equal(usage.exitCode, 2, 'usage errors exit 2');
    assert.equal(usage.error.code, 'INVALID_ARGUMENT');

    const quota = await run(['provider', 'limit', 'set', '--connection', 'conn-1', '--tokens', '100', '--json']);
    assert.equal(quota.exitCode, 2, '--tokens without --window is a usage error');

    const limits = await run(['provider', 'limit', 'set', '--connection', 'conn-1', '--max-inflight', '2',
      '--tokens', '100', '--window', '60', '--model', 'openai:gpt-5', '--max-inflight', '1', '--json']);
    assert.equal(limits.exitCode, 0);
    assert.equal(limits.data.kind, 'provider-limits');
    assert.deepEqual(state.patchBodies[0], {
      maxInflight: 2,
      windowTokenBudget: 100,
      windowSeconds: 60,
      modelLimits: [{ provider: 'openai', model: 'gpt-5', maxInflight: 1 }],
    });

    const shown = await run(['provider', 'limit', 'show', '--connection', 'conn-1', '--json']);
    assert.equal(shown.exitCode, 0);
    assert.equal(shown.data.limits.maxInflight, 2);
    assert.equal(shown.data.limits.windowSeconds, 60);
    assert.equal(shown.data.limits.modelLimits[0].maxInflight, 1);

    // PLAN-0622 contract v1: modelLimits is a full replacement (clear / inherit / null).
    const clearModels = await run(['provider', 'limit', 'set', '--connection', 'conn-1', '--clear-model-limits', '--json']);
    assert.equal(clearModels.exitCode, 0);
    assert.deepEqual(state.patchBodies[1].modelLimits, []);

    const clearedGlobal = await run(['provider', 'limit', 'set', '--connection', 'conn-1', '--max-inflight', 'none', '--json']);
    assert.equal(clearedGlobal.exitCode, 0);
    assert.equal(state.patchBodies[2].maxInflight, null);

    const clearedModel = await run(['provider', 'limit', 'set', '--connection', 'conn-1',
      '--model', 'openai:gpt-5', '--max-inflight', 'none', '--json']);
    assert.equal(clearedModel.exitCode, 0);
    assert.deepEqual(state.patchBodies[3].modelLimits, [{ provider: 'openai', model: 'gpt-5', maxInflight: null }]);

    const inherited = await run(['provider', 'limit', 'set', '--connection', 'conn-1', '--max-inflight', '3', '--json']);
    assert.equal(inherited.exitCode, 0);
    assert.equal('modelLimits' in state.patchBodies[4], false, 'omitting modelLimits must inherit');

    const unknownConnection = await run(['provider', 'limit', 'show', '--connection', 'nope', '--json']);
    assert.equal(unknownConnection.exitCode, 1);
    assert.equal(unknownConnection.error.code, 'CONNECTION_NOT_FOUND');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
test('run-agent-e2e: usage 2, scope gate 3, and a full A5+A6 pass against a fake CP', async () => {
  const { main } = await import('./xihe-cli/run-agent-e2e.mjs');
  const env = { XIHE_DEV_ADMIN_PASSWORD: TEST_PASSWORD };

  let chats = 0;
  let scopeMode = 'missing';
  const patches = [];
  const state = { agents: [], workspaceBound: false };
  const fakeFetch = async (url, init = {}) => {
    const target = new URL(url);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    const respond = (status, payload, headers = {}) => new Response(JSON.stringify(payload), {
      status, headers: { 'Content-Type': 'application/json', ...headers },
    });
    if (target.pathname === '/api/v1/auth/login' && method === 'POST') {
      return respond(200, { accessToken: 'runner-token', tokenType: 'Bearer', expiresIn: 900 });
    }
    if (target.pathname === '/api/v1/agent-principals' && method === 'GET') {
      return scopeMode === 'ok'
        ? respond(200, { principals: [] })
        : respond(404, { code: 'NOT_FOUND' });
    }
    if (target.pathname === '/api/v1/agent-principals' && method === 'POST') {
      const principalId = body.scope === 'PERSONAL' ? 'p-9' : 'p-10';
      return respond(201, { principalId, scope: body.scope, name: body.name });
    }
    if (target.pathname === '/api/v1/workspaces/ws-1/agents' && method === 'GET') {
      // V4：PERSONAL 未绑也可见；WORKSPACE 只有绑定才可见。
      const agents = [{ principalId: 'p-9', name: 'personal', source: 'personal', permissionsSnapshot: [] }];
      if (state.workspaceBound) agents.push({ principalId: 'p-10', name: 'workspace', source: 'workspace', permissionsSnapshot: [] });
      return respond(200, { agents });
    }
    if (target.pathname === '/api/v1/workspaces/ws-1/agents/p-9' && (method === 'PUT' || method === 'DELETE')) {
      return method === 'PUT' ? respond(200, { principalId: 'p-9' }) : new Response(null, { status: 204 });
    }
    if (target.pathname === '/api/v1/workspaces/ws-1/agents/p-10' && method === 'PUT') {
      state.workspaceBound = true;
      return respond(200, { principalId: 'p-10' });
    }
    if (target.pathname === '/api/v1/workspaces/ws-1/agents/p-10' && method === 'DELETE') {
      state.workspaceBound = false;
      return new Response(null, { status: 204 });
    }
    if (target.pathname === '/api/v1/provider-connections' && method === 'GET') {
      return respond(200, { connections: [{ id: 'c-1', status: 'READY', enabled: true, connectionKey: 'c-1', manualModels: ['gpt-5'], ...(patches.length > 0 ? { maxInflight: 1 } : {}) }] });
    }
    if (target.pathname === '/api/v1/provider-connections/c-1' && method === 'PATCH') {
      patches.push(body);
      return respond(200, { connection: { id: 'c-1', ...body } });
    }
    if (target.pathname === '/api/v1/config/api-request-templates' && method === 'GET') {
      return respond(200, { templates: [{ id: 't-1', status: 'published', version: 1 }] });
    }
    if (target.pathname === '/api/v1/sessions' && method === 'POST') {
      return respond(201, { id: 's-1' });
    }
    if (target.pathname === '/api/v1/sessions/s-1/branches' && method === 'GET') {
      return respond(200, { items: [{ branchId: 'b-1' }] });
    }
    if (target.pathname === '/api/v1/sessions/s-1' && method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    if (target.pathname === '/api/v1/chat' && method === 'POST') {
      if (patches.length >= 2) return respond(202, { runId: 'run-after' });
      chats += 1;
      if (chats === 1) return respond(202, { runId: 'run-1' });
      return respond(429, { code: 'RESOURCE_EXHAUSTED', retryAfterSeconds: 1, resourceKind: 'CONNECTION', scope: 'ws-1' }, { 'Retry-After': '1' });
    }
    if (target.pathname.startsWith('/api/v1/chat/runs/') && method === 'POST') {
      return respond(200, {});
    }
    return respond(404, { code: 'NOT_FOUND' });
  };
  const usage = await main(['--ui-workspace', 'ws-1', '--json']);
  assert.equal(usage, 2, 'missing --cp is a usage error');

  const scopeUnsupported = await main(['--cp', 'http://cp-fake', '--ui-workspace', 'ws-1', '--json'], { env, fetchImpl: fakeFetch });
  assert.equal(scopeUnsupported, 3, 'CP without M1.2 must exit 3, not pass');

  scopeMode = 'ok'; // CP M1.2 delivered from here on
  const { runAgentE2E } = await import('./xihe-cli/run-agent-e2e.mjs');
  const pass = await runAgentE2E({
    env,
    fetchImpl: fakeFetch,
    options: { '--cp': 'http://cp-fake', '--ui-workspace': 'ws-1' },
  });
  assert.equal(pass.exitCode, 0, JSON.stringify(pass.data?.steps ?? pass.error));
  assert.equal(pass.data.personal.principalId, 'p-9');
  assert.equal(pass.data.workspacePrincipal.principalId, 'p-10');
  assert.equal(pass.data.workspacePrincipal.status, 'PASS');
  assert.equal(pass.data.limit.status, 'PASS');
  assert.equal(pass.data.session.id, 's-1');
  assert.equal(pass.data.limit.detail.includes('kind=CONNECTION'), true);
  assert.equal(patches.length, 2, 'set maxInflight=1 then restore');
  assert.equal(patches[0].maxInflight, 1);
  assert.equal(pass.data.steps.at(-1).name, 'cleanup second session');
});
test('session participants + chat send: contract shapes, code passthrough, and --as body', async () => {
  const state = { lastChatBody: null, lastAddBody: null, lastPatchBody: null };
  const view = (patch = {}) => ({
    participantId: 'part-1', principalKind: 'AGENT', principalId: 'p-1', role: 'MEMBER',
    orderIndex: 20, wakePolicy: 'MENTION', respondPolicy: 'WHEN_MENTIONED', source: 'workspace',
    disabledAt: null, readCursor: null, ...patch,
  });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/api/v1/auth/login') { json(response, 200, { accessToken: 'p-token' }); return; }
    const listMatch = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/participants$/);
    if (listMatch && request.method === 'GET') {
      json(response, 200, { participants: [view({ role: 'PRIMARY', orderIndex: 10 }), view()] });
      return;
    }
    if (listMatch && request.method === 'POST') {
      const body = await requestBody(request);
      state.lastAddBody = body;
      if (body.principalId === 'p-dup') { json(response, 409, { code: 'PARTICIPANT_ALREADY_EXISTS', detail: 'exists' }); return; }
      if (body.role === 'PRIMARY') { json(response, 409, { code: 'PARTICIPANT_PRIMARY_EXISTS', detail: 'primary' }); return; }
      json(response, 201, view({ principalId: body.principalId, principalKind: body.principalKind, wakePolicy: body.wakePolicy ?? 'MENTION' }));
      return;
    }
    const oneMatch = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/participants\/([^/]+)$/);
    if (oneMatch && request.method === 'PATCH') {
      state.lastPatchBody = await requestBody(request);
      json(response, 200, view({ participantId: oneMatch[2], ...state.lastPatchBody }));
      return;
    }
    if (oneMatch && request.method === 'DELETE') {
      if (oneMatch[2] === 'part-primary') { json(response, 409, { code: 'PARTICIPANT_PRIMARY_IMMUTABLE', detail: 'immutable' }); return; }
      response.writeHead(204); response.end(); return;
    }
    if (url.pathname === '/api/v1/chat' && request.method === 'POST') {
      state.lastChatBody = await requestBody(request);
      if (state.lastChatBody.asParticipantId === 'part-forbidden') {
        json(response, 403, { code: 'PARTICIPANT_CAP_DENIED', detail: 'not your participant' }); return;
      }
      json(response, 202, { runId: 'run-1', status: 'accepted', sessionId: state.lastChatBody.sessionId });
      return;
    }
    json(response, 404, { code: 'NOT_FOUND' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const env = { XIHE_CP_PORT: String(port), XIHE_DEV_ADMIN_PASSWORD: TEST_PASSWORD };
  const noPrompt = async () => { throw new Error('must not prompt'); };
  const run = (argv) => runCommand(argv, { env, promptSecret: noPrompt, stdout: sink(), stderr: sink() });
  try {
    const list = await run(['session', 'participants', 'list', '--session', 's-1', '--json']);
    assert.equal(list.exitCode, 0, JSON.stringify(list.error));
    assert.equal(list.data.kind, 'session-participants');
    assert.equal(list.data.participants.length, 2);
    assert.equal(list.data.participants[0].role, 'PRIMARY');

    const add = await run(['session', 'participants', 'add', '--session', 's-1', '--principal', 'p-1',
      '--kind', 'agent', '--role', 'member', '--wake', 'all_messages', '--respond', 'always', '--json']);
    assert.equal(add.exitCode, 0, JSON.stringify(add.error));
    assert.equal(add.data.kind, 'session-participant');
    assert.deepEqual(state.lastAddBody, {
      principalKind: 'AGENT', principalId: 'p-1', role: 'MEMBER', wakePolicy: 'ALL_MESSAGES', respondPolicy: 'ALWAYS',
    });

    const duplicate = await run(['session', 'participants', 'add', '--session', 's-1', '--principal', 'p-dup', '--kind', 'AGENT', '--json']);
    assert.equal(duplicate.exitCode, 1);
    assert.equal(duplicate.error.code, 'PARTICIPANT_ALREADY_EXISTS');

    const primaryRemove = await run(['session', 'participants', 'remove', '--session', 's-1', '--participant', 'part-primary', '--json']);
    assert.equal(primaryRemove.exitCode, 1);
    assert.equal(primaryRemove.error.code, 'PARTICIPANT_PRIMARY_IMMUTABLE');

    const removed = await run(['session', 'participants', 'remove', '--session', 's-1', '--participant', 'part-1', '--json']);
    assert.equal(removed.exitCode, 0);
    assert.equal(removed.data.action, 'remove');

    const policy = await run(['session', 'participants', 'policy', '--session', 's-1', '--participant', 'part-1',
      '--wake', 'MENTION', '--respond', 'MUTED', '--json']);
    assert.equal(policy.exitCode, 0);
    // 0624 M5: 切回普通 wake 时显式清 wake_config（null = 显式清除）。
    assert.deepEqual(state.lastPatchBody, { wakePolicy: 'MENTION', respondPolicy: 'MUTED', wakeConfig: null });

    const emptyPolicy = await run(['session', 'participants', 'policy', '--session', 's-1', '--participant', 'part-1', '--json']);
    assert.equal(emptyPolicy.exitCode, 2);
    assert.equal(emptyPolicy.error.code, 'INVALID_ARGUMENT');

    const badKind = await run(['session', 'participants', 'add', '--session', 's-1', '--principal', 'p-1', '--kind', 'ROBOT', '--json']);
    assert.equal(badKind.exitCode, 2);
    assert.equal(badKind.error.code, 'INVALID_ARGUMENT');

    const missingSession = await run(['session', 'participants', 'list', '--json']);
    assert.equal(missingSession.exitCode, 2);

    const sent = await run(['chat', 'send', '--session', 's-1', '--branch', 'b-1', '--content', 'hello', '--as', 'part-1', '--json']);
    assert.equal(sent.exitCode, 0, JSON.stringify(sent.error));
    assert.equal(sent.data.kind, 'chat-sent');
    assert.equal(sent.data.runId, 'run-1');
    assert.equal(state.lastChatBody.asParticipantId, 'part-1');

    const forbidden = await run(['chat', 'send', '--session', 's-1', '--branch', 'b-1', '--content', 'hi', '--as', 'part-forbidden', '--json']);
    assert.equal(forbidden.exitCode, 1);
    assert.equal(forbidden.error.code, 'PARTICIPANT_CAP_DENIED');

    // PLAN-0624 M5: wake=SCHEDULE + wake_config（V94）
    const schedule = await run(['session', 'participants', 'policy', '--session', 's-1', '--participant', 'part-1',
      '--wake', 'SCHEDULE', '--interval', '30', '--jitter', '5', '--max-concurrent', '2', '--json']);
    assert.equal(schedule.exitCode, 0, JSON.stringify(schedule.error));
    assert.deepEqual(state.lastPatchBody, {
      wakePolicy: 'SCHEDULE',
      wakeConfig: { intervalSeconds: 30, jitterSeconds: 5, maxConcurrent: 2 },
    });

    const scheduleMin = await run(['session', 'participants', 'policy', '--session', 's-1', '--participant', 'part-1',
      '--wake', 'schedule', '--interval', '60', '--json']);
    assert.equal(scheduleMin.exitCode, 0);
    assert.deepEqual(state.lastPatchBody, { wakePolicy: 'SCHEDULE', wakeConfig: { intervalSeconds: 60 } });

    const scheduleNoInterval = await run(['session', 'participants', 'policy', '--session', 's-1',
      '--participant', 'part-1', '--wake', 'SCHEDULE', '--json']);
    assert.equal(scheduleNoInterval.exitCode, 2);
    assert.equal(scheduleNoInterval.error.code, 'INVALID_ARGUMENT');

    const backToMention = await run(['session', 'participants', 'policy', '--session', 's-1',
      '--participant', 'part-1', '--wake', 'MENTION', '--json']);
    assert.equal(backToMention.exitCode, 0);
    assert.deepEqual(state.lastPatchBody, { wakePolicy: 'MENTION', wakeConfig: null });

    const intervalWithoutSchedule = await run(['session', 'participants', 'policy', '--session', 's-1',
      '--participant', 'part-1', '--respond', 'ALWAYS', '--interval', '10', '--json']);
    assert.equal(intervalWithoutSchedule.exitCode, 2);

    const badInterval = await run(['session', 'participants', 'policy', '--session', 's-1',
      '--participant', 'part-1', '--wake', 'SCHEDULE', '--interval', '0', '--json']);
    assert.equal(badInterval.exitCode, 2);
    const noContent = await run(['chat', 'send', '--session', 's-1', '--branch', 'b-1', '--content', ' ', '--json']);
    assert.equal(noContent.exitCode, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PLAN-0628 M3: the `skill` command at the runCommand layer
//
// The domain module has its own suite (scripts/xihe-cli/skill.test.mjs), and that suite cannot see
// the three places the command breaks without touching the domain: the `if (group === 'skill')`
// registration branch, the `helpText()` entries, and the `printResult` rendering branches. Broken
// there, every domain test stays green and a human only sees `Command completed.` — so these cases
// are asserted end to end: real HTTP mock → `runCommand` → the text a user reads.
// ─────────────────────────────────────────────────────────────────────────────

async function startSkillCpMock() {
  const state = { requests: [], importBody: null };
  const skills = [
    { skillId: 's-1', name: 'writing', version: 3, definitionScope: { type: 'instance' } },
    {
      skillId: 's-2',
      name: 'notes',
      version: 1,
      definitionScope: { type: 'workspace', workspaceId: 'ws-1' },
      oversize: true,
      trusted: true,
    },
  ];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const body = await requestBody(request).catch(() => undefined);
    state.requests.push({
      method: request.method,
      pathname: url.pathname,
      search: url.search,
      authorization: request.headers.authorization ?? null,
      body,
    });

    if (url.pathname === '/api/v1/auth/login' && request.method === 'POST') {
      if (body?.identifier !== 'admin@xihe.local' || body?.password !== TEST_PASSWORD) {
        json(response, 401, { code: 'AUTHENTICATION_FAILED', detail: 'must not be printed' });
        return;
      }
      json(response, 200, { accessToken: 'skill-token' });
      return;
    }
    if (url.pathname === '/api/v1/skills' && request.method === 'GET') {
      json(response, 200, { items: skills });
      return;
    }
    if (url.pathname === '/api/v1/skills/import' && request.method === 'POST') {
      state.importBody = body;
      json(response, 200, {
        results: [{ skillId: 's-1', action: 'created' }],
        rejected: [{
          code: 'SKILL_NAME_INVALID',
          sourcePath: 'bad/SKILL.md',
          detail: 'name must be lowercase',
        }],
        summary: { created: 1, updated: 0, unchanged: 0, rejected: 1, oversize: 0 },
      });
      return;
    }
    const bindingsMatch = url.pathname.match(/^\/api\/v1\/skills\/([^/]+)\/bindings$/);
    if (bindingsMatch && request.method === 'GET') {
      json(response, 200, {
        items: [
          { bindingId: 'b-1', subjectType: 'user', subjectId: 'u-1', scopeType: 'instance' },
          {
            bindingId: 'b-2',
            subjectType: 'agent_principal',
            subjectId: 'p-1',
            scopeType: 'workspace',
            scopeId: 'ws-1',
          },
        ],
      });
      return;
    }
    const skillMatch = url.pathname.match(/^\/api\/v1\/skills\/([^/]+)$/);
    if (skillMatch && request.method === 'GET') {
      json(response, 200, {
        skillId: skillMatch[1],
        name: 'writing',
        version: 3,
        bodyTokensEst: 812,
        oversize: true,
      });
      return;
    }
    if (skillMatch && request.method === 'DELETE') {
      response.writeHead(204);
      response.end();
      return;
    }
    if (url.pathname === '/api/v1/skill-bindings' && request.method === 'POST') {
      json(response, 200, { bindingId: 'b-9', skillId: body?.skillId });
      return;
    }
    const bindingMatch = url.pathname.match(/^\/api\/v1\/skill-bindings\/([^/]+)$/);
    if (bindingMatch && request.method === 'DELETE') {
      response.writeHead(204);
      response.end();
      return;
    }
    json(response, 404, { code: 'NOT_FOUND', detail: 'unknown endpoint' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    state,
    env: { XIHE_CP_PORT: String(server.address().port), XIHE_DEV_ADMIN_PASSWORD: TEST_PASSWORD },
    close: () => new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

/** Like `captureStdout`, but both streams: the import rendering writes rejections to stderr. */
function captureOutput(fn) {
  const stdout = [];
  const stderr = [];
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = (chunk) => { stdout.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true; };
  try {
    fn();
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
  return { stdout: stdout.join(''), stderr: stderr.join('') };
}

test('skill list is registered at runCommand and renders the rows', async (t) => {
  const cp = await startSkillCpMock();
  t.after(cp.close);

  const result = await runCommand(['skill', 'list'], {
    env: cp.env, promptSecret: noPrompt, stdout: sink(), stderr: sink(),
  });

  // Registration: without the `if (group === 'skill')` branch this returns
  // INVALID_ARGUMENT "Unknown XH command" and never touches CP.
  assert.equal(result.error, undefined, JSON.stringify(result.error));
  assert.equal(result.exitCode, 0);
  const listRequests = cp.state.requests.filter((call) => call.pathname === '/api/v1/skills');
  assert.equal(listRequests.length, 1, 'skill list must reach listSkills');
  assert.equal(listRequests[0].search, '?definitionScope=instance');
  assert.equal(listRequests[0].authorization, 'Bearer skill-token');

  // Rendering: without the `Array.isArray(result.data?.skills)` branch this prints
  // `Command completed.` instead of the rows a user can act on.
  assert.equal(
    captureStdout(() => printResult(result)),
    's-1  writing  instance  v3\n'
    + 's-2  notes  workspace:ws-1  v1  OVERSIZE  trusted\n',
  );
});

test('skill list and skill bindings say so when there is nothing to show', () => {
  assert.equal(
    captureStdout(() => printResult({ exitCode: 0, json: false, data: { skills: [] } })),
    'No visible skills.\n',
  );
  assert.equal(
    captureStdout(() => printResult({ exitCode: 0, json: false, data: { bindings: [] } })),
    'No bindings.\n',
  );
});

test('skill show renders the version, the token estimate and the oversize flag', async (t) => {
  const cp = await startSkillCpMock();
  t.after(cp.close);

  const result = await runCommand(['skill', 'show', 's-1', '--include-body'], {
    env: cp.env, promptSecret: noPrompt, stdout: sink(), stderr: sink(),
  });

  assert.equal(result.exitCode, 0, JSON.stringify(result.error));
  const showRequest = cp.state.requests.find((call) => call.pathname === '/api/v1/skills/s-1');
  assert.equal(showRequest.search, '?includeBody=true');
  assert.equal(
    captureStdout(() => printResult(result)),
    's-1  writing  v3  812 tok  OVERSIZE\n',
  );
});

test('skill bindings renders one line per binding', async (t) => {
  const cp = await startSkillCpMock();
  t.after(cp.close);

  const result = await runCommand(['skill', 'bindings', 's-1'], {
    env: cp.env, promptSecret: noPrompt, stdout: sink(), stderr: sink(),
  });

  assert.equal(result.exitCode, 0, JSON.stringify(result.error));
  assert.equal(
    captureStdout(() => printResult(result)),
    'b-1  user:u-1  instance\n'
    + 'b-2  agent_principal:p-1  workspace:ws-1\n',
  );
});

test('skill bind posts the binding and confirms with the id the server returned', async (t) => {
  const cp = await startSkillCpMock();
  t.after(cp.close);

  const result = await runCommand(['skill', 'bind', '--skill', 's-1', '--subject-id', 'u-1'], {
    env: cp.env, promptSecret: noPrompt, stdout: sink(), stderr: sink(),
  });

  assert.equal(result.exitCode, 0, JSON.stringify(result.error));
  const bindRequest = cp.state.requests.find((call) => call.pathname === '/api/v1/skill-bindings');
  assert.deepEqual(bindRequest.body, {
    skillId: 's-1', subjectType: 'user', subjectId: 'u-1', scopeType: 'instance',
  });
  assert.equal(captureStdout(() => printResult(result)), 'bound b-9\n');
});

test('skill delete --yes deletes through CP and reports the removed id', async (t) => {
  const cp = await startSkillCpMock();
  t.after(cp.close);

  const result = await runCommand(['skill', 'delete', 's-1', '--yes'], {
    env: cp.env, promptSecret: noPrompt, stdout: sink(), stderr: sink(),
  });

  assert.equal(result.exitCode, 0, JSON.stringify(result.error));
  const deletes = cp.state.requests.filter((call) => call.method === 'DELETE');
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].pathname, '/api/v1/skills/s-1');
  assert.equal(captureStdout(() => printResult(result)), 'removed s-1\n');
});

test('skill import prints the summary and every rejected row', async (t) => {
  const cp = await startSkillCpMock();
  t.after(cp.close);
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'xihe-skill-import-'));
  const file = path.join(directory, 'request.json');
  const request = { definitionScope: { type: 'instance' }, skills: [{ name: 'writing' }] };
  fs.writeFileSync(file, JSON.stringify(request));

  const result = await runCommand(['skill', 'import', '--file', file], {
    env: cp.env, promptSecret: noPrompt, stdout: sink(), stderr: sink(),
  });

  assert.equal(result.exitCode, 0, JSON.stringify(result.error));
  assert.deepEqual(cp.state.importBody, request);
  const printed = captureOutput(() => printResult(result));
  assert.equal(printed.stdout, 'created=1 updated=0 unchanged=0 rejected=1 oversize=0\n');
  assert.equal(
    printed.stderr,
    '[SKILL_NAME_INVALID] bad/SKILL.md: name must be lowercase\n',
  );
});

test('help lists every skill command form', async () => {
  const result = await runCommand(['help'], { env: {}, promptSecret: noPrompt });

  assert.equal(result.exitCode, 0);
  for (const form of [
    'skill list', 'skill show', 'skill import', 'skill bind', 'skill unbind', 'skill delete',
  ]) {
    assert.ok(result.data.help.includes(form), `help is missing: ${form}`);
  }
});

test('an unknown skill subcommand is refused instead of completing silently', async () => {
  const result = await runCommand(['skill', 'frobnicate'], { env: {}, promptSecret: noPrompt });

  // PLAN-0643 T3.6: INVALID_ARGUMENT is a usage error and answers 2 (was 1 before the frozen table).
  assert.equal(result.exitCode, 2);
  assert.equal(result.error.code, 'INVALID_ARGUMENT');
  assert.match(result.error.message, /Unknown skill command/);
});

test('PLAN-0643 T3.6: usage errors answer 2 and XIHE_CLI_LEGACY_EXIT_CODES=1 restores 1', async () => {
  const strict = await runCommand(['nosuchgroup'], { env: {}, promptSecret: noPrompt });
  assert.equal(strict.exitCode, 2);
  assert.equal(strict.error.code, 'INVALID_ARGUMENT');

  const legacy = await runCommand(['nosuchgroup'], { env: { XIHE_CLI_LEGACY_EXIT_CODES: '1' }, promptSecret: noPrompt });
  assert.equal(legacy.exitCode, 1);
  assert.equal(legacy.error.code, 'INVALID_ARGUMENT');
});

test('PLAN-0643 T3.6: help documents the exit-code table', async () => {
  const result = await runCommand(['help'], { env: {}, promptSecret: noPrompt });

  assert.equal(result.exitCode, 0);
  assert.match(result.data.help, /Exit codes: 0 = success; 1 = business\/runtime failure; 2 = usage error/);
  assert.match(result.data.help, /XIHE_CLI_LEGACY_EXIT_CODES=1/);
});

test('PLAN-0643 T1.7: XIHE_CP_URL selects the endpoint when XIHE_CP_PORT is absent', async (t) => {
  const cp = await startCpMock();
  t.after(cp.close);

  const result = await runCommand(['provider', 'list'], {
    env: { ...cp.env, XIHE_CP_URL: `http://127.0.0.1:${cp.env.XIHE_CP_PORT}`, XIHE_CP_PORT: `1` },
    promptSecret: noPrompt,
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.data.connections, []);
});

test('PLAN-0643 T1.7: global --base-url wins over XIHE_CP_PORT', async (t) => {
  const cp = await startCpMock();
  t.after(cp.close);

  const result = await runCommand(['--base-url', `http://127.0.0.1:${cp.env.XIHE_CP_PORT}`, 'provider', 'list'], {
    env: { XIHE_DEV_ADMIN_PASSWORD: cp.env.XIHE_DEV_ADMIN_PASSWORD, XIHE_CP_PORT: '1' },
    promptSecret: noPrompt,
  });

  assert.equal(result.exitCode, 0);
});

test('PLAN-0643 T1.7: an invalid --base-url fails closed as a usage error', async () => {
  const result = await runCommand(['--base-url', 'not-a-url', 'provider', 'list'], {
    env: { XIHE_CP_PORT: '1' },
    promptSecret: noPrompt,
  });

  // T3.6: INVALID_BASE_URL is in the usage-error table.
  assert.equal(result.exitCode, 2);
  assert.equal(result.error.code, 'INVALID_BASE_URL');
});

test('PLAN-0643 T1.7: global --workspace is accepted before the group and forwarded', async (t) => {
  const cp = await startCpMock();
  t.after(cp.close);

  const result = await runCommand(['--workspace', 'ws-1', 'skill', 'list'], {
    env: cp.env,
    promptSecret: noPrompt,
  });

  assert.notEqual(result.error?.code, 'INVALID_ARGUMENT');
});

// ── PLAN-0643 T1.1/T1.6/T1.8: escape hatch ────────────────────────────────

async function startApiEscapeMock({ responseType = 'json', status = 200, bodyText } = {}) {
  const state = { requests: [], lastQuery: null, lastMethod: null, lastBody: null, lastHeaders: null };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    state.requests.push(`${request.method} ${url.pathname}${url.search}`);
    state.lastQuery = url.searchParams;
    state.lastMethod = request.method;
    state.lastHeaders = request.headers;
    state.lastBody = await requestBody(request);
    if (url.pathname === '/api/v1/auth/login') {
      json(response, 200, { accessToken: 'test-token' });
      return;
    }
    if (bodyText !== undefined) {
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(bodyText);
      return;
    }
    if (responseType === 'sse') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end('data: {}\n\n');
      return;
    }
    if (responseType === 'text') {
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.end('plain body');
      return;
    }
    if (url.pathname === '/api/v1/status') {
      json(response, 200, { status: 'ok', instance: 'xihe' });
      return;
    }
    if (url.pathname === '/api/v1/config/export') {
      json(response, 200, { domains: { 'llm-provider': {} } });
      return;
    }
    json(response, status, status >= 400 ? { code: 'NOT_FOUND', detail: 'nope' } : { ok: true });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    state,
    env: { XIHE_CP_PORT: String(server.address().port), XIHE_DEV_ADMIN_PASSWORD: TEST_PASSWORD },
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

test('PLAN-0643 T1.1: xihe api forwards a GET and returns the {ok,status,body} envelope', async (t) => {
  const cp = await startApiEscapeMock();
  t.after(cp.close);

  const result = await runCommand(['api', 'GET', '/api/v1/status', '--json'], {
    env: cp.env,
    promptSecret: noPrompt,
    stderr: sink(),
  });

  assert.equal(result.exitCode, 0, JSON.stringify(result.error));
  assert.deepEqual(result.envelope, { ok: true, status: 200, body: { status: 'ok', instance: 'xihe' } });
  assert.equal(cp.state.lastHeaders.authorization, 'Bearer test-token');
});

test('PLAN-0643 T1.6: non-2xx answers keep status in the envelope', async (t) => {
  const cp = await startApiEscapeMock({ status: 404 });
  t.after(cp.close);

  const result = await runCommand(['api', 'GET', '/api/v1/nope', '--json'], {
    env: cp.env,
    promptSecret: noPrompt,
    stderr: sink(),
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.envelope.ok, false);
  assert.equal(result.envelope.status, 404);
  assert.equal(result.envelope.body.code, 'NOT_FOUND');
});

test('PLAN-0643 T1.1: /api/v1/mcp is denied unless --allow-dangerous is passed', async (t) => {
  const cp = await startApiEscapeMock();
  t.after(cp.close);

  const denied = await runCommand(['api', 'POST', '/api/v1/mcp', '--yes', '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });
  assert.equal(denied.exitCode, 2);
  assert.equal(denied.error.code, 'API_DANGEROUS_REQUIRES_ALLOW');

  const allowed = await runCommand(['api', 'POST', '/api/v1/mcp', '--yes', '--allow-dangerous', '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });
  assert.equal(allowed.exitCode, 0, JSON.stringify(allowed.error));
  assert.equal(cp.state.lastQuery.get('includeSecrets'), null);
});

test('PLAN-0643 T1.1: the audit line is printed on stderr for every dangerous call', async (t) => {
  const cp = await startApiEscapeMock();
  t.after(cp.close);
  const stderr = sink();

  await runCommand(['api', 'POST', '/api/v1/mcp', '--yes', '--allow-dangerous', '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr,
  });

  assert.match(stderr.text(), /audit: --allow-dangerous/);
});

test('PLAN-0643 T1.1: credential reveal and /internal targets are forbidden', async (t) => {
  const cp = await startApiEscapeMock();
  t.after(cp.close);

  const reveal = await runCommand(['api', 'POST', '/api/v1/credentials/c-1/reveal', '--yes', '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });
  assert.equal(reveal.exitCode, 2);
  assert.equal(reveal.error.code, 'API_TARGET_INVALID');

  const internal = await runCommand(['api', 'GET', '/internal/v1/status', '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });
  assert.equal(internal.exitCode, 2);
  assert.equal(internal.error.code, 'API_TARGET_INVALID');
});

// V51 (PLAN-0643 audit R1): Node/undici normalise dot segments client-side, so a
// raw-string gate would let `/api/v1/x/%2e%2e/mcp` go out as `/api/v1/mcp`. Every
// non-canonical form must be refused *before* any request is sent.
test('PLAN-0643 V51: percent-encoded / dot-segment targets can never bypass the api gates', async (t) => {
  const cp = await startApiEscapeMock();
  t.after(cp.close);

  const attempts = [
    ['POST', '/api/v1/x/%2e%2e/mcp', '--yes'], // tool-execution gate (needs --allow-dangerous)
    ['GET', '/api/v1/config/x/%2e%2e/export', ''], // includeSecrets=false force
    ['POST', '/api/v1/credentials/c-1/x/%2e%2e/reveal', '--yes'], // reveal prohibition
    ['GET', '/api/v1/%2e%2e/%2e%2e/internal/v1/agent/health', ''], // service surface
    ['GET', '/api/v1/x/../mcp', ''], // plain dot segment
    ['GET', '/api/v1//status', ''], // empty segment
  ];

  for (const [method, target, extra] of attempts) {
    const args = ['api', method, target, ...(extra === '' ? [] : [extra]), '--json'];
    const result = await runCommand(args, { env: cp.env, promptSecret: noPrompt, stderr: sink() });
    assert.equal(result.exitCode, 2, `${method} ${target} -> ${JSON.stringify(result)}`);
    assert.equal(result.error.code, 'API_TARGET_INVALID', `${method} ${target}`);
  }
  assert.equal(cp.state.requests.length, 0, 'no rejected target may reach the CP');
});

test('PLAN-0643 T1.1: config/export is forced to includeSecrets=false', async (t) => {
  const cp = await startApiEscapeMock();
  t.after(cp.close);

  const result = await runCommand(['api', 'GET', '/api/v1/config/export', '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });

  assert.equal(result.exitCode, 0, JSON.stringify(result.error));
  assert.equal(cp.state.lastQuery.get('includeSecrets'), 'false');
});

test('PLAN-0643 T1.1: mutating methods require --yes and --body never exists', async (t) => {
  const cp = await startApiEscapeMock();
  t.after(cp.close);

  const deleteDenied = await runCommand(['api', 'DELETE', '/api/v1/provider-connections/c-1', '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });
  assert.equal(deleteDenied.exitCode, 2);
  assert.equal(deleteDenied.error.code, 'API_METHOD_REQUIRES_YES');

  const bodyFlag = await runCommand(['api', 'POST', '/api/v1/whatever', '--yes', '--body', '{"a":1}', '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });
  assert.equal(bodyFlag.exitCode, 2);
  assert.equal(bodyFlag.error.code, 'INVALID_ARGUMENT');
});

test('PLAN-0643 T1.1: the request body comes from stdin', async (t) => {
  const cp = await startApiEscapeMock();
  t.after(cp.close);

  const result = await runCommand(['api', 'POST', '/api/v1/whatever', '--yes', '--stdin', '--json'], {
    env: cp.env,
    promptSecret: noPrompt,
    stderr: sink(),
    stdin: Readable.from(['{"hello":"world"}']),
  });

  assert.equal(result.exitCode, 0, JSON.stringify(result.error));
  assert.deepEqual(cp.state.lastBody, { hello: 'world' });
  assert.equal(cp.state.lastHeaders['content-type'], 'application/json');
});

test('PLAN-0643 T1.6: SSE is refused with a pointer to events tail', async (t) => {
  const cp = await startApiEscapeMock({ responseType: 'sse' });
  t.after(cp.close);

  const result = await runCommand(['api', 'GET', '/api/v1/events', '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });

  assert.equal(result.exitCode, 2);
  assert.equal(result.error.code, 'API_RESPONSE_UNSUPPORTED');
  assert.match(result.error.message, /events tail/);
});

test('PLAN-0643 T1.6: non-JSON needs --raw', async (t) => {
  const cp = await startApiEscapeMock({ responseType: 'text' });
  t.after(cp.close);

  const refused = await runCommand(['api', 'GET', '/api/v1/whatever', '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });
  assert.equal(refused.exitCode, 2);
  assert.equal(refused.error.code, 'API_RESPONSE_NOT_JSON');

  const raw = await runCommand(['api', 'GET', '/api/v1/whatever', '--raw', '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });
  assert.equal(raw.exitCode, 0);
  assert.equal(raw.envelope.body, 'plain body');
});

test('PLAN-0643 T1.8: XIHE_CLI_DISABLE_API_ESCAPE=1 disables the escape hatch', async (t) => {
  const cp = await startApiEscapeMock();
  t.after(cp.close);

  const result = await runCommand(['api', 'GET', '/api/v1/status', '--json'], {
    env: { ...cp.env, XIHE_CLI_DISABLE_API_ESCAPE: '1' },
    promptSecret: noPrompt,
    stderr: sink(),
  });

  assert.equal(result.exitCode, 2);
  assert.equal(result.error.code, 'API_ESCAPE_DISABLED');
});

// ── PLAN-0643 T1.2–T1.5: token cache ──────────────────────────────────────

function tempTokenFile() {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'xihe-cli-token-'));
  return { directory, file: path.join(directory, 'cli-token.json'), cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

function readTokenFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function startAuthMock({ status = 200 } = {}) {
  const state = { loginRequests: 0, statusRequests: 0, statusCode: status, lastAuthHeader: null };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    await requestBody(request);
    if (url.pathname === '/api/v1/auth/login') {
      state.loginRequests += 1;
      json(response, 200, { accessToken: 'access-token-1' });
      return;
    }
    if (url.pathname === '/api/v1/status') {
      state.statusRequests += 1;
      state.lastAuthHeader = request.headers.authorization ?? null;
      json(response, state.statusCode, state.statusCode === 200 ? { status: 'ok' } : { code: 'AUTHENTICATION_FAILED' });
      return;
    }
    json(response, 404, { code: 'NOT_FOUND' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    state,
    env: { XIHE_CP_PORT: String(server.address().port), XIHE_DEV_ADMIN_PASSWORD: TEST_PASSWORD },
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

// PLAN-0643 R5: a fake CP that rejects a stale token with 401 and accepts the token
// issued by the (single) re-login. `forbidden` makes every business call 403 instead.
async function startAuthRefreshMock({ freshToken = 'fresh-token', loginStatus = 200, forbidden = false } = {}) {
  const state = { loginRequests: 0, staleRequests: 0, freshRequests: 0 };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    await requestBody(request);
    if (url.pathname === '/api/v1/auth/login') {
      state.loginRequests += 1;
      if (loginStatus !== 200) {
        json(response, loginStatus, { code: 'AUTHENTICATION_FAILED' });
        return;
      }
      json(response, 200, { accessToken: freshToken });
      return;
    }
    if (forbidden) {
      json(response, 403, { code: 'ACCESS_DENIED' });
      return;
    }
    if (url.pathname === '/api/v1/provider-connections') {
      if (String(request.headers.authorization ?? '') === `Bearer ${freshToken}`) {
        state.freshRequests += 1;
        json(response, 200, { connections: [] });
        return;
      }
      state.staleRequests += 1;
      json(response, 401, { code: 'AUTHENTICATION_FAILED' });
      return;
    }
    json(response, 404, { code: 'NOT_FOUND' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    state,
    baseUrl,
    env: { XIHE_CP_PORT: String(server.address().port) },
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function seedStaleToken(file, baseUrl, token = 'stale-token') {
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    tokens: { [baseUrl]: { token, email: null, expiresAt: '2099-01-01T00:00:00.000Z', obtainedAt: '2026-01-01T00:00:00.000Z' } },
  }));
}

test('PLAN-0643 T1.2: auth login writes an access-only, baseUrl-keyed cache entry', async (t) => {
  const cp = await startAuthMock();
  const token = tempTokenFile();
  t.after(async () => { await cp.close(); token.cleanup(); });

  const result = await runCommand(['auth', 'login', '--json'], {
    env: { ...cp.env, XIHE_CLI_TOKEN_FILE: token.file },
    promptSecret: noPrompt,
    stderr: sink(),
  });

  assert.equal(result.exitCode, 0, JSON.stringify(result.error));
  assert.equal(result.data.persisted, true);
  const store = readTokenFile(token.file);
  assert.equal(store.version, 1);
  const entry = store.tokens[`http://127.0.0.1:${cp.env.XIHE_CP_PORT}`];
  assert.ok(entry, 'entry must be keyed by the CP base URL');
  assert.equal(entry.token, 'access-token-1');
  assert.ok(Number.isFinite(Date.parse(entry.expiresAt)));
  assert.equal(Object.hasOwn(entry, 'refresh'), false);
  assert.equal(Object.keys(store.tokens).length, 1);
});

test('PLAN-0643 T1.3: the cached token is reused instead of logging in again', async (t) => {
  const cp = await startAuthMock();
  const token = tempTokenFile();
  t.after(async () => { await cp.close(); token.cleanup(); });
  const env = { ...cp.env, XIHE_CLI_TOKEN_FILE: token.file };

  await runCommand(['auth', 'login', '--json'], { env, promptSecret: noPrompt, stderr: sink() });
  const loginCount = cp.state.loginRequests;
  const second = await runCommand(['auth', 'status', '--check', '--json'], { env, promptSecret: noPrompt, stderr: sink() });

  assert.equal(second.exitCode, 0, JSON.stringify(second.error));
  assert.equal(cp.state.loginRequests, loginCount);
  assert.equal(cp.state.lastAuthHeader, 'Bearer access-token-1');
  assert.equal(second.data.source, 'cache');
});

test('PLAN-0643 T1.3: XIHE_TOKEN takes precedence over the cache file', async (t) => {
  const cp = await startAuthMock();
  const token = tempTokenFile();
  t.after(async () => { await cp.close(); token.cleanup(); });
  const env = { ...cp.env, XIHE_CLI_TOKEN_FILE: token.file, XIHE_TOKEN: 'env-token-value' };

  const result = await runCommand(['auth', 'status', '--check', '--json'], { env, promptSecret: noPrompt, stderr: sink() });

  assert.equal(result.exitCode, 0, JSON.stringify(result.error));
  assert.equal(result.data.source, 'env');
  assert.equal(cp.state.loginRequests, 0);
  assert.equal(cp.state.lastAuthHeader, 'Bearer env-token-value');
});

test('PLAN-0643 T1.2: entries are partitioned per base URL', async (t) => {
  const first = await startAuthMock();
  const second = await startAuthMock();
  const token = tempTokenFile();
  t.after(async () => { await first.close(); await second.close(); token.cleanup(); });

  await runCommand(['auth', 'login', '--json'], {
    env: { ...first.env, XIHE_CLI_TOKEN_FILE: token.file }, promptSecret: noPrompt, stderr: sink(),
  });
  await runCommand(['auth', 'login', '--json'], {
    env: { ...second.env, XIHE_CLI_TOKEN_FILE: token.file }, promptSecret: noPrompt, stderr: sink(),
  });

  const store = readTokenFile(token.file);
  assert.deepEqual(Object.keys(store.tokens).sort(), [
    `http://127.0.0.1:${first.env.XIHE_CP_PORT}`,
    `http://127.0.0.1:${second.env.XIHE_CP_PORT}`,
  ].sort());
});

test('PLAN-0643 T1.3: a corrupt cache file is an explicit error, never a silent degrade', async (t) => {
  const cp = await startAuthMock();
  const token = tempTokenFile();
  t.after(async () => { await cp.close(); token.cleanup(); });
  fs.writeFileSync(token.file, '{not json');
  const env = { ...cp.env, XIHE_CLI_TOKEN_FILE: token.file };

  const result = await runCommand(['provider', 'list', '--json'], { env, promptSecret: noPrompt, stderr: sink() });
  assert.equal(result.exitCode, 1);
  assert.equal(result.error.code, 'TOKEN_FILE_CORRUPT');
  assert.equal(cp.state.loginRequests, 0);

  const repaired = await runCommand(['auth', 'logout', '--force', '--json'], { env, promptSecret: noPrompt, stderr: sink() });
  assert.equal(repaired.exitCode, 0, JSON.stringify(repaired.error));
  assert.equal(fs.existsSync(token.file), false);
});

test('PLAN-0643 T1.4: auth status reports metadata only and never the token value', async (t) => {
  const cp = await startAuthMock();
  const token = tempTokenFile();
  t.after(async () => { await cp.close(); token.cleanup(); });
  const env = { ...cp.env, XIHE_CLI_TOKEN_FILE: token.file };
  await runCommand(['auth', 'login', '--json'], { env, promptSecret: noPrompt, stderr: sink() });

  const status = await runCommand(['auth', 'status', '--json'], { env, promptSecret: noPrompt, stderr: sink() });
  assert.equal(status.exitCode, 0);
  assert.equal(status.data.hasToken, true);
  assert.equal(status.data.charCount, 'access-token-1'.length);
  assert.equal(JSON.stringify(status.data).includes('access-token-1'), false);
  assert.equal(status.data.fileState, 'ok');
});

test('PLAN-0643 T1.4: auth logout removes the entry and deletes the file when empty', async (t) => {
  const cp = await startAuthMock();
  const token = tempTokenFile();
  t.after(async () => { await cp.close(); token.cleanup(); });
  const env = { ...cp.env, XIHE_CLI_TOKEN_FILE: token.file };
  await runCommand(['auth', 'login', '--json'], { env, promptSecret: noPrompt, stderr: sink() });

  const logout = await runCommand(['auth', 'logout', '--json'], { env, promptSecret: noPrompt, stderr: sink() });
  assert.equal(logout.exitCode, 0, JSON.stringify(logout.error));
  assert.equal(logout.data.removed, true);
  assert.equal(fs.existsSync(token.file), false);
});

test('PLAN-0643 T1.5: an expired cache entry triggers exactly one silent re-login and a rewrite', async (t) => {
  const cp = await startCpMock();
  const token = tempTokenFile();
  t.after(async () => { await cp.close(); token.cleanup(); });
  const baseUrl = `http://127.0.0.1:${cp.env.XIHE_CP_PORT}`;
  fs.writeFileSync(token.file, JSON.stringify({
    version: 1,
    tokens: { [baseUrl]: { token: 'stale-token', email: null, expiresAt: '2020-01-01T00:00:00.000Z', obtainedAt: '2020-01-01T00:00:00.000Z' } },
  }));
  const env = { ...cp.env, XIHE_CLI_TOKEN_FILE: token.file };

  const result = await runCommand(['provider', 'list', '--json'], { env, promptSecret: noPrompt, stderr: sink() });

  assert.equal(result.exitCode, 0, JSON.stringify(result.error));
  assert.equal(cp.state.loginRequests, 1);
  const store = readTokenFile(token.file);
  assert.notEqual(store.tokens[baseUrl].token, 'stale-token');
  assert.ok(Date.parse(store.tokens[baseUrl].expiresAt) > Date.now());
});

test('PLAN-0643 T1.5: a 401 on --check drops the entry; 403 and network keep it', async (t) => {
  const denied = await startAuthMock();
  const token = tempTokenFile();
  t.after(async () => { await denied.close(); token.cleanup(); });
  const env = { ...denied.env, XIHE_CLI_TOKEN_FILE: token.file };
  await runCommand(['auth', 'login', '--json'], { env, promptSecret: noPrompt, stderr: sink() });
  assert.equal(fs.existsSync(token.file), true);
  denied.state.statusCode = 401;

  const checked = await runCommand(['auth', 'status', '--check', '--json'], { env, promptSecret: noPrompt, stderr: sink() });
  assert.equal(checked.data.verification, 'unauthorized');
  assert.equal(checked.data.entryDropped, true);
  assert.equal(fs.existsSync(token.file), false);
});

test('PLAN-0643 T1.2 worst case: a token path that is a directory is refused', async (t) => {
  const cp = await startAuthMock();
  const token = tempTokenFile();
  const asDirectory = path.join(token.directory, 'nested');
  fs.mkdirSync(asDirectory);
  t.after(async () => { await cp.close(); token.cleanup(); });

  const result = await runCommand(['auth', 'login', '--json'], {
    env: { ...cp.env, XIHE_CLI_TOKEN_FILE: asDirectory },
    promptSecret: noPrompt,
    stderr: sink(),
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.error.code, 'TOKEN_FILE_UNSAFE');
});

test('PLAN-0643 T1.2 worst case: an ACL failure leaves no token file behind', async (t) => {
  const cp = await startAuthMock();
  const token = tempTokenFile();
  t.after(async () => { await cp.close(); token.cleanup(); });

  const result = await runCommand(['auth', 'login', '--json'], {
    env: { ...cp.env, XIHE_CLI_TOKEN_FILE: token.file },
    promptSecret: noPrompt,
    stderr: sink(),
    aclRunner: () => ({ ok: false, code: 'TOKEN_ACL_FAILED', message: 'simulated icacls failure' }),
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.error.code, 'TOKEN_ACL_FAILED');
  assert.equal(fs.existsSync(token.file), false);
  assert.deepEqual(fs.readdirSync(token.directory), []);
});

test('PLAN-0643 T1.2 worst case: an unwritable token path reports TOKEN_FILE_UNWRITABLE', async (t) => {
  const cp = await startAuthMock();
  const token = tempTokenFile();
  const blocker = path.join(token.directory, 'blocker');
  fs.writeFileSync(blocker, 'x');
  t.after(async () => { await cp.close(); token.cleanup(); });

  const result = await runCommand(['auth', 'login', '--json'], {
    env: { ...cp.env, XIHE_CLI_TOKEN_FILE: path.join(blocker, 'cli-token.json') },
    promptSecret: noPrompt,
    stderr: sink(),
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.error.code, 'TOKEN_FILE_UNWRITABLE');
});

test('PLAN-0643 T1.5: concurrent logins converge on one valid entry (last writer wins)', async (t) => {
  const cp = await startAuthMock();
  const token = tempTokenFile();
  t.after(async () => { await cp.close(); token.cleanup(); });
  const env = { ...cp.env, XIHE_CLI_TOKEN_FILE: token.file };

  const results = await Promise.all(Array.from({ length: 5 }, () => runCommand(['auth', 'login', '--json'], {
    env, promptSecret: noPrompt, stderr: sink(),
  })));

  assert.equal(results.every((result) => result.exitCode === 0), true);
  const store = readTokenFile(token.file);
  assert.equal(Object.keys(store.tokens).length, 1);
  assert.deepEqual(fs.readdirSync(token.directory), ['cli-token.json']);
});

// V14b (PLAN-0643 audit R2): a partial logout rewrites the file for the remaining
// base URLs. That rewrite must tighten the ACL again — the previous no-op runner
// left the new file on the inherited directory ACL and exposed every other stack's
// access token to any local account that inherits it.
test('PLAN-0643 V14b: a partial logout re-tightens the ACL of the rewritten token file', () => {
  const token = tempTokenFile();
  const a = 'http://127.0.0.1:12631';
  const b = 'http://127.0.0.1:12641';
  fs.writeFileSync(token.file, JSON.stringify({
    version: 1,
    tokens: {
      [a]: { token: 'token-a', email: null, expiresAt: '2099-01-01T00:00:00.000Z', obtainedAt: '2026-01-01T00:00:00.000Z' },
      [b]: { token: 'token-b', email: null, expiresAt: '2099-01-01T00:00:00.000Z', obtainedAt: '2026-01-01T00:00:00.000Z' },
    },
  }));
  const env = { XIHE_CLI_TOKEN_FILE: token.file };
  const aclCalls = [];
  try {
    const cleared = clearToken(env, {
      baseUrl: a,
      platform: 'linux',
      aclRunner: (filePath) => {
        aclCalls.push(filePath);
        return { ok: true };
      },
    });

    assert.equal(cleared.ok, true, JSON.stringify(cleared));
    assert.equal(aclCalls.length, 1, 'the rewritten file must go through the ACL runner exactly once');
    assert.match(path.basename(aclCalls[0]), /^\.cli-token\..*\.tmp$/, 'the ACL is tightened on the tmp file before the rename');
    const store = readTokenFile(token.file);
    assert.deepEqual(Object.keys(store.tokens), [b], 'the other base URL survives');
    assert.deepEqual(fs.readdirSync(token.directory), ['cli-token.json'], 'no tmp file is left behind');
  } finally {
    token.cleanup();
  }
});

test('PLAN-0643 V14b: an ACL failure during a partial logout keeps the old file intact', () => {
  const token = tempTokenFile();
  const a = 'http://127.0.0.1:12631';
  const b = 'http://127.0.0.1:12641';
  const original = JSON.stringify({
    version: 1,
    tokens: {
      [a]: { token: 'token-a', email: null, expiresAt: '2099-01-01T00:00:00.000Z', obtainedAt: '2026-01-01T00:00:00.000Z' },
      [b]: { token: 'token-b', email: null, expiresAt: '2099-01-01T00:00:00.000Z', obtainedAt: '2026-01-01T00:00:00.000Z' },
    },
  });
  fs.writeFileSync(token.file, original);
  try {
    const cleared = clearToken({ XIHE_CLI_TOKEN_FILE: token.file }, {
      baseUrl: a,
      platform: 'linux',
      aclRunner: () => ({ ok: false, code: 'TOKEN_ACL_FAILED', message: 'simulated' }),
    });

    assert.equal(cleared.ok, false);
    assert.equal(cleared.code, 'TOKEN_ACL_FAILED');
    assert.equal(fs.readFileSync(token.file, 'utf8'), original, 'the old file must survive a failed rewrite');
    assert.deepEqual(fs.readdirSync(token.directory), ['cli-token.json'], 'the failed tmp file is cleaned up');
  } finally {
    token.cleanup();
  }
});

// ── PLAN-0643 R5: 401 refresh, single-flight across processes ───────────────────

test('PLAN-0643 R5: three concurrent 401s trigger exactly one re-login and all commands succeed', async (t) => {
  const cp = await startAuthRefreshMock();
  const token = tempTokenFile();
  t.after(async () => { await cp.close(); token.cleanup(); });
  seedStaleToken(token.file, cp.baseUrl);
  const env = { ...cp.env, XIHE_CLI_TOKEN_FILE: token.file };
  const prompt = async () => TEST_PASSWORD;

  const results = await Promise.all(Array.from({ length: 3 }, () => runCommand(['provider', 'list', '--json'], {
    env,
    promptSecret: prompt,
    stderr: sink(),
    authRefreshWaitMs: 5_000,
    authRefreshPollMs: 10,
  })));

  for (const result of results) assert.equal(result.exitCode, 0, JSON.stringify(result.error));
  assert.equal(cp.state.loginRequests, 1, 'three concurrent 401s must produce exactly one login');
  assert.equal(cp.state.freshRequests, 3, 'each command replays with the refreshed token');
  const store = readTokenFile(token.file);
  assert.equal(store.tokens[cp.baseUrl].token, 'fresh-token', 'the cache is replaced with the refreshed token');
  assert.deepEqual(fs.readdirSync(token.directory).sort(), ['cli-token.json'], 'the refresh lock is released');
});

test('PLAN-0643 R5: a 403 keeps the cache and never triggers a re-login', async (t) => {
  const cp = await startAuthRefreshMock({ forbidden: true });
  const token = tempTokenFile();
  t.after(async () => { await cp.close(); token.cleanup(); });
  seedStaleToken(token.file, cp.baseUrl);
  const env = { ...cp.env, XIHE_CLI_TOKEN_FILE: token.file };

  const result = await runCommand(['provider', 'list', '--json'], {
    env, promptSecret: async () => TEST_PASSWORD, stderr: sink(), authRefreshWaitMs: 2_000, authRefreshPollMs: 10,
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.error.code, 'ACCESS_DENIED');
  assert.equal(cp.state.loginRequests, 0, '403 is an authorization answer, not an expired token');
  assert.equal(readTokenFile(token.file).tokens[cp.baseUrl].token, 'stale-token', 'the cache is untouched on 403');
});

test('PLAN-0643 R5: a failed re-login reports AUTH_REFRESH_FAILED and keeps the old entry', async (t) => {
  const cp = await startAuthRefreshMock({ loginStatus: 401 });
  const token = tempTokenFile();
  t.after(async () => { await cp.close(); token.cleanup(); });
  seedStaleToken(token.file, cp.baseUrl);
  const env = { ...cp.env, XIHE_CLI_TOKEN_FILE: token.file };

  const result = await runCommand(['provider', 'list', '--json'], {
    env, promptSecret: async () => TEST_PASSWORD, stderr: sink(), authRefreshWaitMs: 2_000, authRefreshPollMs: 10,
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.error.code, 'AUTH_REFRESH_FAILED');
  assert.equal(cp.state.loginRequests, 1, 'exactly one refresh attempt');
  assert.equal(readTokenFile(token.file).tokens[cp.baseUrl].token, 'stale-token', 'the old token is not deleted on failure');
  assert.deepEqual(
    fs.readdirSync(token.directory).filter((name) => name.endsWith('.lock') || name.endsWith('.tmp')),
    [],
    'the refresh lock is released (the .lock.error marker is left for waiting processes)',
  );
});

test('PLAN-0643 R5: automatic refresh never reads XIHE_DEV_ADMIN_PASSWORD (B7)', async (t) => {
  const cp = await startAuthRefreshMock();
  const token = tempTokenFile();
  t.after(async () => { await cp.close(); token.cleanup(); });
  seedStaleToken(token.file, cp.baseUrl);
  const env = { ...cp.env, XIHE_CLI_TOKEN_FILE: token.file, XIHE_DEV_ADMIN_PASSWORD: TEST_PASSWORD };

  const result = await runCommand(['provider', 'list', '--json'], {
    env, promptSecret: noPrompt, stderr: sink(), authRefreshWaitMs: 2_000, authRefreshPollMs: 10,
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.error.code, 'AUTHENTICATION_FAILED', 'without an interactive prompt the original 401 is surfaced');
  assert.equal(cp.state.loginRequests, 0, 'the dev-admin password from the environment must never be replayed automatically');
});

// ── PLAN-0643 R7: byte-capped, streaming response reads ─────────────────────────

test('PLAN-0643 R7: readResponseText caps by BYTES and reports truncation', async () => {
  const exact = new Response('abcdef');
  const exactRead = await readResponseText(exact, 6);
  assert.deepEqual(exactRead, { text: 'abcdef', truncated: false }, 'exactly at the cap is not truncation');

  const over = new Response('abcdefg');
  const overRead = await readResponseText(over, 6);
  assert.equal(overRead.text, 'abcdef');
  assert.equal(overRead.truncated, true);

  // 2 chars but 6 UTF-8 bytes: a character-based cap would have admitted this.
  const multibyte = new Response('中文');
  const multibyteRead = await readResponseText(multibyte, 4);
  assert.equal(multibyteRead.truncated, true, 'the cap is measured in bytes, not UTF-16 units');
  assert.ok(Buffer.byteLength(multibyteRead.text, 'utf8') <= 4);
});

test('PLAN-0643 R7: an oversized CP response fails with CP_RESPONSE_TOO_LARGE + truncated details', async (t) => {
  const state = { requests: 0 };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    state.requests += 1;
    await requestBody(request);
    if (url.pathname === '/api/v1/auth/login') {
      json(response, 200, { accessToken: 'token-1' });
      return;
    }
    if (url.pathname === '/api/v1/provider-connections') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(`{"connections":[{"id":"c-1","big":"${'x'.repeat(1_200_000)}"}]}`);
      return;
    }
    json(response, 404, { code: 'NOT_FOUND' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const result = await runCommand(['provider', 'list', '--json'], {
    env: { XIHE_CP_PORT: String(server.address().port), XIHE_DEV_ADMIN_PASSWORD: TEST_PASSWORD },
    promptSecret: noPrompt,
    stderr: sink(),
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.error.code, 'CP_RESPONSE_TOO_LARGE');
  assert.equal(result.error.details.truncated, true);
  assert.equal(result.error.details.limitBytes, 1_000_000);
});

test('PLAN-0643 R7: xihe api reports truncation (stderr marker + truncated:true + exit 1)', async (t) => {
  const cp = await startApiEscapeMock();
  t.after(cp.close);
  const stderr = sink();

  const result = await runCommand(['api', 'GET', '/api/v1/status', '--max-bytes', '5', '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr,
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.envelope.ok, false);
  assert.equal(result.envelope.truncated, true);
  assert.equal(typeof result.envelope.body, 'string', 'a truncated JSON body stays text and is not half-parsed');
  assert.match(stderr.text(), /# truncated: response exceeded --max-bytes \(5 bytes\)/);
});

test('PLAN-0643 R7: --raw truncation keeps the partial bytes and never claims success', async (t) => {
  // 2 chars / 6 UTF-8 bytes: the old `text.length` check (2 <= 4) would have passed it whole.
  const cp = await startApiEscapeMock({ bodyText: '中文' });
  t.after(cp.close);

  const result = await runCommand(['api', 'GET', '/api/v1/whatever', '--raw', '--max-bytes', '4'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.envelope.truncated, true);
  assert.equal(result.envelope.ok, false);
  assert.ok(Buffer.byteLength(result.data.bodyText, 'utf8') <= 4, 'the printed body is capped at the byte limit');
  assert.ok(result.data.bodyText.startsWith('中'), 'the readable prefix is preserved');
});

// ─────────────────────────────────────────────────────────────────────────────
// PLAN-0643 T2 (M6-1): config get/set/unset/meta/put + config-locks (V36–V43)
// ─────────────────────────────────────────────────────────────────────────────

async function startConfigCpMock({
  envOverrides = { runMaxTurns: '12' },
  putInstanceStatus = 200,
  putInstanceCode = 'CONFIG_KEY_LOCKED',
  deleteKeyStatus = 200,
  deleteKeyCode = 'CONFIG_ENV_LOCKED',
  locksStatus = 200,
} = {}) {
  const state = {
    loginRequests: 0,
    configGetRequests: 0,
    lastConfigQuery: null,
    lastConfigDomain: null,
    instancePutRequests: 0,
    lastPutDomain: null,
    lastPutBody: null,
    deleteKeyRequests: 0,
    lastDeleteDomain: null,
    lastDeleteKey: null,
    domainPutRequests: 0,
    lastDomainPutLayer: null,
    lastDomainPutDomain: null,
    lastDomainPutBody: null,
    lastDomainPutQuery: null,
    metaRequests: 0,
    lastMetaQuery: null,
    locksListRequests: 0,
    lastLocksQuery: null,
    locksSetRequests: 0,
    lastLocksPutPath: null,
    lastLocksPutBody: null,
    locksDeleteRequests: 0,
    lastLocksDeleteQuery: null,
  };
  const domains = {
    'agent-runtime': { instance: { runMaxTurns: '10', rateLimitPerMin: '3' }, user: {}, workspace: {} },
    'agent-templates': { instance: { 'tpl.default': 'base-v2' }, user: {}, workspace: {} },
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/api/v1/auth/login' && request.method === 'POST') {
      state.loginRequests += 1;
      json(response, 200, { accessToken: 'test-access-token' });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/config-locks') {
      state.locksListRequests += 1;
      state.lastLocksQuery = url.searchParams;
      if (locksStatus !== 200) {
        json(response, locksStatus, { code: 'FORBIDDEN', detail: 'must not be printed' });
        return;
      }
      json(response, 200, {
        domain: url.searchParams.get('domain'),
        revision: 3,
        keys: [
          { key: 'runMaxTurns', lockable: true, notLockableReason: null, locked: true, reason: 'pin for demo', mode: 'enforce_value', updatedBy: 'admin', updatedAt: '2026-11-06T00:00:00Z', revision: 3, valuePresent: true },
          { key: 'rateLimitPerMin', lockable: true, notLockableReason: null, locked: false, reason: null, mode: null, updatedBy: null, updatedAt: null, revision: 0, valuePresent: true },
        ],
      });
      return;
    }
    if (request.method === 'PUT' && url.pathname.startsWith('/api/v1/config-locks/')) {
      state.locksSetRequests += 1;
      state.lastLocksPutPath = url.pathname;
      state.lastLocksPutBody = await requestBody(request);
      if (locksStatus !== 200) {
        json(response, locksStatus, { code: 'FORBIDDEN', detail: 'must not be printed' });
        return;
      }
      json(response, 200, {
        key: 'runMaxTurns', lockable: true, notLockableReason: null, locked: true,
        reason: state.lastLocksPutBody?.reason ?? null, mode: state.lastLocksPutBody?.mode ?? 'enforce_value',
        updatedBy: 'admin', updatedAt: '2026-11-06T00:00:00Z', revision: 3, valuePresent: true,
      });
      return;
    }
    if (request.method === 'DELETE' && url.pathname.startsWith('/api/v1/config-locks/')) {
      state.locksDeleteRequests += 1;
      state.lastLocksDeleteQuery = url.searchParams;
      json(response, 200, { status: 'ok' });
      return;
    }
    if (request.method === 'GET' && url.pathname.startsWith('/api/v1/config/')) {
      const tail = url.pathname.slice('/api/v1/config/'.length);
      if (tail.endsWith('/meta')) {
        state.metaRequests += 1;
        state.lastMetaQuery = url.searchParams;
        json(response, 200, {
          domain: decodeURIComponent(tail.slice(0, -'/meta'.length)),
          layer: url.searchParams.get('layer'),
          keys: [
            { key: 'runMaxTurns', source: 'env', locked: true, writable: false },
            { key: 'rateLimitPerMin', source: 'instance', locked: false, writable: true },
            { key: 'timeoutMs', source: 'default', locked: false, writable: true },
          ],
        });
        return;
      }
      state.configGetRequests += 1;
      state.lastConfigQuery = url.searchParams;
      state.lastConfigDomain = decodeURIComponent(tail);
      if (state.lastConfigDomain === 'not-a-domain') {
        json(response, 400, { code: 'INVALID_DOMAIN', detail: 'must not be printed' });
        return;
      }
      const layer = url.searchParams.get('layer');
      const includeMeta = url.searchParams.get('includeMeta') === 'true';
      const rows = layer
        ? { ...(domains[state.lastConfigDomain]?.[layer] ?? {}) }
        : {
            ...domains[state.lastConfigDomain]?.instance,
            ...domains[state.lastConfigDomain]?.user,
            ...domains[state.lastConfigDomain]?.workspace,
            ...envOverrides,
          };
      if (includeMeta) {
        json(response, 200, { domain: state.lastConfigDomain, entries: rows, envOverridden: layer ? {} : envOverrides });
        return;
      }
      json(response, 200, rows);
      return;
    }
    if (request.method === 'PUT' && url.pathname.startsWith('/api/v1/config/instance/')) {
      state.instancePutRequests += 1;
      state.lastPutDomain = decodeURIComponent(url.pathname.slice('/api/v1/config/instance/'.length));
      state.lastPutBody = await requestBody(request);
      if (putInstanceStatus !== 200) {
        json(response, putInstanceStatus, { code: putInstanceCode, detail: 'must not be printed' });
        return;
      }
      domains[state.lastPutDomain] = domains[state.lastPutDomain] ?? { instance: {}, user: {}, workspace: {} };
      domains[state.lastPutDomain].instance = { ...domains[state.lastPutDomain].instance, ...state.lastPutBody };
      json(response, 200, state.lastPutBody);
      return;
    }
    if (request.method === 'DELETE' && url.pathname.startsWith('/api/v1/config/instance/')) {
      const parts = url.pathname.slice('/api/v1/config/instance/'.length).split('/');
      state.deleteKeyRequests += 1;
      state.lastDeleteDomain = decodeURIComponent(parts[0]);
      state.lastDeleteKey = decodeURIComponent(parts[1] ?? '');
      if (deleteKeyStatus !== 200) {
        json(response, deleteKeyStatus, { code: deleteKeyCode, detail: 'must not be printed' });
        return;
      }
      delete domains[state.lastDeleteDomain]?.instance?.[state.lastDeleteKey];
      json(response, 200, { status: 'ok' });
      return;
    }
    if (request.method === 'PUT' && (url.pathname.startsWith('/api/v1/config/user/') || url.pathname.startsWith('/api/v1/config/workspace/'))) {
      state.domainPutRequests += 1;
      state.lastDomainPutLayer = url.pathname.startsWith('/api/v1/config/user/') ? 'user' : 'workspace';
      state.lastDomainPutDomain = decodeURIComponent(url.pathname.split('/').pop());
      state.lastDomainPutBody = await requestBody(request);
      state.lastDomainPutQuery = url.searchParams;
      json(response, 200, state.lastDomainPutBody);
      return;
    }
    json(response, 404, { code: 'NOT_FOUND', detail: 'nope' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    state,
    env: { XIHE_CP_PORT: String(server.address().port), XIHE_DEV_ADMIN_PASSWORD: TEST_PASSWORD },
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function writeTempEntriesFile(t, content) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'xihe-config-put-'));
  const file = path.join(dir, 'entries.json');
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return file;
}

test('PLAN-0643 V36: config get effective view includes envOverridden, the single layer does not', async (t) => {
  const cp = await startConfigCpMock();
  t.after(cp.close);

  const effective = await runCommand(['config', 'get', 'agent-runtime', '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });
  assert.equal(effective.exitCode, 0, JSON.stringify(effective.error));
  assert.equal(effective.data.kind, 'config-get');
  assert.equal(effective.data.layer, 'effective');
  assert.equal(effective.data.entries.runMaxTurns, '12', 'the env value wins the merged view');
  assert.equal(effective.data.envOverridden.runMaxTurns, '12');
  assert.equal(cp.state.lastConfigQuery.get('includeMeta'), 'true');
  assert.equal(cp.state.lastConfigQuery.get('layer'), null);

  const layered = await runCommand(['config', 'get', 'agent-runtime', '--layer', 'instance', '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });
  assert.equal(layered.exitCode, 0, JSON.stringify(layered.error));
  assert.equal(layered.data.layer, 'instance');
  assert.equal(layered.data.entries.runMaxTurns, '10', 'the raw instance row has no env overlay');
  assert.equal(layered.data.envOverridden, undefined);
  assert.equal(cp.state.lastConfigQuery.get('layer'), 'instance');
  assert.equal(cp.state.lastConfigQuery.get('includeMeta'), null);

  const optIn = await runCommand(['config', 'get', 'agent-runtime', '--layer', 'instance', '--include-meta', '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });
  assert.equal(optIn.data.includeMeta, true);
  assert.equal(cp.state.lastConfigQuery.get('includeMeta'), 'true');
});

test('PLAN-0643 V38: explicit-only domains pass --layer through to the CP read', async (t) => {
  const cp = await startConfigCpMock();
  t.after(cp.close);

  const result = await runCommand(['config', 'get', 'agent-templates', '--layer', 'instance', '--workspace', 'ws-1', '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });

  assert.equal(result.exitCode, 0, JSON.stringify(result.error));
  assert.equal(result.data.entries['tpl.default'], 'base-v2');
  assert.equal(cp.state.lastConfigQuery.get('layer'), 'instance');
  assert.equal(cp.state.lastConfigQuery.get('workspaceId'), 'ws-1');
});

test('PLAN-0643 V39: --layer user read succeeds while config set --layer user is a usage error before any request', async (t) => {
  const cp = await startConfigCpMock();
  t.after(cp.close);

  const read = await runCommand(['config', 'get', 'agent-runtime', '--layer', 'user', '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });
  assert.equal(read.exitCode, 0, JSON.stringify(read.error));
  assert.equal(read.data.layer, 'user');

  const rejected = await runCommand(['config', 'set', 'agent-runtime', 'runMaxTurns', '5', '--layer', 'user'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });
  assert.equal(rejected.exitCode, 2);
  assert.equal(rejected.error.code, 'INVALID_ARGUMENT');
  assert.equal(cp.state.instancePutRequests, 0, 'the user-layer write is rejected CLI-side (T2.6 boundary)');
});

test('PLAN-0643 V40: config set round-trips the instance rows and config unset removes the key', async (t) => {
  const cp = await startConfigCpMock();
  t.after(cp.close);

  const set = await runCommand(['config', 'set', 'agent-runtime', 'runMaxTurns', '5', '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });
  assert.equal(set.exitCode, 0, JSON.stringify(set.error));
  assert.equal(set.data.kind, 'config-set');
  assert.equal(set.data.before, '10');
  assert.equal(set.data.after, '5');
  assert.equal(set.data.changed, true);
  assert.equal(set.data.verified, true);
  assert.deepEqual(cp.state.lastPutBody, { rateLimitPerMin: '3', runMaxTurns: '5' });
  assert.equal(cp.state.lastPutDomain, 'agent-runtime');

  cp.state.lastConfigQuery = null;
  const readBack = await runCommand(['config', 'get', 'agent-runtime', '--layer', 'instance', '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });
  assert.equal(readBack.data.entries.runMaxTurns, '5');

  const unset = await runCommand(['config', 'unset', 'agent-runtime', 'runMaxTurns', '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });
  assert.equal(unset.exitCode, 0, JSON.stringify(unset.error));
  assert.equal(unset.data.status, 'ok');
  assert.equal(cp.state.lastDeleteKey, 'runMaxTurns');

  const afterUnset = await runCommand(['config', 'get', 'agent-runtime', '--layer', 'instance', '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });
  assert.equal(afterUnset.data.entries.runMaxTurns, undefined);
  assert.equal(afterUnset.data.entries.rateLimitPerMin, '3', 'the untouched key survives the whole-domain write');
});

test('PLAN-0643 V41: a locked key keeps the CP 409 code and hints at config-locks (set)', async (t) => {
  const cp = await startConfigCpMock({ putInstanceStatus: 409, putInstanceCode: 'CONFIG_KEY_LOCKED' });
  t.after(cp.close);
  const stderr = sink();

  const result = await runCommand(['config', 'set', 'agent-runtime', 'runMaxTurns', '5'], {
    env: cp.env, promptSecret: noPrompt, stderr,
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.error.code, 'CONFIG_KEY_LOCKED');
  assert.match(stderr.text(), /config-locks/);
});

test('PLAN-0643 V41: config unset keeps CONFIG_ENV_LOCKED and hints at config-locks', async (t) => {
  const cp = await startConfigCpMock({ deleteKeyStatus: 409, deleteKeyCode: 'CONFIG_ENV_LOCKED' });
  t.after(cp.close);
  const stderr = sink();

  const result = await runCommand(['config', 'unset', 'agent-runtime', 'runMaxTurns'], {
    env: cp.env, promptSecret: noPrompt, stderr,
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.error.code, 'CONFIG_ENV_LOCKED');
  assert.match(stderr.text(), /config-locks/);
});

test('PLAN-0643 V42: config meta defaults to the instance layer and reports source/locked/writable', async (t) => {
  const cp = await startConfigCpMock();
  t.after(cp.close);

  const result = await runCommand(['config', 'meta', 'agent-runtime', '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });

  assert.equal(result.exitCode, 0, JSON.stringify(result.error));
  assert.equal(result.data.kind, 'config-meta');
  assert.equal(result.data.layer, 'instance');
  assert.equal(cp.state.lastMetaQuery.get('layer'), 'instance');
  assert.equal(result.data.keys.length, 3);
  assert.deepEqual(
    result.data.keys.map((entry) => ({ source: entry.source, locked: entry.locked, writable: entry.writable })),
    [
      { source: 'env', locked: true, writable: false },
      { source: 'instance', locked: false, writable: true },
      { source: 'default', locked: false, writable: true },
    ],
  );
});

test('PLAN-0643 V43: config export stays instance-only (--layer user answers 2)', async () => {
  const result = await runCommand(['config', 'export', '--layer', 'user'], {
    env: {}, promptSecret: noPrompt,
  });

  assert.equal(result.exitCode, 2);
  assert.equal(result.error.code, 'INVALID_ARGUMENT');
});

test('PLAN-0643 V43: config-locks list forwards the optional domain filter', async (t) => {
  const cp = await startConfigCpMock();
  t.after(cp.close);

  const all = await runCommand(['config-locks', 'list', '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });
  assert.equal(all.exitCode, 0, JSON.stringify(all.error));
  assert.equal(all.data.kind, 'config-locks-list');
  assert.equal(all.data.revision, 3);
  assert.equal(all.data.keys.length, 2);
  assert.equal(cp.state.lastLocksQuery.get('domain'), null);

  const filtered = await runCommand(['config-locks', 'list', 'agent-runtime', '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });
  assert.equal(filtered.data.domain, 'agent-runtime');
  assert.equal(cp.state.lastLocksQuery.get('domain'), 'agent-runtime');
});

test('PLAN-0643 V43: config-locks set requires --reason and forwards the lock request body', async (t) => {
  const cp = await startConfigCpMock();
  t.after(cp.close);

  const missing = await runCommand(['config-locks', 'set', 'agent-runtime', 'runMaxTurns', '--value', '5'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });
  assert.equal(missing.exitCode, 2);
  assert.equal(missing.error.code, 'INVALID_ARGUMENT');
  assert.equal(cp.state.locksSetRequests, 0);

  const set = await runCommand(['config-locks', 'set', 'agent-runtime', 'runMaxTurns', '--reason', 'pin for demo', '--value', '5', '--revision', '2', '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });
  assert.equal(set.exitCode, 0, JSON.stringify(set.error));
  assert.equal(set.data.kind, 'config-locks-set');
  assert.equal(set.data.locked, true);
  assert.deepEqual(cp.state.lastLocksPutBody, { reason: 'pin for demo', value: '5', revision: 2 });
  assert.match(cp.state.lastLocksPutPath, /\/api\/v1\/config-locks\/agent-runtime\/runMaxTurns$/);
});

test('PLAN-0643 V43: config-locks delete forwards revision and clearValue as query parameters', async (t) => {
  const cp = await startConfigCpMock();
  t.after(cp.close);

  const result = await runCommand(['config-locks', 'delete', 'agent-runtime', 'runMaxTurns', '--revision', '2', '--clear-value', '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });

  assert.equal(result.exitCode, 0, JSON.stringify(result.error));
  assert.equal(result.data.status, 'ok');
  assert.equal(result.data.clearValue, true);
  assert.equal(cp.state.lastLocksDeleteQuery.get('revision'), '2');
  assert.equal(cp.state.lastLocksDeleteQuery.get('clearValue'), 'true');
});

test('PLAN-0643 V11: config get injects workspaceId as a query from --workspace and XIHE_WORKSPACE_ID', async (t) => {
  const cp = await startConfigCpMock();
  t.after(cp.close);

  const flag = await runCommand(['config', 'get', 'agent-runtime', '--layer', 'workspace', '--workspace', 'ws-1', '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });
  assert.equal(flag.exitCode, 0, JSON.stringify(flag.error));
  assert.equal(flag.data.workspaceId, 'ws-1');
  assert.equal(cp.state.lastConfigQuery.get('workspaceId'), 'ws-1');

  const fromEnv = await runCommand(['--workspace', 'ws-lead', 'config', 'get', 'agent-runtime', '--layer', 'workspace', '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });
  assert.equal(fromEnv.data.workspaceId, 'ws-lead', 'the leading global --workspace lands in the same query');
  assert.equal(cp.state.lastConfigQuery.get('workspaceId'), 'ws-lead');
});

test('PLAN-0643 T2.4: config put writes the whole user domain from --file', async (t) => {
  const cp = await startConfigCpMock();
  t.after(cp.close);
  const file = writeTempEntriesFile(t, { defaultModel: 'xiaomi:mimo-v2', retryLimit: '2' });

  const result = await runCommand(['config', 'put', 'llm-provider', '--layer', 'user', '--file', file, '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });

  assert.equal(result.exitCode, 0, JSON.stringify(result.error));
  assert.equal(result.data.kind, 'config-put');
  assert.equal(result.data.layer, 'user');
  assert.equal(result.data.keys, 2);
  assert.deepEqual(cp.state.lastDomainPutBody, { defaultModel: 'xiaomi:mimo-v2', retryLimit: '2' });
  assert.equal(cp.state.lastDomainPutLayer, 'user');
  assert.equal(cp.state.lastDomainPutDomain, 'llm-provider');
});

test('PLAN-0643 T2.4: config put --layer workspace requires workspace context and rides the query', async (t) => {
  const cp = await startConfigCpMock();
  t.after(cp.close);
  const file = writeTempEntriesFile(t, { defaultModel: 'xiaomi:mimo-v2' });

  const missing = await runCommand(['config', 'put', 'llm-provider', '--layer', 'workspace', '--file', file], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });
  assert.equal(missing.exitCode, 2);
  assert.equal(missing.error.code, 'INVALID_ARGUMENT');
  assert.equal(cp.state.domainPutRequests, 0);

  const ok = await runCommand(['config', 'put', 'llm-provider', '--layer', 'workspace', '--file', file, '--workspace', 'ws-1', '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });
  assert.equal(ok.exitCode, 0, JSON.stringify(ok.error));
  assert.equal(cp.state.lastDomainPutQuery.get('workspaceId'), 'ws-1');
  assert.equal(cp.state.lastDomainPutLayer, 'workspace');
});

test('PLAN-0643 T2.4: config put rejects the instance layer, a missing file and malformed entries', async (t) => {
  const cp = await startConfigCpMock();
  t.after(cp.close);

  const instance = await runCommand(['config', 'put', 'llm-provider', '--layer', 'instance', '--file', 'x.json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });
  assert.equal(instance.exitCode, 2);
  assert.equal(instance.error.code, 'INVALID_ARGUMENT');
  assert.match(instance.error.message, /config set/);

  const noFile = await runCommand(['config', 'put', 'llm-provider', '--layer', 'user'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });
  assert.equal(noFile.exitCode, 2);
  assert.equal(cp.state.domainPutRequests, 0);

  const badJson = await runCommand(['config', 'put', 'llm-provider', '--layer', 'user', '--file', writeTempEntriesFile(t, 'not json')], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });
  assert.equal(badJson.exitCode, 2);

  const nonString = await runCommand(['config', 'put', 'llm-provider', '--layer', 'user', '--file', writeTempEntriesFile(t, { retryLimit: 2 })], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });
  assert.equal(nonString.exitCode, 2);
  assert.match(nonString.error.message, /retryLimit/);
  assert.equal(cp.state.domainPutRequests, 0);
});

test('PLAN-0643 T2.7: unknown config and config-locks commands answer 2', async () => {
  const configUnknown = await runCommand(['config', 'nosuch'], { env: {}, promptSecret: noPrompt });
  assert.equal(configUnknown.exitCode, 2);
  assert.match(configUnknown.error.message, /get\/set\/unset\/meta\/put\/import\/export/);

  const locksUnknown = await runCommand(['config-locks', 'nosuch'], { env: {}, promptSecret: noPrompt });
  assert.equal(locksUnknown.exitCode, 2);
  assert.match(locksUnknown.error.message, /list\/set\/delete/);
});

test('PLAN-0643 T2.1: CP 4xx error codes surface verbatim (INVALID_DOMAIN, locks 403)', async (t) => {
  const cp = await startConfigCpMock({ locksStatus: 403 });
  t.after(cp.close);

  const domain = await runCommand(['config', 'get', 'not-a-domain', '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });
  assert.equal(domain.exitCode, 1);
  assert.equal(domain.error.code, 'INVALID_DOMAIN', 'preserveServerCodes keeps the CP body code');
  assert.equal(domain.error.details.status, 400);

  const locks = await runCommand(['config-locks', 'list'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });
  assert.equal(locks.exitCode, 1);
  assert.equal(locks.error.code, 'FORBIDDEN');
});

test('PLAN-0643 T2.7: --json keeps the frozen {ok,data|error} envelope on stdout (spawned CLI)', () => {
  // printResult builds the envelope at print time, so this checks the printed
  // bytes end-to-end with offline commands (version / usage error).
  const env = { ...process.env, XIHE_CLI_TOKEN_CACHE: 'off', XIHE_CP_PORT: '1' };
  const okRun = spawnSync(process.execPath, ['scripts/xihe.mjs', 'version', '--json'], {
    cwd: process.cwd(), env, encoding: 'utf8', timeout: 30_000, windowsHide: true,
  });
  assert.equal(okRun.status, 0, okRun.stderr);
  const okEnvelope = JSON.parse(okRun.stdout);
  assert.deepEqual(Object.keys(okEnvelope).sort(), ['data', 'ok']);
  assert.equal(okEnvelope.ok, true);

  const errorRun = spawnSync(process.execPath, ['scripts/xihe.mjs', 'config', 'nosuch', '--json'], {
    cwd: process.cwd(), env, encoding: 'utf8', timeout: 30_000, windowsHide: true,
  });
  assert.equal(errorRun.status, 2);
  const errorEnvelope = JSON.parse(errorRun.stdout);
  assert.deepEqual(Object.keys(errorEnvelope).sort(), ['error', 'ok']);
  assert.equal(errorEnvelope.ok, false);
  assert.equal(errorEnvelope.error.code, 'INVALID_ARGUMENT');
});

test('PLAN-0643 V8: --base-url wins over XIHE_CP_URL (auth status reports the chosen base)', async () => {
  const result = await runCommand(['--base-url', 'http://10.1.1.1:9', 'auth', 'status', '--json'], {
    env: { XIHE_CP_URL: 'http://10.2.2.2:8' },
    promptSecret: noPrompt,
  });

  assert.equal(result.exitCode, 0, JSON.stringify(result.error));
  assert.equal(result.data.baseUrl, 'http://10.1.1.1:9');
});

test('PLAN-0643 V9: with no --base-url, XIHE_CP_URL or XIHE_CP_PORT the CLI targets loopback 12631', async () => {
  const result = await runCommand(['auth', 'status', '--json'], {
    env: {},
    promptSecret: noPrompt,
  });

  assert.equal(result.exitCode, 0, JSON.stringify(result.error));
  assert.equal(result.data.baseUrl, 'http://127.0.0.1:12631');
});

// ---------------------------------------------------------------------------
// PLAN-0643 M6-2 (T3.1-T3.5): chat run/cancel/approvals + session read surface,
// chat send Idempotency-Key, workspace header injection and conflict detection.
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Real-process tests must reach the in-test loopback mock directly: strip the
// operator's proxy environment (NODE_USE_ENV_PROXY/HTTP(S)_PROXY/ALL_PROXY) so
// Node's env-proxy cannot route the child's fetch away from 127.0.0.1.
function directConnectEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of Object.keys(env)) {
    if (/^(https?_proxy|all_proxy|no_proxy|node_use_env_proxy)$/i.test(key)) delete env[key];
  }
  return env;
}

async function startChatSessionMock() {
  const state = {
    loginRequests: 0,
    chatIdempotencyKeys: [],
    lastWorkspaceHeader: null,
    lastCancelBody: null,
    lastDecisionBody: null,
    lastExportQuery: null,
    lastExportHeader: null,
    exportMarkdown: '# Session export\n\nhello from the fake CP export surface.\n',
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const body = await requestBody(request);
    if (url.pathname === '/api/v1/auth/login' && request.method === 'POST') {
      state.loginRequests += 1;
      json(response, 200, { accessToken: 'test-access-token' });
      return;
    }
    if (url.pathname === '/api/v1/chat' && request.method === 'POST') {
      state.chatIdempotencyKeys.push(request.headers['idempotency-key'] ?? null);
      state.lastWorkspaceHeader = request.headers['x-workspace-id'] ?? null;
      json(response, 202, { runId: 'run-new', status: 'accepted' });
      return;
    }
    if (url.pathname === '/api/v1/chat/runs/run-1' && request.method === 'GET') {
      json(response, 200, {
        runId: 'run-1', sessionId: 'session-1', origin: 'user_submission',
        status: 'running', terminalOutcome: null, leaseExpired: false, pendingApprovals: [],
      });
      return;
    }
    if (url.pathname === '/api/v1/chat/runs/run-1/attempts' && request.method === 'GET') {
      json(response, 200, [{ attempt: 1, httpStatus: 200 }]);
      return;
    }
    if (url.pathname === '/api/v1/chat/runs/run-1/trace' && request.method === 'GET') {
      json(response, 200, { steps: ['cp', 'agent'] });
      return;
    }
    if (url.pathname === '/api/v1/chat/runs/run-1/cancel' && request.method === 'POST') {
      state.lastCancelBody = body;
      json(response, 200, { status: 'cancel_accepted', runId: 'run-1' });
      return;
    }
    if (url.pathname === '/api/v1/approvals/pending' && request.method === 'GET') {
      json(response, 200, [
        { sessionId: 'session-1', workspaceId: 'ws-1', count: 2, oldestRequestedAt: '2026-11-06T01:00:00.000Z' },
      ]);
      return;
    }
    if (url.pathname === '/api/v1/chat/approvals/req-1/decision' && request.method === 'POST') {
      state.lastDecisionBody = body;
      json(response, 200, { requestId: 'req-1', state: 'accepted' });
      return;
    }
    if (url.pathname === '/api/v1/sessions' && request.method === 'GET') {
      state.lastWorkspaceHeader = request.headers['x-workspace-id'] ?? null;
      json(response, 200, {
        sessions: [{ id: 'session-1', title: 'Demo', kind: null, archived: false, workspaceId: 'ws-1', agentPrincipalId: null }],
      });
      return;
    }
    if (url.pathname === '/api/v1/sessions/session-1' && request.method === 'GET') {
      json(response, 200, { id: 'session-1', workspaceId: 'ws-1', title: 'Demo', archived: false, agentPrincipalId: null });
      return;
    }
    if (url.pathname === '/api/v1/sessions/session-1/export' && request.method === 'GET') {
      state.lastExportQuery = url.searchParams.get('branchId');
      state.lastExportHeader = request.headers['x-workspace-id'] ?? null;
      response.writeHead(200, { 'Content-Type': 'text/markdown' });
      response.end(state.exportMarkdown);
      return;
    }
    json(response, 404, { code: 'NOT_FOUND', detail: 'unknown endpoint' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    state,
    env: { XIHE_CP_PORT: String(server.address().port), XIHE_DEV_ADMIN_PASSWORD: TEST_PASSWORD },
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

test('PLAN-0643 T3.1/V44: chat run reports the CP run status (--json carries status)', async (t) => {
  const cp = await startChatSessionMock();
  t.after(() => cp.close());

  const result = await runCommand(['chat', 'run', 'run-1', '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });

  assert.equal(result.exitCode, 0, JSON.stringify(result.error));
  assert.equal(result.data.kind, 'chat-run');
  assert.equal(result.data.runId, 'run-1');
  assert.equal(result.data.status, 'running');
});

test('PLAN-0643 T3.1: --attempts/--trace attach the side reads', async (t) => {
  const cp = await startChatSessionMock();
  t.after(() => cp.close());

  const result = await runCommand(['chat', 'run', 'run-1', '--attempts', '--trace', '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });

  assert.equal(result.exitCode, 0, JSON.stringify(result.error));
  assert.deepEqual(result.data.attempts, [{ attempt: 1, httpStatus: 200 }]);
  assert.deepEqual(result.data.trace, { steps: ['cp', 'agent'] });
});

test('PLAN-0643 T3.2/V44: chat cancel is idempotent (a second call still succeeds)', async (t) => {
  const cp = await startChatSessionMock();
  t.after(() => cp.close());

  const first = await runCommand(['chat', 'cancel', 'run-1', '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });
  const second = await runCommand(['chat', 'cancel', 'run-1', '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });

  assert.equal(first.exitCode, 0, JSON.stringify(first.error));
  assert.equal(first.data.status, 'cancel_accepted');
  assert.equal(second.exitCode, 0, JSON.stringify(second.error));
  assert.equal(second.data.status, 'cancel_accepted');
  assert.deepEqual(cp.state.lastCancelBody, undefined, 'no reason flag means no request body');
});

test('PLAN-0643 T3.3/V44: chat approvals outputs the pending array', async (t) => {
  const cp = await startChatSessionMock();
  t.after(() => cp.close());

  const result = await runCommand(['chat', 'approvals', '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });

  assert.equal(result.exitCode, 0, JSON.stringify(result.error));
  assert.equal(result.data.kind, 'chat-approvals');
  assert.equal(result.data.items.length, 1);
  assert.equal(result.data.items[0].count, 2);
});

test('PLAN-0643 T3.3: chat approve/reject POST the decision body', async (t) => {
  const cp = await startChatSessionMock();
  t.after(() => cp.close());

  const approved = await runCommand(['chat', 'approve', 'req-1', '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });
  assert.equal(approved.exitCode, 0, JSON.stringify(approved.error));
  assert.deepEqual(cp.state.lastDecisionBody, { decision: 'once' });

  const rejected = await runCommand(['chat', 'reject', 'req-1', '--feedback', 'no thanks', '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });
  assert.equal(rejected.exitCode, 0, JSON.stringify(rejected.error));
  assert.deepEqual(cp.state.lastDecisionBody, { decision: 'reject', feedback: 'no thanks' });
});

test('PLAN-0643 V45: chat send carries an Idempotency-Key; an explicit key is reused', async (t) => {
  const cp = await startChatSessionMock();
  t.after(() => cp.close());

  const base = ['chat', 'send', '--session', 'session-1', '--branch', 'branch-1', '--content', 'hello'];
  const generated = await Promise.all([
    runCommand([...base, '--json'], { env: cp.env, promptSecret: noPrompt, stderr: sink() }),
    runCommand([...base, '--json'], { env: cp.env, promptSecret: noPrompt, stderr: sink() }),
  ]);
  const explicit = await Promise.all([
    runCommand([...base, '--idempotency-key', 'fixed-key-1', '--json'], { env: cp.env, promptSecret: noPrompt, stderr: sink() }),
    runCommand([...base, '--idempotency-key', 'fixed-key-1', '--json'], { env: cp.env, promptSecret: noPrompt, stderr: sink() }),
  ]);

  assert.equal(generated.every((r) => r.exitCode === 0), true, JSON.stringify(generated.map((r) => r.error)));
  assert.equal(explicit.every((r) => r.exitCode === 0), true, JSON.stringify(explicit.map((r) => r.error)));
  const keys = cp.state.chatIdempotencyKeys;
  assert.equal(keys.length, 4);
  assert.match(keys[0], UUID_RE, 'a missing flag must still generate a UUID key');
  assert.match(keys[1], UUID_RE);
  assert.notEqual(keys[0], keys[1], 'each invocation without a flag generates a fresh key');
  assert.equal(keys[2], 'fixed-key-1');
  assert.equal(keys[3], 'fixed-key-1');
});

test('PLAN-0643 V46/V10: session list/get/export hit their endpoints; --workspace injects the header', async (t) => {
  const cp = await startChatSessionMock();
  t.after(() => cp.close());

  const list = await runCommand(['session', 'list', '--workspace', 'ws-1', '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });
  assert.equal(list.exitCode, 0, JSON.stringify(list.error));
  assert.equal(cp.state.lastWorkspaceHeader, 'ws-1', 'V10: the list request carries x-workspace-id');
  assert.equal(list.data.sessions[0].id, 'session-1');

  const got = await runCommand(['session', 'get', 'session-1', '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });
  assert.equal(got.exitCode, 0, JSON.stringify(got.error));
  assert.equal(got.data.session.title, 'Demo');

  const exported = await runCommand(['session', 'export', 'session-1', '--branch', 'branch-9', '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });
  assert.equal(exported.exitCode, 0, JSON.stringify(exported.error));
  assert.equal(cp.state.lastExportQuery, 'branch-9', 'export hits /export?branchId=...');
  assert.match(exported.data.markdown, /^# Session export/, 'export output is Markdown');
});

test('PLAN-0643 V46: session export prints the Markdown document (human output)', async (t) => {
  const cp = await startChatSessionMock();
  t.after(() => cp.close());

  // The real-process shape cannot run inside the DSH sandbox (child HTTP data
  // plane is swallowed), so the human face is asserted through printResult —
  // the same function main() invokes.
  const result = await runCommand(['session', 'export', 'session-1', '--branch', 'branch-1'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });
  assert.equal(result.exitCode, 0, JSON.stringify(result.error));
  const human = captureStdout(() => printResult(result));
  assert.match(human, /^# Session export\n/, 'the human output is the Markdown document');
  assert.ok(human.endsWith('hello from the fake CP export surface.\n'), 'a missing trailing newline is restored');
});

test('PLAN-0643 V12: conflicting --workspace and XIHE_WORKSPACE_ID exit 2; agreeing values pass', async (t) => {
  const cp = await startChatSessionMock();
  t.after(() => cp.close());

  const conflict = await runCommand(['--workspace', 'ws-b', 'session', 'list', '--json'], {
    env: { ...cp.env, XIHE_WORKSPACE_ID: 'ws-a' }, promptSecret: noPrompt, stderr: sink(),
  });
  assert.equal(conflict.exitCode, 2, JSON.stringify(conflict.error));
  assert.equal(conflict.error.code, 'INVALID_ARGUMENT');
  assert.match(conflict.error.message, /provide only one of them/);

  const trailing = await runCommand(['session', 'list', '--workspace', 'ws-9'], {
    env: { ...cp.env, XIHE_WORKSPACE_ID: 'ws-a' }, promptSecret: noPrompt, stderr: sink(),
  });
  assert.equal(trailing.exitCode, 2, JSON.stringify(trailing.error));
  assert.match(trailing.error.message, /provide only one of them/, 'trailing flag form hits the same guard');

  const agreeing = await runCommand(['--workspace', 'ws-a', 'session', 'list', '--json'], {
    env: { ...cp.env, XIHE_WORKSPACE_ID: 'ws-a' }, promptSecret: noPrompt, stderr: sink(),
  });
  assert.equal(agreeing.exitCode, 0, JSON.stringify(agreeing.error));
});

test('PLAN-0643 T3.5/V12b: XIHE_WORKSPACE_ID alone injects the header via the fetch wrapper', async (t) => {
  const cp = await startChatSessionMock();
  t.after(() => cp.close());

  const result = await runCommand(['session', 'list', '--json'], {
    env: { ...cp.env, XIHE_WORKSPACE_ID: 'ws-env' }, promptSecret: noPrompt, stderr: sink(),
  });

  assert.equal(result.exitCode, 0, JSON.stringify(result.error));
  assert.equal(cp.state.lastWorkspaceHeader, 'ws-env', 'the env value reaches the sessions read');
});

test('PLAN-0643 M6-2: unknown chat/session subcommands are usage errors', async (t) => {
  const cp = await startChatSessionMock();
  t.after(() => cp.close());

  const chatBogus = await runCommand(['chat', 'bogus'], { env: cp.env, promptSecret: noPrompt, stderr: sink() });
  assert.equal(chatBogus.exitCode, 2, JSON.stringify(chatBogus.error));
  assert.equal(chatBogus.error.code, 'INVALID_ARGUMENT');

  const sessionBogus = await runCommand(['session', 'bogus'], { env: cp.env, promptSecret: noPrompt, stderr: sink() });
  assert.equal(sessionBogus.exitCode, 2, JSON.stringify(sessionBogus.error));

  const missingRunId = await runCommand(['chat', 'run'], { env: cp.env, promptSecret: noPrompt, stderr: sink() });
  assert.equal(missingRunId.exitCode, 2, JSON.stringify(missingRunId.error));

  const missingBranch = await runCommand(['session', 'export', 'session-1'], { env: cp.env, promptSecret: noPrompt, stderr: sink() });
  assert.equal(missingBranch.exitCode, 2, JSON.stringify(missingBranch.error));
});

test('PLAN-0643 V23: five concurrent `xihe status` calls converge on at most two logins', async (t) => {
  const cp = await startAuthMock();
  const token = tempTokenFile();
  t.after(async () => { await cp.close(); token.cleanup(); });
  const env = { ...cp.env, XIHE_CLI_TOKEN_FILE: token.file };

  // Same-process concurrency (the T1.5 shape): real-process children cannot run
  // HTTP inside the DSH sandbox (TCP connects but the data plane is swallowed),
  // so the contention proof runs five concurrent status commands against one
  // empty shared token file; the login() in-flight dedup must converge them.
  const results = await Promise.all(Array.from({ length: 5 }, () => runCommand(['status', '--json'], {
    env, promptSecret: noPrompt, stderr: sink(),
  })));

  assert.equal(results.every((result) => result.exitCode === 0), true, JSON.stringify(results.map((r) => r.error)));
  assert.ok(cp.state.loginRequests <= 2, `first-login contention must converge (got ${cp.state.loginRequests})`);
  const store = readTokenFile(token.file);
  assert.equal(Object.keys(store.tokens).length, 1);
  assert.deepEqual(fs.readdirSync(token.directory), ['cli-token.json'], 'no tmp residue');
});

test('PLAN-0643 V24: killing a concurrent token-store writer leaves a parseable store (old or new value)', async (t) => {
  const token = tempTokenFile();
  t.after(() => token.cleanup());
  const storeModule = pathToFileURL(path.resolve('scripts/xihe-cli/token-store.mjs')).href;
  const script = `
    import { persistToken } from ${JSON.stringify(storeModule)};
    for (let i = 0; i < 200; i += 1) {
      await persistToken({ XIHE_CLI_TOKEN_FILE: ${JSON.stringify(token.file)} }, {
        baseUrl: 'http://127.0.0.1:12631',
        token: 'v'.repeat(2000) + i,
        email: null,
        expiresAt: '2099-01-01T00:00:00.000Z',
        obtainedAt: '2026-01-01T00:00:00.000Z',
        platform: 'linux',
      });
      await new Promise((resolve) => setTimeout(resolve, 4));
    }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
  });

  // Wait until the first write has landed (bounded poll, no fixed sleep), then kill
  // mid-loop — the store must stay parseable (old or new value, never torn).
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(token.file) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(fs.existsSync(token.file), true, 'the writer must have completed at least one atomic write');
  child.kill('SIGKILL');
  const killed = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
  const outcome = await Promise.race([killed, new Promise((resolve) => setTimeout(() => resolve(null), 10_000))]);
  assert.ok(outcome, 'the child must die promptly after the kill');

  assert.equal(fs.existsSync(token.file), true, 'the loop writes long before the kill lands');
  const store = JSON.parse(fs.readFileSync(token.file, 'utf8'));
  assert.equal(store.version, 1);
  const entry = store.tokens['http://127.0.0.1:12631'];
  assert.match(entry.token, /^v{2000}\d+$/, 'the store holds either the old or the new value, fully written');
});

// ---------------------------------------------------------------------------
// PLAN-0643 M6-3 (T4.x, V47/V48/V49/V2): catalog reads, workspace write face,
// scheduled-task verbs, events tail, and the groups.added re-judge.
// Same-process only (runCommand + fake CP): child HTTP is a documented sandbox
// boundary; real-process acceptance belongs to the Lead (V13/V23 precedent).
// ---------------------------------------------------------------------------

async function startM63Mock() {
  const state = { loginRequests: 0, requests: [] };
  const record = (request, url, body) => state.requests.push({
    method: request.method,
    path: url.pathname,
    body: body ?? null,
    idempotencyKey: request.headers['idempotency-key'] ?? null,
    workspaceHeader: request.headers['x-workspace-id'] ?? null,
  });
  const hits = (method, path) => state.requests.filter((r) => r.method === method && r.path === path);
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const body = await requestBody(request);
    if (url.pathname === '/api/v1/auth/login' && request.method === 'POST') {
      state.loginRequests += 1;
      json(response, 200, { accessToken: 'test-access-token' });
      return;
    }
    if (url.pathname === '/api/v1/provider-catalog' && request.method === 'GET') {
      record(request, url, body);
      json(response, 200, {
        providers: { 'xiaomi:mimo': { displayName: 'MiMo', apiTypeId: 'openai-compat', apiTypeVersion: 1, operation: 'chat' } },
      });
      return;
    }
    if (url.pathname === '/api/v1/models' && request.method === 'GET') {
      record(request, url, body);
      json(response, 200, {
        providers: { 'conn-1': { connectionId: 'conn-1', providerId: 'xiaomi', connectionStatus: 'ready', models: ['model-a', 'model-b'] } },
        models: { xiaomi: ['model-a', 'model-b'] },
        configRevision: 'rev-7',
      });
      return;
    }
    if (url.pathname === '/api/v1/api-input-types' && request.method === 'GET') {
      record(request, url, body);
      json(response, 200, {
        types: [{
          apiTypeId: 'openai-compat', version: 1, operation: 'chat', method: 'POST',
          path: '/v1/chat/completions', requiredBaseSuffix: '',
          requestShape: {}, responseShape: {}, streamShape: {},
        }],
      });
      return;
    }
    if (url.pathname === '/api/v1/me/permissions' && request.method === 'GET') {
      record(request, url, body);
      json(response, 200, {
        userId: 'user-1',
        instanceCapabilities: ['chat.run', 'workspace.create'],
        instancePermissions: [{ atom: 'workspace:create', granted: true }],
        workspaces: [{ workspaceId: 'ws-1', role: 'OWNER', permissions: ['workspace:read'] }],
      });
      return;
    }
    if (url.pathname === '/api/v1/workspaces' && request.method === 'POST') {
      record(request, url, body);
      json(response, 201, {
        id: 'ws-new', name: body.name, storageMode: body.storageMode,
        hostPath: body.hostPath ?? null, roots: body.roots ?? null,
        executionMode: body.executionMode ?? null, generation: 1,
      });
      return;
    }
    if (url.pathname === '/api/v1/workspaces/ws-1' && request.method === 'DELETE') {
      record(request, url, body);
      response.writeHead(204);
      response.end();
      return;
    }
    if (url.pathname === '/api/v1/workspaces/ws-1/members' && request.method === 'GET') {
      record(request, url, body);
      json(response, 200, [{ userId: 'u-1', username: 'alice', role: 'OWNER', createdAt: '2026-11-06T00:00:00.000Z' }]);
      return;
    }
    if (url.pathname === '/api/v1/workspaces/ws-1/members' && request.method === 'POST') {
      record(request, url, body);
      json(response, 201, { userId: 'u-2', username: body.username, role: body.role, createdAt: '2026-11-06T00:00:00.000Z' });
      return;
    }
    if (url.pathname === '/api/v1/workspaces/ws-1/members/u-2' && request.method === 'PATCH') {
      record(request, url, body);
      json(response, 200, { userId: 'u-2', username: 'bob', role: body.role });
      return;
    }
    if (url.pathname === '/api/v1/workspaces/ws-1/members/u-2' && request.method === 'DELETE') {
      record(request, url, body);
      response.writeHead(204);
      response.end();
      return;
    }
    if (url.pathname === '/api/v1/workspaces/ws-1/roots' && request.method === 'POST') {
      record(request, url, body);
      json(response, 201, { id: 'root-2', position: 1, alias: body.alias ?? null });
      return;
    }
    if (url.pathname === '/api/v1/workspaces/ws-1/roots/root-2' && request.method === 'PATCH') {
      record(request, url, body);
      json(response, 200, { id: 'root-2', position: body.position ?? 0, alias: body.alias ?? null });
      return;
    }
    if (url.pathname === '/api/v1/workspaces/ws-1/roots/root-2' && request.method === 'DELETE') {
      record(request, url, body);
      response.writeHead(204);
      response.end();
      return;
    }
    if (url.pathname === '/api/v1/workspaces/ws-1/scheduled-tasks' && request.method === 'POST') {
      record(request, url, body);
      json(response, 201, {
        id: 'task-1', status: 'scheduled', triggerKind: body.triggerKind,
        cronExpr: body.cronExpr ?? null, nextFireAt: '2026-11-07T00:00:00.000Z',
      });
      return;
    }
    if (url.pathname === '/api/v1/workspaces/ws-1/scheduled-tasks/task-1' && request.method === 'DELETE') {
      record(request, url, body);
      json(response, 200, { taskId: 'task-1', status: 'cancelled', changed: true, task: null });
      return;
    }
    if (url.pathname === '/api/v1/workspaces/ws-1/scheduled-tasks/task-1/rerun' && request.method === 'POST') {
      record(request, url, body);
      json(response, 200, { id: 'task-1', status: 'scheduled', triggerKind: 'cron', nextFireAt: '2026-11-07T01:00:00.000Z' });
      return;
    }
    if (url.pathname === '/api/v1/workspaces/ws-1/scheduled-tasks/task-1/remove' && request.method === 'POST') {
      record(request, url, body);
      json(response, 200, { taskId: 'task-1', status: 'cancelled', changed: true });
      return;
    }
    if (url.pathname === '/api/v1/workspaces/ws-1/scheduled-tasks/task-1/postpone' && request.method === 'POST') {
      record(request, url, body);
      json(response, 200, { id: 'task-1', status: 'scheduled', triggerKind: 'delay_once', nextFireAt: body.at });
      return;
    }
    json(response, 404, { code: 'NOT_FOUND', detail: 'unknown endpoint' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const env = {
    XIHE_CP_PORT: String(server.address().port),
    XIHE_DEV_ADMIN_PASSWORD: TEST_PASSWORD,
    XIHE_WORKSPACE_ID: 'ws-1',
  };
  return {
    state, hits, env,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

const collectStdoutStream = () => {
  const stream = new PassThrough();
  stream.setEncoding('utf8');
  let text = '';
  stream.on('data', (chunk) => { text += chunk; });
  return { stream, text: () => text };
};

async function waitFor(predicate, { timeoutMs = 2000, stepMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return false;
}

async function startEventsSseMock({ status = 200, frames = [], closeAfter = true } = {}) {
  const state = { loginRequests: 0, lastSinceHeader: null, lastQuerySessionId: null };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/api/v1/auth/login' && request.method === 'POST') {
      state.loginRequests += 1;
      json(response, 200, { accessToken: 'test-access-token' });
      return;
    }
    if (url.pathname === '/api/v1/events' && request.method === 'GET') {
      state.lastSinceHeader = request.headers['last-event-id'] ?? null;
      state.lastQuerySessionId = url.searchParams.get('sessionId');
      if (status !== 200) {
        json(response, status, { code: 'SESSION_ACCESS_DENIED', message: 'not your session' });
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const frame of frames) {
        response.write(`event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`);
      }
      response.write(': transport heartbeat comment\n\n');
      if (closeAfter) response.end();
      return;
    }
    json(response, 404, { code: 'NOT_FOUND' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    state,
    env: { XIHE_CP_PORT: String(server.address().port), XIHE_DEV_ADMIN_PASSWORD: TEST_PASSWORD },
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

test('PLAN-0643 T4.1/V47: provider catalog and models return structured CP bodies', async (t) => {
  const cp = await startM63Mock();
  t.after(() => cp.close());

  const catalog = await runCommand(['provider', 'catalog', '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });
  assert.equal(catalog.exitCode, 0, JSON.stringify(catalog.error));
  assert.equal(catalog.data.kind, 'provider-catalog');
  assert.equal(catalog.data.providers['xiaomi:mimo'].displayName, 'MiMo');

  const models = await runCommand(['models', '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });
  assert.equal(models.exitCode, 0, JSON.stringify(models.error));
  assert.equal(models.data.kind, 'models');
  assert.equal(models.data.configRevision, 'rev-7');
  assert.deepEqual(models.data.providers['conn-1'].models, ['model-a', 'model-b']);
});

test('PLAN-0643 T4.1/V47: api-input-types list and me permissions return structured CP bodies', async (t) => {
  const cp = await startM63Mock();
  t.after(() => cp.close());

  const types = await runCommand(['api-input-types', 'list', '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });
  assert.equal(types.exitCode, 0, JSON.stringify(types.error));
  assert.equal(types.data.kind, 'api-input-types');
  assert.equal(types.data.types[0].apiTypeId, 'openai-compat');

  const me = await runCommand(['me', 'permissions', '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });
  assert.equal(me.exitCode, 0, JSON.stringify(me.error));
  assert.equal(me.data.kind, 'me-permissions');
  assert.equal(me.data.userId, 'user-1');
  assert.deepEqual(me.data.instanceCapabilities, ['chat.run', 'workspace.create']);
});

test('PLAN-0643 T4.1: models human face lists connections and model ids', async (t) => {
  const cp = await startM63Mock();
  t.after(() => cp.close());

  const result = await runCommand(['models'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });
  assert.equal(result.exitCode, 0, JSON.stringify(result.error));
  const human = captureStdout(() => printResult(result));
  assert.match(human, /^models: 1 connection\(s\), configRevision=rev-7\n/);
  assert.match(human, /conn-1\s+xiaomi\s+ready\s+models=2\n/);
  assert.match(human, /xiaomi: model-a, model-b\n/);
});

test('PLAN-0643 T4.3/V48: workspace create posts direct_attach body with idempotency key', async (t) => {
  const cp = await startM63Mock();
  t.after(() => cp.close());

  const result = await runCommand([
    'workspace', 'create', '--name', 'demo', '--storage-mode', 'direct_attach',
    '--host-path', 'C:/data/demo', '--idempotency-key', 'idem-1', '--json',
  ], { env: cp.env, promptSecret: noPrompt, stderr: sink() });
  assert.equal(result.exitCode, 0, JSON.stringify(result.error));
  assert.equal(result.data.kind, 'workspace-created');
  assert.equal(result.data.workspace.id, 'ws-new');

  const post = cp.hits('POST', '/api/v1/workspaces');
  assert.equal(post.length, 1);
  assert.deepEqual(post[0].body, {
    name: 'demo', storageMode: 'direct_attach', hostPath: 'C:/data/demo',
  });
  assert.equal(post[0].idempotencyKey, 'idem-1');
});

test('PLAN-0643 T4.3: workspace create warns before a managed_import call (docker frozen)', async (t) => {
  const cp = await startM63Mock();
  t.after(() => cp.close());

  const warnings = [];
  const stderr = { write: (chunk) => { warnings.push(String(chunk)); } };
  const result = await runCommand([
    'workspace', 'create', '--name', 'legacy', '--storage-mode', 'managed_import', '--json',
  ], { env: cp.env, promptSecret: noPrompt, stderr });
  assert.equal(result.exitCode, 0, JSON.stringify(result.error));
  const joined = warnings.join('');
  assert.match(joined, /docker workspace backend is frozen/);
  assert.match(joined, /direct_attach/);
  assert.equal(cp.hits('POST', '/api/v1/workspaces').length, 1);
});

test('PLAN-0643 T4.3: workspace create rejects direct_attach without a location (usage, no request)', async (t) => {
  const cp = await startM63Mock();
  t.after(() => cp.close());

  const result = await runCommand([
    'workspace', 'create', '--name', 'demo', '--storage-mode', 'direct_attach', '--json',
  ], { env: cp.env, promptSecret: noPrompt, stderr: sink() });
  assert.equal(result.exitCode, 2);
  assert.equal(result.error.code, 'INVALID_ARGUMENT');
  assert.equal(cp.state.requests.length, 0, 'no CP call may leave the CLI before validation');
});

test('PLAN-0643 T4.3/V48: workspace delete requires --yes in a non-interactive session', async (t) => {
  const cp = await startM63Mock();
  t.after(() => cp.close());

  const denied = await runCommand(['workspace', 'delete', 'ws-1', '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });
  assert.equal(denied.exitCode, 1);
  assert.equal(denied.error.code, 'CONFIRMATION_REQUIRED');
  assert.equal(cp.hits('DELETE', '/api/v1/workspaces/ws-1').length, 0);

  const ok = await runCommand(['workspace', 'delete', 'ws-1', '--yes', '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });
  assert.equal(ok.exitCode, 0, JSON.stringify(ok.error));
  assert.equal(ok.data.kind, 'workspace-deleted');
  assert.equal(cp.hits('DELETE', '/api/v1/workspaces/ws-1').length, 1);
});

test('PLAN-0643 T4.3/V48: workspace members read/add/role/remove hit the expected method+path', async (t) => {
  const cp = await startM63Mock();
  t.after(() => cp.close());

  const list = await runCommand(['workspace', 'members', 'ws-1', '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });
  assert.equal(list.exitCode, 0, JSON.stringify(list.error));
  assert.equal(list.data.kind, 'workspace-members');
  assert.equal(list.data.items[0].role, 'OWNER');

  const added = await runCommand([
    'workspace', 'members', 'ws-1', '--add', 'bob', '--role', 'EDITOR', '--json',
  ], { env: cp.env, promptSecret: noPrompt, stderr: sink() });
  assert.equal(added.exitCode, 0, JSON.stringify(added.error));
  assert.equal(added.data.kind, 'workspace-member');
  assert.equal(added.data.action, 'add');

  const role = await runCommand([
    'workspace', 'members', 'ws-1', '--set-role', 'u-2', '--role', 'VIEWER', '--json',
  ], { env: cp.env, promptSecret: noPrompt, stderr: sink() });
  assert.equal(role.exitCode, 0, JSON.stringify(role.error));
  assert.equal(role.data.action, 'role');

  const removed = await runCommand([
    'workspace', 'members', 'ws-1', '--remove', 'u-2', '--yes', '--json',
  ], { env: cp.env, promptSecret: noPrompt, stderr: sink() });
  assert.equal(removed.exitCode, 0, JSON.stringify(removed.error));
  assert.equal(removed.data.action, 'remove');

  assert.deepEqual(cp.hits('GET', '/api/v1/workspaces/ws-1/members').length, 1);
  const post = cp.hits('POST', '/api/v1/workspaces/ws-1/members')[0];
  assert.deepEqual(post.body, { username: 'bob', role: 'EDITOR' });
  assert.equal(post.workspaceHeader, 'ws-1');
  const patch = cp.hits('PATCH', '/api/v1/workspaces/ws-1/members/u-2')[0];
  assert.deepEqual(patch.body, { role: 'VIEWER' });
  assert.equal(cp.hits('DELETE', '/api/v1/workspaces/ws-1/members/u-2').length, 1);
});

test('PLAN-0643 T4.3/V48: workspace roots write verbs hit the expected method+path', async (t) => {
  const cp = await startM63Mock();
  t.after(() => cp.close());

  const bare = await runCommand(['workspace', 'roots', 'ws-1', '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });
  assert.equal(bare.exitCode, 2, 'roots without a write flag is a usage error (reads ride workspace get)');

  const added = await runCommand([
    'workspace', 'roots', 'ws-1', '--add', 'C:/data/extra', '--alias', 'extra', '--json',
  ], { env: cp.env, promptSecret: noPrompt, stderr: sink() });
  assert.equal(added.exitCode, 0, JSON.stringify(added.error));
  assert.equal(added.data.kind, 'workspace-root');

  const renamed = await runCommand([
    'workspace', 'roots', 'ws-1', '--rename', 'root-2', '--alias', 'renamed', '--json',
  ], { env: cp.env, promptSecret: noPrompt, stderr: sink() });
  assert.equal(renamed.exitCode, 0, JSON.stringify(renamed.error));

  const moved = await runCommand([
    'workspace', 'roots', 'ws-1', '--reposition', 'root-2', '--position', '3', '--json',
  ], { env: cp.env, promptSecret: noPrompt, stderr: sink() });
  assert.equal(moved.exitCode, 0, JSON.stringify(moved.error));

  const removed = await runCommand([
    'workspace', 'roots', 'ws-1', '--remove', 'root-2', '--yes', '--json',
  ], { env: cp.env, promptSecret: noPrompt, stderr: sink() });
  assert.equal(removed.exitCode, 0, JSON.stringify(removed.error));

  const post = cp.hits('POST', '/api/v1/workspaces/ws-1/roots')[0];
  assert.deepEqual(post.body, { path: 'C:/data/extra', alias: 'extra' });
  assert.equal(cp.hits('PATCH', '/api/v1/workspaces/ws-1/roots/root-2').length, 2);
  assert.equal(cp.hits('DELETE', '/api/v1/workspaces/ws-1/roots/root-2').length, 1);
});

test('PLAN-0643 T4.5/V48: scheduled-task create posts the session_wakeup cron body', async (t) => {
  const cp = await startM63Mock();
  t.after(() => cp.close());

  const result = await runCommand([
    'scheduled-task', 'create', 'ws-1',
    '--kind', 'cron', '--cron-expr', '0 9 * * *',
    '--target', 'session_wakeup', '--session', 'session-9', '--prompt', 'morning brief', '--json',
  ], { env: cp.env, promptSecret: noPrompt, stderr: sink() });
  assert.equal(result.exitCode, 0, JSON.stringify(result.error));
  assert.equal(result.data.kind, 'scheduled-task');
  assert.equal(result.data.task.id, 'task-1');

  const post = cp.hits('POST', '/api/v1/workspaces/ws-1/scheduled-tasks')[0];
  assert.equal(post.workspaceHeader, 'ws-1');
  assert.deepEqual(post.body, {
    triggerKind: 'cron', cronExpr: '0 9 * * *',
    targetKind: 'session_wakeup', targetSessionId: 'session-9', prompt: 'morning brief',
  });
});

test('PLAN-0643 T4.5/V48: scheduled-task create job_dispatch reads the payload file', async (t) => {
  const cp = await startM63Mock();
  t.after(() => cp.close());
  const payloadFile = path.join(tmpdir(), `xh-payload-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`);
  fs.writeFileSync(payloadFile, JSON.stringify({ jobId: 'job-7', action: 'export' }));
  t.after(() => fs.rmSync(payloadFile, { force: true }));

  const result = await runCommand([
    'scheduled-task', 'create', 'ws-1',
    '--kind', 'delay_once', '--at', '2026-11-07T09:00:00Z', '--timezone', 'UTC',
    '--target', 'job_dispatch', '--payload-file', payloadFile, '--json',
  ], { env: cp.env, promptSecret: noPrompt, stderr: sink() });
  assert.equal(result.exitCode, 0, JSON.stringify(result.error));

  const post = cp.hits('POST', '/api/v1/workspaces/ws-1/scheduled-tasks')[0];
  assert.deepEqual(post.body, {
    triggerKind: 'delay_once', at: '2026-11-07T09:00:00Z', timezone: 'UTC',
    targetKind: 'job_dispatch', payload: { jobId: 'job-7', action: 'export' },
  });
});

test('PLAN-0643 T4.5/V48: scheduled-task rerun/remove/postpone/delete hit the expected method+path', async (t) => {
  const cp = await startM63Mock();
  t.after(() => cp.close());
  const base = '/api/v1/workspaces/ws-1/scheduled-tasks/task-1';

  const rerun = await runCommand(['scheduled-task', 'rerun', 'ws-1', 'task-1', '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });
  assert.equal(rerun.exitCode, 0, JSON.stringify(rerun.error));
  assert.equal(rerun.data.kind, 'scheduled-task', 'rerun answers with the rescheduled task');

  const postpone = await runCommand([
    'scheduled-task', 'postpone', 'ws-1', 'task-1', '--at', '2026-11-08T00:00:00Z', '--json',
  ], { env: cp.env, promptSecret: noPrompt, stderr: sink() });
  assert.equal(postpone.exitCode, 0, JSON.stringify(postpone.error));

  const removed = await runCommand(['scheduled-task', 'remove', 'ws-1', 'task-1', '--yes', '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });
  assert.equal(removed.exitCode, 0, JSON.stringify(removed.error));

  const deleted = await runCommand(['scheduled-task', 'delete', 'ws-1', 'task-1', '--yes', '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });
  assert.equal(deleted.exitCode, 0, JSON.stringify(deleted.error));

  assert.equal(cp.hits('POST', `${base}/rerun`).length, 1);
  const postponeHit = cp.hits('POST', `${base}/postpone`)[0];
  assert.deepEqual(postponeHit.body, { at: '2026-11-08T00:00:00Z' });
  assert.equal(cp.hits('POST', `${base}/remove`).length, 1);
  assert.equal(cp.hits('DELETE', base).length, 1);
});

test('PLAN-0643 T4.5/V48: scheduled-task remove without --yes asks nothing and sends nothing', async (t) => {
  const cp = await startM63Mock();
  t.after(() => cp.close());

  const denied = await runCommand(['scheduled-task', 'remove', 'ws-1', 'task-1', '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });
  assert.equal(denied.exitCode, 1);
  assert.equal(denied.error.code, 'CONFIRMATION_REQUIRED');
  assert.equal(cp.hits('POST', '/api/v1/workspaces/ws-1/scheduled-tasks/task-1/remove').length, 0);
});

test('PLAN-0643 T4.6/V49: events tail drains a closing stream line-by-line and exits 0', async (t) => {
  const cp = await startEventsSseMock({
    frames: [
      { event: 'token', data: { text: 'hello' } },
      { event: 'run.completed', data: { runId: 'run-1' } },
    ],
    closeAfter: true,
  });
  t.after(() => cp.close());
  const output = collectStdoutStream();

  const result = await runCommand(['events', 'tail', 'session-1', '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(), stdout: output.stream,
  });
  assert.equal(result.exitCode, 0, JSON.stringify(result.error));
  assert.equal(result.data.kind, 'events-tail');
  assert.equal(result.data.events, 2, 'both SSE frames are delivered before the close');

  const lines = output.text().split('\n').filter(Boolean);
  assert.equal(lines.length, 2, 'each event is exactly one JSON line');
  assert.deepEqual(JSON.parse(lines[0]), { event: 'token', data: { text: 'hello' } });
  assert.deepEqual(JSON.parse(lines[1]), { event: 'run.completed', data: { runId: 'run-1' } });
});

test('PLAN-0643 T4.6/V49: events tail --follow exits 0 on Ctrl-C (injected signal)', async (t) => {
  const cp = await startEventsSseMock({
    frames: [{ event: 'token', data: { text: 'first' } }],
    closeAfter: false,
  });
  t.after(() => cp.close());
  const output = collectStdoutStream();
  const tailController = new AbortController();

  const pending = runCommand(['events', 'tail', 'session-1', '--follow', '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(), stdout: output.stream,
    tailSignal: tailController.signal,
  });
  const gotFirst = await waitFor(() => output.text().includes('"event":"token"'));
  assert.equal(gotFirst, true, 'the first frame must arrive before the interrupt');
  tailController.abort();

  const result = await pending;
  assert.equal(result.exitCode, 0, 'SIGINT during follow is a clean exit 0');
  assert.equal(result.data.kind, 'events-tail');
  assert.equal(result.data.follow, true);
});

test('PLAN-0643 T4.6/V49: events tail passes --since as Last-Event-ID and 403 fails closed', async (t) => {
  const ok = await startEventsSseMock({
    frames: [{ event: 'token', data: { text: 'resumed' } }],
    closeAfter: true,
  });
  t.after(() => ok.close());
  const output = collectStdoutStream();
  const resumed = await runCommand(['events', 'tail', 'session-1', '--since', 'evt-41', '--json'], {
    env: ok.env, promptSecret: noPrompt, stderr: sink(), stdout: output.stream,
  });
  assert.equal(resumed.exitCode, 0, JSON.stringify(resumed.error));
  assert.equal(ok.state.lastSinceHeader, 'evt-41');
  assert.equal(ok.state.lastQuerySessionId, 'session-1');

  const denied = await startEventsSseMock({ status: 403 });
  t.after(() => denied.close());
  const failure = await runCommand(['events', 'tail', 'session-1', '--json'], {
    env: denied.env, promptSecret: noPrompt, stderr: sink(),
  });
  assert.equal(failure.exitCode, 1);
  assert.equal(failure.error.code, 'SESSION_ACCESS_DENIED', 'the CP problem code passes through');
});

test('PLAN-0643 T4.6: events tail usage errors stay exit 2', async (t) => {
  const cp = await startEventsSseMock({ frames: [], closeAfter: true });
  t.after(() => cp.close());

  const missing = await runCommand(['events', 'tail', '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });
  assert.equal(missing.exitCode, 2);
  assert.equal(missing.error.code, 'INVALID_ARGUMENT');

  const badTimeout = await runCommand(['events', 'tail', 'session-1', '--timeout', 'soon', '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });
  assert.equal(badTimeout.exitCode, 2);
  assert.equal(badTimeout.error.code, 'INVALID_ARGUMENT');
});

test('PLAN-0643 V2 re-judge: coverage groups.added counts >= 12 via new groups + extensions', async (t) => {
  const coverageScript = path.resolve('scripts/xihe-cli/coverage.mjs');
  const child = spawnSync(process.execPath, [coverageScript, '--json'], {
    cwd: process.cwd(), encoding: 'utf8', windowsHide: true, timeout: 30_000,
  });
  assert.equal(child.status, 0, child.stderr);
  const report = JSON.parse(child.stdout);
  assert.equal(report.groups.added.present >= 12, true,
    `groups.added.present must reach 12 (got ${report.groups.added.present})`);
  assert.deepEqual(report.groups.added.names,
    ['auth', 'api', 'config-locks', 'me', 'models', 'api-input-types', 'events']);
  const extensions = Object.fromEntries(report.groups.added.extensions.map((row) => [row.group, row.via]));
  assert.deepEqual(extensions, {
    config: 'config put', chat: 'chat run', session: 'session export',
    provider: 'provider catalog', workspace: 'workspace create',
    'scheduled-task': 'scheduled-task create',
  });
  assert.equal(report.matrix.covered, report.matrix.total, 'the whole matrix must be present');
});
