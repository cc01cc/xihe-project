import { CliError, login, parseOptions, promptSecret as defaultPromptSecret, requestJson } from './provider.mjs';
import fs from 'node:fs';

// PLAN-0643 T2 (M6-1): the config domain surface. Reads are passthrough-first
// (design D23): the CLI validates only what the design fixes (layer enum,
// positional counts) and forwards CP bodies and error codes unchanged via
// preserveServerCodes (INVALID_DOMAIN, CONFIG_KEY_LOCKED, CONFIG_ENV_LOCKED,
// NOT_LOCKABLE … surface verbatim). Writes are instance-layer single keys
// (design D2, T2.2/T2.7); user/workspace layers are whole-domain via --file
// (design D1, T2.4); per-key user/workspace writes stay T2.6 (not in this PLAN).
// Locked-key 409s print a config-locks hint on stderr (V41).

const CONFIG_LAYERS = new Set(['instance', 'user', 'workspace']);
const LOCK_CODES = new Set(['CONFIG_KEY_LOCKED', 'CONFIG_ENV_LOCKED']);

function requirePositionalCount(positionals, count, usage) {
  if (positionals.length !== count) {
    throw new CliError('INVALID_ARGUMENT', `config takes exactly ${count} positional${count === 1 ? '' : 's'}: ${usage}.`);
  }
}

function requireDomain(positionals) {
  const domain = String(positionals[0] ?? '').trim();
  if (domain === '') throw new CliError('INVALID_ARGUMENT', 'A config domain is required.');
  return domain;
}

function optionalLayer(value, { fallback } = {}) {
  const layer = value ?? fallback;
  if (layer === undefined) {
    throw new CliError('INVALID_ARGUMENT', '--layer is required; use --layer user or --layer workspace.');
  }
  if (!CONFIG_LAYERS.has(layer)) {
    throw new CliError('INVALID_ARGUMENT', `--layer must be one of instance|user|workspace (got ${layer}).`);
  }
  return layer;
}

function workspaceContext(options, env) {
  const explicit = typeof options['--workspace'] === 'string' ? options['--workspace'].trim() : '';
  if (explicit !== '') return explicit;
  const fromEnv = typeof env?.XIHE_WORKSPACE_ID === 'string' ? env.XIHE_WORKSPACE_ID.trim() : '';
  return fromEnv !== '' ? fromEnv : undefined;
}

function optionalRevision(options) {
  const raw = options['--revision'];
  if (raw === undefined) return undefined;
  // CP revisions are Java `long` epoch-millis values (13 digits today), so the
  // bound is the long digit range, not the old 9-digit guess (PLAN-0643 V43).
  if (!/^\d{1,19}$/.test(String(raw))) {
    throw new CliError('INVALID_ARGUMENT', '--revision must be a non-negative integer.');
  }
  const revision = Number(raw);
  if (!Number.isSafeInteger(revision)) {
    throw new CliError('INVALID_ARGUMENT', '--revision is too large to survive a JSON round-trip safely.');
  }
  return revision;
}

function buildQuery(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const query = search.toString();
  return query === '' ? '' : `?${query}`;
}

/** V41: 409 lock rejections keep the CP code and point at the config-locks surface. */
async function hintConfigLocks(error, stderr) {
  if (error instanceof CliError && LOCK_CODES.has(error.code)) {
    stderr?.write('# hint: this config key is locked; inspect it with `xihe config-locks list <domain>` and clear it with `xihe config-locks delete <domain> <key>`.\n');
  }
  throw error;
}

// T2.1: GET /api/v1/config/{domain}. Without --layer the CLI reads the merged
// effective view and always asks for includeMeta so envOverridden is visible
// (V36); an explicit --layer reads the raw single-layer rows and adds meta only
// on --include-meta. workspaceId rides the query string (spec §7, V11).
export async function runConfigGet({ apiBase, fetchImpl, token, options, positionals, env }) {
  requirePositionalCount(positionals, 1, '<domain>');
  const domain = requireDomain(positionals);
  const layer = options['--layer'] === undefined ? undefined : optionalLayer(options['--layer']);
  const includeMeta = layer === undefined ? true : options['--include-meta'] === true;
  const workspaceId = workspaceContext(options, env);
  const body = await requestJson(
    `/api/v1/config/${encodeURIComponent(domain)}${buildQuery({ layer, workspaceId, includeMeta: includeMeta ? 'true' : undefined })}`,
    { apiBase, fetchImpl, token, preserveServerCodes: true },
  );
  const wrapped = body && typeof body === 'object' && !Array.isArray(body) && body.entries !== undefined;
  return {
    kind: 'config-get',
    domain,
    layer: layer ?? 'effective',
    includeMeta,
    ...(workspaceId !== undefined ? { workspaceId } : {}),
    entries: wrapped ? body.entries : (body ?? {}),
    ...(wrapped && body.envOverridden !== undefined ? { envOverridden: body.envOverridden } : {}),
  };
}

