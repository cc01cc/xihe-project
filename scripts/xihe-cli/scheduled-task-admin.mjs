import { readFileSync } from 'node:fs';
import { CliError, requestJson, confirmAction } from './provider.mjs';

// PLAN-0643 T4.5 (M6-3): scheduled-task write verbs (PLAN-0489 contract).
//   create   <wsId>        -> POST   /api/v1/workspaces/{wsId}/scheduled-tasks
//   delete   <wsId> <task> -> DELETE /api/v1/workspaces/{wsId}/scheduled-tasks/{task}  (scheduled -> cancelled; --yes)
//   rerun    <wsId> <task> -> POST   /api/v1/workspaces/{wsId}/scheduled-tasks/{task}/rerun
//   remove   <wsId> <task> -> POST   /api/v1/workspaces/{wsId}/scheduled-tasks/{task}/remove  (missed/expired; --yes)
//   postpone <wsId> <task> -> POST   /api/v1/workspaces/{wsId}/scheduled-tasks/{task}/postpone  (body {at} required)
// The group deliberately does not use `cancel` (spec §2 verb mapping); DELETE is
// the cancellation route and POST /remove is the missed/expired disposition.

const TRIGGERS = new Set(['delay_once', 'cron']);
const TARGETS = new Set(['session_wakeup', 'job_dispatch']);

function requireValue(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CliError('INVALID_ARGUMENT', `${label} is required.`);
  }
  return value.trim();
}

function optionalId(options, flag) {
  const raw = options[flag];
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  return raw.trim();
}

function agentMarker(options) {
  const id = optionalId(options, '--agent-principal');
  return id === undefined ? {} : { agentPrincipalId: id };
}

async function confirmOrYes({ yes, confirm, stdin, message }) {
  if (yes === true) return;
  await (confirm ?? confirmAction)({ message, stdin });
}

export async function runScheduledTaskCreate({ apiBase, fetchImpl, token, workspaceId, options }) {
  const triggerKind = requireValue(options['--kind'], '--kind (delay_once|cron)');
  if (!TRIGGERS.has(triggerKind)) {
    throw new CliError('INVALID_ARGUMENT', '--kind must be delay_once or cron.');
  }
  const targetKind = requireValue(options['--target'], '--target (session_wakeup|job_dispatch)');
  if (!TARGETS.has(targetKind)) {
    throw new CliError('INVALID_ARGUMENT', '--target must be session_wakeup or job_dispatch.');
  }
  const body = { triggerKind, targetKind, ...agentMarker(options) };
  if (triggerKind === 'cron') {
    body.cronExpr = requireValue(options['--cron-expr'], '--cron-expr (5 fields, minute grain)');
  } else {
    body.at = requireValue(options['--at'], '--at (future ISO-8601 UTC instant)');
  }
  if (typeof options['--timezone'] === 'string' && options['--timezone'].trim() !== '') {
    body.timezone = options['--timezone'].trim();
  }
  if (targetKind === 'session_wakeup') {
    body.targetSessionId = requireValue(options['--session'], '--session (target session ID)');
    body.prompt = requireValue(options['--prompt'], '--prompt');
  } else {
    const file = requireValue(options['--payload-file'], '--payload-file (JSON payload for job_dispatch)');
    let payload;
    try {
      payload = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      throw new CliError('INVALID_ARGUMENT', `--payload-file must be a readable JSON file (${error.message}).`);
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new CliError('INVALID_ARGUMENT', '--payload-file must contain a JSON object.');
    }
    body.payload = payload;
  }
  const task = await requestJson(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/scheduled-tasks`,
    { apiBase, fetchImpl, token, method: 'POST', body, headers: { 'X-Workspace-Id': workspaceId } },
  );
  return { kind: 'scheduled-task', task };
}

function taskPath(workspaceId, taskId) {
  return `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/scheduled-tasks/${encodeURIComponent(taskId)}`;
}

export async function runScheduledTaskDelete({ apiBase, fetchImpl, token, workspaceId, taskId, options, yes, confirm, stdin }) {
  await confirmOrYes({
    yes, confirm, stdin,
    message: `Cancel scheduled task ${taskId} (scheduled -> cancelled)? Missed/expired tasks must use 'scheduled-task remove'.`,
  });
  const result = await requestJson(taskPath(workspaceId, taskId), {
    apiBase, fetchImpl, token, method: 'DELETE',
    body: Object.keys(agentMarker(options)).length > 0 ? agentMarker(options) : undefined,
    headers: { 'X-Workspace-Id': workspaceId },
  });
  return { kind: 'scheduled-task-disposition', taskId, ...(result ?? { status: 'cancelled' }) };
}

export async function runScheduledTaskRerun({ apiBase, fetchImpl, token, workspaceId, taskId, options }) {
  const task = await requestJson(`${taskPath(workspaceId, taskId)}/rerun`, {
    apiBase, fetchImpl, token, method: 'POST',
    body: Object.keys(agentMarker(options)).length > 0 ? agentMarker(options) : undefined,
    headers: { 'X-Workspace-Id': workspaceId },
  });
  return { kind: 'scheduled-task', task };
}

export async function runScheduledTaskRemove({ apiBase, fetchImpl, token, workspaceId, taskId, options, yes, confirm, stdin }) {
  await confirmOrYes({
    yes, confirm, stdin,
    message: `Remove scheduled task ${taskId} (missed/expired -> cancelled)?`,
  });
  const result = await requestJson(`${taskPath(workspaceId, taskId)}/remove`, {
    apiBase, fetchImpl, token, method: 'POST',
    body: Object.keys(agentMarker(options)).length > 0 ? agentMarker(options) : undefined,
    headers: { 'X-Workspace-Id': workspaceId },
  });
  return { kind: 'scheduled-task-disposition', taskId, ...(result ?? { status: 'cancelled' }) };
}

export async function runScheduledTaskPostpone({ apiBase, fetchImpl, token, workspaceId, taskId, options }) {
  const at = requireValue(options['--at'], '--at (future ISO-8601 UTC instant)');
  const task = await requestJson(`${taskPath(workspaceId, taskId)}/postpone`, {
    apiBase, fetchImpl, token, method: 'POST',
    body: { at, ...agentMarker(options) },
    headers: { 'X-Workspace-Id': workspaceId },
  });
  return { kind: 'scheduled-task', task };
}
