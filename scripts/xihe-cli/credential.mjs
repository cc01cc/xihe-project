import { CliError, confirmAction, getApiBase, requestJson, requireOption } from './provider.mjs';
import { writeExportFile } from './config-export.mjs';

const SERVICE_TOKEN_ENV = 'XIHE_CP_API_TOKEN';
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_MAX_BATCHES = 200;
const MAX_BATCH_SIZE = 500;

export const ROTATION_STATUS_PATH = '/internal/v1/credentials/rotation/status';
export const ROTATION_RUNS_PATH = '/internal/v1/credentials/rotation/runs';
export const CREDENTIALS_PATH = '/api/v1/credentials';

const CREDENTIAL_VIEW_FIELDS = [
  'id', 'label', 'kind', 'deliveryTier', 'ownerType', 'ownerId',
  'status', 'fingerprint', 'revision', 'referenceCount', 'createdAt', 'replacedAt',
];

export function readServiceToken(env) {
  const token = (env[SERVICE_TOKEN_ENV] ?? '').trim();
  if (!token) {
    throw new CliError(
      'MISSING_SERVICE_TOKEN',
      `Set ${SERVICE_TOKEN_ENV} to the CP service token before rotating credentials.`,
    );
  }
  return token;
}

function parsePositiveInt(value, flag, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_BATCH_SIZE) {
    throw new CliError('INVALID_ARGUMENT', `${flag} must be an integer between 1 and ${MAX_BATCH_SIZE}.`);
  }
  return parsed;
}

/**
 * PLAN-0495 M3: `credential rotate` — ring completeness check, batched
 * re-encryption until no row is pending, then the retirement check
 * (per-version counts must reach zero before an old key is removed).
 */
