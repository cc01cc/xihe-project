import { CliError, requestJson } from './provider.mjs';

// PLAN-0643 T4.1/T4.2 (M6-3): the read-only catalog face.
//   provider catalog -> GET /api/v1/provider-catalog
//   models           -> GET /api/v1/models
//   api-input-types  -> GET /api/v1/api-input-types  (via `api-input-types list`)
//   me permissions   -> GET /api/v1/me/permissions
// All four are GET passthroughs: the CLI forwards the server body unchanged and
// stamps only its own `kind` discriminator (verify V47 wants structured output,
// which the --json face provides directly and the human face summarizes).

function passthrough(kind, body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new CliError('CP_RESPONSE_INVALID', 'CP returned an unexpected catalog shape.', {}, 1);
  }
  return { kind, ...body };
}

export async function runProviderCatalog({ apiBase, fetchImpl, token }) {
  return passthrough('provider-catalog',
    await requestJson('/api/v1/provider-catalog', { apiBase, fetchImpl, token }));
}

export async function runModels({ apiBase, fetchImpl, token }) {
  return passthrough('models', await requestJson('/api/v1/models', { apiBase, fetchImpl, token }));
}

export async function runApiInputTypes({ apiBase, fetchImpl, token }) {
  const body = await requestJson('/api/v1/api-input-types', { apiBase, fetchImpl, token });
  if (body === null || typeof body !== 'object' || !Array.isArray(body.types)) {
    throw new CliError('CP_RESPONSE_INVALID', 'CP returned an unexpected api-input-types shape.', {}, 1);
  }
  return { kind: 'api-input-types', types: body.types, ...(body.configRevision !== undefined ? { configRevision: body.configRevision } : {}) };
}

export async function runMePermissions({ apiBase, fetchImpl, token }) {
  return passthrough('me-permissions',
    await requestJson('/api/v1/me/permissions', { apiBase, fetchImpl, token }));
}
