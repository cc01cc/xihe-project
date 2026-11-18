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
import { acquireLoginLock, loginLockPath } from './xihe-cli/login-lock.mjs';
import { HELP_GROUPS } from './xihe-cli/help.mjs';
import { login, promptSecret, readResponseText } from './xihe-cli/provider.mjs';
import { clearToken, readStore } from './xihe-cli/token-store.mjs';
import { applySetToEnv, applyUrlSyncToEnv, parseStackSetArgs } from './lib/stack-set.mjs';
import { createReceipt, validateReceipt } from './lib/gate-receipt.mjs';
import {
  DRIVE_GATE,
  buildDriveReceipt,
  driveReceiptDir,
  isDriveFakeGreen,
  pollRunToTerminal,
  validateDriveReceipt,
  writeDriveReceipt,
} from './xihe-cli/drive.mjs';
import { resolveSessionBinding } from './xihe-cli/session-binding.mjs';

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
    connectionKey: 'default',
    hasKey: true,
    maskedKey: '****alue',
    enabled: true,
    // task-50: the mock mirrors CP's uppercase enum (ProviderConnection.STATUS_VERIFYING).
    // It used to say 'verifying', which made the fixtures agree with the CLI's lowercase bug.
    status: 'VERIFYING',
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
      // Mirrors CP: ProviderConnectionService.requireConnectionKey rejects a missing or malformed
      // key with this exact code. Keeping the mock faithful is what makes the CLI tests able to
      // catch the defect this fix removes -- a lenient mock would have stayed green.
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(body.connectionKey ?? '')) {
        json(response, 400, { code: 'PROVIDER_CONNECTION_KEY_INVALID', detail: 'invalid key; must not be printed' });
        return;
      }
      if (state.connections.some((item) => item.providerId === body.providerId
        && item.scope === body.scope && item.connectionKey === body.connectionKey)) {
        json(response, 409, { code: 'PROVIDER_CONNECTION_KEY_CONFLICT', detail: 'duplicate key; must not be printed' });
        return;
      }
      if (body.apiKey !== TEST_KEY) {
        json(response, 400, { code: 'PROVIDER_CONNECTION_INVALID', detail: 'Invalid key; must not be printed' });
        return;
      }
      const catalogDefaults = { xiaomi: 'remote-models', 'volcengine-ark': 'manual' };
      state.lastCreateBody = body;
      const connection = createView('connection-1', {
        connectionKey: body.connectionKey,
        providerId: body.providerId,
        label: body.label,
        modelDiscovery: body.modelDiscovery ?? catalogDefaults[body.providerId],
        manualModels: body.manualModels,
        status: 'VERIFYING',
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
      Object.assign(connection, body, { revision: connection.revision + 1, status: 'VERIFYING' });
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
        // CP maps any non-CREDENTIALS_INVALID verify failure to UNREACHABLE (markVerificationFailure),
        // never to 'failed' - another fixture value the real CP does not use.
        Object.assign(connection, { status: 'UNREACHABLE', lastErrorCode: 'LLM_MODEL_CATALOG_INVALID' });
        json(response, 200, { connection, models: [] });
        return;
      }
      Object.assign(connection, { status: 'READY', lastErrorCode: null, lastVerifiedAt: '2026-10-02T00:00:00Z' });
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
  assert.equal(result.data.connection.status, 'READY');
  assert.equal(cp.state.createRequests, 1);
  assert.equal(cp.state.verifyRequests, 1);
  assert.equal(JSON.stringify(result).includes(TEST_KEY), false);

  const listed = await runCommand(['provider', 'list', '--scope', 'USER'], { env: cp.env, promptSecret: noPrompt });
  assert.equal(listed.exitCode, 0);
  assert.equal(listed.data.connections[0].id, 'connection-1');
  assert.equal(JSON.stringify(listed).includes(TEST_KEY), false);

  const verified = await runCommand(['provider', 'verify', 'connection-1'], { env: cp.env, promptSecret: noPrompt });
  assert.equal(verified.exitCode, 0);
  assert.equal(verified.data.connection.status, 'READY');
  assert.equal(cp.state.verifyRequests, 2);
});

test('provider add sends the default connection key so CP accepts the create', async (t) => {
  const cp = await startCpMock();
  t.after(cp.close);
  const result = await runCommand([
    'provider', 'add', 'xiaomi', '--scope', 'USER', '--label', 'XH local MiMo', '--api-key-env', 'XIHE_XIAOMI_API_KEY',
  ], { env: cp.env, promptSecret: noPrompt });

  assert.equal(result.exitCode, 0);
  assert.equal(result.data.action, 'created-and-verified');
  // The regression this pins: the body used to omit connectionKey entirely, so CP answered 400
  // PROVIDER_CONNECTION_KEY_INVALID for every provider and no CLI create could ever succeed.
  assert.equal(cp.state.lastCreateBody.connectionKey, 'default');
  assert.equal(cp.state.connections[0].connectionKey, 'default');
});

test('provider add sends an explicit connection key and lists it', async (t) => {
  const cp = await startCpMock();
  t.after(cp.close);
  const result = await runCommand([
    'provider', 'add', 'xiaomi', '--scope', 'USER', '--label', 'XH local MiMo',
    '--api-key-env', 'XIHE_XIAOMI_API_KEY', '--connection-key', 'my-key',
  ], { env: cp.env, promptSecret: noPrompt });

  assert.equal(result.exitCode, 0);
  assert.equal(cp.state.lastCreateBody.connectionKey, 'my-key');
  const listed = await runCommand(['provider', 'list', '--scope', 'USER'], { env: cp.env, promptSecret: noPrompt });
  assert.equal(listed.exitCode, 0);
  assert.equal(listed.data.connections[0].connectionKey, 'my-key');
});

test('provider add rejects an illegal connection key locally, before sending any request', async (t) => {
  const cp = await startCpMock();
  t.after(cp.close);
  for (const bad of ['My-Key', 'has space', '', 'key_', '-lead']) {
    const args = [
      'provider', 'add', 'xiaomi', '--scope', 'USER', '--label', 'XH local MiMo',
      '--api-key-env', 'XIHE_XIAOMI_API_KEY', '--connection-key', bad,
    ];
    const result = await runCommand(args, { env: cp.env, promptSecret: noPrompt });
    assert.equal(result.exitCode, 2, `expected usage exit for ${JSON.stringify(bad)}`);
    assert.equal(result.error.code, 'INVALID_ARGUMENT');
  }
  // Usage errors must not touch the network at all: no catalog, no create, no list.
  assert.equal(cp.state.createRequests, 0);
  assert.equal(cp.state.catalogRequests, 0);
  assert.equal(cp.state.listRequests, 0);
});

test('provider add surfaces a duplicate connection key as its own error and suggests the flag', async (t) => {
  const cp = await startCpMock();
  t.after(cp.close);
  const first = await runCommand([
    'provider', 'add', 'xiaomi', '--scope', 'USER', '--label', 'XH local MiMo', '--api-key-env', 'XIHE_XIAOMI_API_KEY',
  ], { env: cp.env, promptSecret: noPrompt });
  assert.equal(first.exitCode, 0);

  const duplicate = await runCommand([
    'provider', 'add', 'xiaomi', '--scope', 'USER', '--label', 'Second MiMo', '--api-key-env', 'XIHE_XIAOMI_API_KEY',
  ], { env: cp.env, promptSecret: noPrompt });
  assert.equal(duplicate.exitCode, 1);
  assert.equal(duplicate.error.code, 'PROVIDER_CONNECTION_KEY_CONFLICT');
  // Never silently rename: the message must name the flag, and the key must be unchanged on the record.
  assert.equal(duplicate.error.message.includes('--connection-key'), true);
  assert.equal(cp.state.connections.length, 1);
  assert.equal(cp.state.connections[0].connectionKey, 'default');

  const distinct = await runCommand([
    'provider', 'add', 'xiaomi', '--scope', 'USER', '--label', 'Second MiMo',
    '--api-key-env', 'XIHE_XIAOMI_API_KEY', '--connection-key', 'second',
  ], { env: cp.env, promptSecret: noPrompt });
  assert.equal(distinct.exitCode, 0);
  assert.equal(cp.state.connections.length, 2);
});

test('provider update refuses to change the connection key and says why', async (t) => {
  const cp = await startCpMock();
  t.after(cp.close);
  cp.state.connections.push(createView('connection-1'));
  const result = await runCommand([
    'provider', 'update', 'connection-1', '--label', 'Renamed', '--connection-key', 'other',
  ], { env: cp.env, promptSecret: noPrompt });

  // CP answers KeyImmutableException for any key change, so the CLI must refuse locally rather
  // than send a PATCH that can only fail.
  assert.equal(result.exitCode, 2);
  assert.equal(result.error.code, 'INVALID_ARGUMENT');
  assert.equal(result.error.message.includes('immutable'), true);
  assert.equal(cp.state.patchRequests, 0);
});