export async function rotateCredentials({ env, fetchImpl = fetch, options = {}, stdout = process.stdout }) {
  const apiBase = getApiBase(env);
  const token = readServiceToken(env);
  const batchSize = parsePositiveInt(options['--batch-size'], '--batch-size', DEFAULT_BATCH_SIZE);
  const maxBatches = parsePositiveInt(options['--max-batches'], '--max-batches', DEFAULT_MAX_BATCHES);
  const dryRun = options['--dry-run'] === true;

  const status = await requestJson(ROTATION_STATUS_PATH, { apiBase, fetchImpl, token });
  const missingVersions = Object.keys(status?.pendingByVersion ?? {})
    .filter((version) => !(status?.ringVersions ?? []).includes(version));
  if (missingVersions.length > 0) {
    throw new CliError(
      'KEY_RING_INCOMPLETE',
      `Pending key version(s) ${missingVersions.join(', ')} are missing from the key ring; `
        + 'extend cp.credentials.key-ring (old + new, current=new) and restart CP first.',
      { missingVersions },
    );
  }
  if (dryRun || status.pendingTotal === 0) {
    return {
      dryRun,
      rounds: 0,
      totals: { migrated: 0, conflicts: 0, failures: 0 },
      status,
    };
  }

  const totals = { migrated: 0, conflicts: 0, failures: 0 };
  let current = status;
  let rounds = 0;
  while (current.pendingTotal > 0) {
    if (rounds >= maxBatches) {
      throw new CliError(
        'ROTATION_INCOMPLETE',
        `Rotation stopped after ${maxBatches} batch(es) with ${current.pendingTotal} row(s) pending; ` +
          'triage failures (if any) and re-run to continue.',
        { pendingTotal: current.pendingTotal },
      );
    }
    const batch = await requestJson(ROTATION_RUNS_PATH, {
      apiBase,
      fetchImpl,
      token,
      method: 'POST',
      body: { batchSize },
    });
    rounds += 1;
    totals.migrated += batch?.migrated ?? 0;
    totals.conflicts += batch?.conflicts ?? 0;
    totals.failures += batch?.failures ?? 0;
    stdout.write(
      `Batch ${rounds}: migrated=${batch?.migrated ?? 0} conflicts=${batch?.conflicts ?? 0} `
        + `failures=${batch?.failures ?? 0} remaining=${batch?.remaining ?? 'unknown'}\n`,
    );
    if ((batch?.migrated ?? 0) === 0 && (batch?.conflicts ?? 0) === 0
        && (batch?.failures ?? 0) > 0 && (batch?.remaining ?? 0) > 0) {
      throw new CliError(
        'ROTATION_STALLED',
        `Rotation stalled with ${batch.remaining} row(s) pending and no progress in the current batch `
          + '(every scanned row failed to decrypt); triage those rows before retrying.',
        { remaining: batch.remaining },
      );
    }
    current = await requestJson(ROTATION_STATUS_PATH, { apiBase, fetchImpl, token });
  }
  return {
    dryRun: false,
    rounds,
    totals,
    status: current,
    retireReady: current.pendingTotal === 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PLAN-0575 M1/M2: user-facing credential surface
// (list / references / events / precheck / create / replace / delete /
//  bind / unbind / reveal). Values are read from environment variable names or a
// no-echo TTY prompt only; they are never placed in argv, logs or error text.
// ─────────────────────────────────────────────────────────────────────────────

function invalid(message) {
  return new CliError('INVALID_ARGUMENT', message);
}

function requireWorkspace(values) {
  const raw = values['--workspace'];
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw invalid('--workspace <wsId> is required for this credential command (explicit target, no CP fallback).');
  }
  return raw.trim();
}

function requireOwnerPair(values, { flagPrefix = '' } = {}) {
  const ownerType = values['--owner-type'];
  const ownerId = values['--owner-id'];
  if (ownerType === undefined && ownerId === undefined) return null;
  if (ownerType === undefined || ownerId === undefined) {
    throw invalid(`${flagPrefix}--owner-type and --owner-id must be provided together.`);
  }
  const normalized = String(ownerType).toUpperCase();
  if (normalized !== 'USER' && normalized !== 'WORKSPACE') {
    throw invalid(`${flagPrefix}--owner-type must be USER or WORKSPACE.`);
  }
  const trimmedId = String(ownerId).trim();
  if (trimmedId === '') throw invalid(`${flagPrefix}--owner-id must not be empty.`);
  return { ownerType: normalized, ownerId: trimmedId };
}

function credentialView(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new CliError('CP_RESPONSE_INVALID', 'CP returned an invalid credential payload.');
  }
  const view = {};
  for (const field of CREDENTIAL_VIEW_FIELDS) {
    if (raw[field] !== undefined) view[field] = raw[field];
  }
  if (typeof view.id !== 'string' || view.id === '') {
    throw new CliError('CP_RESPONSE_INVALID', 'CP credential payload has no id.');
  }
  return view;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) throw new CliError('CP_RESPONSE_INVALID', `CP returned an invalid ${label} list.`);
  return value;
}

function envSecretName(flag, values) {
  const name = values[flag];
  if (name === undefined) return null;
  if (typeof name !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(name)) {
    throw invalid(`${flag} must be an environment variable name.`);
  }
  return name;
}

// Secret injection channel: environment variable name, or a no-echo TTY prompt.
// Neither path ever echoes the value, and error messages only name the variable.
async function readSecret({ env, values, flag, label, promptSecret, stdin }) {
  const name = envSecretName(flag, values);
  if (name !== null) {
    const value = env[name];
    if (typeof value !== 'string' || value === '') {
      throw new CliError('SECRET_INPUT_REQUIRED', `${label} is not set in ${name}.`, { envVar: name });
    }
    return value;
  }
  if (stdin?.isTTY) {
    const value = await promptSecret(label);
    if (typeof value !== 'string' || value === '') {
      throw new CliError('SECRET_INPUT_REQUIRED', `${label} must not be empty.`);
    }
    return value;
  }
  throw new CliError(
    'SECRET_INPUT_REQUIRED',
    `Provide ${flag} <ENV_NAME>, or run in a TTY for a no-echo prompt; secret values are never accepted as arguments.`,
  );
}

function assertFlagsAllowed(values, allowed, forbidden, kind) {
  for (const flag of forbidden) {
    if (values[flag] !== undefined) throw invalid(`${flag} is not valid with --kind ${kind}.`);
  }
  return allowed;
}

