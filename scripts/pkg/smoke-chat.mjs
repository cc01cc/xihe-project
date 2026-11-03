#!/usr/bin/env node
/**
 * PLAN-0632 M2-3 smoke: on the *installed* stack, create a session and receive a model reply.
 *
 * This runs against the packaged product (CP on its own port, PG from the bundled payload, Agent from
 * the PyInstaller onedir bundle) — nothing here is a dev stack, and nothing is mocked at the CP/Agent
 * boundary. The model itself is **scripted**: the smoke imports the built-in `mock` LLM profile
 * (`{providerId:'openai', connectionKey:'default', model:'mock'}`) through the normal config API, so
 * the reply is produced by the Agent's mock provider instead of a paid provider. That is the
 * "mock/scripted 可接受" case in the acceptance table, stated explicitly instead of implied.
 *
 * Flow (every step is logged with its HTTP status so a failure names the step, not the symptom):
 *   login (seeded admin) → import mock llm-provider → wait for Agent readiness
 *   → create workspace (direct_attach) → create Agent principal → find its binding
 *   → create session → read the root branch → subscribe `GET /api/v1/events?sessionId=`
 *   → `POST /api/v1/chat` → read the SSE stream until the run's terminal event → print the reply
 *
 * Exit codes: 0 = a reply arrived; 1 = a step failed (the step is named); 2 = not installed.
 *
 * usage: node scripts/pkg/smoke-chat.mjs [--install-dir <dir>] [--data-dir <dir>]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(PKG_DIR, '..', '..');
const DIST = join(PROJECT_ROOT, '.tmp', 'pkg');
const EVIDENCE = join(DIST, 'evidence');
const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const INSTALL_DIR = resolve(arg('--install-dir', join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Xihe')));
const DATA_DIR = resolve(arg('--data-dir', join(process.env.LOCALAPPDATA ?? '', 'Xihe')));

const steps = [];
function step(name, status, detail = {}) {
  steps.push({ name, status, ...detail });
  console.log(`${status === 'pass' ? 'PASS' : 'FAIL'} ${name}${detail.note ? ` — ${detail.note}` : ''}`);
}

function secrets() {
  // Java launcher layout: <data>/secrets/launcher.properties (java.util.Properties.store output).
  const text = readFileSync(join(DATA_DIR, 'secrets', 'launcher.properties'), 'utf8');
  const map = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const index = line.indexOf('=');
    if (index > 0) map[line.slice(0, index).trim()] = line.slice(index + 1).trim().replaceAll('\\:', '\\:');
  }
  return { adminPassword: map['admin.password'], agentToken: map['service.token'] };
}

async function call(base, method, path, { token, body, headers = {} }) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}

async function main() {
  if (!existsSync(join(INSTALL_DIR, 'app', 'ports.json'))) {
    console.error(`[smoke] not installed at ${INSTALL_DIR} (build + install first; see plans/PLAN-0632-.../verify.md)`);
    process.exit(2);
  }
  mkdirSync(EVIDENCE, { recursive: true });
  const ports = JSON.parse(readFileSync(join(INSTALL_DIR, 'app', 'ports.json'), 'utf8')).ports;
  const cp = `http://127.0.0.1:${ports.cp}`;
  const agent = `http://127.0.0.1:${ports.agent}`;
  const secret = secrets();

  // --- 1. login ------------------------------------------------------------
  const login = await call(cp, 'POST', '/api/v1/auth/login', {
    body: { identifier: 'admin@xihe.local', password: secret.adminPassword },
  });
  const token = login.json?.accessToken;
  step('login as the seeded admin', login.status === 200 && typeof token === 'string' ? 'pass' : 'fail', {
    note: `HTTP ${login.status}${token ? ` token=${token.length} chars` : ' (no accessToken)'}`,
  });
  if (!token) return finish(1, { login });

  // --- 2. scripted model ---------------------------------------------------
  const imported = await call(cp, 'POST', '/api/v1/config/import', {
    token,
    body: { 'llm-provider': { profile: { providerId: 'openai', connectionKey: 'default', model: 'mock' } } },
  });
  step('import the built-in mock llm-provider profile', imported.status < 300 ? 'pass' : 'fail', {
    note: `HTTP ${imported.status}`,
  });

  // --- 3. agent readiness --------------------------------------------------
  // The Agent's startup path is fail-closed on llm-provider, so this is the real "did the config
  // reach the Agent" assertion; the service token is the same one the launcher generated.
  let agentReady = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await call(agent, 'GET', '/internal/v1/agent/health', { token: secret.agentToken });
    if (response.status === 200) {
      agentReady = response.json;
      break;
    }
    await new Promise((done) => setTimeout(done, 1000));
  }
  step('agent reports ready after the config import', agentReady ? 'pass' : 'fail', {
    note: agentReady ? `status=${agentReady.status ?? JSON.stringify(agentReady).slice(0, 160)}` : 'no 200 within 40s',
  });

  // --- 4. workspace --------------------------------------------------------
  const hostPath = join(DATA_DIR, 'workspaces', 'smoke-ws');
  mkdirSync(hostPath, { recursive: true });
  const workspace = await call(cp, 'POST', '/api/v1/workspaces', {
    token,
    body: {
      name: `smoke-${Date.now()}`,
      storageMode: 'direct_attach',
      hostPath,
      executionMode: 'windows-host',
    },
  });
  const workspaceId = workspace.json?.id;
  step('create a direct_attach workspace', workspace.status < 300 && workspaceId ? 'pass' : 'fail', {
    note: `HTTP ${workspace.status}${workspaceId ? ` id=${workspaceId}` : ` body=${workspace.text.slice(0, 300)}`}`,
  });
  if (!workspaceId) return finish(1, { workspace });

  // --- 4b. fake-LLM provider connection + real profile ---------------------
  // `openai + model:mock` has no credentials, so the CP answers 503 LLM_NOT_CONFIGURED.
  // The e2e lane's own provisioning CLI creates a built-in `openai` connection pointed at the
  // local fake server, verifies it, and returns its connectionKey; the profile import then names
  // that connection, which is what makes the Agent's llmReady actually `ready`.
  const fakePort = process.env.SMOKE_FAKE_LLM_PORT ?? '12790';
  const prep = spawnSync(
    process.execPath,
    [
      'scripts/xihe-cli/prepare-agent-e2e-connection.mjs',
      '--cp', cp,
      '--workspace', workspaceId,
      '--fake-llm-port', fakePort,
      '--model', 'fake-openai',
      '--email', 'admin@xihe.local',
      '--password-env', 'SMOKE_ADMIN_PW',
      '--json',
    ],
    { encoding: 'utf8', env: { ...process.env, SMOKE_ADMIN_PW: secret.adminPassword }, timeout: 120_000 },
  );
  let connectionId = null;
  try {
    const parsed = JSON.parse((prep.stdout ?? '').trim() || '{}');
    connectionId = parsed.data?.connectionId ?? parsed.connectionId ?? null;
  } catch { connectionId = null; }
  step('provision the fake-LLM provider connection', prep.status === 0 && connectionId ? 'pass' : 'fail', {
    note: `exit=${prep.status} connectionId=${connectionId ?? 'none'} ${(prep.stderr ?? '').slice(0, 200)}`,
  });
  if (connectionId) {
    const imported2 = await call(cp, 'POST', '/api/v1/config/import', {
      token,
      body: {
        'llm-provider': {
          profile: { providerId: 'openai', connectionKey: 'default', model: 'fake-openai' },
        },
      },
    });
    step('import the provider profile bound to that connection', imported2.status < 300 ? 'pass' : 'fail', {
      note: `HTTP ${imported2.status} ${imported2.text.slice(0, 200)}`,
    });
    let ready = null;
    const deadline2 = Date.now() + 60_000;
    while (Date.now() < deadline2) {
      ready = await call(agent, 'GET', '/internal/v1/agent/health', { token: secret.agentToken });
      if (ready.json?.llmReady === 'ready') break;
      await new Promise((done) => setTimeout(done, 1000));
    }
    step('agent llmReady after the real profile import', ready?.json?.llmReady === 'ready' ? 'pass' : 'fail', {
      note: `llmReady=${ready?.json?.llmReady} status=${ready?.json?.status}`,
    });
  }
  // --- 5. agent principal + binding ---------------------------------------
  const principal = await call(cp, 'POST', '/api/v1/agent-principals', {
    token,
    headers: { 'X-Workspace-Id': workspaceId },
    body: { name: 'smoke-agent', scope: 'WORKSPACE' },
  });
  const principalId = principal.json?.principalId;
  if (principalId) {
    // WORKSPACE principals are created but not usable until the workspace binding exists (D26).
    const bound = await call(cp, 'PUT', `/api/v1/workspaces/${workspaceId}/agents/${principalId}`, {
      token,
      headers: { 'X-Workspace-Id': workspaceId },
      body: { permissions: [] },
    });
    step('bind the principal to the workspace', bound.status < 300 ? 'pass' : 'fail', { note: `HTTP ${bound.status} ${bound.text.slice(0, 200)}` });
  }
  step('create an agent principal', principal.status < 300 && principalId ? 'pass' : 'fail', {
    note: `HTTP ${principal.status}${principalId ? ` id=${principalId}` : ` body=${principal.text.slice(0, 300)}`}`,
  });

  const agents = await call(cp, 'GET', `/api/v1/workspaces/${workspaceId}/agents`, { token, headers: { 'X-Workspace-Id': workspaceId } });
  const listed = Array.isArray(agents.json?.agents) ? agents.json.agents : [];
  const usable = listed.find((entry) => entry.principalId === principalId) ?? listed.find((entry) => entry.bound);
  step('the principal is bound and usable in the workspace', usable?.bound || usable?.source === 'instance' ? 'pass' : 'fail', {
    note: `HTTP ${agents.status} listed=${listed.length} chosen=${usable?.principalId ?? 'none'} bound=${usable?.bound} source=${usable?.source}`,
  });
  if (!usable) return finish(1, { principal, agents });

  // --- 6. session ----------------------------------------------------------
  const session = await call(cp, 'POST', `/api/v1/workspaces/${workspaceId}/sessions`, {
    token,
    headers: { 'X-Workspace-Id': workspaceId },
    body: {
      agentPrincipalId: usable.principalId,
      title: 'installer smoke',
      // PLAN-0504: a Session binds its model identity explicitly; without this the first chat
      // answers 409 API_TYPE_REBIND_REQUIRED instead of resolving the imported profile.
      ...(connectionId
        ? { modelProvider: 'openai', modelName: 'fake-openai', providerConnectionId: connectionId }
        : {}),
    },
  });
  const sessionId = session.json?.id ?? session.json?.sessionId;
  step('create a session', session.status < 300 && sessionId ? 'pass' : 'fail', {
    note: `HTTP ${session.status}${sessionId ? ` id=${sessionId}` : ` body=${session.text.slice(0, 300)}`}`,
  });
  if (!sessionId) return finish(1, { session });

  // --- 7. branch -----------------------------------------------------------
  const sessionView = await call(cp, 'GET', `/api/v1/sessions/${sessionId}`, { token, headers: { 'X-Workspace-Id': workspaceId } });
  const branches = await call(cp, 'GET', `/api/v1/sessions/${sessionId}/branches`, { token, headers: { 'X-Workspace-Id': workspaceId } });
  const branchId =
    sessionView.json?.branchId ??
    sessionView.json?.rootBranchId ??
    sessionView.json?.currentBranchId ??
    (Array.isArray(branches.json?.items) ? branches.json.items[0]?.id ?? branches.json.items[0]?.branchId : undefined);
  step('resolve the session branch', branchId ? 'pass' : 'fail', {
    note: branchId ? `branchId=${branchId}` : `session keys=${Object.keys(sessionView.json ?? {}).join(',')}`,
  });
  if (!branchId) return finish(1, { sessionView, branches });

  // --- 8. SSE subscription -------------------------------------------------
  const controller = new AbortController();
  const events = [];
  let replyText = '';
  let terminal = null;
  const sse = await fetch(`${cp}/api/v1/events?sessionId=${sessionId}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream', 'X-Workspace-Id': workspaceId },
    signal: controller.signal,
  });
  step('open the session SSE subscription', sse.ok ? 'pass' : 'fail', { note: `HTTP ${sse.status}` });
  if (!sse.ok) return finish(1, {});

  const reading = (async () => {
    const reader = sse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const event = /^event:\s*(.+)$/m.exec(chunk)?.[1]?.trim();
        const data = /^data:\s*([\s\S]*)$/m.exec(chunk)?.[1]?.trim();
        if (!event) continue;
        events.push(event);
        if (event === 'token' && data) {
          try {
            const parsed = JSON.parse(data);
            replyText += parsed.content ?? parsed.delta ?? parsed.text ?? '';
          } catch {
            replyText += data;
          }
        }
        if (event === 'done' || event === 'run_completed' || event === 'error') {
          terminal = { event, data };
          return;
        }
      }
    }
  })();

  // --- 9. chat -------------------------------------------------------------
  const chat = await call(cp, 'POST', '/api/v1/chat', {
    token,
    headers: { 'X-Workspace-Id': workspaceId },
    body: { sessionId, branchId, content: '你好，请用一句话确认你收到了这条消息。', toolMode: 'none' },
  });
  step('enqueue the chat turn', chat.status === 202 || chat.status === 200 ? 'pass' : 'fail', {
    note: `HTTP ${chat.status}${chat.status >= 300 ? ` body=${chat.text.slice(0, 300)}` : ''}`,
  });

  await Promise.race([reading, new Promise((done) => setTimeout(done, 125_000))]);
  controller.abort();

  const gotReply = replyText.trim().length > 0;
  step('receive the model reply over SSE', gotReply ? 'pass' : 'fail', {
    note: gotReply
      ? `reply="${replyText.trim().slice(0, 200)}" terminal=${terminal?.event ?? 'none'} tokens=${events.filter((name) => name === 'token').length}`
      : `events=${[...new Set(events)].join(',') || 'none'} terminal=${terminal?.event ?? 'none'}`,
  });
  return finish(gotReply ? 0 : 1, { login, imported, workspace, principal, session, reply: replyText, terminal, eventNames: [...new Set(events)] });
}

function finish(code, detail) {
  const payload = { at: new Date().toISOString(), ok: code === 0, steps, detail: sanitize(detail) };
  mkdirSync(EVIDENCE, { recursive: true });
  writeFileSync(join(EVIDENCE, 'chat-smoke.json'), `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`[smoke] ${code === 0 ? 'PASS' : 'FAIL'} — evidence: ${join(EVIDENCE, 'chat-smoke.json')}`);
  process.exit(code);
}

/** Never write a token into the evidence file. */
function sanitize(value) {
  const clone = JSON.parse(JSON.stringify(value ?? {}));
  const scrub = (node) => {
    if (!node || typeof node !== 'object') return;
    for (const key of Object.keys(node)) {
      if (/token/i.test(key) && typeof node[key] === 'string') node[key] = `***${node[key].length} chars`;
      else scrub(node[key]);
    }
  };
  scrub(clone);
  return clone;
}

main().catch((error) => {
  console.error(`[smoke] ERROR: ${error instanceof Error ? error.message : String(error)}`);
  finish(1, { error: String(error) });
});
