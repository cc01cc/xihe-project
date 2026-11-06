import { CliError, requestJson, confirmAction } from './provider.mjs';

// PLAN-0643 T4.3 (M6-3): the workspace write face.
//   workspace create <name?>  -> POST   /api/v1/workspaces          (--name/--storage-mode required)
//   workspace delete <id>     -> DELETE /api/v1/workspaces/{id}     (destructive: --yes)
//   workspace members <wsId>  -> GET    /api/v1/workspaces/{wsId}/members
//                               + --add / --set-role / --remove (PLAN-0565 verbs)
//   workspace roots <wsId>    -> POST   /api/v1/workspaces/{wsId}/roots
//                               + --rename / --reposition / --remove (PLAN-0639 verbs)
// Confirmation follows the pre-existing confirmAction discipline (skill/provider
// delete): non-interactive callers must pass --yes; the CLI never assumes consent.

const ROLES = new Set(['EDITOR', 'VIEWER']);

function requireValue(value, flag, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CliError('INVALID_ARGUMENT', `${flag} requires a ${label}.`);
  }
  return value.trim();
}

function requireRole(options) {
  const role = String(options['--role'] ?? '').toUpperCase();
  if (!ROLES.has(role)) {
    throw new CliError('INVALID_ARGUMENT', '--role must be EDITOR or VIEWER.');
  }
  return role;
}

async function confirmOrYes({ yes, confirm, stdin, message }) {
  if (yes === true) return;
  await (confirm ?? confirmAction)({ message, stdin });
}

export async function runWorkspaceCreate({ apiBase, fetchImpl, token, options, stderr }) {
  const name = requireValue(options['--name'], '--name', 'workspace name');
  const storageMode = requireValue(options['--storage-mode'], '--storage-mode', 'storage mode (direct_attach)');
  if (storageMode !== 'direct_attach' && storageMode !== 'managed_import') {
    throw new CliError('INVALID_ARGUMENT', '--storage-mode must be direct_attach or managed_import.');
  }
  // Workspace docker backend is fully frozen (PLAN-0618): the product surface must
  // warn before the call instead of letting the user hit the raw 409.
  if (storageMode === 'managed_import') {
    stderr?.write('warning: the docker workspace backend is frozen; managed_import is rejected with 409 BACKEND_DISABLED. Use --storage-mode direct_attach.\n');
  }
  const hostPath = typeof options['--host-path'] === 'string' && options['--host-path'].trim() !== ''
    ? options['--host-path'].trim()
    : undefined;
  const roots = typeof options['--roots'] === 'string' && options['--roots'].trim() !== ''
    ? options['--roots'].split(',').map((p) => p.trim()).filter((p) => p !== '')
    : undefined;
  if (hostPath !== undefined && roots !== undefined) {
    throw new CliError('INVALID_ARGUMENT', '--host-path and --roots are mutually exclusive.');
  }
  if (storageMode === 'direct_attach' && hostPath === undefined && roots === undefined) {
    throw new CliError('INVALID_ARGUMENT', 'direct_attach requires --host-path <dir> or --roots <dir,...>.');
  }
  const body = {
    name,
    storageMode,
    ...(hostPath !== undefined ? { hostPath } : {}),
    ...(roots !== undefined ? { roots } : {}),
    ...(typeof options['--description'] === 'string' && options['--description'].trim() !== ''
      ? { description: options['--description'].trim() } : {}),
    ...(typeof options['--execution-mode'] === 'string' && options['--execution-mode'].trim() !== ''
      ? { executionMode: options['--execution-mode'].trim() } : {}),
  };
  const data = await requestJson('/api/v1/workspaces', {
    apiBase, fetchImpl, token, method: 'POST', body,
    headers: options['--idempotency-key'] !== undefined
      ? { 'Idempotency-Key': String(options['--idempotency-key']) } : {},
  });
  return { kind: 'workspace-created', workspace: data };
}