function workspaceHeaders(workspace) {
  return workspace === undefined ? undefined : { 'X-Workspace-Id': workspace };
}

function csvValues(raw, flag) {
  if (typeof raw !== 'string' || raw.trim() === '') throw invalid(`${flag} requires a comma-separated list.`);
  const values = raw.split(',').map((item) => item.trim()).filter((item) => item !== '');
  if (values.length === 0) throw invalid(`${flag} requires a comma-separated list.`);
  return values;
}

export async function runCredentialList({ apiBase, fetchImpl, token, options }) {
  const owner = requireOwnerPair(options);
  const query = owner === null
    ? ''
    : `?ownerType=${encodeURIComponent(owner.ownerType)}&ownerId=${encodeURIComponent(owner.ownerId)}`;
  const response = await requestJson(`${CREDENTIALS_PATH}${query}`, {
    apiBase,
    fetchImpl,
    token,
    preserveServerCodes: true,
  });
  const credentials = requireArray(response?.credentials, 'credential').map(credentialView);
  const count = typeof response?.count === 'number' ? response.count : credentials.length;
  return { kind: 'credential-list', count, credentials };
}

export async function runCredentialReferences({ apiBase, fetchImpl, token, options, positionals }) {
  if (positionals.length !== 1) throw invalid('credential references requires exactly one credential ID.');
  const workspace = requireWorkspace(options);
  const credentialId = positionals[0].trim();
  if (credentialId === '') throw invalid('credential references requires a credential ID.');
  const response = await requestJson(`${CREDENTIALS_PATH}/${encodeURIComponent(credentialId)}/references`, {
    apiBase,
    fetchImpl,
    token,
    headers: workspaceHeaders(workspace),
    preserveServerCodes: true,
  });
  const references = requireArray(response?.references, 'reference');
  return { kind: 'credential-references', credentialId, references };
}

export async function runCredentialEvents({ apiBase, fetchImpl, token, options, positionals }) {
  if (positionals.length !== 1) throw invalid('credential events requires exactly one credential ID.');
  const workspace = requireWorkspace(options);
  const credentialId = positionals[0].trim();
  const response = await requestJson(`${CREDENTIALS_PATH}/${encodeURIComponent(credentialId)}/events`, {
    apiBase,
    fetchImpl,
    token,
    headers: workspaceHeaders(workspace),
    preserveServerCodes: true,
  });
  const events = requireArray(response?.events, 'event');
  return { kind: 'credential-events', credentialId, events };
}

export async function runCredentialPrecheck({ apiBase, fetchImpl, token, options }) {
  const permissionTokens = csvValues(options['--permissions'], '--permissions');
  // CP/UI contract (GrantIntersectionEvaluator.parse, api.ts:3053): permissions is
  // an array of {actionClass, resource?} atom objects; the CLI input notation is
  // `actionClass@resource` (resource optional). Missing resource falls back to '*'
  // on the CP side, matching the UI.
  const permissions = permissionTokens.map((token) => {
    const at = token.indexOf('@');
    if (at === -1) return { actionClass: token };
    const actionClass = token.slice(0, at).trim();
    const resource = token.slice(at + 1).trim();
    if (actionClass === '') throw invalid('--permissions entries must be actionClass or actionClass@resource.');
    return resource === '' ? { actionClass } : { actionClass, resource };
  });
  const response = await requestJson(`${CREDENTIALS_PATH}/precheck`, {
    apiBase,
    fetchImpl,
    token,
    method: 'POST',
    body: { permissions },
    preserveServerCodes: true,
  });
  const uncovered = requireArray(response?.uncovered, 'uncovered permission');
  return { kind: 'credential-precheck', permissions, uncovered };
}