// T2.2: single-key instance write (design D2). CP only offers a whole-domain
// PUT, so the CLI read-modify-writes the raw instance rows (ConfigService
// layerEntries — no code defaults, no env overlay) and then re-reads to verify
// (D23). user/workspace layers are rejected CLI-side (V39) — that is T2.6.
export async function runConfigSet({ apiBase, fetchImpl, token, options, positionals, stderr }) {
  requirePositionalCount(positionals, 3, '<domain> <key> <value>');
  const [domain, key, value] = positionals.map((item) => String(item).trim());
  requireDomain([domain]);
  if (key === '') throw new CliError('INVALID_ARGUMENT', 'A config key is required.');
  if (options['--layer'] !== undefined && options['--layer'] !== 'instance') {
    throw new CliError('INVALID_ARGUMENT', 'config set only writes the instance layer; user/workspace layers support whole-domain writes only (`xihe config put`).');
  }
  const readPath = `/api/v1/config/${encodeURIComponent(domain)}${buildQuery({ layer: 'instance' })}`;
  const before = await requestJson(readPath, { apiBase, fetchImpl, token, preserveServerCodes: true });
  const current = before && typeof before === 'object' && !Array.isArray(before) ? before : {};
  const rows = { ...current, [key]: value };
  await requestJson(`/api/v1/config/instance/${encodeURIComponent(domain)}`, {
    apiBase, fetchImpl, token, method: 'PUT', body: rows, preserveServerCodes: true,
  }).catch((error) => hintConfigLocks(error, stderr));
  const after = await requestJson(readPath, { apiBase, fetchImpl, token, preserveServerCodes: true });
  const actual = after && typeof after === 'object' ? after[key] : undefined;
  if (actual !== value) {
    throw new CliError('CP_RESPONSE_INVALID', `config set verification mismatch for ${domain}.${key}; the instance row does not read back as written.`, {
      key,
      expected: value,
      actual: actual ?? null,
    });
  }
  return {
    kind: 'config-set',
    domain,
    key,
    layer: 'instance',
    before: current[key] ?? null,
    after: actual,
    changed: current[key] !== value,
    verified: true,
  };
}

// T2.7: delete one instance key (DELETE /api/v1/config/instance/{domain}/{key}).
// Idempotent on the CP side; 409 lock codes pass through with the locks hint.
export async function runConfigUnset({ apiBase, fetchImpl, token, positionals, stderr }) {
  requirePositionalCount(positionals, 2, '<domain> <key>');
  const [domain, key] = positionals.map((item) => String(item).trim());
  requireDomain([domain]);
  if (key === '') throw new CliError('INVALID_ARGUMENT', 'A config key is required.');
  await requestJson(`/api/v1/config/instance/${encodeURIComponent(domain)}/${encodeURIComponent(key)}`, {
    apiBase, fetchImpl, token, method: 'DELETE', preserveServerCodes: true,
  }).catch((error) => hintConfigLocks(error, stderr));
  return { kind: 'config-unset', domain, key, layer: 'instance', status: 'ok' };
}

// T2.3: GET /api/v1/config/{domain}/meta (layer is required by the CP; the CLI
// defaults to the admin instance view). Prints per-key source/locked/writable (V42).
export async function runConfigMeta({ apiBase, fetchImpl, token, options, positionals, env }) {
  requirePositionalCount(positionals, 1, '<domain>');
  const domain = requireDomain(positionals);
  const layer = optionalLayer(options['--layer'], { fallback: 'instance' });
  const workspaceId = workspaceContext(options, env);
  const body = await requestJson(
    `/api/v1/config/${encodeURIComponent(domain)}/meta${buildQuery({ layer, workspaceId })}`,
    { apiBase, fetchImpl, token, preserveServerCodes: true },
  );
  return {
    kind: 'config-meta',
    domain,
    layer,
    ...(workspaceId !== undefined ? { workspaceId } : {}),
    keys: Array.isArray(body?.keys) ? body.keys : [],
  };
}