test('dev init sends the default connection key too', async (t) => {
  const cp = await startCpMock();
  t.after(cp.close);
  const result = await runCommand([
    'dev', 'init', '--provider', 'xiaomi', '--scope', 'USER', '--label', 'XH local MiMo', '--api-key-env', 'XIHE_XIAOMI_API_KEY',
  ], { env: cp.env, promptSecret: noPrompt });

  assert.equal(result.exitCode, 0);
  assert.equal(result.data.action, 'created-and-verified');
  assert.equal(cp.state.lastCreateBody.connectionKey, 'default');
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
  assert.equal(cp.state.connections[0].status, 'READY');
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
  assert.equal(result.data.connection.status, 'READY');
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
  // The mock now answers like CP: a second create on the same provider+scope+key is a 409
  // KEY_CONFLICT (not a generic 400), so the CLI names that conflict and points at the flag.
  assert.equal(duplicate.error.code, 'PROVIDER_CONNECTION_KEY_CONFLICT');
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
          connection: createView('connection-1', { status: 'UNREACHABLE', lastErrorCode: providerErrorCode }),
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

// task-50: the defect this pins was a casing bug, not a missing key. CP answers `status: READY`
// (ProviderConnection.STATUS_READY, openapi ProviderConnectionView enum) while this module
// compared against lowercase 'ready', so every successful verify was reported as a failure and
// `provider list` disagreed with `provider verify` about the same record. These tests state the
// contract's uppercase values directly; the fixtures used to mirror the CLI's mistake, which is
// precisely why the whole suite stayed green while the bug shipped.
test('provider verify accepts the contract READY status (uppercase), so list and verify agree', async (t) => {
  const cp = await startCpMock();
  t.after(cp.close);
  const added = await runCommand([
    'provider', 'add', 'xiaomi', '--scope', 'USER', '--label', 'XH local MiMo', '--api-key-env', 'XIHE_XIAOMI_API_KEY',
  ], { env: cp.env, promptSecret: noPrompt });

  // create+verify already succeeded; the point is that the CLI must report it as success.
  assert.equal(added.exitCode, 0);
  assert.equal(added.data.connection.status, 'READY');

  const verified = await runCommand(['provider', 'verify', 'connection-1'], { env: cp.env, promptSecret: noPrompt });
  assert.equal(verified.exitCode, 0);
  assert.equal(verified.data.connection.status, 'READY');

  // Criterion 4: both readings of the same connection must agree.
  const listed = await runCommand(['provider', 'list', '--scope', 'USER'], { env: cp.env, promptSecret: noPrompt });
  assert.equal(listed.exitCode, 0);
  assert.equal(listed.data.connections[0].status, verified.data.connection.status);
});

test('provider verify fails on every non-READY status in the contract enum, naming the status', async (t) => {
  const cp = await startCpMock();
  t.after(cp.close);
  await runCommand([
    'provider', 'add', 'xiaomi', '--scope', 'USER', '--label', 'XH local MiMo', '--api-key-env', 'XIHE_XIAOMI_API_KEY',
  ], { env: cp.env, promptSecret: noPrompt });

  // Closed enumeration of CP's non-READY states. VERIFYING is the one that matters most: it is a
  // non-terminal state, and a comparator written as `status !== 'ready' && status !== 'verifying'`
  // (or any future allow-list) would silently swallow it. Equivalence must be exact.
  const failures = [
    { status: 'UNVERIFIED', lastErrorCode: null },
    { status: 'VERIFYING', lastErrorCode: null },
    { status: 'INVALID_CREDENTIALS', lastErrorCode: 'LLM_CREDENTIALS_INVALID' },
    { status: 'UNREACHABLE', lastErrorCode: 'LLM_PROVIDER_UNREACHABLE' },
    { status: 'DISABLED', lastErrorCode: null },
  ];
  for (const failure of failures) {
    const fetchImpl = async (url, options) => {
      if (String(url).endsWith('/connection-1/verify') && options.method === 'POST') {
        return new Response(JSON.stringify({
          connection: createView('connection-1', failure),
          models: [],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return fetch(url, options);
    };
    const result = await runCommand(['provider', 'verify', 'connection-1'], { env: cp.env, fetchImpl, promptSecret: noPrompt });
    assert.equal(result.exitCode, 1, `${failure.status} must be reported as a failure`);
    assert.equal(result.error.code, 'PROVIDER_VERIFY_FAILED', `${failure.status} must fail on the verify step`);
    // The message has to name the status; otherwise a user cannot tell which state it stopped in.
    assert.equal(result.error.message.includes(`status=${failure.status}`), true,
      `message must name the observed status, got: ${result.error.message}`);
    assert.equal(JSON.stringify(result).includes(TEST_KEY), false);
  }
});

test('provider add fails with the credential status when CP rejects the key at verify time', async (t) => {
  const cp = await startCpMock();
  t.after(cp.close);
  // Wrong-key leg, modelled on the real chain: CP stores whatever key it is given and only
  // discovers the key is bad when /verify calls the provider's /models endpoint and gets 401,
  // which maps to INVALID_CREDENTIALS + LLM_CREDENTIALS_INVALID (ProviderConnectionService
  // .markVerificationFailure). The create itself still returns 201, so the CLI must fail on the
  // verify step - and it must never degrade into 'created-and-verified'.
  const badKey = 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const fetchImpl = async (url, options) => {
    if (String(url).endsWith('/api/v1/provider-connections') && options.method === 'POST') {
      const created = createView('connection-1', { status: 'VERIFYING' });
      cp.state.connections.push(created);
      return new Response(JSON.stringify(created), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }
    if (String(url).endsWith('/connection-1/verify') && options.method === 'POST') {
      const failed = { ...cp.state.connections[0], status: 'INVALID_CREDENTIALS', lastErrorCode: 'LLM_CREDENTIALS_INVALID' };
      return new Response(JSON.stringify({ connection: failed, models: [] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return fetch(url, options);
  };
  const result = await runCommand([
    'provider', 'add', 'xiaomi', '--scope', 'USER', '--label', 'XH local MiMo',
    '--api-key-env', 'XIHE_XIAOMI_API_KEY',
  ], { env: { ...cp.env, XIHE_XIAOMI_API_KEY: badKey }, fetchImpl, promptSecret: noPrompt });

  assert.equal(result.exitCode, 1);
  assert.notEqual(result.data?.action, 'created-and-verified');
  assert.equal(result.error.code, 'PROVIDER_VERIFY_FAILED');
  assert.equal(result.error.details.providerErrorCode, 'LLM_CREDENTIALS_INVALID');
  // Criterion 2: the credential-class status must be named, not swallowed into a generic failure.
  assert.equal(result.error.message.includes('status=INVALID_CREDENTIALS'), true,
    `message must name INVALID_CREDENTIALS, got: ${result.error.message}`);
  assert.equal(result.error.message.includes('lastErrorCode=LLM_CREDENTIALS_INVALID'), true,
    `message must name the provider error code, got: ${result.error.message}`);
  // Credential hygiene: neither the bad key nor the real one may reach the output.
  assert.equal(JSON.stringify(result).includes(badKey), false);
  assert.equal(JSON.stringify(result).includes(TEST_KEY), false);
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
  // task-38（Q1=b）：verify 不再 create+bind，只复用显式/只读发现的行 ⇒ 默认给一个已绑定可用行供发现。
  existingPrincipal = 'principal-existing',
  // task-38: 真 CP GET /workspaces/{id}/agents 回 {agents:[WorkspaceAgentView]}（含 bound/disabled）。
  // null ⇒ 用 existingPrincipal + 探针行合成默认 envelope；非 null ⇒ 原样返回（发现负例/回落腿用）。
  wsAgentsFace = null,
  // task-38: 回落面 GET /agent-principals?workspaceId=…（reach ∪ owned，无 bound 旗标，有 disabledAt）。
  principalsFace = { status: 200, body: { principals: [] } },
  // task-38: 建会话被 CP 拒（403 未绑/409 停用/404 不存在）⇒ 可读原因腿用。
  sessionCreateReject = null,
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
  const state = { calls: [], runIndex: 0, createdPrincipals: [], boundPrincipals: new Set(), workspaceAgentsGets: 0 };
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
      // task-38: 真 CP 契约形 = {agents:[WorkspaceAgentView]}（openapi.yaml:7201，required 含 bound/disabled）。
      // 旧 mock 回裸数组 ⇒ verify 旧发现块 Array.isArray(bound.body) 在真栈恒失败=假绿源头；此处同步真形状。
      // wsAgentsFace 覆盖只作用于**首次** GET（A4 发现）；A5 探活仍需读自己新建的行，用下面默认合成逻辑。
      if (wsAgentsFace && state.workspaceAgentsGets === 0) {
        state.workspaceAgentsGets += 1;
        json(response, wsAgentsFace.status, wsAgentsFace.body);
        return;
      }
      state.workspaceAgentsGets = (state.workspaceAgentsGets ?? 0) + 1;
      // V4 reach semantics (PLAN-0750 M2): the pre-existing row plus lifecycle-probe rows.
      // A user-door PERSONAL probe row stays visible unbound (source=personal, three-source merge
      // in this fake); a workspace-door row is visible only while bound (source=workspace).
      // task-38: 预存行按「已绑定可用」建模（bound:true, disabled:false），供只读发现取用。
      const agents = existingPrincipal
        ? [{ principalId: existingPrincipal, name: 'pre-existing', bound: true, disabled: false, permissionsSnapshot: [] }]
        : [];
      for (const row of state.createdPrincipals) {
        if (row.personal) {
          agents.push({ principalId: row.principalId, source: 'personal', bound: state.boundPrincipals.has(row.principalId), disabled: false });
        } else if (state.boundPrincipals.has(row.principalId)) {
          agents.push({ principalId: row.principalId, source: 'workspace', bound: true, disabled: false });
        }
      }
      json(response, 200, { agents });
      return;
    }
    if (pathname === '/api/v1/agent-principals' && request.method === 'GET') {
      // task-38: 回落面 GET /agent-principals?workspaceId=…（reach ∪ owned，无 bound 旗标，有 disabledAt）。
      // D-174: 已废止 scope query ⇒ 400（防旧口径复活）；真 CP 忽略未知 query，此 fake 故意更严。
      if (url.searchParams.has('scope')) {
        json(response, 400, { code: 'INVALID_REQUEST', detail: 'scope retired (D-174)' });
        return;
      }
      json(response, principalsFace.status, principalsFace.body);
      return;
    }
    if (pathname === '/api/v1/agent-principals' && request.method === 'POST') {
      // D-174 strict wire gate mirror: the retired scope key is a 400, like the real CP.
      if (body && Object.hasOwn(body, 'scope')) {
        json(response, 400, { code: 'INVALID_REQUEST', detail: 'scope retired (D-174)' });
        return;
      }
      // Door semantics: X-Workspace-Id header ⇒ workspace-tier row; no header ⇒ user-level
      // (personal) row. The A5 probes rely on this distinction for visibility. The tier-A
      // create keeps the historical 'principal-new' id; probe rows get suffixed ids.
      const personal = !request.headers['x-workspace-id'];
      const isProbe = String(body?.name ?? '').startsWith('xihe-verify-personal-')
        || String(body?.name ?? '').startsWith('xihe-verify-workspace-');
      const principalId = isProbe ? `principal-probe-${state.createdPrincipals.length + 1}` : 'principal-new';
      state.createdPrincipals.push({ principalId, personal });
      json(response, 201, { principalId, name: body?.name, ownership: 'USER', ownerUserId: null });
      return;
    }
    const wsAgentBind = pathname.match(/^\/api\/v1\/workspaces\/ws-1\/agents\/([^/]+)$/);
    if (wsAgentBind && request.method === 'PUT') {
      const principalId = decodeURIComponent(wsAgentBind[1]);
      state.boundPrincipals.add(principalId);
      json(response, 200, { principalId, workspaceId: 'ws-1', permissions: [] });
      return;
    }
    if (wsAgentBind && request.method === 'DELETE') {
      state.boundPrincipals.delete(decodeURIComponent(wsAgentBind[1]));
      response.writeHead(204);
      response.end();
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
      // task-38: B3 契约镜像——缺 principal ⇒ 400（SessionService.java:248 同款 problem）。
      if (typeof body?.agentPrincipalId !== 'string' || body.agentPrincipalId.trim() === '') {
        json(response, 400, { code: 'INVALID_REQUEST', detail: 'agentPrincipalId is required' });
        return;
      }
      if (sessionCreateReject) {
        json(response, sessionCreateReject.status, sessionCreateReject.body);
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
  // task-38（Q1=b）：verify 只复用只读发现的 principal，不再 create+bind ⇒ cleanup=reused（无残留）。
  assert.equal(result.data.cleanup.principal.status, 'reused');
  assert.equal(result.data.cleanup.principal.modified, false);
  assert.equal(result.data.agentPrincipalId, 'principal-existing');
  assert.equal(result.data.principalSource, 'discovered:workspace-agents');
  assert.equal(JSON.stringify(result).includes('agent log must not be printed'), false);
  assert.equal(stderr.text().includes('agent log must not be printed'), false);

  const methods = cp.state.calls.map((call) => `${call.method} ${call.pathname}`);
  // task-38: A4 只读发现（GET workspace-agents）必须先于建会话；全程不为 tier-A 建/绑 principal。
  assert.ok(methods.indexOf('GET /api/v1/workspaces/ws-1/agents') < methods.indexOf('POST /api/v1/sessions'));
  assert.equal(methods.includes('PUT /api/v1/workspaces/ws-1/agents/principal-existing'), false, '发现的 principal 不被 rebind');
  assert.ok(methods.indexOf('POST /api/v1/chat') < methods.indexOf('GET /api/v1/chat/runs/run-1'));
  assert.equal(methods.at(-1), 'DELETE /api/v1/sessions/session-1');

  for (const path of ['/api/v1/sessions', '/api/v1/chat', '/api/v1/chat/runs/run-1']) {
    const call = cp.state.calls.find((item) => item.pathname === path);
    assert.equal(call.headers['x-workspace-id'], 'ws-1');
  }
  // task-38: A5a/A5b 探针仍各建自己的行（user-door / workspace-door），body 不带 scope（D-174）。
  const probeCreates = cp.state.calls.filter((item) => item.method === 'POST' && item.pathname === '/api/v1/agent-principals');
  assert.ok(probeCreates.length >= 1, 'A5 probes create their own principals');
  for (const probeCreate of probeCreates) {
    assert.equal(Object.hasOwn(probeCreate.body ?? {}, 'scope'), false, 'probe create body must not carry scope');
  }

  // PLAN-0601: the Session must carry the explicit template + connection binding, otherwise CP
  // rejects chat with 409 API_TYPE_REBIND_REQUIRED.
  const sessionCall = cp.state.calls.find(
    (item) => item.method === 'POST' && item.pathname === '/api/v1/sessions',
  );
  // task-38（PLAN-0689 B3）：建会话 body 必须带 agentPrincipalId（发现的已绑定行）。
  assert.equal(sessionCall.body.agentPrincipalId, 'principal-existing');
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
  // task-38（Q1=b）：只读发现复用预存行 ⇒ cleanup=reused，来源记 discovered:workspace-agents。
  assert.equal(result.data.cleanup.principal.status, 'reused');
  assert.equal(result.data.agentPrincipalId, 'principal-existing');
  assert.equal(result.data.principalSource, 'discovered:workspace-agents');
  // task-25 B: the mock now echoes ownership and models door-based visibility, so the A5
  // probes run to a real verdict instead of stopping at the retired scope-echo check.
  assert.equal(result.data.personal.status, 'PASS');
  const principalCreates = cp.state.calls.filter((call) => call.method === 'POST' && call.pathname === '/api/v1/agent-principals');
  assert.ok(principalCreates.length >= 1, 'A5 probe creates its own PERSONAL principal');
  // The reuse invariant is about the PRE-EXISTING tier-A principal: it is never rebound.
  // (The A5 lifecycle probes bind/unbind their own probe rows — that is their job.)
  assert.equal(
    cp.state.calls.some((call) => call.method === 'PUT' && call.pathname.endsWith('/agents/principal-existing')),
    false,
    'reuses the pre-existing principal without rebinding',
  );
  // task-38: 发现是只读的——首选面可用就不打回落面，且不为 tier-A 建 principal。
  assert.equal(cp.state.calls.some((call) => call.method === 'GET' && call.pathname === '/api/v1/agent-principals'), false);
  const sessionCall = cp.state.calls.find((call) => call.method === 'POST' && call.pathname === '/api/v1/sessions');
  assert.equal(sessionCall.body.agentPrincipalId, 'principal-existing');
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
  const createCalls = [];
  const fakeClient = (handler) => ({ call: async (method, pathname, options = {}) => {
    calls.push(`${method} ${pathname}`);
    if (method === 'POST' && pathname === '/api/v1/agent-principals') createCalls.push(options);
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
        // D-174: no scope on the wire; the create echo carries server-derived ownership.
        return { status: 201, body: { principalId: 'p-1', ownership: 'USER' }, code: null };
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
        return { status: 201, body: { principalId: 'p-2', ownership: 'USER' }, code: null };
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

  // task-25 B（D-174）：create body 一律不含 scope；门由 workspace 上下文决定 ——
  // PERSONAL 探活不带工作区上下文（user-level door），WORKSPACE 探活必须带（workspace-tier door）。
  assert.ok(createCalls.length >= 2, 'both probes created a principal');
  for (const call of createCalls) {
    assert.equal(Object.hasOwn(call.body ?? {}, 'scope'), false, 'create body must not carry the retired scope field');
  }
  const personalCreate = createCalls.find((call) => String(call.body?.name ?? '').startsWith('xihe-verify-personal-'));
  const workspaceCreate = createCalls.find((call) => String(call.body?.name ?? '').startsWith('xihe-verify-workspace-'));
  assert.equal(personalCreate.workspace, false, 'PERSONAL probe uses the user-level door (no X-Workspace-Id)');
  assert.equal(workspaceCreate.workspace, true, 'WORKSPACE probe uses the workspace-tier door (X-Workspace-Id)');

  const workspaceUnboundVisible = await runWorkspaceLifecycleProbe({
    client: fakeClient((method, _pathname) => {
      if (method === 'POST') return { status: 201, body: { principalId: 'p-2', ownership: 'USER' }, code: null };
      if (method === 'GET') return { status: 200, body: { agents: [{ principalId: 'p-2', source: 'workspace' }] }, code: null };
      return { status: 404, body: {}, code: 'NOT_FOUND' };
    }),
    workspaceId: 'ws-1',
  });
  assert.equal(workspaceUnboundVisible.status, 'FAIL');
  assert.equal(workspaceUnboundVisible.code, 'WORKSPACE_VISIBLE_UNBOUND');
  const wrongSource = await runPersonalLifecycleProbe({
    client: fakeClient((method, _pathname) => {
      if (method === 'POST') return { status: 201, body: { principalId: 'p-1', ownership: 'USER' }, code: null };
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
    client: fakeClient((method, _pathname) => {
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
    createBodies: [],
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
      // D-174: the only contract query is workspaceId; a scope query would be silently
      // ignored by the real CP — this fake refuses it outright so the CLI can't regress.
      if (url.searchParams.has('scope')) {
        json(response, 400, { code: 'INVALID_REQUEST', detail: 'scope query retired (D-174)' });
        return;
      }
      json(response, 200, { principals: state.principals });
      return;
    }
    if (url.pathname === '/api/v1/agent-principals' && request.method === 'POST') {
      state.createRequests += 1;
      const body = await requestBody(request);
      // Mirror AgentPrincipalWireBody.CREATE_KEYS (additionalProperties:false): any unknown
      // key — including the retired scope — is a 400 INVALID_REQUEST, same as the real CP.
      const CREATE_KEYS = new Set(['name', 'templateId', 'defaultModelProvider', 'defaultModelName', 'allowedModels', 'hooks', 'roleIds']);
      if (!body || typeof body.name !== 'string' || body.name === '' || Object.keys(body).some((key) => !CREATE_KEYS.has(key))) {
        json(response, 400, { code: 'INVALID_REQUEST', detail: 'Body must contain name plus optional templateId, defaultModelProvider, defaultModelName, allowedModels, hooks and roleIds only' });
        return;
      }
      state.createBodies.push(body);
      // Server-derived fields (AgentPrincipalCreateView): user door ⇒ ownership USER, owner stays null.
      const principal = { principalId: `p-${state.principals.length + 1}`, ownership: 'USER', ownerUserId: null, ...body };
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
    // D-174: no --scope on the wire. The strict fake CP above answers 400 for any scope
    // key, so exit 0 here IS the "request body carries no scope" assertion (mutation leg pins it).
    const created = await run(['agent', 'create', '--name', 'cli-agent',
      '--template', 'tpl-1', '--default-model', 'openai:gpt-5', '--allow-model', 'openai:gpt-5',
      '--allow-model', 'openai:gpt-5-mini', '--json']);
    assert.equal(created.exitCode, 0);
    assert.equal(created.data.kind, 'agent-created');
    assert.equal(created.data.created, true);
    assert.equal(created.data.principalId, 'p-1');
    assert.equal(created.data.principal.ownership, 'USER');
    assert.equal(Object.hasOwn(state.createBodies[0], 'scope'), false, 'create body must not carry scope');
    assert.deepEqual(created.data.principal.allowedModels, [
      { provider: 'openai', model: 'gpt-5' },
      { provider: 'openai', model: 'gpt-5-mini' },
    ]);
    assert.deepEqual(created.data.principal.defaultModelProvider, 'openai');
    assert.equal(created.data.principal.defaultModelName, 'gpt-5');

    const again = await run(['agent', 'create', '--name', 'cli-agent',
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

    // --scope survives as a CLI-local filter (ownership/ownerUserId derived), explicitly marked.
    // Row p-1 has ownerUserId:null ⇒ WORKSPACE view; personal filter yields none.
    const localWs = await run(['agent', 'list', '--scope', 'workspace', '--json']);
    assert.equal(localWs.exitCode, 0);
    assert.equal(localWs.data.principals.length, 1);
    assert.equal(localWs.data.localFilter.scope, 'WORKSPACE');
    assert.match(localWs.data.localFilter.basis, /CLI-local/);
    const localPersonal = await run(['agent', 'list', '--scope', 'personal', '--json']);
    assert.equal(localPersonal.exitCode, 0);
    assert.equal(localPersonal.data.principals.length, 0, 'ownerless row is not PERSONAL in the local view');

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
  const state = { agents: [], workspaceBound: false, personalBound: false, sessionBodies: [] };
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
      // D-174: no scope query; a regressed CLI sending one gets a 400 here (real CP ignores it,
      // which was the fake-green — this fake is stricter on purpose).
      if (new URL(url).searchParams.has('scope')) return respond(400, { code: 'INVALID_REQUEST' });
      return scopeMode === 'ok'
        ? respond(200, { principals: [] })
        : respond(404, { code: 'NOT_FOUND' });
    }
    if (target.pathname === '/api/v1/agent-principals' && method === 'POST') {
      // Strict CREATE_KEYS mirror: scope in the body ⇒ 400, exactly like AgentPrincipalWireBody.
      if (body && Object.hasOwn(body, 'scope')) return respond(400, { code: 'INVALID_REQUEST' });
      // The two doors are told apart by the probe names (personal vs workspace lifecycle).
      const principalId = String(body?.name ?? '').startsWith('xihe-verify-personal-') ? 'p-9' : 'p-10';
      return respond(201, { principalId, ownership: 'USER', ownerUserId: null, name: body.name });
    }
    if (target.pathname === '/api/v1/workspaces/ws-1/agents' && method === 'GET') {
      // V4：PERSONAL 未绑也可见；WORKSPACE 只有绑定才可见。
      // task-38: 真契约形带 bound/disabled 旗标——A5a 把 p-9 bind→unbind，A6 发现时 p-9 已未绑(bound:false)，
      // 须跳过它取已绑定行。p-bound 是 workspace 预存的已绑定可用行（A6 发现的目标）；p-10 探针行解绑后也不可用。
      const agents = [
        { principalId: 'p-bound', name: 'prebound', bound: true, disabled: false, permissionsSnapshot: [] },
        { principalId: 'p-9', name: 'personal', source: 'personal', bound: state.personalBound, disabled: false, permissionsSnapshot: [] },
      ];
      if (state.workspaceBound) agents.push({ principalId: 'p-10', name: 'workspace', source: 'workspace', bound: true, disabled: false, permissionsSnapshot: [] });
      return respond(200, { agents });
    }
    if (target.pathname === '/api/v1/workspaces/ws-1/agents/p-9' && (method === 'PUT' || method === 'DELETE')) {
      state.personalBound = method === 'PUT';
      return method === 'PUT' ? respond(200, { principalId: 'p-9' }) : new Response(null, { status: 204 });
    }
    if (target.pathname === '/api/v1/workspaces/ws-1/agents/p-bound' && method === 'PUT') {
      return respond(200, { principalId: 'p-bound' });
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
      state.sessionBodies.push(body);
      // task-38: B3 契约镜像——缺 principal ⇒ 400（SessionService.java:248 同款 problem）。
      if (typeof body?.agentPrincipalId !== 'string' || body.agentPrincipalId.trim() === '') {
        return respond(400, { code: 'INVALID_REQUEST', detail: 'agentPrincipalId is required' });
      }
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
  // task-38（PLAN-0689 B3）：A6 建会话 principal 走只读发现——跳过 A5a 解绑后的 p-9(bound:false)，取预存已绑定 p-bound。
  assert.equal(pass.data.agentPrincipalId, 'p-bound');
  assert.equal(pass.data.principalSource, 'discovered:workspace-agents');
  // 两处建会话 body 都必须带 agentPrincipalId（B3 契约），且 binding 六字段一个不丢。
  assert.equal(state.sessionBodies.length, 2);
  for (const sessionBody of state.sessionBodies) {
    assert.equal(sessionBody.agentPrincipalId, 'p-bound');
    assert.equal(sessionBody.providerConnectionId, 'c-1');
    assert.equal(sessionBody.contextTemplateId, 't-1');
  }
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
    'skill list', 'skill show', 'skill import', 'skill bind', 'skill bindings', 'skill unbind', 'skill delete',
  ]) {
    assert.ok(result.data.help.includes(form), `help is missing: ${form}`);
  }
});

// task-25 C（盘点 P2-1）：五处「已实现未列 help」漂移的静态门 —— 每条 usage 必须列出对应参数。
test('help documents the five formerly-missing flags (task-25 P2-1)', async () => {
  const result = await runCommand(['help'], { env: {}, promptSecret: noPrompt });
  assert.equal(result.exitCode, 0);
  const text = result.data.help;
  const expectations = [
    ['skill bindings', /skill bindings <skillId>/],
    ['drive --content-file', /drive --workspace <wsId> \(--content <text> \| --content-file <path>\)/],
    ['auth status --check', /auth status \[--check\]/],
    ['config-locks set --mode', /config-locks set <domain> <key> --reason <text> \[--value <v>\] \[--mode <m>\]/],
    ['provider limit --clear-model-limits', /provider limit set --connection <c> .*\[--clear-model-limits\]/],
  ];
  for (const [label, pattern] of expectations) {
    assert.match(text, pattern, `help is missing the implemented flag: ${label}`);
  }
  // agent usage lines must advertise the local-filter semantics, not a wire scope.
  assert.match(text, /agent create --name <n> \[--workspace <wsId>\] \[--scope personal\|workspace\|instance\]/);
  assert.match(text, /--scope filters locally by ownership\/ownerUserId/);
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

// PLAN-0643 T4.7 (design D9): `xihe-cli/help.mjs` is the single registry. The bare `--help`
// prints every group (heading once, alphabetical, one usage line per command), `<group> --help`
// prints only that group, and an unknown group is a usage error instead of a silent full dump.
test('PLAN-0643 T4.7: bare help lists every registered group and command', async () => {
  const result = await runCommand(['help'], { env: {}, promptSecret: noPrompt });

  assert.equal(result.exitCode, 0);
  const text = result.data.help;
  assert.match(text, /^XH development and operations CLI/);
  assert.ok(text.includes('Commands by group:'), 'full help must announce the grouped layout');
  for (const group of HELP_GROUPS) {
    assert.equal(
      text.split(`\n${group.name} — `).length - 1,
      1,
      `group heading must appear exactly once: ${group.name}`,
    );
    for (const command of group.commands) {
      assert.ok(text.includes(`node scripts/xihe.mjs ${command.usage}`), `usage line missing: ${command.usage}`);
    }
  }
});

test('PLAN-0643 T4.7: <group> --help prints only that group', async () => {
  const result = await runCommand(['credential', '--help'], { env: {}, promptSecret: noPrompt });

  assert.equal(result.exitCode, 0);
  const text = result.data.help;
  assert.ok(text.includes('credential — Credential lifecycle and reveal'), 'own heading missing');
  assert.ok(text.includes('node scripts/xihe.mjs credential create'), 'own usage line missing');
  for (const foreign of [
    'node scripts/xihe.mjs provider add',
    'node scripts/xihe.mjs verify --stack',
    'node scripts/xihe.mjs chat send',
    'node scripts/xihe.mjs skill list',
    'Commands by group:',
  ]) {
    assert.ok(!text.includes(foreign), `another group leaked into credential help: ${foreign}`);
  }

  // `--help` wins over a trailing command token: no dispatch, no CP call, same group text.
  const nested = await runCommand(['provider', 'list', '--help'], { env: {}, promptSecret: noPrompt });
  assert.equal(nested.exitCode, 0);
  assert.equal(nested.data.help, (await runCommand(['provider', '--help'], { env: {}, promptSecret: noPrompt })).data.help);
});

test('PLAN-0643 T4.7: an unknown help group is a usage error (exit 2)', async () => {
  const viaFlag = await runCommand(['nosuchgroup', '--help'], { env: {}, promptSecret: noPrompt });
  assert.equal(viaFlag.exitCode, 2);
  assert.equal(viaFlag.error.code, 'INVALID_ARGUMENT');
  assert.match(viaFlag.error.message, /Unknown help group "nosuchgroup"/);

  const viaHelp = await runCommand(['help', 'nosuchgroup'], { env: {}, promptSecret: noPrompt });
  assert.equal(viaHelp.exitCode, 2);
  assert.equal(viaHelp.error.code, 'INVALID_ARGUMENT');
});

test('PLAN-0643 T4.7: help <group> matches <group> --help and keeps the {ok,data.help} envelope', async () => {
  const viaFlag = await runCommand(['provider', '--help', '--json'], { env: {}, promptSecret: noPrompt });
  const viaSubcommand = await runCommand(['help', 'provider'], { env: {}, promptSecret: noPrompt });

  assert.equal(viaFlag.exitCode, 0);
  assert.equal(viaSubcommand.exitCode, 0);
  assert.equal(viaFlag.json, true);
  assert.equal(viaFlag.data.help, viaSubcommand.data.help);

  const printed = captureOutput(() => printResult(viaFlag));
  const parsed = JSON.parse(printed.stdout);
  assert.deepEqual(Object.keys(parsed).sort(), ['data', 'ok']);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.help, viaFlag.data.help);
});

// A leading option token is not a group. `xihe --version --help` / `xihe --help extra` printed
// the full help before the registry; the per-group answer must not turn them into exit 2.
test('PLAN-0643 T4.7: a leading option before --help still prints the full help', async () => {
  const groupHeadings = (text) => text.split('\n').filter((line) => /^[a-z][a-z-]* — /.test(line)).length;

  const viaVersion = await runCommand(['--version', '--help'], { env: {}, promptSecret: noPrompt });
  assert.equal(viaVersion.exitCode, 0);
  assert.equal(groupHeadings(viaVersion.data.help), HELP_GROUPS.length);

  const trailing = await runCommand(['--help', 'extra'], { env: {}, promptSecret: noPrompt });
  assert.equal(trailing.exitCode, 0);
  assert.equal(trailing.data.help, viaVersion.data.help);

  // Without `--help`, `--version` still routes to the version command, not to help.
  const plain = await runCommand(['--version'], { env: {}, promptSecret: noPrompt });
  assert.equal(plain.data?.help, undefined);
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

test('BL-418: --body-file is judged before anything is sent to CP', async (t) => {
  // Three controls. The point of the first two is NOT "it errors" but "nothing left the CLI":
  // body resolution happens at api.mjs:219-233, while login() and the request are at :235/:248,
  // so a bad --body-file must produce zero network traffic. That only became observable once
  // node:fs stopped being an optional injection (before BL-418 the empty default dependency bag
  // threw "No filesystem reader is available" before any of this was reachable).
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'xihe-body-file-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const noPrompt = async () => {
    throw new Error('must not prompt');
  };
  const countingFetch = () => {
    let calls = 0;
    return {
      fetchImpl: async () => {
        calls += 1;
        throw new Error('no request may leave the CLI');
      },
      calls: () => calls,
    };
  };

  // Control 1: the file does not exist.
  const missingFetch = countingFetch();
  const missing = await runCommand(
    ['api', 'POST', '/api/v1/whatever', '--yes', '--body-file', path.join(dir, 'nope.json'), '--json'],
    { env: { XIHE_CP_PORT: '1' }, promptSecret: noPrompt, stderr: sink(), fetchImpl: missingFetch.fetchImpl },
  );
  assert.equal(missing.exitCode, 2);
  assert.equal(missing.error.code, 'API_BODY_INVALID');
  assert.match(missing.error.message, /Cannot read body file/);
  assert.equal(missingFetch.calls(), 0, 'a missing --body-file must not reach the network');

  // Control 2: the file is there but is not JSON.
  const brokenPath = path.join(dir, 'broken.json');
  fs.writeFileSync(brokenPath, '{"a":1,');
  const invalidFetch = countingFetch();
  const invalid = await runCommand(
    ['api', 'POST', '/api/v1/whatever', '--yes', '--body-file', brokenPath, '--json'],
    { env: { XIHE_CP_PORT: '1' }, promptSecret: noPrompt, stderr: sink(), fetchImpl: invalidFetch.fetchImpl },
  );
  assert.equal(invalid.exitCode, 2);
  assert.equal(invalid.error.code, 'API_BODY_INVALID');
  assert.match(invalid.error.message, /must be valid JSON/);
  assert.equal(invalidFetch.calls(), 0, 'invalid --body-file JSON must not reach the network');

  // Control 3: valid JSON really is forwarded — otherwise "sent nothing" above would be vacuous.
  const cp = await startApiEscapeMock();
  t.after(cp.close);
  const goodPath = path.join(dir, 'good.json');
  fs.writeFileSync(goodPath, '{"a":1,"b":[2,3]}');
  const good = await runCommand(['api', 'POST', '/api/v1/whatever', '--yes', '--body-file', goodPath, '--json'], {
    env: cp.env,
    promptSecret: noPrompt,
    stderr: sink(),
  });
  assert.equal(good.exitCode, 0, JSON.stringify(good.error));
  assert.equal(cp.state.lastMethod, 'POST');
  const sentBody = typeof cp.state.lastBody === 'string' ? JSON.parse(cp.state.lastBody) : cp.state.lastBody;
  assert.deepEqual(sentBody, { a: 1, b: [2, 3] });
  assert.equal(cp.state.lastHeaders['content-type'], 'application/json');
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
  configGetStatus = 200,
  configGetCode = 'INVALID_DOMAIN',
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
      if (configGetStatus !== 200) {
        json(response, configGetStatus, { code: configGetCode, detail: 'must not be printed' });
        return;
      }
      if (state.lastConfigDomain === 'not-a-domain') {
        json(response, 400, { code: 'INVALID_DOMAIN', detail: 'must not be printed' });
        return;
      }
      const layer = url.searchParams.get('layer');
      const includeMeta = url.searchParams.get('includeMeta') === 'true';
      const rows = layer
        ? { ...domains[state.lastConfigDomain]?.[layer] }
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

test('PLAN-0643 V37: a non-ADMIN instance-layer 403 is surfaced as FORBIDDEN', async (t) => {
  const cp = await startConfigCpMock({ configGetStatus: 403, configGetCode: 'FORBIDDEN' });
  t.after(cp.close);

  const result = await runCommand(['config', 'get', 'agent-runtime', '--layer', 'instance', '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });
  assert.equal(result.exitCode, 1, JSON.stringify(result.error));
  assert.equal(result.error.code, 'FORBIDDEN');
  assert.equal(result.error.details.status, 403);
  assert.equal(JSON.stringify(result).includes('must not be printed'), false, 'CP detail must not enter the result');

  // The printed CLI boundary must keep both the machine-readable envelope and the
  // human-readable stderr line; asserting only runCommand's return would not prove
  // that `--json` and stderr still carry the CP code.
  const baseUrl = `http://127.0.0.1:${cp.env.XIHE_CP_PORT}`;
  const token = tempTokenFile();
  t.after(token.cleanup);
  fs.writeFileSync(token.file, JSON.stringify({
    version: 1,
    tokens: {
      [baseUrl]: {
        token: 'test-access-token',
        email: null,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        obtainedAt: new Date().toISOString(),
      },
    },
  }));
  const runSpawned = async (argv) => {
    const child = spawn(process.execPath, ['scripts/xihe.mjs', ...argv], {
      cwd: process.cwd(),
      env: { ...process.env, XIHE_CP_URL: baseUrl, XIHE_CLI_TOKEN_FILE: token.file },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const status = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    return { status, stdout, stderr };
  };

  const jsonRun = await runSpawned(['config', 'get', 'agent-runtime', '--layer', 'instance', '--json']);
  assert.equal(jsonRun.status, 1, `stdout=${jsonRun.stdout}\nstderr=${jsonRun.stderr}`);
  const envelope = JSON.parse(jsonRun.stdout);
  assert.deepEqual(Object.keys(envelope).sort(), ['error', 'ok']);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, 'FORBIDDEN', `stdout=${jsonRun.stdout}\nstderr=${jsonRun.stderr}`);
  assert.equal(jsonRun.stderr.includes('must not be printed'), false, 'JSON stderr must not echo CP detail');

  // `--json` intentionally writes only the machine envelope; the human face must
  // still put the same CP code on stderr instead of swallowing the failure.
  const humanRun = await runSpawned(['config', 'get', 'agent-runtime', '--layer', 'instance']);
  assert.equal(humanRun.status, 1, `stdout=${humanRun.stdout}\nstderr=${humanRun.stderr}`);
  assert.equal(humanRun.stdout, '');
  assert.match(humanRun.stderr, /\[FORBIDDEN\] CP request failed \(HTTP 403\)\./);
  assert.equal(humanRun.stderr.includes('must not be printed'), false, 'human stderr must not echo CP detail');
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

test('PLAN-0643 V43 fix: a 13-digit CP revision (epoch millis) is forwarded as-is', async (t) => {
  const cp = await startConfigCpMock();
  t.after(cp.close);

  const result = await runCommand(['config-locks', 'delete', 'agent-runtime', 'runMaxTurns', '--revision', '1793960949576', '--clear-value', '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });

  assert.equal(result.exitCode, 0, JSON.stringify(result.error));
  assert.equal(cp.state.lastLocksDeleteQuery.get('revision'), '1793960949576');
  assert.equal(cp.state.lastLocksDeleteQuery.get('clearValue'), 'true');
});

test('PLAN-0643 V43 fix: a non-numeric --revision is a usage error before any request', async (t) => {
  const cp = await startConfigCpMock();
  t.after(cp.close);

  const result = await runCommand(['config-locks', 'delete', 'agent-runtime', 'runMaxTurns', '--revision', 'soon', '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });

  assert.equal(result.exitCode, 2);
  assert.equal(result.error.code, 'INVALID_ARGUMENT');
  assert.match(result.error.message, /non-negative integer/);
  assert.equal(cp.state.locksDeleteRequests, 0, 'a usage error must not reach the CP');
});

test('PLAN-0643 V43 fix: a 20-digit --revision is rejected as a usage error', async (t) => {
  const cp = await startConfigCpMock();
  t.after(cp.close);

  const result = await runCommand(['config-locks', 'delete', 'agent-runtime', 'runMaxTurns', '--revision', '1'.repeat(20), '--json'], {
    env: cp.env, promptSecret: noPrompt, stderr: sink(),
  });

  assert.equal(result.exitCode, 2);
  assert.equal(result.error.code, 'INVALID_ARGUMENT');
  assert.match(result.error.message, /non-negative integer/);
  assert.equal(cp.state.locksDeleteRequests, 0, 'a usage error must not reach the CP');
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

  // Same-process concurrency (the T1.5 shape): five concurrent status commands
  // against one empty shared token file; the login() in-flight dedup must converge
  // them. The cross-process half (BL-396) is covered by the real-child tests below.
  const results = await Promise.all(Array.from({ length: 5 }, () => runCommand(['status', '--json'], {
    env, promptSecret: noPrompt, stderr: sink(),
  })));

  assert.equal(results.every((result) => result.exitCode === 0), true, JSON.stringify(results.map((r) => r.error)));
  assert.ok(cp.state.loginRequests <= 2, `first-login contention must converge (got ${cp.state.loginRequests})`);
  const store = readTokenFile(token.file);
  assert.equal(Object.keys(store.tokens).length, 1);
  assert.deepEqual(fs.readdirSync(token.directory), ['cli-token.json'], 'no tmp residue');
});

// ── BL-396: cross-process first-login single-flight (PLAN-0643 V23) ────────
// The V23 test above only covers the in-process map; these cover the lock that
// makes five *independent* processes converge on one login.

function startLoginCounterMock({ loginDelayMs = 0, rateLimitFailures = 0 } = {}) {
  const state = { loginRequests: 0, statusRequests: 0, rateLimited: 0 };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    await requestBody(request);
    if (url.pathname === '/api/v1/auth/login') {
      state.loginRequests += 1;
      if (state.loginRequests <= rateLimitFailures) {
        state.rateLimited += 1;
        // CP's real 429 shape (AuthController.rateLimited): Retry-After + AUTH_RATE_LIMITED.
        response.writeHead(429, { 'content-type': 'application/problem+json', 'retry-after': '0', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ code: 'AUTH_RATE_LIMITED', status: 429, detail: 'Too many login attempts; retry later' }));
        return;
      }
      if (loginDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, loginDelayMs));
      json(response, 200, { accessToken: 'shared-token' });
      return;
    }
    if (url.pathname === '/api/v1/status') {
      state.statusRequests += 1;
      json(response, 200, { status: 'ok' });
      return;
    }
    json(response, 404, { code: 'NOT_FOUND' });
  });
  return { state, server };
}

async function startCounterMock(options) {
  const mock = startLoginCounterMock(options);
  await new Promise((resolve) => mock.server.listen(0, '127.0.0.1', resolve));
  return {
    state: mock.state,
    env: { XIHE_CP_PORT: String(mock.server.address().port), XIHE_DEV_ADMIN_PASSWORD: TEST_PASSWORD },
    close: () => new Promise((resolve, reject) => mock.server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function spawnCliStatus(env) {
  const child = spawn(process.execPath, [path.resolve('scripts/xihe.mjs'), 'status', '--json'], {
    cwd: process.cwd(),
    // XIHE_CP_URL wins over XIHE_CP_PORT in resolveBaseUrl (design D5), and an empty
    // value would be refilled from the developer's .env chain, so pin the mock URL.
    env: { ...process.env, ...env, XIHE_CP_URL: `http://127.0.0.1:${env.XIHE_CP_PORT}` },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return new Promise((resolve) => {
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('BL-396: two real CLI processes converge on a single login (cross-process lock)', async (t) => {
  // The login answer is deliberately slow so both children are provably inside the
  // contention window at the same time; without the lock each would POST (2 logins).
  const cp = await startCounterMock({ loginDelayMs: 150 });
  const token = tempTokenFile();
  t.after(async () => { await cp.close(); token.cleanup(); });
  const env = { ...cp.env, XIHE_CLI_TOKEN_FILE: token.file };

  const results = await Promise.all([spawnCliStatus(env), spawnCliStatus(env)]);

  assert.deepEqual(results.map((result) => result.code), [0, 0], JSON.stringify(results));
  assert.equal(cp.state.loginRequests, 1, 'exactly one process may log in');
  const store = readTokenFile(token.file);
  assert.equal(Object.keys(store.tokens).length, 1);
  assert.equal(store.tokens[`http://127.0.0.1:${cp.env.XIHE_CP_PORT}`].token, 'shared-token');
  assert.deepEqual(fs.readdirSync(token.directory), ['cli-token.json'], 'the lock file is released, no tmp residue');
});

test('BL-396: a login waiting on the lock reuses the peer token and never POSTs', async (t) => {
  const cp = await startAuthMock();
  const token = tempTokenFile();
  t.after(async () => { await cp.close(); token.cleanup(); });
  const env = { ...cp.env, XIHE_CLI_TOKEN_FILE: token.file };
  const apiBase = `http://127.0.0.1:${cp.env.XIHE_CP_PORT}`;

  // "Virtual peer": it holds the lock; during the first backoff it persists a token
  // (what a winning process does) and keeps the lock until it releases it.
  fs.writeFileSync(loginLockPath(env), `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`);
  let sleeps = 0;
  const sleep = async () => {
    sleeps += 1;
    seedStaleToken(token.file, apiBase, 'peer-token');
  };

  const reused = await login({
    apiBase,
    fetchImpl: fetch,
    env,
    options: {},
    promptSecret: async () => { throw new Error('a waiting login must not prompt for a password'); },
    dependencies: { sleep, budgetMs: 5_000 },
  });

  assert.equal(reused, 'peer-token');
  assert.equal(sleeps, 1, 'one backoff is enough once the peer persisted');
  assert.equal(cp.state.loginRequests, 0, 'the waiter must never log in itself');
});

test('BL-396: a live foreign holder is never stolen; the waiter fails with AUTH_LOGIN_CONTENTION', async (t) => {
  const cp = await startAuthMock();
  const token = tempTokenFile();
  t.after(async () => { await cp.close(); token.cleanup(); });
  const env = { ...cp.env, XIHE_CLI_TOKEN_FILE: token.file };
  const lockFile = loginLockPath(env);
  fs.writeFileSync(lockFile, `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`);

  // Injected clock + sleep: the budget advances deterministically, no wall-clock wait.
  let clockMs = Date.now();
  const now = () => clockMs;
  const sleep = async (ms) => { clockMs += ms; };

  await assert.rejects(
    () => login({
      apiBase: `http://127.0.0.1:${cp.env.XIHE_CP_PORT}`,
      fetchImpl: fetch,
      env,
      options: {},
      promptSecret: noPrompt,
      dependencies: { now, sleep, budgetMs: 5_000 },
    }),
    (error) => error.code === 'AUTH_LOGIN_CONTENTION' && error.exitCode === 1,
    'an exhausted budget must fail explicitly instead of racing a login',
  );
  assert.equal(cp.state.loginRequests, 0, 'no login may be sent while the holder is alive');
  assert.equal(fs.existsSync(lockFile), true, 'a live holder lock must not be removed');
});

test('BL-396: the login lock creates a missing cache directory instead of degrading', async (t) => {
  // Real-stack regression (2026-11-06): a cold first login has no cache directory
  // yet, so `wx` failed with ENOENT and every process silently fell back to an
  // unlocked login (5 processes, 9 login POSTs through the counting proxy).
  const base = fs.mkdtempSync(path.join(tmpdir(), 'xihe-lock-cold-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const file = path.join(base, 'missing', 'cli-token.json');
  const env = { XIHE_CLI_TOKEN_FILE: file };
  assert.equal(fs.existsSync(path.dirname(file)), false, 'precondition: cold cache directory');

  const first = await acquireLoginLock({ env });
  assert.equal(first.kind, 'acquired', 'a cold cache directory must not degrade to an unlocked login');
  assert.equal(fs.existsSync(path.dirname(file)), true, 'the lock creates the cache directory');
  assert.equal(first.release(), true);
  assert.equal(fs.existsSync(loginLockPath(env)), false);

  // A peer waiting on a live holder re-reads the store instead of logging in again.
  const holder = await acquireLoginLock({ env });
  assert.equal(holder.kind, 'acquired');
  const waiter = await acquireLoginLock({ env, onWait: () => 'peer-token' });
  assert.equal(waiter.kind, 'reuse');
  assert.equal(waiter.token, 'peer-token');
  assert.equal(holder.release(), true);
});

test('BL-396: stale login locks (dead pid / expired mtime) are swept and acquired', async (t) => {
  const token = tempTokenFile();
  t.after(() => token.cleanup());
  const env = { XIHE_CLI_TOKEN_FILE: token.file };
  const lockFile = loginLockPath(env);
  const holderBody = (pid) => `${JSON.stringify({ pid, acquiredAt: new Date(0).toISOString() })}\n`;

  // 1. holder pid is dead -> stale immediately (covers a hard-killed login).
  fs.writeFileSync(lockFile, holderBody(findDeadPid()));
  const afterDeadPid = await acquireLoginLock({ env });
  assert.equal(afterDeadPid.kind, 'acquired');
  assert.equal(afterDeadPid.clearedStale, 1);
  assert.equal(afterDeadPid.release(), true);
  assert.equal(fs.existsSync(lockFile), false, 'release removes our own lock');

  // 2. live pid but the lock is older than the stale threshold (pid reuse / long hang).
  fs.writeFileSync(lockFile, holderBody(process.pid));
  const ancient = new Date(Date.now() - 3_600_000);
  fs.utimesSync(lockFile, ancient, ancient);
  const afterExpiredMtime = await acquireLoginLock({ env });
  assert.equal(afterExpiredMtime.kind, 'acquired');
  assert.equal(afterExpiredMtime.clearedStale, 1);
  afterExpiredMtime.release();

  // 3. live pid + fresh mtime is honoured: wait, then time out instead of stealing.
  fs.writeFileSync(lockFile, holderBody(process.pid));
  const contended = await acquireLoginLock({ env, budgetMs: 300 });
  assert.equal(contended.kind, 'timeout');
  assert.equal(contended.clearedStale, 0);
  assert.equal(fs.existsSync(lockFile), true, 'a live holder survives the contender');
});

test('BL-396: a 429 login is retried per Retry-After and then succeeds', async (t) => {
  const cp = await startCounterMock({ rateLimitFailures: 1 });
  const token = tempTokenFile();
  t.after(async () => { await cp.close(); token.cleanup(); });

  const result = await runCommand(['status', '--json'], {
    env: { ...cp.env, XIHE_CLI_TOKEN_FILE: token.file }, promptSecret: noPrompt, stderr: sink(),
  });

  assert.equal(result.exitCode, 0, JSON.stringify(result.error));
  assert.equal(cp.state.loginRequests, 2, 'one throttled attempt + one retry');
  assert.equal(cp.state.statusRequests, 1);
  assert.equal(readTokenFile(token.file).tokens[`http://127.0.0.1:${cp.env.XIHE_CP_PORT}`].token, 'shared-token');
});

test('BL-396: consecutive 429s still surface AUTH_RATE_LIMITED after bounded retries', async (t) => {
  const cp = await startCounterMock({ rateLimitFailures: 5 });
  const token = tempTokenFile();
  t.after(async () => { await cp.close(); token.cleanup(); });

  const result = await runCommand(['status', '--json'], {
    env: { ...cp.env, XIHE_CLI_TOKEN_FILE: token.file }, promptSecret: noPrompt, stderr: sink(),
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.error.code, 'AUTH_RATE_LIMITED', 'the CLI never swallows the throttle');
  assert.equal(cp.state.loginRequests, 3, 'the initial attempt plus two bounded retries');
  assert.equal(cp.state.statusRequests, 0, 'a failed login must not issue business calls');
  assert.equal(fs.existsSync(token.file), false, 'a failed login persists nothing');
  assert.equal(fs.existsSync(loginLockPath(cp.env)), false, 'the lock is released on the error path too');
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

function findDeadPid() {
  for (let pid = 3_000_000; pid < 3_000_200; pid += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === 'ESRCH') return pid;
    }
  }
  throw new Error('could not find an unused pid for the V24 sweep fixture');
}

test('PLAN-0643 V24 fix: loading the store sweeps leaked temps and keeps a live writer temp', async (t) => {
  const token = tempTokenFile();
  t.after(() => token.cleanup());
  const now = Date.now();
  const twoHoursAgo = new Date(now - 2 * 60 * 60 * 1000);
  const leaked = path.join(token.directory, `.cli-token.${findDeadPid()}.${now}.tmp`);
  const aged = path.join(token.directory, `.cli-token.${process.pid}.${now - 7_200_000}.tmp`);
  const inflight = path.join(token.directory, `.cli-token.${process.pid}.${now}.tmp`);
  const foreign = path.join(token.directory, 'keep-me.tmp');
  for (const file of [leaked, aged, inflight, foreign]) fs.writeFileSync(file, '{}');
  fs.utimesSync(aged, twoHoursAgo, twoHoursAgo);

  const state = readStore({ XIHE_CLI_TOKEN_FILE: token.file });

  assert.equal(state.kind, 'absent', 'sweeping must not fabricate a store');
  assert.equal(fs.existsSync(leaked), false, 'a temp whose writer was killed is swept immediately');
  assert.equal(fs.existsSync(aged), false, 'a temp older than the stale bound is swept even when its pid was recycled');
  assert.equal(fs.existsSync(inflight), true, 'a live writer temp must never be deleted');
  assert.equal(fs.existsSync(foreign), true, 'only .cli-token.<pid>.<ts>.tmp is considered');
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
        providers: { 'conn-1': { connectionId: 'conn-1', providerId: 'xiaomi', status: 'ready', models: ['model-a', 'model-b'] } },
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
      // task-10: mirror CP's binding contract. CreateWorkspaceRequest.roots is
      // List<Map<String,String>>; a string array is a Jackson binding failure and CP
      // answers 400 INVALID_REQUEST *before* any service validation. The mock refuses
      // the same shape so the CLI regression is caught here, not only in a live stack.
      if (body.roots !== undefined && body.roots !== null) {
        const bad = !Array.isArray(body.roots)
          || body.roots.some((entry) => entry === null || typeof entry !== 'object' || Array.isArray(entry));
        if (bad) {
          json(response, 400, { code: 'INVALID_REQUEST', message: 'mock CP: roots must be a list of objects' });
          return;
        }
      }
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

test('task-10: workspace create --roots sends CP object shape [{path,alias}] (comma form)', async (t) => {
  const cp = await startM63Mock();
  t.after(() => cp.close());

  const result = await runCommand([
    'workspace', 'create', '--name', 'multi', '--storage-mode', 'direct_attach',
    '--roots', 'C:/data/a,C:/data/b', '--json',
  ], { env: cp.env, promptSecret: noPrompt, stderr: sink() });
  assert.equal(result.exitCode, 0, JSON.stringify(result.error));
  assert.equal(result.data.kind, 'workspace-created');

  const post = cp.hits('POST', '/api/v1/workspaces');
  assert.equal(post.length, 1);
  // The regression this card fixes: these used to be the strings 'C:/data/a' / 'C:/data/b',
  // which CP's List<Map<String,String>> binding rejects with 400 INVALID_REQUEST.
  assert.deepEqual(post[0].body.roots, [{ path: 'C:/data/a' }, { path: 'C:/data/b' }]);
  for (const entry of post[0].body.roots) {
    assert.equal(typeof entry, 'object');
    assert.equal(Array.isArray(entry), false);
    assert.equal(typeof entry.path, 'string');
  }
});

test('task-10: workspace create --roots accepts the JSON object array (path + alias)', async (t) => {
  const cp = await startM63Mock();
  t.after(() => cp.close());

  const result = await runCommand([
    'workspace', 'create', '--name', 'multi', '--storage-mode', 'direct_attach',
    '--roots', '[{"path":"C:/data/a","alias":"one"},{"path":"C:/data/b"}]', '--json',
  ], { env: cp.env, promptSecret: noPrompt, stderr: sink() });
  assert.equal(result.exitCode, 0, JSON.stringify(result.error));

  const post = cp.hits('POST', '/api/v1/workspaces');
  assert.deepEqual(post[0].body.roots, [{ path: 'C:/data/a', alias: 'one' }, { path: 'C:/data/b' }]);
});

test('task-10: workspace create --roots maps a JSON string array to objects (wire compat)', async (t) => {
  const cp = await startM63Mock();
  t.after(() => cp.close());

  const result = await runCommand([
    'workspace', 'create', '--name', 'multi', '--storage-mode', 'direct_attach',
    '--roots', '["C:/data/a","C:/data/b"]', '--json',
  ], { env: cp.env, promptSecret: noPrompt, stderr: sink() });
  assert.equal(result.exitCode, 0, JSON.stringify(result.error));

  const post = cp.hits('POST', '/api/v1/workspaces');
  assert.deepEqual(post[0].body.roots, [{ path: 'C:/data/a' }, { path: 'C:/data/b' }]);
});

test('task-10: workspace create rejects malformed --roots before any CP call (usage)', async (t) => {
  const cp = await startM63Mock();
  t.after(() => cp.close());

  const cases = [
    ['--roots', '[]', /at least one root/],
    ['--roots', '[{not json', /not valid JSON/],
    ['--roots', '[{"alias":"one"}]', /--roots\[0\]\.path requires/],
    ['--roots', '[{"path":"C:/data/a","typo":"x"}]', /unknown key/],
    ['--roots', '[["C:/data/a"]]', /must be an object/],
    ['--roots', '{"path":"C:/data/a"}', /must be an array/],
    ['--roots', ', ,', /at least one directory/],
    ['--roots', '[,]', /not valid JSON/],
  ];
  for (const [flag, value, expected] of cases) {
    const result = await runCommand([
      'workspace', 'create', '--name', 'multi', '--storage-mode', 'direct_attach', flag, value, '--json',
    ], { env: cp.env, promptSecret: noPrompt, stderr: sink() });
    assert.equal(result.exitCode, 2, `${value} must be a usage error`);
    assert.equal(result.error.code, 'INVALID_ARGUMENT');
    assert.match(result.error.message, expected);
  }
  assert.equal(cp.state.requests.length, 0, 'no CP call may leave the CLI before --roots validation');
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

test('PLAN-0643 V2 re-judge: coverage groups.added counts >= 12 via new groups + extensions', async () => {
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

// ── PLAN-0643 T5.3: read-only four-class assertions + five-command concurrency ──
// T5.3 asks for success / parameter-error / permission-4xx / `--json`-shape per command
// plus one concurrency case over five read-only commands. The per-batch matrix already
// covers most single-command faces (see the M6 task rows); the gap this block closes is
// "five *different* read-only commands in parallel" — V23 and the R5 cases race copies
// of the same command. `--json`'s envelope shape ({"ok":…,"data":…}) is asserted by the
// existing spawn-level cases; here every command's `data` shape is asserted instead.

const READ_ONLY_COMMANDS = [
  ['status', ['status', '--json'], 'status'],
  ['provider catalog', ['provider', 'catalog', '--json'], 'provider-catalog'],
  ['me permissions', ['me', 'permissions', '--json'], 'me-permissions'],
  ['session list', ['session', 'list', '--json'], 'session-list'],
  ['config get agent-runtime', ['config', 'get', 'agent-runtime', '--json'], 'config-get'],
];

// One fake CP for the whole read-only face: status fans out to /status + /health + /version,
// the other four are single GETs. `deny` turns every business call into a 403 so the same
// five commands can assert the permission-4xx class.
async function startReadOnlyMock({ deny = false } = {}) {
  const state = { loginRequests: 0, hits: [], authHeaders: [] };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    await requestBody(request);
    if (url.pathname === '/api/v1/auth/login') {
      state.loginRequests += 1;
      json(response, 200, { accessToken: 'read-only-token' });
      return;
    }
    state.hits.push(`${request.method} ${url.pathname}`);
    state.authHeaders.push(request.headers.authorization ?? null);
    if (deny) {
      json(response, 403, { code: 'ACCESS_DENIED', detail: TEST_KEY });
      return;
    }
    if (url.pathname === '/api/v1/status' && request.method === 'GET') { json(response, 200, { status: 'ok' }); return; }
    if (url.pathname === '/api/v1/health' && request.method === 'GET') { json(response, 200, { status: 'UP' }); return; }
    if (url.pathname === '/api/v1/version' && request.method === 'GET') { json(response, 200, { version: 'test-version' }); return; }
    if (url.pathname === '/api/v1/provider-catalog' && request.method === 'GET') { json(response, 200, { providers: [] }); return; }
    if (url.pathname === '/api/v1/me/permissions' && request.method === 'GET') { json(response, 200, { permissions: ['instance:admin'] }); return; }
    if (url.pathname === '/api/v1/sessions' && request.method === 'GET') { json(response, 200, { sessions: [] }); return; }
    if (url.pathname === '/api/v1/config/agent-runtime' && request.method === 'GET') { json(response, 200, { runMaxTurns: 5 }); return; }
    json(response, 404, { code: 'NOT_FOUND' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    state,
    env: { XIHE_CP_PORT: String(server.address().port), XIHE_DEV_ADMIN_PASSWORD: TEST_PASSWORD },
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

const runReadOnly = (argv, env) => runCommand([...argv], {
  env, promptSecret: noPrompt, stderr: sink(),
});

test('PLAN-0643 T5.3: five different read-only commands run concurrently against one CP', async (t) => {
  const cp = await startReadOnlyMock();
  const token = tempTokenFile();
  t.after(async () => { await cp.close(); token.cleanup(); });
  const env = { ...cp.env, XIHE_CLI_TOKEN_FILE: token.file };

  const results = await Promise.all(READ_ONLY_COMMANDS.map(([, argv]) => runReadOnly(argv, env)));

  assert.deepEqual(results.map((result) => result.exitCode), [0, 0, 0, 0, 0],
    JSON.stringify(results.map((result) => result.error)));
  assert.deepEqual(results.map((result) => result.data.kind),
    READ_ONLY_COMMANDS.map(([, , kind]) => kind));
  // Success faces: each command's `--json` data carries its documented discriminators.
  assert.equal(results[0].data.overall, 'healthy');
  assert.deepEqual(results[0].data.endpoints.status.body, { status: 'ok' });
  assert.deepEqual(results[1].data.providers, []);
  assert.deepEqual(results[2].data.permissions, ['instance:admin']);
  assert.deepEqual(results[3].data.sessions, []);
  assert.deepEqual(results[4].data.entries, { runMaxTurns: 5 });
  assert.equal(results[4].data.domain, 'agent-runtime');
  // Concurrency invariants: one converged login, and exactly one request per endpoint.
  assert.ok(cp.state.loginRequests <= 2,
    `concurrent first-login must converge (got ${cp.state.loginRequests})`);
  const counts = {};
  for (const hit of cp.state.hits) counts[hit] = (counts[hit] ?? 0) + 1;
  assert.deepEqual(counts, {
    'GET /api/v1/status': 1,
    'GET /api/v1/health': 1,
    'GET /api/v1/version': 1,
    'GET /api/v1/provider-catalog': 1,
    'GET /api/v1/me/permissions': 1,
    'GET /api/v1/sessions': 1,
    'GET /api/v1/config/agent-runtime': 1,
  });
  // Every tokened call reuses the converged bearer token; /health is permitAll (no header).
  const tokened = cp.state.hits
    .map((hit, index) => ({ hit, header: cp.state.authHeaders[index] }))
    .filter(({ hit }) => hit !== 'GET /api/v1/health');
  assert.equal(tokened.every(({ header }) => header === 'Bearer read-only-token'), true,
    JSON.stringify(tokened));
});

test('PLAN-0643 T5.3: the same five commands reject positional usage with exit 2 and send nothing', async (t) => {
  const cp = await startReadOnlyMock();
  const token = tempTokenFile();
  t.after(async () => { await cp.close(); token.cleanup(); });
  const env = { ...cp.env, XIHE_CLI_TOKEN_FILE: token.file };

  // Warm the token first: `session list` logs in before it validates positionals, so a cold
  // cache would add a login POST; this asserts "no *business* request", not "no HTTP at all".
  const warm = await runReadOnly(['status', '--json'], env);
  assert.equal(warm.exitCode, 0, JSON.stringify(warm.error));
  const hitsBefore = cp.state.hits.length;

  const usageCases = [
    // `status` has no per-command usage face of its own: the status-style group drops a
    // stray sub-command silently (observed — a product gap to register, not a contract to
    // freeze). Its usage class is asserted through the shared global --base-url validator
    // (D5/V8), which fails closed before dispatch for every command.
    ['status --base-url not-a-url', ['--base-url', 'not-a-url', 'status', '--json'], 'INVALID_BASE_URL'],
    ['provider catalog extra', ['provider', 'catalog', 'extra', '--json'], 'INVALID_ARGUMENT'],
    ['me permissions extra', ['me', 'permissions', 'extra', '--json'], 'INVALID_ARGUMENT'],
    ['session list extra', ['session', 'list', 'extra', '--json'], 'INVALID_ARGUMENT'],
    ['config get without a domain', ['config', 'get', '--json'], 'INVALID_ARGUMENT'],
  ];
  const results = await Promise.all(usageCases.map(([, argv]) => runReadOnly(argv, env)));

  assert.deepEqual(results.map((result) => result.exitCode), [2, 2, 2, 2, 2],
    JSON.stringify(results.map((result) => result.error)));
  assert.deepEqual(results.map((result) => result.error.code),
    usageCases.map(([, , code]) => code));
  assert.equal(cp.state.hits.length, hitsBefore, 'a usage error must not reach the CP');
});

test('PLAN-0643 T5.3: a CP 403 maps to ACCESS_DENIED for four commands; status degrades', async (t) => {
  const cp = await startReadOnlyMock({ deny: true });
  const token = tempTokenFile();
  t.after(async () => { await cp.close(); token.cleanup(); });
  const env = { ...cp.env, XIHE_CLI_TOKEN_FILE: token.file };

  const results = await Promise.all(READ_ONLY_COMMANDS.map(([, argv]) => runReadOnly(argv, env)));

  // `status` is a status-style command: partial failure is a `degraded` payload (exit 0),
  // never an error exit — the CLI must not hide which endpoint failed.
  assert.equal(results[0].exitCode, 0, JSON.stringify(results[0].error));
  assert.equal(results[0].data.overall, 'degraded');
  assert.equal(results[0].data.endpoints.status.status, 'failed');
  assert.equal(results[0].data.endpoints.status.code, 'ACCESS_DENIED');
  // The four plain read-only commands surface the 403 as a stable code without CP detail.
  for (const [index, [, , kind]] of READ_ONLY_COMMANDS.entries()) {
    if (index === 0) continue;
    assert.equal(results[index].exitCode, 1, `${kind}: ${JSON.stringify(results[index].data)}`);
    assert.equal(results[index].error.code, 'ACCESS_DENIED', kind);
    assert.equal(JSON.stringify(results[index]).includes(TEST_KEY), false,
      `${kind} must not echo the CP detail`);
  }
});

// ── BL-414: `xihe status <anything>` used to drop the stray token silently ──────
// The status-style group parsed the second token as a sub-command name, found nothing to
// dispatch for it, and answered success without a request. `models` already rejects a
// sub-command; `status` now does the same (usage error, exit 2, no CP call).
test('BL-414: status rejects a stray sub-command instead of dropping it silently', async (t) => {
  const cp = await startReadOnlyMock();
  const token = tempTokenFile();
  t.after(async () => { await cp.close(); token.cleanup(); });
  const env = { ...cp.env, XIHE_CLI_TOKEN_FILE: token.file };

  // Regression guard: the normal face still succeeds after the new validation.
  const ok = await runReadOnly(['status', '--json'], env);
  assert.equal(ok.exitCode, 0, JSON.stringify(ok.error));
  assert.equal(ok.data.kind, 'status');
  const hitsBefore = cp.state.hits.length;
  const loginsBefore = cp.state.loginRequests;

  for (const argv of [['status', 'extra', '--json'], ['status', 'extra']]) {
    const result = await runReadOnly(argv, env);
    assert.equal(result.exitCode, 2, `${argv.join(' ')}: ${JSON.stringify(result.data)}`);
    assert.equal(result.error.code, 'INVALID_ARGUMENT');
    assert.equal(result.json, argv.includes('--json'),
      `${argv.join(' ')}: --json must still select the envelope`);
  }
  assert.equal(cp.state.hits.length, hitsBefore, 'a usage error must not reach the CP');
  assert.equal(cp.state.loginRequests, loginsBefore, 'a usage error must not log in');

  // `--json` keeps the frozen {ok:false,error} envelope end-to-end (spawned, offline: the
  // usage check runs before any login, so no CP is needed).
  const spawnedEnv = { ...process.env, XIHE_CLI_TOKEN_CACHE: 'off', XIHE_CP_PORT: '1' };
  delete spawnedEnv.XIHE_CP_URL;
  delete spawnedEnv.XIHE_CLI_TOKEN_FILE;
  const spawned = spawnSync(process.execPath, ['scripts/xihe.mjs', 'status', 'extra', '--json'], {
    cwd: process.cwd(), env: spawnedEnv, encoding: 'utf8', timeout: 30_000, windowsHide: true,
  });
  assert.equal(spawned.status, 2, spawned.stderr);
  const envelope = JSON.parse(spawned.stdout);
  assert.deepEqual(Object.keys(envelope).sort(), ['error', 'ok']);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, 'INVALID_ARGUMENT');
});

// ── task-95 ②「建会话 → 发消息 → 等终态」一条命令（drive）────────────────────────────
// 卡面判据：一条命令给回「会话 id / 事件数 / 终态 / 耗时 / 是否报错」的**机读**结果，
// 且是 receipt 形态（task-93 同一份契约）。三条硬要求由用例钉着：
//   ① 白名单只减「未知门」这一类，且只在 gate === 'drive-chat' 时减（别的未注册 gate 必须仍报错）；
//   ② receipt 落盘目录与 gate 批次分离（否则 gate-receipt-read 读到未知门 ⇒ 整批判 ERROR）；
//   ③ 0 事件 / 超时 / 未受理 ⇒ error，不许 pass（假绿判据）。

// 用真 createReceipt 造（不手写对象）：字段集与 schemaVersion 跟着契约走，
// 有人改契约时这里会跟着变，而不是留下一份自造的平行形状。
function baseDriveReceipt({ verdict, code, events, drive = {}, reason = null }) {
  return {
    ...createReceipt({
      gate: DRIVE_GATE,
      verdict,
      code,
      numbers: { events, waitedMs: 12, polls: 1 },
      command: 'node scripts/xihe.mjs drive --workspace ws-1 --content <4 chars> --timeout 5',
      durationMs: 12,
      executed: { events },
      reason,
      at: '2026-11-16T12:00:00.000Z',
    }),
    drive: { sessionId: 's-1', runId: 'run-1', events, ...drive },
  };
}

test('task-95 ② drive: receipt 契约只白名单减「未知门」，落盘目录与门批次隔离', async () => {
  // ① 正向：drive receipt 结构合法（说明共享校验器 + 白名单这条缝只差成员资格一项）。
  const ok = baseDriveReceipt({ verdict: 'pass', code: 'OK', events: 3 });
  assert.deepEqual(validateDriveReceipt(ok), { ok: true, problems: [] });

  // ② 反过来钉住耦合：共享校验器对同一条 receipt 只报一条 problem，且它就是「未知门」那一类。
  //    哪天 task-93 改了这句文案，这条断言会红 —— 那正是必须有人重看白名单的时刻。
  const shared = validateReceipt(ok);
  assert.equal(shared.ok, false);
  assert.equal(shared.problems.length, 1, shared.problems.join('; '));
  assert.match(shared.problems[0], /^未知门 /);

  // ③ 负例（Lead 裁定② 条件 1）：塞一个**别的**未注册 gate ⇒ 必须仍然报错，
  //    白名单不许退化成「凡未知门都放行」的后门。
  const otherGate = validateDriveReceipt({ ...ok, gate: 'drive-other' });
  assert.equal(otherGate.ok, false);
  assert.ok(otherGate.problems.some((problem) => problem.startsWith('未知门 ')), otherGate.problems.join('; '));
  assert.ok(otherGate.problems.some((problem) => problem.startsWith('gate 必须是 "drive-chat"')), otherGate.problems.join('; '));

  // ④ 结构问题一个都不许被白名单吞掉。
  // task-34: 「会话从未存在」的失败 receipt（principal 发现失败/CP 拒绝 create）必须能保留可读原因：
  // sessionId='' + created:false + runId:null 合法；但已建会话或有 run 时空 sessionId 仍拒收（不放宽假绿缝）。
  const preSession = validateDriveReceipt({ ...ok, verdict: 'error', code: 'E_UNPARSABLE', reason: '无法确定 agentPrincipalId：列表为空', drive: { sessionId: '', created: false, runId: null, reason: 'PRINCIPAL_DISCOVERY_EMPTY' } });
  assert.equal(preSession.ok, true, preSession.problems.join('; '));
  const createdButEmpty = validateDriveReceipt({ ...ok, drive: { sessionId: '', created: true, runId: null } });
  assert.ok(createdButEmpty.problems.includes('drive.sessionId 为空'), '已建会话却空 id 必须仍拒收');
  const runButEmpty = validateDriveReceipt({ ...ok, drive: { sessionId: '', created: false, runId: 'r-1' } });
  assert.ok(runButEmpty.problems.includes('drive.sessionId 为空'), '已有 run 却空 id 必须仍拒收');
  const noDrive = validateDriveReceipt({ ...ok, drive: undefined });
  assert.equal(noDrive.ok, false);
  assert.ok(noDrive.problems.includes('drive 缺失：receipt 必须说清「哪个会话、哪个 run、多少个事件」'));
  const badCommand = validateDriveReceipt({ ...ok, command: '  ' });
  assert.equal(badCommand.ok, false);
  assert.ok(badCommand.problems.some((problem) => problem.includes('command 为空')), badCommand.problems.join('; '));

  // ⑤ 假绿判据（裁定③ 硬要求）：pass + 0 事件 ⇒ 假绿；fail/error 不算假绿。
  assert.equal(isDriveFakeGreen(baseDriveReceipt({ verdict: 'pass', code: 'OK', events: 0 })), true);
  assert.equal(isDriveFakeGreen(baseDriveReceipt({ verdict: 'pass', code: 'OK', events: 2 })), false);
  assert.equal(isDriveFakeGreen(baseDriveReceipt({ verdict: 'fail', code: 'E_GATE_FAILED', events: 0 })), false);

  // ⑥ 词表复用：不在 VERDICTS 里的状态词直接拒绝（不许自造第五态）。
  assert.throws(() => buildDriveReceipt({
    verdict: 'green', code: 'OK', command: 'x', durationMs: 1, executed: { events: 1 }, drive: { sessionId: 's', runId: null },
  }), /verdict 必须是/);

  // ⑦ 落盘目录分离（裁定③ 条件 2）：默认目录必须是 .tmp/xh/receipts/drive，且不在 gate 目录下。
  const root = fs.mkdtempSync(path.join(tmpdir(), 'xihe-drive-receipt-'));
  try {
    const dir = driveReceiptDir(root);
    assert.equal(dir, path.join(root, '.tmp', 'xh', 'receipts', 'drive'));
    assert.equal(/[\\/]receipts[\\/]gate([\\/]|$)/.test(dir), false, 'drive receipt 不能落进 gate 批次目录');
    const written = writeDriveReceipt({ receipt: ok, root, now: () => Date.parse('2026-11-16T12:00:00.000Z') });
    assert.equal(path.dirname(written), dir);
    assert.deepEqual(JSON.parse(fs.readFileSync(written, 'utf8')), ok);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('task-95 ② drive: 轮询 run 的四态（终态/超时/审批/HTTP 错误）互不混淆', async () => {
  const makeClient = (statuses) => {
    let index = 0;
    return {
      async call() {
        const body = statuses[Math.min(index, statuses.length - 1)];
        index += 1;
        return body === null
          ? { status: 500, body: null, code: 'INTERNAL_ERROR' }
          : { status: 200, body, code: null };
      },
    };
  };
  const noSleep = async () => {};
  let clock = 0;
  const now = () => { clock += 10; return clock; };

  const terminal = await pollRunToTerminal({
    client: makeClient([{ status: 'running' }, { status: 'succeeded', terminalOutcome: 'success' }]),
    runId: 'r-1', waitMs: 5_000, sleep: noSleep, now,
  });
  assert.equal(terminal.outcome, 'TERMINAL');
  assert.equal(terminal.status, 'succeeded');
  assert.equal(terminal.polls, 2);

  clock = 0;
  const awaiting = await pollRunToTerminal({
    client: makeClient([{ status: 'awaiting_approval' }]), runId: 'r-1', waitMs: 5_000, sleep: noSleep, now,
  });
  assert.equal(awaiting.outcome, 'AWAITING_APPROVAL');

  clock = 0;
  const httpError = await pollRunToTerminal({
    client: makeClient([null]), runId: 'r-1', waitMs: 5_000, sleep: noSleep, now,
  });
  assert.equal(httpError.outcome, 'HTTP_ERROR');

  // 超时必须自己成一个 outcome（= 无法判定 ⇒ error），不能落成「终态」，更不许 pass。
  clock = 0;
  const timedOut = await pollRunToTerminal({
    client: makeClient([{ status: 'running' }]), runId: 'r-1', waitMs: 200, sleep: noSleep, now,
  });
  assert.equal(timedOut.outcome, 'TIMEOUT');
  assert.equal(timedOut.status, 'running');
});

test('task-95 ② drive: 假 CP 上跑通一条消息到终态；四种失败一律不判 pass', async () => {
  const encoder = new TextEncoder();
  const sseStream = (frames) => new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('event: connected\ndata: {"type":"connected"}\n\n'));
      for (const name of frames) controller.enqueue(encoder.encode(`event: ${name}\ndata: {"type":"${name}"}\n\n`));
      // 故意不 close：真 CP 的流也活到客户端 abort（drive 的 stop() 负责关）。
    },
  });

  const startCp = ({ events = ['agent_delta', 'agent_done'], sseStatus = 200, runStatus = 'succeeded' } = {}) => {
    // task-34: fake CP 镜像 PLAN-0689 B3 —— SessionCreateRequest.required=[agentPrincipalId]，
    // 缺字段/空串 ⇒ 400 INVALID_REQUEST "agentPrincipalId is required"（SessionService.java:248 同款）。
    const state = { sessions: 0, deleted: 0, chats: 0, polls: 0, lastSessionBody: null, principalListCalls: 0 };
    const fetchImpl = async (url, init = {}) => {
      const target = new URL(url);
      const method = init.method ?? 'GET';
      const respond = (status, payload) => new Response(JSON.stringify(payload), {
        status, headers: { 'Content-Type': 'application/json' },
      });
      if (target.pathname === '/api/v1/provider-connections') {
        return respond(200, {
          connections: [{
            id: 'c-1', status: 'READY', enabled: true, connectionKey: 'c-1',
            apiTypeId: 'openai-chat-completions', apiTypeVersion: 1, manualModels: ['gpt-5'],
          }],
        });
      }
      if (target.pathname === '/api/v1/config/api-request-templates') {
        return respond(200, {
          templates: [{ id: 't-1', status: 'published', version: 1, apiTypeId: 'openai-chat-completions', apiTypeVersion: 1 }],
        });
      }
      if (target.pathname === '/api/v1/models') return respond(200, { models: [{ id: 'gpt-5' }] });
      if (target.pathname === '/api/v1/workspaces/ws-1/agents' && method === 'GET') {
        // WorkspaceAgentView：bound=true 才是「本工作区可用」；owned 未绑行 bound:false（不能建会话）。
        return respond(200, { agents: [
          { principalId: 'p-owned', name: 'owned-unbound', bound: false, disabled: false },
          { principalId: 'p-bound', name: 'bound-usable', bound: true, disabled: false },
        ] });
      }
      if (target.pathname === '/api/v1/agent-principals' && method === 'GET') {
        state.principalListCalls += 1;
        return respond(200, { principals: [{ principalId: 'p-list', name: 'list-row', ownership: 'USER', disabledAt: null }] });
      }
      if (target.pathname === '/api/v1/sessions' && method === 'POST') {
        state.sessions += 1;
        const createBody = init.body ? JSON.parse(init.body) : {};
        state.lastSessionBody = createBody;
        if (typeof createBody.agentPrincipalId !== 'string' || createBody.agentPrincipalId.trim() === '') {
          return respond(400, { code: 'INVALID_REQUEST', detail: 'agentPrincipalId is required' });
        }
        return respond(201, { id: 's-9' });
      }
      if (target.pathname === '/api/v1/sessions/s-9/branches') return respond(200, { items: [{ branchId: 'b-9' }] });
      if (target.pathname === '/api/v1/sessions/s-9' && method === 'DELETE') {
        state.deleted += 1;
        return new Response(null, { status: 204 });
      }
      if (target.pathname === '/api/v1/events') {
        if (sseStatus !== 200) return respond(sseStatus, { code: 'SSE_DENIED' });
        return new Response(sseStream(events), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      if (target.pathname === '/api/v1/chat' && method === 'POST') {
        state.chats += 1;
        return respond(202, { runId: 'r-9' });
      }
      if (target.pathname === '/api/v1/chat/runs/r-9') {
        state.polls += 1;
        return respond(200, {
          status: runStatus,
          terminalOutcome: runStatus === 'succeeded' ? 'success' : 'error',
          errorCode: runStatus === 'failed' ? 'AGENT_STREAM_FAILED' : null,
        });
      }
      return respond(404, { code: 'NOT_FOUND' });
    };
    return { fetchImpl, state };
  };

  // sleepImpl 注入「让出宏任务」的 sleep：既不写死真实 500 ms 轮询间隔，也不空转。
  const runDrive = async ({ cp, path: outPath }) => runCommand(
    ['drive', '--workspace', 'ws-1', '--content', 'ping', '--timeout', '5', '--out', outPath, '--json'],
    {
      env: { XIHE_TOKEN: 'drive-token' },
      fetchImpl: cp.fetchImpl,
      promptSecret: noPrompt,
      sleepImpl: () => new Promise((resolve) => setTimeout(resolve, 0)),
    },
  );

  const tmp = fs.mkdtempSync(path.join(tmpdir(), 'xihe-drive-run-'));
  try {
    // ① 正常路径：pass，receipt 里有会话 id / 事件数 / 终态 / 耗时 / 无错。
    const okCp = startCp();
    const okRun = await runDrive({ cp: okCp, path: path.join(tmp, 'ok.json') });
    assert.equal(okRun.exitCode, 0, JSON.stringify(okRun.error ?? okRun.data));
    const okReceipt = okRun.data;
    assert.equal(okReceipt.gate, DRIVE_GATE);
    assert.equal(okReceipt.verdict, 'pass');
    assert.equal(okReceipt.code, 'OK');
    assert.equal(okReceipt.drive.sessionId, 's-9');
    assert.equal(okReceipt.drive.runId, 'r-9');
    assert.equal(okReceipt.drive.terminalStatus, 'succeeded');
    assert.equal(okReceipt.drive.events, 2, 'connected 合成事件不计入事件数');
    assert.deepEqual(okReceipt.drive.eventNames, ['agent_delta', 'agent_done']);
    assert.equal(okReceipt.executed.events, 2);
    assert.equal(typeof okReceipt.durationMs, 'number');
    assert.equal(okReceipt.drive.sessionDeleted, true, '默认删掉本次建的会话');
    assert.equal(okCp.state.deleted, 1);
    // task-34: 建会话 body 必须带 agentPrincipalId（PLAN-0689 B3），且来源是只读发现而非伪造。
    assert.equal(okCp.state.lastSessionBody.agentPrincipalId, 'p-bound', 'body 必须携带已绑定 principal');
    assert.equal(okReceipt.drive.agentPrincipalId, 'p-bound');
    assert.equal(okReceipt.drive.principalSource, 'discovered:workspace-agents');
    assert.equal(okCp.state.principalListCalls, 0, 'workspace-agents 面可读时不该再打 agent-principals');
    assert.equal(validateDriveReceipt(okReceipt).ok, true);
    // 落盘与输出同一份（落盘的是纯 receipt；receiptPath 只在 CLI 输出里，指向 --out）。
    const { receiptPath, ...persisted } = okReceipt;
    assert.equal(receiptPath, path.join(tmp, 'ok.json'));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tmp, 'ok.json'), 'utf8')), persisted);

    // ② 0 事件但 run 报成功 ⇒ 假绿，必须 error（不许 pass）。
    const quietRun = await runDrive({ cp: startCp({ events: [] }), path: path.join(tmp, 'quiet.json') });
    assert.equal(quietRun.exitCode, 1);
    assert.equal(quietRun.data.verdict, 'error');
    assert.equal(quietRun.data.code, 'E_FAKE_GREEN');
    assert.equal(quietRun.data.drive.reason, 'NO_EVENTS');

    // ③ SSE 订阅不上 ⇒ 没有 run 可等，error（CP 无订阅必 409 SSE_SUBSCRIPTION_REQUIRED）。
    const noSse = startCp({ sseStatus: 409 });
    const noSseRun = await runDrive({ cp: noSse, path: path.join(tmp, 'nosse.json') });
    assert.equal(noSseRun.exitCode, 1);
    assert.equal(noSseRun.data.verdict, 'error');
    assert.equal(noSseRun.data.code, 'E_UNPARSABLE');
    assert.match(noSseRun.data.drive.reason, /^SSE_/);
    assert.equal(noSse.state.chats, 0, '连不上订阅就不该发消息');

    // ④ 终态失败 ⇒ fail（跑通了但判据不满足），与 error 分开。
    const failedRun = await runDrive({ cp: startCp({ runStatus: 'failed' }), path: path.join(tmp, 'failed.json') });
    assert.equal(failedRun.exitCode, 1);
    assert.equal(failedRun.data.verdict, 'fail');
    assert.equal(failedRun.data.code, 'E_GATE_FAILED');
    assert.equal(failedRun.data.drive.terminalStatus, 'failed');
    assert.equal(failedRun.data.drive.errorCode, 'AGENT_STREAM_FAILED');

    // ⑤ 复用既有会话 + --keep-session：不建会话、不删会话，但仍要出 receipt。
    const reuseCp = startCp();
    const reuseRun = await runCommand(
      ['drive', '--workspace', 'ws-1', '--content', 'ping', '--session', 's-9', '--keep-session',
        '--timeout', '5', '--out', path.join(tmp, 'reuse.json'), '--json'],
      {
        env: { XIHE_TOKEN: 'drive-token' },
        fetchImpl: reuseCp.fetchImpl,
        promptSecret: noPrompt,
        sleepImpl: () => new Promise((resolve) => setTimeout(resolve, 0)),
      },
    );
    assert.equal(reuseRun.exitCode, 0, JSON.stringify(reuseRun.error ?? reuseRun.data));
    assert.equal(reuseRun.data.drive.created, false, '给了 --session 就不该建会话');
    assert.equal(reuseRun.data.drive.sessionDeleted, false, '--keep-session 不许删会话');
    assert.equal(reuseCp.state.sessions, 0);
    assert.equal(reuseCp.state.deleted, 0);
    // task-34: 复用会话不建会话 ⇒ 不解析 principal（receipt 两字段保持 null，不冒充来源）。
    assert.equal(reuseRun.data.drive.agentPrincipalId, null);
    assert.equal(reuseRun.data.drive.principalSource, null);
    assert.equal(reuseCp.state.principalListCalls, 0);

    // ⑦ task-32：真 CP 契约形态的 /models（connectionId-keyed object）也必须能建会话跑通。
    //    旧 Array.isArray 门在这具 body 下 models 恒空 ⇒ VERIFY_MODEL_MISSING；此腿用真实链路
    //    同款 body（非友好输入），修复前必红、修复后转绿（变异双向见证据 README §7）。
    const objectModelsCp = startCp();
    const origFetch = objectModelsCp.fetchImpl;
    objectModelsCp.fetchImpl = async (url, init) => {
      if (new URL(url).pathname === '/api/v1/models') {
        return new Response(JSON.stringify({
          providers: {}, configRevision: 'rev-1',
          models: { 'c-1': ['catalog-model-1'], 'c-other': ['foreign-model'] },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return origFetch(url, init);
    };
    const objectRun = await runDrive({ cp: objectModelsCp, path: path.join(tmp, 'object-models.json') });
    assert.equal(objectRun.exitCode, 0, JSON.stringify(objectRun.error ?? objectRun.data));
    assert.equal(objectRun.data.verdict, 'pass');
    assert.equal(objectRun.data.drive.sessionId, 's-9');
    assert.equal(objectModelsCp.state.sessions, 1, 'object catalog 必须真的建出会话');

    // ⑥ 用法：缺 --content / 缺 workspace 都是 exit 2（用法错不是业务失败）。
    const noContent = await runCommand(['drive', '--workspace', 'ws-1', '--json'], { env: { XIHE_TOKEN: 't' }, promptSecret: noPrompt });
    assert.equal(noContent.exitCode, 2);
    assert.equal(noContent.error.code, 'INVALID_ARGUMENT');
    const noWorkspace = await runCommand(['drive', '--content', 'ping', '--json'], { env: { XIHE_TOKEN: 't' }, promptSecret: noPrompt });
    assert.equal(noWorkspace.exitCode, 2);
    assert.equal(noWorkspace.error.code, 'INVALID_ARGUMENT');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── task-32: /api/v1/models 的 object-keyed 契约（ProviderModelCatalog.models）────────────
// 根因：session-binding.mjs:142 旧口径只认 Array.isArray，真 CP 返回
// {providers:{…}, models:{<connectionId>: ["model-a"]}, configRevision} ⇒ models 恒空 ⇒
// pickModelName 三源全空 ⇒ drive/verify/run-agent-e2e 的建会话链全断（VERIFY_MODEL_MISSING）。
// 三条腿钉死：object 能选 model / array 旧形态不回归 / 空 object fail-closed 且原因可读。
function sessionBindingFakeCp(models) {
  const calls = [];
  const client = {
    async call(method, pathname) {
      calls.push({ method, pathname });
      if (pathname === '/api/v1/provider-connections') {
        return { status: 200, body: { connections: [{
          id: 'c-1', providerId: 'openai-compatible', status: 'READY', enabled: true,
          apiTypeId: 'openai-chat-completions', apiTypeVersion: 1,
        }] }, code: null };
      }
      if (pathname.startsWith('/api/v1/config/api-request-templates')) {
        return { status: 200, body: { templates: [{
          id: 't-1', status: 'published', version: 1,
          apiTypeId: 'openai-chat-completions', apiTypeVersion: 1,
        }] }, code: null };
      }
      if (pathname === '/api/v1/models') return { status: 200, body: { models }, code: null };
      throw new Error('unexpected call ' + pathname);
    },
  };
  return { client, calls };
}

test('task-32 session-binding: object-keyed /models catalog yields a usable model binding', async () => {
  // 真 CP 契约形态：models 是 connectionId → string[] 的普通对象（openapi.yaml:8436）。
  const cp = sessionBindingFakeCp({
    'c-other': ['model-for-other-connection'],
    'c-1': ['catalog-model-1', 'catalog-model-2'],
  });
  const result = await resolveSessionBinding({ client: cp.client, stack: 'stack-2' });
  assert.equal(result.error, undefined, JSON.stringify(result.error));
  assert.equal(result.binding.modelName, 'catalog-model-1');
  assert.equal(result.binding.connectionId, 'c-1');
  assert.equal(result.binding.templateId, 't-1');
  assert.equal(cp.calls.some((call) => call.pathname === '/api/v1/models'), true);
});

test('task-32 session-binding: legacy array /models catalog keeps working', async () => {
  const cp = sessionBindingFakeCp([{ id: 'legacy-model-1' }, { id: 'legacy-model-2' }]);
  const result = await resolveSessionBinding({ client: cp.client, stack: 'stack-2' });
  assert.equal(result.error, undefined, JSON.stringify(result.error));
  assert.equal(result.binding.modelName, 'legacy-model-1');
});

test('task-32 session-binding: empty object /models catalog fails closed with a readable reason', async () => {
  const cp = sessionBindingFakeCp({});
  const result = await resolveSessionBinding({ client: cp.client, stack: 'stack-2' });
  assert.equal(result.binding, undefined);
  assert.equal(result.error.code, 'VERIFY_MODEL_MISSING');
  assert.match(result.error.message, /Connection c-1 exposes no usable chat model/);
  assert.match(result.error.message, /xihe verify/);
});

test('task-32 session-binding: catalog first entry ASR, second chat ⇒ must pick the chat model', async () => {
  // infra-1c 真栈探针：首项 mimo-v2.5-asr 是语音模型，裸取第一项会把非 chat 模型钉进会话。
  const cp = sessionBindingFakeCp({ 'c-1': ['mimo-v2.5-asr', 'mimo-v2.5-chat'] });
  const result = await resolveSessionBinding({ client: cp.client, stack: 'stack-2' });
  assert.equal(result.error, undefined, JSON.stringify(result.error));
  assert.equal(result.binding.modelName, 'mimo-v2.5-chat');
});

test('task-32 session-binding: all-non-chat catalog fails closed with a readable reason', async () => {
  const cp = sessionBindingFakeCp({ 'c-1': ['mimo-v2.5-asr', 'text-embedding-3-large', 'tts-1'] });
  const result = await resolveSessionBinding({ client: cp.client, stack: 'stack-2' });
  assert.equal(result.binding, undefined);
  assert.equal(result.error.code, 'VERIFY_MODEL_MISSING');
  assert.match(result.error.message, /no usable chat model/);
  assert.match(result.error.message, /ASR\/TTS\/embedding\/image/);
});

test('task-32 session-binding: capability flags override the name screen', async () => {
  // ProviderModel objects carry capabilities.chat; an explicitly chat:false entry is rejected
  // even when its name looks neutral, and chat:true wins over a suspicious-looking name.
  const cp = sessionBindingFakeCp({ 'c-1': [
    { name: 'neutral-name', capabilities: { chat: false, vision: false, tools: false } },
    { name: 'weird-asr-sounding-but-chat', capabilities: { chat: true, vision: false, tools: true } },
  ] });
  const result = await resolveSessionBinding({ client: cp.client, stack: 'stack-2' });
  assert.equal(result.error, undefined, JSON.stringify(result.error));
  assert.equal(result.binding.modelName, 'weird-asr-sounding-but-chat');
});

// ── task-34（PLAN-0689 B3）：drive 的 agentPrincipalId 支持 ────────────────────────────────
// 根因（task-30 窗口 drive 二跑 FAIL）：POST /api/v1/sessions → 400 "agentPrincipalId is required"。
// SessionCreateRequest.required=[agentPrincipalId]（openapi.yaml），drive/bindingRequestBody 均无该字段。
// 修法（Lead 裁定）：drive.mjs 侧 spread 补字段，不动 session-binding.mjs；--principal 显式优先，
// 未指定走只读发现（workspace-agents bound 面优先，agent-principals 回落）；receipt 记来源；禁伪造 id。
// 本组用例钉死：请求体含 agentPrincipalId × 两来源分支 + 绑定校验可读原因（403/409/404）+ 发现负例 fail-closed。
const P_UUID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const P_UUID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function principalDriveFakeCp({
  wsAgents = { status: 200, body: { agents: [
    { principalId: 'p-owned', name: 'owned-unbound', bound: false, disabled: false },
    { principalId: P_UUID_B, name: 'bound-usable', bound: true, disabled: false },
  ] } },
  principals = { status: 200, body: { principals: [{ principalId: P_UUID_A, name: 'list-row', ownership: 'USER', disabledAt: null }] } },
  createReject = null,
} = {}) {
  const encoder = new TextEncoder();
  const state = { sessionBodies: [], calls: [], chats: 0, deleted: 0 };
  const fetchImpl = async (url, init = {}) => {
    const target = new URL(url);
    const method = init.method ?? 'GET';
    state.calls.push({ method, pathname: target.pathname, search: target.search, headers: init.headers ?? {} });
    const respond = (status, payload) => new Response(JSON.stringify(payload), {
      status, headers: { 'Content-Type': 'application/json' },
    });
    if (target.pathname === '/api/v1/provider-connections') {
      return respond(200, { connections: [{
        id: 'c-1', status: 'READY', enabled: true, connectionKey: 'c-1',
        apiTypeId: 'openai-chat-completions', apiTypeVersion: 1, manualModels: ['gpt-5'],
      }] });
    }
    if (target.pathname === '/api/v1/config/api-request-templates') {
      return respond(200, { templates: [{ id: 't-1', status: 'published', version: 1, apiTypeId: 'openai-chat-completions', apiTypeVersion: 1 }] });
    }
    if (target.pathname === '/api/v1/models') return respond(200, { models: { 'c-1': ['gpt-5'] } });
    if (target.pathname === '/api/v1/workspaces/ws-1/agents' && method === 'GET') {
      return respond(wsAgents.status, wsAgents.body);
    }
    if (target.pathname === '/api/v1/agent-principals' && method === 'GET') {
      // 真 CP 忽略未知 query；这里按 D-174 严格拒绝已废止的 scope（防旧口径复活）。
      if (target.searchParams.has('scope')) return respond(400, { code: 'INVALID_REQUEST', detail: 'scope is retired' });
      return respond(principals.status, principals.body);
    }
    if (target.pathname === '/api/v1/sessions' && method === 'POST') {
      const body = init.body ? JSON.parse(init.body) : {};
      state.sessionBodies.push(body);
      // B3 契约镜像：缺 principal ⇒ 400（SessionService.java:248 同款 problem）。
      if (typeof body.agentPrincipalId !== 'string' || body.agentPrincipalId.trim() === '') {
        return respond(400, { code: 'INVALID_REQUEST', detail: 'agentPrincipalId is required' });
      }
      if (createReject) return respond(createReject.status, createReject.body);
      return respond(201, { id: 's-9' });
    }
    if (target.pathname === '/api/v1/sessions/s-9/branches') return respond(200, { items: [{ branchId: 'b-9' }] });
    if (target.pathname === '/api/v1/sessions/s-9' && method === 'DELETE') {
      state.deleted += 1;
      return new Response(null, { status: 204 });
    }
    if (target.pathname === '/api/v1/events') {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('event: connected\ndata: {"type":"connected"}\n\n'));
          controller.enqueue(encoder.encode('event: agent_done\ndata: {"type":"agent_done"}\n\n'));
        },
      });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    if (target.pathname === '/api/v1/chat' && method === 'POST') {
      state.chats += 1;
      return respond(202, { runId: 'r-9' });
    }
    if (target.pathname === '/api/v1/chat/runs/r-9') {
      return respond(200, { status: 'succeeded', terminalOutcome: 'success', errorCode: null });
    }
    return respond(404, { code: 'NOT_FOUND' });
  };
  return { fetchImpl, state };
}

async function runPrincipalDrive(cp, tmp, extraArgs = []) {
  return runCommand(
    ['drive', '--workspace', 'ws-1', '--content', 'ping', '--timeout', '5',
      '--out', path.join(tmp, `drive-${Math.random().toString(36).slice(2)}.json`), '--json', ...extraArgs],
    {
      env: { XIHE_TOKEN: 'drive-token' },
      fetchImpl: cp.fetchImpl,
      promptSecret: noPrompt,
      sleepImpl: () => new Promise((resolve) => setTimeout(resolve, 0)),
    },
  );
}

test('task-34 drive: explicit --principal goes into the session body and receipt records source=explicit', async () => {
  const cp = principalDriveFakeCp();
  const tmp = fs.mkdtempSync(path.join(tmpdir(), 'xihe-drive-principal-'));
  try {
    const run = await runPrincipalDrive(cp, tmp, ['--principal', P_UUID_A]);
    assert.equal(run.exitCode, 0, JSON.stringify(run.error ?? run.data));
    assert.equal(run.data.verdict, 'pass');
    // 请求体钉死：agentPrincipalId = 显式值，且既有 binding 字段一个不丢（spread 不是替换）。
    assert.equal(cp.state.sessionBodies.length, 1);
    const body = cp.state.sessionBodies[0];
    assert.equal(body.agentPrincipalId, P_UUID_A);
    assert.equal(body.providerConnectionId, 'c-1');
    assert.equal(body.modelName, 'gpt-5');
    assert.equal(body.contextTemplateId, 't-1');
    assert.equal(body.contextTemplateLayer, 'user');
    assert.equal(body.contextTemplateVersion, 1);
    // receipt 来源 = explicit；可复现命令行带 --principal。
    assert.equal(run.data.drive.agentPrincipalId, P_UUID_A);
    assert.equal(run.data.drive.principalSource, 'explicit');
    assert.ok(run.data.command.includes(`--principal ${P_UUID_A}`), run.data.command);
    // 显式给了就不做发现（两个 GET 面都不该被打）。
    assert.equal(cp.state.calls.some((c) => c.pathname === '/api/v1/workspaces/ws-1/agents'), false);
    assert.equal(cp.state.calls.some((c) => c.pathname === '/api/v1/agent-principals'), false);
    assert.equal(validateDriveReceipt(run.data).ok, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('task-34 drive: discovery prefers the bound workspace-agents face; fallback face stays untouched', async () => {
  const cp = principalDriveFakeCp();
  const tmp = fs.mkdtempSync(path.join(tmpdir(), 'xihe-drive-principal-'));
  try {
    const run = await runPrincipalDrive(cp, tmp);
    assert.equal(run.exitCode, 0, JSON.stringify(run.error ?? run.data));
    // bound:false 的 owned 行必须跳过，取 bound:true 行。
    assert.equal(cp.state.sessionBodies[0].agentPrincipalId, P_UUID_B);
    assert.equal(run.data.drive.agentPrincipalId, P_UUID_B);
    assert.equal(run.data.drive.principalSource, 'discovered:workspace-agents');
    assert.equal(cp.state.calls.some((c) => c.pathname === '/api/v1/agent-principals'), false, '首选面可用就不许打回落面');
    // 发现是只读的：全程无 POST /agent-principals、无 PUT 绑定（禁伪造/禁自动建）。
    assert.equal(cp.state.calls.some((c) => c.method !== 'GET' && c.pathname.includes('agent')), false);
    // 发现来源不冒充显式参数：命令行不带 --principal。
    assert.equal(run.data.command.includes('--principal'), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('task-34 drive: workspace face unreadable ⇒ falls back to GET /agent-principals?workspaceId (source recorded)', async () => {
  const cp = principalDriveFakeCp({ wsAgents: { status: 403, body: { code: 'WORKSPACE_FORBIDDEN', detail: 'not a member' } } });
  const tmp = fs.mkdtempSync(path.join(tmpdir(), 'xihe-drive-principal-'));
  try {
    const run = await runPrincipalDrive(cp, tmp);
    assert.equal(run.exitCode, 0, JSON.stringify(run.error ?? run.data));
    assert.equal(cp.state.sessionBodies[0].agentPrincipalId, P_UUID_A);
    assert.equal(run.data.drive.principalSource, 'discovered:agent-principals');
    const listCall = cp.state.calls.find((c) => c.pathname === '/api/v1/agent-principals');
    assert.equal(listCall.search, '?workspaceId=ws-1', '回落面必须带 workspaceId query（reach 语义）');
    assert.equal(listCall.headers['X-Workspace-Id'], 'ws-1');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('task-34 drive: fallback skips disabled rows; all-disabled or empty lists fail closed with readable reasons', async () => {
  const tmp = fs.mkdtempSync(path.join(tmpdir(), 'xihe-drive-principal-'));
  try {
    // ① 首行 disabledAt 非空 ⇒ 跳过，取第二行。
    const skipCp = principalDriveFakeCp({
      wsAgents: { status: 404, body: { code: 'NOT_FOUND' } },
      principals: { status: 200, body: { principals: [
        { principalId: P_UUID_A, disabledAt: '2026-11-16T00:00:00Z' },
        { principalId: P_UUID_B, disabledAt: null },
      ] } },
    });
    const skipRun = await runPrincipalDrive(skipCp, tmp);
    assert.equal(skipRun.exitCode, 0, JSON.stringify(skipRun.error ?? skipRun.data));
    assert.equal(skipCp.state.sessionBodies[0].agentPrincipalId, P_UUID_B);

    // ② 回落面全停用 ⇒ error，不建会话（禁拿停用 principal 硬闯）。
    const emptyCp = principalDriveFakeCp({
      wsAgents: { status: 404, body: { code: 'NOT_FOUND' } },
      principals: { status: 200, body: { principals: [{ principalId: P_UUID_A, disabledAt: '2026-11-16T00:00:00Z' }] } },
    });
    const emptyRun = await runPrincipalDrive(emptyCp, tmp);
    assert.equal(emptyRun.exitCode, 1);
    assert.equal(emptyRun.data.verdict, 'error');
    assert.equal(emptyRun.data.drive.reason, 'PRINCIPAL_DISCOVERY_EMPTY');
    assert.match(emptyRun.data.reason, /--principal/);
    assert.equal(emptyCp.state.sessionBodies.length, 0, '发现失败绝不建会话');
    assert.equal(emptyCp.state.chats, 0);

    // ③ workspace 面可读但只有 owned 未绑行 ⇒ PRINCIPAL_NONE_BOUND（不能拿 bound:false 建会话）。
    const noneCp = principalDriveFakeCp({
      wsAgents: { status: 200, body: { agents: [{ principalId: 'p-owned', bound: false, disabled: false }] } },
    });
    const noneRun = await runPrincipalDrive(noneCp, tmp);
    assert.equal(noneRun.exitCode, 1);
    assert.equal(noneRun.data.drive.reason, 'PRINCIPAL_NONE_BOUND');
    assert.match(noneRun.data.reason, /绑定/);
    assert.equal(noneCp.state.sessionBodies.length, 0);

    // ④ 两个面都不可读 ⇒ PRINCIPAL_DISCOVERY_FAILED，两面状态都写进原因（fail-closed，不伪造）。
    const deadCp = principalDriveFakeCp({
      wsAgents: { status: 500, body: { code: 'INTERNAL_ERROR' } },
      principals: { status: 403, body: { code: 'FORBIDDEN', detail: 'membership required' } },
    });
    const deadRun = await runPrincipalDrive(deadCp, tmp);
    assert.equal(deadRun.exitCode, 1);
    assert.equal(deadRun.data.drive.reason, 'PRINCIPAL_DISCOVERY_FAILED');
    assert.match(deadRun.data.reason, /HTTP 500/);
    assert.match(deadRun.data.reason, /HTTP 403 FORBIDDEN/);
    assert.match(deadRun.data.reason, /membership required/);
    assert.equal(deadCp.state.sessionBodies.length, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('task-34 drive: CP binding rejections (403/409/404) surface readable reasons with the principal identity', async () => {
  const tmp = fs.mkdtempSync(path.join(tmpdir(), 'xihe-drive-principal-'));
  try {
    const cases = [
      { status: 403, body: { code: 'FORBIDDEN', detail: 'Agent principal holds no role binding for this Workspace' }, hint: /绑定|PUT \/api\/v1\/workspaces/ },
      { status: 409, body: { code: 'AGENT_PRINCIPAL_DISABLED', detail: 'Agent principal is disabled' }, hint: /停用/ },
      { status: 404, body: { code: 'AGENT_PRINCIPAL_NOT_FOUND', detail: 'Agent principal not found' }, hint: /agent list/ },
    ];
    for (const reject of cases) {
      const cp = principalDriveFakeCp({ createReject: reject });
      const run = await runPrincipalDrive(cp, tmp, ['--principal', P_UUID_A]);
      assert.equal(run.exitCode, 1);
      assert.equal(run.data.verdict, 'error');
      assert.equal(run.data.drive.reason, 'SESSION_CREATE_FAILED');
      // 可读原因三要素：CP code + detail 原文 + 处置指引；并点名是哪个 principal、什么来源。
      assert.ok(run.data.reason.includes(reject.body.code), run.data.reason);
      assert.ok(run.data.reason.includes(reject.body.detail), run.data.reason);
      assert.match(run.data.reason, reject.hint);
      assert.ok(run.data.reason.includes(`principal=${P_UUID_A}`), run.data.reason);
      assert.ok(run.data.reason.includes('source=explicit'), run.data.reason);
      // 被拒后不许发消息、不许删别人的会话。
      assert.equal(cp.state.chats, 0);
      assert.equal(cp.state.deleted, 0);
      assert.equal(run.data.drive.created, false);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('task-34 drive: --principal shape is validated as usage (exit 2); missing flag value is refused', async () => {
  const notUuid = await runCommand(
    ['drive', '--workspace', 'ws-1', '--content', 'ping', '--principal', 'not-a-uuid', '--json'],
    { env: { XIHE_TOKEN: 't' }, promptSecret: noPrompt },
  );
  assert.equal(notUuid.exitCode, 2);
  assert.equal(notUuid.error.code, 'INVALID_ARGUMENT');
  assert.match(notUuid.error.message, /--principal/);
  const noValue = await runCommand(
    ['drive', '--workspace', 'ws-1', '--content', 'ping', '--principal', '--json'],
    { env: { XIHE_TOKEN: 't' }, promptSecret: noPrompt },
  );
  assert.equal(noValue.exitCode, 2);
  assert.equal(noValue.error.code, 'INVALID_ARGUMENT');
});

test('task-34 drive: help usage advertises --principal (static drift gate)', async () => {
  const result = await runCommand(['help'], { env: {}, promptSecret: noPrompt });
  assert.equal(result.exitCode, 0);
  assert.match(result.data.help, /drive --workspace <wsId> \(--content <text> \| --content-file <path>\) \[--principal <agentPrincipalId>\]/);
});

// ── task-38（PLAN-0689 B3 第二/三消费方）：verify / run-agent-e2e 复用 drive 的 --principal + 只读发现口径 ──
// 根因（task-34 遗留②）：两文件建会话链虽已带 agentPrincipalId，但 principal 解析偏离 drive 口径——
// verify 旧发现读裸数组（真 CP 回 {agents:[WorkspaceAgentView]}，含 bound/disabled）⇒ 真栈恒失败→create+bind 假绿；
// run-agent-e2e 用 A5a 探针行、无 --principal/无发现复用。Lead 裁定 Q1=b：纯只读发现+fail-closed，去 create+bind 兜底。
// 本组钉死：body 含 agentPrincipalId × 两来源分支（explicit/discovered:*）+ 发现负例 fail-closed + 用法校验 + help 静态门。
const V_UUID_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const V_UUID_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function runVerifyWith(cp, extraArgs = [], extraEnv = {}) {
  return runCommand(
    ['verify', '--stack', 'stack-1', '--email', 'admin@xihe.local', '--workspace', 'ws-1', '--yes', ...extraArgs],
    {
      env: { ...cp.env, ...extraEnv },
      spawnSyncImpl: cp.spawnSyncImpl,
      promptSecret: noPrompt,
      stdout: sink(),
      stderr: sink(),
    },
  );
}

test('task-38 verify: explicit --principal goes into the session body; source=explicit; discovery faces untouched', async (t) => {
  const cp = await startVerifyCpMock();
  t.after(cp.close);
  const result = await runVerifyWith(cp, ['--principal', V_UUID_A]);
  assert.equal(result.exitCode, 0, JSON.stringify(result.error ?? result.data?.a));
  assert.equal(result.data.agentPrincipalId, V_UUID_A);
  assert.equal(result.data.principalSource, 'explicit');
  assert.equal(result.data.cleanup.principal.status, 'reused');
  const sessionCall = cp.state.calls.find((c) => c.method === 'POST' && c.pathname === '/api/v1/sessions');
  assert.equal(sessionCall.body.agentPrincipalId, V_UUID_A);
  // binding 六字段一个不丢（spread 非替换）。
  assert.equal(sessionCall.body.providerConnectionId, 'conn-1');
  assert.equal(sessionCall.body.contextTemplateId, 'tpl-user');
  // 显式给了就不做 A4 发现：建会话前不许打两个发现面（A5 探针其后合法 GET workspace-agents）。
  const sessionIdx = cp.state.calls.findIndex((c) => c.method === 'POST' && c.pathname === '/api/v1/sessions');
  assert.equal(cp.state.calls.slice(0, sessionIdx).some((c) => c.pathname === '/api/v1/workspaces/ws-1/agents'), false);
  assert.equal(cp.state.calls.slice(0, sessionIdx).some((c) => c.pathname === '/api/v1/agent-principals'), false);
  assert.equal(result.data.principalSource, 'explicit');
});

test('task-38 verify: XIHE_VERIFY_AGENT_PRINCIPAL_ID env is an explicit source (UUID validated)', async (t) => {
  const cp = await startVerifyCpMock();
  t.after(cp.close);
  const result = await runVerifyWith(cp, [], { XIHE_VERIFY_AGENT_PRINCIPAL_ID: V_UUID_B });
  assert.equal(result.exitCode, 0, JSON.stringify(result.error ?? result.data?.a));
  assert.equal(result.data.agentPrincipalId, V_UUID_B);
  assert.equal(result.data.principalSource, 'explicit');
  const sessionCall = cp.state.calls.find((c) => c.method === 'POST' && c.pathname === '/api/v1/sessions');
  assert.equal(sessionCall.body.agentPrincipalId, V_UUID_B);
});

test('task-38 verify: discovery prefers the bound workspace-agents face; skips owned-unbound and disabled rows', async (t) => {
  const cp = await startVerifyCpMock({
    existingPrincipal: null,
    wsAgentsFace: { status: 200, body: { agents: [
      { principalId: 'p-owned', name: 'owned-unbound', bound: false, disabled: false },
      { principalId: 'p-disabled', name: 'bound-disabled', bound: true, disabled: true },
      { principalId: V_UUID_B, name: 'bound-usable', bound: true, disabled: false },
    ] } },
  });
  t.after(cp.close);
  const result = await runVerifyWith(cp);
  assert.equal(result.exitCode, 0, JSON.stringify(result.error ?? result.data?.a));
  assert.equal(result.data.agentPrincipalId, V_UUID_B);
  assert.equal(result.data.principalSource, 'discovered:workspace-agents');
  const sessionCall = cp.state.calls.find((c) => c.method === 'POST' && c.pathname === '/api/v1/sessions');
  assert.equal(sessionCall.body.agentPrincipalId, V_UUID_B);
  // 首选面可用就不打回落面；发现全程只 GET（禁伪造/自动建）。A5 探针其后合法 GET workspace-agents。
  const sessionIdx = cp.state.calls.findIndex((c) => c.method === 'POST' && c.pathname === '/api/v1/sessions');
  assert.equal(cp.state.calls.some((c) => c.method === 'GET' && c.pathname === '/api/v1/agent-principals'), false);
  // 首个 workspace-agents GET（=A4 发现）必须发生在建会话之前。
  const firstFaceIdx = cp.state.calls.findIndex((c) => c.method === 'GET' && c.pathname === '/api/v1/workspaces/ws-1/agents');
  assert.ok(firstFaceIdx >= 0 && firstFaceIdx < sessionIdx);
  assert.equal(cp.state.calls.some((c) => c.method === 'POST' && c.pathname === '/api/v1/agent-principals' && String(c.body?.name ?? '') === 'xihe-verify'), false);
});

test('task-38 verify: workspace face unreadable ⇒ falls back to GET /agent-principals?workspaceId (source recorded)', async (t) => {
  const cp = await startVerifyCpMock({
    existingPrincipal: null,
    wsAgentsFace: { status: 403, body: { code: 'WORKSPACE_FORBIDDEN', detail: 'not a member' } },
    principalsFace: { status: 200, body: { principals: [{ principalId: V_UUID_A, name: 'list-row', ownership: 'USER', disabledAt: null }] } },
  });
  t.after(cp.close);
  const result = await runVerifyWith(cp);
  assert.equal(result.exitCode, 0, JSON.stringify(result.error ?? result.data?.a));
  assert.equal(result.data.agentPrincipalId, V_UUID_A);
  assert.equal(result.data.principalSource, 'discovered:agent-principals');
  const listCall = cp.state.calls.find((c) => c.method === 'GET' && c.pathname === '/api/v1/agent-principals');
  assert.equal(listCall.search, '?workspaceId=ws-1', '回落面必须带 workspaceId query（reach 语义）');
  assert.equal(listCall.headers['x-workspace-id'], 'ws-1');
});

test('task-38 verify: discovery fail-closed (none-bound / empty / both-faces-dead) ⇒ no session, no chat, no create', async (t) => {
  // ① workspace 面只有 owned 未绑行 ⇒ PRINCIPAL_NONE_BOUND。
  const noneCp = await startVerifyCpMock({
    existingPrincipal: null,
    wsAgentsFace: { status: 200, body: { agents: [{ principalId: 'p-owned', bound: false, disabled: false }] } },
  });
  t.after(noneCp.close);
  const noneRun = await runVerifyWith(noneCp);
  assert.equal(noneRun.exitCode, 1);
  assert.equal(noneRun.data.a.code, 'PRINCIPAL_NONE_BOUND');
  assert.match(noneRun.data.a.message, /绑定|--principal/);
  assert.equal(noneCp.state.calls.some((c) => c.pathname === '/api/v1/sessions'), false);
  assert.equal(noneCp.state.calls.some((c) => c.pathname === '/api/v1/chat'), false);

  // ② 回落面全停用 ⇒ PRINCIPAL_DISCOVERY_EMPTY。
  const emptyCp = await startVerifyCpMock({
    existingPrincipal: null,
    wsAgentsFace: { status: 404, body: { code: 'NOT_FOUND' } },
    principalsFace: { status: 200, body: { principals: [{ principalId: V_UUID_A, disabledAt: '2026-11-16T00:00:00Z' }] } },
  });
  t.after(emptyCp.close);
  const emptyRun = await runVerifyWith(emptyCp);
  assert.equal(emptyRun.exitCode, 1);
  assert.equal(emptyRun.data.a.code, 'PRINCIPAL_DISCOVERY_EMPTY');
  assert.equal(emptyCp.state.calls.some((c) => c.pathname === '/api/v1/sessions'), false);

  // ③ 两面都不可读 ⇒ PRINCIPAL_DISCOVERY_FAILED，两面状态都写进原因。
  const deadCp = await startVerifyCpMock({
    existingPrincipal: null,
    wsAgentsFace: { status: 500, body: { code: 'INTERNAL_ERROR' } },
    principalsFace: { status: 403, body: { code: 'FORBIDDEN', detail: 'membership required' } },
  });
  t.after(deadCp.close);
  const deadRun = await runVerifyWith(deadCp);
  assert.equal(deadRun.exitCode, 1);
  assert.equal(deadRun.data.a.code, 'PRINCIPAL_DISCOVERY_FAILED');
  assert.match(deadRun.data.a.message, /HTTP 500/);
  assert.match(deadRun.data.a.message, /HTTP 403 FORBIDDEN/);
  assert.equal(deadCp.state.calls.some((c) => c.pathname === '/api/v1/sessions'), false);
  // fail-closed 绝不 create+bind principal（Q1=b：去掉自给自足兜底）。
  assert.equal(deadCp.state.calls.some((c) => c.method === 'POST' && c.pathname === '/api/v1/agent-principals'), false);
});

test('task-38 verify: CP session-create rejections (403/409/404) surface readable reasons with principal identity', async (t) => {
  const cases = [
    { status: 403, body: { code: 'FORBIDDEN', detail: 'Agent principal holds no role binding for this Workspace' } },
    { status: 409, body: { code: 'AGENT_PRINCIPAL_DISABLED', detail: 'Agent principal is disabled' } },
    { status: 404, body: { code: 'AGENT_PRINCIPAL_NOT_FOUND', detail: 'Agent principal not found' } },
  ];
  for (const reject of cases) {
    const cp = await startVerifyCpMock({ sessionCreateReject: reject });
    t.after(cp.close);
    const result = await runVerifyWith(cp, ['--principal', V_UUID_A]);
    assert.equal(result.exitCode, 1);
    assert.equal(result.data.a.code, 'SESSION_CREATE_FAILED');
    assert.ok(result.data.a.message.includes(reject.body.code), result.data.a.message);
    assert.ok(result.data.a.message.includes(reject.body.detail), result.data.a.message);
    assert.ok(result.data.a.message.includes(`principal=${V_UUID_A}`), result.data.a.message);
    assert.ok(result.data.a.message.includes('source=explicit'), result.data.a.message);
    // 被拒后不许发消息。
    assert.equal(cp.state.calls.some((c) => c.pathname === '/api/v1/chat'), false);
  }
});

test('task-38 verify: --principal shape is validated as usage (exit 2); missing flag value is refused', async () => {
  const notUuid = await runCommand(
    ['verify', '--stack', 'stack-1', '--email', 'admin@xihe.local', '--workspace', 'ws-1', '--principal', 'not-a-uuid', '--yes'],
    { env: { XIHE_DEV_ADMIN_PASSWORD: TEST_PASSWORD }, promptSecret: noPrompt, spawnSyncImpl: () => ({ status: 0, stdout: JSON.stringify({ env: {} }), stderr: '' }) },
  );
  assert.equal(notUuid.exitCode, 2);
  assert.equal(notUuid.error.code, 'INVALID_ARGUMENT');
  assert.match(notUuid.error.message, /--principal/);
  const noValue = await runCommand(
    ['verify', '--stack', 'stack-1', '--email', 'admin@xihe.local', '--workspace', 'ws-1', '--principal', '--yes'],
    { env: { XIHE_DEV_ADMIN_PASSWORD: TEST_PASSWORD }, promptSecret: noPrompt },
  );
  assert.equal(noValue.exitCode, 2);
  assert.equal(noValue.error.code, 'INVALID_ARGUMENT');
});

test('task-38 verify: help usage advertises --principal (static drift gate)', async () => {
  const result = await runCommand(['help'], { env: {}, promptSecret: noPrompt });
  assert.equal(result.exitCode, 0);
  assert.match(result.data.help, /verify --stack <n> --email <account> --workspace <wsId> \[--principal <agentPrincipalId>\]/);
});

test('task-38 run-agent-e2e: explicit --principal goes into both session bodies; source=explicit; no discovery GET', async () => {
  const { runAgentE2E } = await import('./xihe-cli/run-agent-e2e.mjs');
  const env = { XIHE_DEV_ADMIN_PASSWORD: TEST_PASSWORD };
  const state = { sessionBodies: [], discoveryGets: 0, patches: [], chats: 0 };
  const fakeFetch = async (url, init = {}) => {
    const target = new URL(url);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    const respond = (status, payload, headers = {}) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json', ...headers } });
    if (target.pathname === '/api/v1/auth/login') return respond(200, { accessToken: 't' });
    if (target.pathname === '/api/v1/agent-principals' && method === 'GET') {
      if (target.searchParams.has('scope')) return respond(400, { code: 'INVALID_REQUEST' });
      return respond(200, { principals: [] });
    }
    if (target.pathname === '/api/v1/agent-principals' && method === 'POST') {
      const probe = String(body?.name ?? '');
      if (probe.startsWith('xihe-verify-personal-')) return respond(201, { principalId: 'p-9', ownership: 'USER' });
      return respond(201, { principalId: 'p-10', ownership: 'USER' });
    }
    if (target.pathname === '/api/v1/workspaces/ws-1/agents' && method === 'GET') {
      state.discoveryGets += 1;
      const agents = [{ principalId: 'p-9', bound: false, disabled: false, source: 'personal' }];
      if (state.workspaceBound) agents.push({ principalId: 'p-10', bound: true, disabled: false, source: 'workspace' });
      return respond(200, { agents });
    }
    if (target.pathname === '/api/v1/workspaces/ws-1/agents/p-9' && (method === 'PUT' || method === 'DELETE')) {
      return method === 'PUT' ? respond(200, {}) : new Response(null, { status: 204 });
    }
    if (target.pathname === '/api/v1/workspaces/ws-1/agents/p-10' && method === 'PUT') { state.workspaceBound = true; return respond(200, {}); }
    if (target.pathname === '/api/v1/workspaces/ws-1/agents/p-10' && method === 'DELETE') { state.workspaceBound = false; return new Response(null, { status: 204 }); }
    if (target.pathname === '/api/v1/workspaces/ws-1/agents/' + V_UUID_A && method === 'PUT') return respond(200, {});
    if (target.pathname === '/api/v1/provider-connections' && method === 'GET') return respond(200, { connections: [{ id: 'c-1', status: 'READY', enabled: true, connectionKey: 'c-1', manualModels: ['gpt-5'], ...(state.patches.length > 0 ? { maxInflight: 1 } : {}) }] });
    if (target.pathname === '/api/v1/provider-connections/c-1' && method === 'PATCH') { state.patches.push(body); return respond(200, { connection: { id: 'c-1', ...body } }); }
    if (target.pathname === '/api/v1/config/api-request-templates' && method === 'GET') return respond(200, { templates: [{ id: 't-1', status: 'published', version: 1 }] });
    if (target.pathname === '/api/v1/sessions' && method === 'POST') {
      state.sessionBodies.push(body);
      if (typeof body?.agentPrincipalId !== 'string' || !body.agentPrincipalId) return respond(400, { code: 'INVALID_REQUEST', detail: 'agentPrincipalId is required' });
      return respond(201, { id: 's-1' });
    }
    if (target.pathname === '/api/v1/sessions/s-1/branches' && method === 'GET') return respond(200, { items: [{ branchId: 'b-1' }] });
    if (target.pathname === '/api/v1/sessions/s-1' && method === 'DELETE') return new Response(null, { status: 204 });
    if (target.pathname === '/api/v1/chat' && method === 'POST') {
      if (state.patches.length >= 2) return respond(202, { runId: 'r-after' });
      state.chats += 1;
      if (state.chats === 1) return respond(202, { runId: 'r-1' });
      return respond(429, { code: 'RESOURCE_EXHAUSTED', retryAfterSeconds: 1, resourceKind: 'CONNECTION', scope: 'ws-1' }, { 'Retry-After': '1' });
    }
    if (target.pathname.startsWith('/api/v1/chat/runs/') && method === 'POST') return respond(200, {});
    return respond(404, { code: 'NOT_FOUND' });
  };
  const result = await runAgentE2E({
    env, fetchImpl: fakeFetch,
    options: { '--cp': 'http://cp-fake', '--ui-workspace': 'ws-1', '--principal': V_UUID_A },
  });
  assert.equal(result.exitCode, 0, JSON.stringify(result.error ?? result.data?.steps));
  assert.equal(result.data.agentPrincipalId, V_UUID_A);
  assert.equal(result.data.principalSource, 'explicit');
  assert.equal(state.sessionBodies.length, 2);
  for (const sessionBody of state.sessionBodies) assert.equal(sessionBody.agentPrincipalId, V_UUID_A);
});

test('task-38 run-agent-e2e: --principal shape validated as usage (exit 2)', async () => {
  const { main } = await import('./xihe-cli/run-agent-e2e.mjs');
  const env = { XIHE_DEV_ADMIN_PASSWORD: TEST_PASSWORD };
  const result = await main(['--cp', 'http://cp-fake', '--ui-workspace', 'ws-1', '--principal', 'not-a-uuid', '--json'], {
    env, fetchImpl: async () => { throw new Error('must not fetch'); },
  });
  assert.equal(result, 2);
});

test('task-38 run-agent-e2e: help advertises --principal (static drift gate)', async () => {
  const { main } = await import('./xihe-cli/run-agent-e2e.mjs');
  let help = '';
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => { help += String(chunk); return true; };
  try { await main(['--help']); } finally { process.stdout.write = originalWrite; }
  assert.match(help, /--principal <agentPrincipalId>/);
});