export async function runCredentialCreate({
  apiBase, fetchImpl, env, token, options, positionals, promptSecret, stdin,
}) {
  if (positionals.length !== 0) throw invalid('credential create takes no positional arguments.');
  const kind = options['--kind'];
  if (kind !== 'token' && kind !== 'key_pair') throw invalid('--kind must be token or key_pair.');
  const label = requireOption(options, '--label');
  const owner = requireOwnerPair(options);
  if (owner === null) throw invalid('--owner-type and --owner-id are required for credential create.');
  const workspace = owner.ownerType === 'WORKSPACE' ? requireWorkspace(options) : undefined;
  if (owner.ownerType === 'WORKSPACE' && owner.ownerId.toLowerCase() !== workspace.toLowerCase()) {
    throw invalid('create --owner-type WORKSPACE requires --owner-id to equal --workspace.');
  }

  const body = {
    ownerType: owner.ownerType,
    ownerId: owner.ownerId,
    label,
    kind,
    // UI parity (CredentialCreateDialog.vue:37): the delivery tier defaults to
    // `lease`; CP requires an explicit tier (CredentialService.requireTier).
    deliveryTier: options['--delivery-tier'] === undefined ? 'lease' : String(options['--delivery-tier']),
  };

  if (kind === 'token') {
    assertFlagsAllowed(options, ['--secret-env'], ['--access-key-env', '--secret-key-env'], kind);
    body.token = await readSecret({
      env, values: options, flag: '--secret-env', label: 'credential token', promptSecret, stdin,
    });
  } else {
    assertFlagsAllowed(options, ['--access-key-env', '--secret-key-env'], ['--secret-env'], kind);
    body.accessKey = await readSecret({
      env, values: options, flag: '--access-key-env', label: 'credential access key', promptSecret, stdin,
    });
    body.secretKey = await readSecret({
      env, values: options, flag: '--secret-key-env', label: 'credential secret key', promptSecret, stdin,
    });
  }

  const response = await requestJson(CREDENTIALS_PATH, {
    apiBase,
    fetchImpl,
    token,
    method: 'POST',
    body,
    headers: workspaceHeaders(workspace),
    preserveServerCodes: true,
  });
  return { kind: 'credential-created', credential: credentialView(response) };
}

export async function runCredentialReplace({
  apiBase, fetchImpl, env, token, options, positionals, promptSecret, stdin,
}) {
  if (positionals.length !== 1) throw invalid('credential replace requires exactly one credential ID.');
  const credentialId = positionals[0].trim();
  if (credentialId === '') throw invalid('credential replace requires a credential ID.');
  const kind = options['--kind'];
  if (kind !== 'token' && kind !== 'key_pair') throw invalid('--kind must be token or key_pair.');
  const workspace = requireWorkspace(options);
  const body = {};
  if (kind === 'token') {
    assertFlagsAllowed(options, ['--secret-env'], ['--access-key-env', '--secret-key-env'], kind);
    body.token = await readSecret({
      env, values: options, flag: '--secret-env', label: 'replacement credential token', promptSecret, stdin,
    });
  } else {
    assertFlagsAllowed(options, ['--access-key-env', '--secret-key-env'], ['--secret-env'], kind);
    body.accessKey = await readSecret({
      env, values: options, flag: '--access-key-env', label: 'replacement credential access key', promptSecret, stdin,
    });
    body.secretKey = await readSecret({
      env, values: options, flag: '--secret-key-env', label: 'replacement credential secret key', promptSecret, stdin,
    });
  }
  let response;
  try {
    response = await requestJson(`${CREDENTIALS_PATH}/${encodeURIComponent(credentialId)}/replace`, {
      apiBase,
      fetchImpl,
      token,
      method: 'POST',
      body,
      headers: workspaceHeaders(workspace),
      preserveServerCodes: true,
    });
  } catch (error) {
    // The replace route carries no `kind`: CP derives the shape from the stored
    // record. A rejection usually means the CLI-side --kind does not match the
    // stored kind; pass the CP code through and tell the operator to re-query.
    if (error instanceof CliError && error.code === 'INVALID_REQUEST') {
      throw new CliError(
        'INVALID_REQUEST',
        'CP rejected the replacement; re-run `credential list` to confirm the stored kind before retrying.',
        error.details,
      );
    }
    throw error;
  }
  return { kind: 'credential-replaced', credential: credentialView(response) };
}