// T2.4: whole-domain user/workspace write from a JSON file (design D1). The
// instance layer is rejected with a pointer to `config set`; the file must be a
// flat JSON object of string values. workspace writes need workspace context
// (query, spec §7).
export async function runConfigPut({ apiBase, fetchImpl, token, options, positionals, env, stderr, fsImpl = fs }) {
  requirePositionalCount(positionals, 1, '<domain>');
  const domain = requireDomain(positionals);
  if (options['--layer'] === 'instance') {
    throw new CliError('INVALID_ARGUMENT', 'config put does not write the instance layer; use `xihe config set <domain> <key> <value>` for single instance keys.');
  }
  const layer = optionalLayer(options['--layer']);
  const file = options['--file'];
  if (typeof file !== 'string' || file.trim() === '') {
    throw new CliError('INVALID_ARGUMENT', '--file is required and must point at a JSON entries file.');
  }
  const workspaceId = layer === 'workspace' ? workspaceContext(options, env) : undefined;
  if (layer === 'workspace' && workspaceId === undefined) {
    throw new CliError('INVALID_ARGUMENT', '--workspace (or XIHE_WORKSPACE_ID) is required for the workspace layer.');
  }
  let entries;
  try {
    entries = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new CliError('INVALID_ARGUMENT', `--file could not be read as JSON (${String(error?.message ?? error).split('\n')[0]}).`);
  }
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
    throw new CliError('INVALID_ARGUMENT', '--file must contain a JSON object of string config values.');
  }
  for (const [key, value] of Object.entries(entries)) {
    if (typeof value !== 'string') {
      throw new CliError('INVALID_ARGUMENT', `--file entry "${key}" must map to a string value.`);
    }
  }
  const path = layer === 'workspace'
    ? `/api/v1/config/workspace/${encodeURIComponent(domain)}${buildQuery({ workspaceId })}`
    : `/api/v1/config/user/${encodeURIComponent(domain)}`;
  await requestJson(path, {
    apiBase, fetchImpl, token, method: 'PUT', body: entries, preserveServerCodes: true,
  }).catch((error) => hintConfigLocks(error, stderr));
  return {
    kind: 'config-put',
    domain,
    layer,
    keys: Object.keys(entries).length,
    ...(workspaceId !== undefined ? { workspaceId } : {}),
  };
}

// T2.5: admin lock catalog, GET /api/v1/config-locks?domain= (all ADMIN).
export async function runConfigLocksList({ apiBase, fetchImpl, token, positionals }) {
  if (positionals.length > 1) {
    throw new CliError('INVALID_ARGUMENT', 'config-locks list takes at most one positional: [<domain>].');
  }
  const domain = String(positionals[0] ?? '').trim() || undefined;
  const body = await requestJson(`/api/v1/config-locks${buildQuery({ domain })}`, {
    apiBase, fetchImpl, token, preserveServerCodes: true,
  });
  return {
    kind: 'config-locks-list',
    domain: body?.domain ?? domain ?? null,
    revision: typeof body?.revision === 'number' ? body.revision : 0,
    keys: Array.isArray(body?.keys) ? body.keys : [],
  };
}

// T2.5: PUT /api/v1/config-locks/{domain}/{key}. reason is mandatory (CP A2);
// mode/value/revision are optional and forwarded as given.
export async function runConfigLocksSet({ apiBase, fetchImpl, token, options, positionals }) {
  requirePositionalCount(positionals, 2, '<domain> <key>');
  const [domain, key] = positionals.map((item) => String(item).trim());
  requireDomain([domain]);
  if (key === '') throw new CliError('INVALID_ARGUMENT', 'A config key is required.');
  const reason = options['--reason'];
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new CliError('INVALID_ARGUMENT', '--reason is required for config-locks set.');
  }
  const value = options['--value'];
  const mode = options['--mode'];
  const revision = optionalRevision(options);
  const view = await requestJson(`/api/v1/config-locks/${encodeURIComponent(domain)}/${encodeURIComponent(key)}`, {
    apiBase,
    fetchImpl,
    token,
    method: 'PUT',
    body: {
      reason,
      ...(value !== undefined ? { value } : {}),
      ...(mode !== undefined ? { mode } : {}),
      ...(revision !== undefined ? { revision } : {}),
    },
    preserveServerCodes: true,
  });
  return {
    kind: 'config-locks-set',
    domain,
    key,
    ...(view && typeof view === 'object' ? view : {}),
  };
}

