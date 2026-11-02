/**
 * PLAN-0628 M1: the `skill` CLI domain (module only — registration, help and rendering live in
 * scripts/xihe.mjs, following how every other domain is wired).
 *
 * Conventions this module follows instead of inventing:
 *   - it only returns `data`; `printResult` in xihe.mjs renders it (a new domain needs a rendering
 *     branch there, otherwise the human-readable output degrades to "Command completed.");
 *   - the auth token is obtained by the caller through `login(...)` from provider.mjs — this module
 *     never builds a login request or reads a token env var;
 *   - `list` shapes the payload like `provider list` does (`{connections: [...]}` → `{skills: [...]}`),
 *     so the JSON contract stays uniform across domains;
 *   - destructive operations ask first via `confirmAction` (which refuses in a non-TTY session and
 *     tells the caller to pass --yes).
 */
import { CliError, confirmAction, requestJson, requireOption } from './provider.mjs';

export const SKILLS_PATH = '/api/v1/skills';
export const SKILL_BINDINGS_PATH = '/api/v1/skill-bindings';

const DEFINITION_SCOPES = ['instance', 'workspace'];
const SUBJECT_TYPES = ['user', 'agent_principal'];
const BINDING_SCOPES = ['instance', 'workspace'];

function requireScopeType(value, label) {
  if (!DEFINITION_SCOPES.includes(value)) {
    throw new CliError('INVALID_ARGUMENT', `${label} must be one of ${DEFINITION_SCOPES.join('|')}`);
  }
  return value;
}

/** `skill list [--scope instance|workspace] [--workspace <wsId>]` */
export async function listSkills({ apiBase, fetchImpl, token, options }) {
  const scope = options['--scope'] ?? 'instance';
  requireScopeType(scope, '--scope');
  const params = new URLSearchParams({ definitionScope: scope });
  if (scope === 'workspace') {
    params.set('workspaceId', requireOption(options, '--workspace'));
  }
  const body = await requestJson(`${SKILLS_PATH}?${params.toString()}`, {
    apiBase, fetchImpl, token, method: 'GET',
  });
  return { skills: Array.isArray(body?.items) ? body.items : [] };
}

/** `skill show <skillId> [--include-body]` */
export async function showSkill({ apiBase, fetchImpl, token, skillId, includeBody }) {
  if (!skillId) throw new CliError('INVALID_ARGUMENT', 'skill show requires a skill id.');
  const suffix = includeBody ? '?includeBody=true' : '';
  const body = await requestJson(`${SKILLS_PATH}/${skillId}${suffix}`, {
    apiBase, fetchImpl, token, method: 'GET',
  });
  return { skill: body };
}

/** `skill bindings <skillId>` */
export async function listSkillBindings({ apiBase, fetchImpl, token, skillId }) {
  if (!skillId) throw new CliError('INVALID_ARGUMENT', 'skill bindings requires a skill id.');
  const body = await requestJson(`${SKILLS_PATH}/${skillId}/bindings`, {
    apiBase, fetchImpl, token, method: 'GET',
  });
  return { bindings: Array.isArray(body?.items) ? body.items : [] };
}

/**
 * `skill import --file <path.json> | --stdin`
 *
 * The body is the import request as documented in openapi (`{definitionScope, skills}`); the CLI
 * does not re-validate it — `SkillImportValidator` on CP is the single write seam, and duplicating
 * its rules here would let the two drift.
 */
export async function importSkills({ apiBase, fetchImpl, token, request }) {
  if (!request || typeof request !== 'object') {
    throw new CliError('INVALID_ARGUMENT', 'skill import needs a JSON request body (--file or --stdin).');
  }
  const body = await requestJson(`${SKILLS_PATH}/import`, {
    apiBase, fetchImpl, token, method: 'POST', body: request,
  });
  return {
    results: Array.isArray(body?.results) ? body.results : [],
    rejected: Array.isArray(body?.rejected) ? body.rejected : [],
    summary: body?.summary ?? {},
  };
}

/** `skill bind --skill <id> --subject <user|agent_principal> --subject-id <id> [--scope ...]` */
export async function bindSkill({ apiBase, fetchImpl, token, options }) {
  const skillId = requireOption(options, '--skill');
  const subjectType = options['--subject'] ?? 'user';
  if (!SUBJECT_TYPES.includes(subjectType)) {
    throw new CliError('INVALID_ARGUMENT', `--subject must be one of ${SUBJECT_TYPES.join('|')}`);
  }
  const subjectId = requireOption(options, '--subject-id');
  const scopeType = options['--scope'] ?? 'instance';
  if (!BINDING_SCOPES.includes(scopeType)) {
    throw new CliError('INVALID_ARGUMENT', `--scope must be one of ${BINDING_SCOPES.join('|')}`);
  }
  const workspaceId = scopeType === 'workspace' ? requireOption(options, '--workspace') : undefined;

  const body = await requestJson(SKILL_BINDINGS_PATH, {
    apiBase,
    fetchImpl,
    token,
    method: 'POST',
    body: {
      skillId,
      subjectType,
      subjectId,
      scopeType,
      ...(workspaceId ? { scopeId: workspaceId } : {}),
    },
  });
  return { binding: body };
}

/** `skill unbind <bindingId> [--yes]` */
export async function unbindSkill({ apiBase, fetchImpl, token, bindingId, assumeYes, stdin, output }) {
  if (!bindingId) throw new CliError('INVALID_ARGUMENT', 'skill unbind requires a binding id.');
  if (!assumeYes) {
    await confirmAction({
      message: `Remove skill binding ${bindingId}?`,
      stdin,
      output,
    });
  }
  await requestJson(`${SKILL_BINDINGS_PATH}/${bindingId}`, {
    apiBase, fetchImpl, token, method: 'DELETE',
  });
  return { removed: bindingId };
}

/** `skill delete <skillId> [--yes]` — bindings cascade (V101 ON DELETE CASCADE). */
export async function deleteSkill({ apiBase, fetchImpl, token, skillId, assumeYes, stdin, output }) {
  if (!skillId) throw new CliError('INVALID_ARGUMENT', 'skill delete requires a skill id.');
  if (!assumeYes) {
    await confirmAction({
      message: `Delete skill ${skillId} and every binding that points at it?`,
      stdin,
      output,
    });
  }
  await requestJson(`${SKILLS_PATH}/${skillId}`, {
    apiBase, fetchImpl, token, method: 'DELETE',
  });
  return { removed: skillId };
}