export async function runCredentialDelete({
  apiBase, fetchImpl, token, options, positionals, yes = false, confirm = confirmAction, stdin,
  stderr = process.stderr, json = false,
}) {
  if (positionals.length !== 1) throw invalid('credential delete requires exactly one credential ID.');
  const credentialId = positionals[0].trim();
  const workspace = requireWorkspace(options);
  const preview = await requestJson(`${CREDENTIALS_PATH}/${encodeURIComponent(credentialId)}/references`, {
    apiBase,
    fetchImpl,
    token,
    headers: workspaceHeaders(workspace),
    preserveServerCodes: true,
  });
  const previewReferences = requireArray(preview?.references, 'reference');
  if (!yes) {
    if (!json) {
      stderr.write(`credential ${credentialId} has ${previewReferences.length} recorded reference(s).\n`);
    }
    await confirm({
      message: `Delete credential ${credentialId}? This cannot be undone.`,
      stdin,
      output: stderr,
    });
  }
  let response;
  try {
    response = await requestJson(`${CREDENTIALS_PATH}/${encodeURIComponent(credentialId)}`, {
      apiBase,
      fetchImpl,
      token,
      method: 'DELETE',
      headers: workspaceHeaders(workspace),
      preserveServerCodes: true,
    });
  } catch (error) {
    if (error instanceof CliError && error.code === 'CREDENTIAL_IN_USE') {
      throw new CliError(
        'CREDENTIAL_IN_USE',
        'CP reports the credential is still referenced and cannot be deleted; re-run `credential references <id>` '
          + 'to refresh the preview (the preview above may be stale).',
        error.details,
      );
    }
    throw error;
  }
  const references = Array.isArray(response?.references) ? response.references : previewReferences;
  return {
    kind: 'credential-delete',
    credentialId,
    deleted: response?.deleted === true,
    previewReferences,
    references,
  };
}

export async function runCredentialBindings({
  apiBase, fetchImpl, token, options, positionals, bind = true,
}) {
  const action = bind ? 'bind' : 'unbind';
  if (positionals.length !== 1) throw invalid(`credential ${action} requires exactly one credential ID.`);
  const credentialId = positionals[0].trim();
  const workspace = requireWorkspace(options);
  const agentPrincipalIds = csvValues(options['--agent'], '--agent');
  const response = await requestJson(`${CREDENTIALS_PATH}/${encodeURIComponent(credentialId)}/bindings`, {
    apiBase,
    fetchImpl,
    token,
    method: bind ? 'POST' : 'DELETE',
    body: { workspaceId: workspace, agentPrincipalIds },
    headers: workspaceHeaders(workspace),
    preserveServerCodes: true,
  });
  if (typeof response?.credentialId !== 'string' || !Array.isArray(response?.agentPrincipalIds)
      || typeof response?.bound !== 'boolean') {
    throw new CliError('CP_RESPONSE_INVALID', 'CP returned an invalid credential binding payload.');
  }
  return {
    kind: 'credential-bindings',
    action,
    credentialId,
    workspaceId: workspace,
    agentPrincipalIds: response.agentPrincipalIds,
    bound: response.bound,
  };
}