// T2.5: DELETE /api/v1/config-locks/{domain}/{key}; --clear-value also drops
// the pinned instance value (CP ?clearValue=).
export async function runConfigLocksDelete({ apiBase, fetchImpl, token, options, positionals }) {
  requirePositionalCount(positionals, 2, '<domain> <key>');
  const [domain, key] = positionals.map((item) => String(item).trim());
  requireDomain([domain]);
  if (key === '') throw new CliError('INVALID_ARGUMENT', 'A config key is required.');
  const revision = optionalRevision(options);
  const clearValue = options['--clear-value'] === true;
  await requestJson(
    `/api/v1/config-locks/${encodeURIComponent(domain)}/${encodeURIComponent(key)}${buildQuery({ revision, clearValue: clearValue ? 'true' : undefined })}`,
    { apiBase, fetchImpl, token, method: 'DELETE', preserveServerCodes: true },
  );
  return {
    kind: 'config-locks-delete',
    domain,
    key,
    status: 'ok',
    ...(revision !== undefined ? { revision } : {}),
    clearValue,
  };
}

// T2.1–T2.4 dispatcher for the new config commands (import/export keep their
// existing dispatch blocks). Parsing and login live here so xihe.mjs stays thin,
// matching the T1.2–T1.5 auth pattern.
export async function runConfigCommand({
  command,
  rest,
  env,
  fetchImpl,
  apiBase,
  promptSecret = defaultPromptSecret,
  stderr = process.stderr,
  fsImpl,
}) {
  if (command === 'get') {
    const parsed = parseOptions(rest, ['--layer', '--workspace', '--email'], ['--include-meta']);
    const token = await login({ apiBase, fetchImpl, env, options: parsed.values, promptSecret });
    return { exitCode: 0, data: await runConfigGet({ apiBase, fetchImpl, token, options: parsed.values, positionals: parsed.positionals, env }) };
  }
  if (command === 'set') {
    const parsed = parseOptions(rest, ['--layer', '--email']);
    const token = await login({ apiBase, fetchImpl, env, options: parsed.values, promptSecret });
    return { exitCode: 0, data: await runConfigSet({ apiBase, fetchImpl, token, options: parsed.values, positionals: parsed.positionals, stderr }) };
  }
  if (command === 'unset') {
    const parsed = parseOptions(rest, ['--email']);
    const token = await login({ apiBase, fetchImpl, env, options: parsed.values, promptSecret });
    return { exitCode: 0, data: await runConfigUnset({ apiBase, fetchImpl, token, options: parsed.values, positionals: parsed.positionals, stderr }) };
  }
  if (command === 'meta') {
    const parsed = parseOptions(rest, ['--layer', '--workspace', '--email']);
    const token = await login({ apiBase, fetchImpl, env, options: parsed.values, promptSecret });
    return { exitCode: 0, data: await runConfigMeta({ apiBase, fetchImpl, token, options: parsed.values, positionals: parsed.positionals, env }) };
  }
  if (command === 'put') {
    const parsed = parseOptions(rest, ['--layer', '--file', '--workspace', '--email']);
    const token = await login({ apiBase, fetchImpl, env, options: parsed.values, promptSecret });
    return { exitCode: 0, data: await runConfigPut({ apiBase, fetchImpl, token, options: parsed.values, positionals: parsed.positionals, env, stderr, fsImpl }) };
  }
  throw new CliError('INVALID_ARGUMENT', 'Unknown config command; use get/set/unset/meta/put/import/export.');
}

// T2.5 dispatcher for the config-locks group (ADMIN surface).
export async function runConfigLocksCommand({
  command,
  rest,
  env,
  fetchImpl,
  apiBase,
  promptSecret = defaultPromptSecret,
}) {
  if (command === 'list') {
    const parsed = parseOptions(rest, ['--email']);
    const token = await login({ apiBase, fetchImpl, env, options: parsed.values, promptSecret });
    return { exitCode: 0, data: await runConfigLocksList({ apiBase, fetchImpl, token, positionals: parsed.positionals }) };
  }
  if (command === 'set') {
    const parsed = parseOptions(rest, ['--reason', '--value', '--mode', '--revision', '--email']);
    const token = await login({ apiBase, fetchImpl, env, options: parsed.values, promptSecret });
    return { exitCode: 0, data: await runConfigLocksSet({ apiBase, fetchImpl, token, options: parsed.values, positionals: parsed.positionals }) };
  }
  if (command === 'delete') {
    const parsed = parseOptions(rest, ['--revision', '--email'], ['--clear-value']);
    const token = await login({ apiBase, fetchImpl, env, options: parsed.values, promptSecret });
    return { exitCode: 0, data: await runConfigLocksDelete({ apiBase, fetchImpl, token, options: parsed.values, positionals: parsed.positionals }) };
  }
  throw new CliError('INVALID_ARGUMENT', 'Unknown config-locks command; use list/set/delete.');
}