export async function runWorkspaceDelete({ apiBase, fetchImpl, token, workspaceId, yes, confirm, stdin }) {
  await confirmOrYes({
    yes, confirm, stdin,
    message: `Delete workspace ${workspaceId}? This is a logical deletion of the workspace.`,
  });
  await requestJson(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}`, {
    apiBase, fetchImpl, token, method: 'DELETE',
  });
  return { kind: 'workspace-deleted', workspaceId };
}

export async function runWorkspaceMembers({ apiBase, fetchImpl, token, workspaceId, options, yes, confirm, stdin }) {
  const base = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/members`;
  const headers = { 'X-Workspace-Id': workspaceId };
  const writeFlags = [
    options['--add'] !== undefined, options['--set-role'] !== undefined, options['--remove'] !== undefined,
  ].filter(Boolean).length;
  if (writeFlags > 1) {
    throw new CliError('INVALID_ARGUMENT', '--add, --set-role and --remove are mutually exclusive.');
  }
  if (options['--add'] !== undefined) {
    const username = requireValue(options['--add'], '--add', 'username');
    const body = { username, role: requireRole(options) };
    const member = await requestJson(base, { apiBase, fetchImpl, token, method: 'POST', body, headers });
    return { kind: 'workspace-member', action: 'add', member };
  }
  if (options['--set-role'] !== undefined) {
    const userId = requireValue(options['--set-role'], '--set-role', 'user ID');
    const member = await requestJson(`${base}/${encodeURIComponent(userId)}`, {
      apiBase, fetchImpl, token, method: 'PATCH', body: { role: requireRole(options) }, headers,
    });
    return { kind: 'workspace-member', action: 'role', member };
  }
  if (options['--remove'] !== undefined) {
    const userId = requireValue(options['--remove'], '--remove', 'user ID');
    await confirmOrYes({
      yes, confirm, stdin,
      message: `Remove member ${userId} from workspace ${workspaceId}?`,
    });
    await requestJson(`${base}/${encodeURIComponent(userId)}`, {
      apiBase, fetchImpl, token, method: 'DELETE', headers,
    });
    return { kind: 'workspace-member', action: 'remove', userId };
  }
  const items = await requestJson(base, { apiBase, fetchImpl, token, headers });
  if (!Array.isArray(items)) {
    throw new CliError('CP_RESPONSE_INVALID', 'CP returned an unexpected member list shape.', {}, 1);
  }
  return { kind: 'workspace-members', items };
}

export async function runWorkspaceRoots({ apiBase, fetchImpl, token, workspaceId, options, yes, confirm, stdin }) {
  const base = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/roots`;
  const headers = { 'X-Workspace-Id': workspaceId };
  const writeFlags = [
    options['--add'] !== undefined, options['--rename'] !== undefined,
    options['--reposition'] !== undefined, options['--remove'] !== undefined,
  ].filter(Boolean).length;
  if (writeFlags === 0) {
    // No list endpoint exists for roots; the ordered projection rides the
    // workspace detail (PLAN-0639), so the read face is `workspace get`.
    throw new CliError('INVALID_ARGUMENT',
      'workspace roots is write-only: use --add/--rename/--reposition/--remove; read roots with `workspace get`.');
  }
  if (writeFlags > 1) {
    throw new CliError('INVALID_ARGUMENT', '--add, --rename, --reposition and --remove are mutually exclusive.');
  }
  if (options['--add'] !== undefined) {
    const path = requireValue(options['--add'], '--add', 'absolute host directory');
    const body = {
      path,
      ...(typeof options['--alias'] === 'string' && options['--alias'].trim() !== ''
        ? { alias: options['--alias'].trim() } : {}),
    };
    const root = await requestJson(base, { apiBase, fetchImpl, token, method: 'POST', body, headers });
    return { kind: 'workspace-root', action: 'add', root };
  }
  if (options['--rename'] !== undefined) {
    const rootId = requireValue(options['--rename'], '--rename', 'root ID');
    if (typeof options['--alias'] !== 'string' || options['--alias'].trim() === '') {
      throw new CliError('INVALID_ARGUMENT', '--rename requires --alias.');
    }
    const root = await requestJson(`${base}/${encodeURIComponent(rootId)}`, {
      apiBase, fetchImpl, token, method: 'PATCH', body: { alias: options['--alias'].trim() }, headers,
    });
    return { kind: 'workspace-root', action: 'rename', root };
  }
  if (options['--reposition'] !== undefined) {
    const rootId = requireValue(options['--reposition'], '--reposition', 'root ID');
    const raw = options['--position'];
    if (!/^\d{1,4}$/.test(String(raw ?? ''))) {
      throw new CliError('INVALID_ARGUMENT', '--reposition requires a non-negative integer --position.');
    }
    const root = await requestJson(`${base}/${encodeURIComponent(rootId)}`, {
      apiBase, fetchImpl, token, method: 'PATCH', body: { position: Number(raw) }, headers,
    });
    return { kind: 'workspace-root', action: 'reposition', root };
  }
  const rootId = requireValue(options['--remove'], '--remove', 'root ID');
  await confirmOrYes({
    yes, confirm, stdin,
    message: `Remove root ${rootId} from workspace ${workspaceId}?`,
  });
  await requestJson(`${base}/${encodeURIComponent(rootId)}`, {
    apiBase, fetchImpl, token, method: 'DELETE', headers,
  });
  return { kind: 'workspace-root', action: 'remove', rootId };
}