export async function runCredentialReveal({
  apiBase, fetchImpl, env, token, options, positionals, promptSecret, stdin, json = false,
  stdout = process.stdout, stderr = process.stderr, confirm = confirmAction,
  fsImpl, force = false, outPath,
}) {
  if (positionals.length !== 1) throw invalid('credential reveal requires exactly one credential ID.');
  const credentialId = positionals[0].trim();
  const workspace = requireWorkspace(options);
  const resolvedOut = outPath ?? options['--out'];
  if (resolvedOut !== undefined && String(resolvedOut).trim() === '') {
    throw invalid('--out requires a file path.');
  }
  if (force && resolvedOut === undefined) throw invalid('--force requires --out.');
  const password = await readSecret({
    env, values: options, flag: '--password-env', label: 'account password for credential reveal step-up', promptSecret, stdin,
  });

  const response = await requestJson(`${CREDENTIALS_PATH}/${encodeURIComponent(credentialId)}/reveal`, {
    apiBase,
    fetchImpl,
    token,
    method: 'POST',
    body: { password },
    headers: workspaceHeaders(workspace),
    preserveServerCodes: true,
  });
  const value = response?.value;
  if (typeof value !== 'string') {
    throw new CliError('CP_RESPONSE_INVALID', 'CP reveal response did not contain the plaintext value.');
  }
  const credentialIdFromResponse = typeof response?.credentialId === 'string' ? response.credentialId : credentialId;
  const revision = typeof response?.revision === 'number' ? response.revision : null;

  if (resolvedOut !== undefined) {
    const file = await writeExportFile({
      filePath: resolvedOut,
      content: value,
      force,
      confirm,
      fsImpl,
      stdin,
      stderr,
      label: 'reveal output',
      codePrefix: 'REVEAL',
    });
    if (!json) {
      stdout.write(`Revealed credential ${credentialIdFromResponse} to ${file.path} (${file.bytes} bytes, revision=${revision ?? 'unknown'}).\n`);
    }
    return {
      kind: 'credential-reveal',
      mode: 'file',
      credentialId: credentialIdFromResponse,
      revision,
      file,
    };
  }

  if (!json) {
    stderr.write('Warning: the revealed value is printed to stdout; terminal scrollback, tool logs and other local users may read it.\n');
  }
  return {
    kind: 'credential-reveal',
    mode: 'stdout',
    credentialId: credentialIdFromResponse,
    revision,
    value,
  };
}

// Human-readable rendering for the credential group. `printResult` calls this
// before the generic branches so `--json` stays the single machine contract.
export function formatCredentialResult(data) {
  const lines = [];
  switch (data?.kind) {
    case 'credential-list':
      lines.push(`${data.count} credential(s)`);
      for (const credential of data.credentials) {
        lines.push(`  ${credential.id} ${credential.kind} ${credential.ownerType}:${credential.ownerId} `
          + `label=${JSON.stringify(credential.label)} status=${credential.status} revision=${credential.revision} `
          + `refs=${credential.referenceCount ?? 0} fingerprint=${credential.fingerprint ?? 'unknown'}`);
      }
      return lines.join('\n');
    case 'credential-references':
      lines.push(`credential ${data.credentialId}: ${data.references.length} reference(s)`);
      for (const reference of data.references) {
        lines.push(`  ${reference.source} ${reference.subjectType}:${reference.subjectId} `
          + `${reference.actionClass}@${reference.resource}`);
      }
      return lines.join('\n');
    case 'credential-events':
      lines.push(`credential ${data.credentialId}: ${data.events.length} event(s)`);
      for (const event of data.events) {
        lines.push(`  ${event.createdAt ?? 'unknown'} ${event.eventType} actor=${event.actor ?? 'unknown'}`);
      }
      return lines.join('\n');
    case 'credential-precheck':
      lines.push(`precheck: ${data.uncovered.length} uncovered permission(s)`);
      for (const item of data.uncovered) lines.push(`  ${item}`);
      return lines.join('\n');
    case 'credential-created':
    case 'credential-replaced': {
      const c = data.credential;
      lines.push(`${data.kind === 'credential-created' ? 'created' : 'replaced'} credential ${c.id} `
        + `kind=${c.kind} owner=${c.ownerType}:${c.ownerId} status=${c.status} revision=${c.revision}`);
      return lines.join('\n');
    }
    case 'credential-delete':
      lines.push(`deleted credential ${data.credentialId}; references before=${data.previewReferences.length} `
        + `reported=${data.references.length}`);
      return lines.join('\n');
    case 'credential-bindings':
      lines.push(`${data.action} credential=${data.credentialId} workspace=${data.workspaceId} `
        + `agents=${data.agentPrincipalIds.length} bound=${data.bound}`);
      return lines.join('\n');
    case 'credential-reveal':
      if (data.mode === 'file') {
        lines.push(`revealed credential ${data.credentialId} to ${data.file.path} (${data.file.bytes} bytes, revision=${data.revision ?? 'unknown'})`);
        return lines.join('\n');
      }
      return null; // stdout mode prints the raw value in printResult
    default:
      return null;
  }
}
