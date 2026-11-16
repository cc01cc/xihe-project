/**
 * PLAN-0601: resolve the explicit Session binding that CP requires before it accepts chat.
 *
 * Since PLAN-0429/0505 a Session must be pinned to (a) a published api-request-template — the
 * `contextTemplateLayer` / `contextTemplateId` / `contextTemplateVersion` triple — and (b) a chat
 * provider connection, otherwise `POST /api/v1/chat` fails with 409 `API_TYPE_REBIND_REQUIRED`
 * (see `ApiRequestTemplateService#admissionSnapshot`). `xihe verify` predates that rule and created
 * bare Sessions, so its B tier could never pass on such builds.
 *
 * This module is intentionally generic (no verify-specific assumptions) so other CLI commands that
 * create Sessions can reuse it. It never hardcodes template ids: it asks the config catalog for
 * published templates and the connection list for a READY chat connection.
 */

const CHAT_OPERATION = 'chat';
const TEMPLATE_LAYERS = ['user', 'workspace', 'instance'];

/** Extracts a JSON array of templates from the config read shape (`{templates}` or `{entries}`). */
export function parseTemplateCatalog(payload) {
  if (payload === null || typeof payload !== 'object') return [];
  const raw = payload.templates ?? payload.entries?.templates;
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Published template records only, newest version first, optionally filtered by API type. */
export function publishedTemplates(templates, { apiTypeId, apiTypeVersion } = {}) {
  const published = (Array.isArray(templates) ? templates : []).filter(
    (template) => template && typeof template === 'object'
      && template.status === 'published'
      && typeof template.id === 'string'
      && Number.isInteger(template.version)
      && template.version >= 1,
  );
  const compatible = published.filter((template) => {
    if (!apiTypeId) return true;
    if (template.apiTypeId !== apiTypeId) return false;
    if (apiTypeVersion === undefined || apiTypeVersion === null) return true;
    return template.apiTypeVersion === apiTypeVersion;
  });
  return compatible.sort((left, right) => right.version - left.version);
}

/** A READY chat connection visible to the account, preferring an explicitly keyed one. */
export function pickChatConnection(connections) {
  const candidates = (Array.isArray(connections) ? connections : []).filter(
    (connection) => connection && typeof connection.id === 'string'
      && connection.enabled !== false
      && connection.status === 'READY'
      && (connection.operation === undefined || connection.operation === CHAT_OPERATION),
  );
  const keyed = candidates.find((connection) => typeof connection.connectionKey === 'string' && connection.connectionKey !== '');
  return keyed ?? candidates[0] ?? null;
}

// task-32: a chat binding must never pin an ASR/TTS/embedding/image model. Prefer the
// catalog's capability flags when present; for bare string ids fall back to a conservative
// name screen (asr/tts/embedding/image/audio/speech). Unknown names stay usable — CP itself
// validates the model at admission, so this screen only rejects clearly non-chat families.
const NON_CHAT_NAME = /(^|[^a-z])(asr|tts|embedding|embeddings|image|audio|speech|whisper)([^a-z]|$)/i;
function isChatModel(model) {
  if (model && typeof model === 'object') {
    if (model.capabilities && typeof model.capabilities.chat === 'boolean') return model.capabilities.chat;
    const name = typeof model.name === 'string' ? model.name : typeof model.id === 'string' ? model.id : '';
    return name !== '' && !NON_CHAT_NAME.test(name);
  }
  return typeof model === 'string' && model !== '' && !NON_CHAT_NAME.test(model);
}

export function pickModelName(connection, models) {
  const fromConnection = Array.isArray(connection?.manualModels)
    ? connection.manualModels.find(isChatModel)
    : undefined;
  if (fromConnection) return fromConnection;
  const fromConnectionList = Array.isArray(connection?.models)
    ? connection.models.filter(isChatModel).map((model) => (typeof model === 'string' ? model : model?.name ?? model?.id)).find(Boolean)
    : undefined;
  if (fromConnectionList) return fromConnectionList;
  // task-32: CP `/api/v1/models` is contracted as a connectionId-keyed object
  // (ProviderModelCatalog.models, openapi.yaml:8436); verify.mjs:countModels already accepts both
  // that shape and the legacy array. Keep one definition of the wire shape — reuse countModels's
  // compatibility口径 here via the same normalization (array or plain object), never a
  // second bespoke parser.
  const catalog = Array.isArray(models) ? models : models && typeof models === 'object' ? models : null;
  // Prefer the pinned connection's own bucket: the object is keyed by connectionId and a
  // foreign connection's models are not usable on this binding. Fall back to the first
  // non-empty bucket only when the pinned key has no entry (legacy instance-fallback shape).
  const entries = catalog
    ? (connection?.id && Array.isArray(catalog[connection.id]) && catalog[connection.id].length > 0
      ? [catalog[connection.id]]
      : Object.values(catalog))
    : [];
  const fromCatalog = entries.flatMap((entry) => (Array.isArray(entry) ? entry : [entry]))
    .filter(isChatModel)
    .map((model) => (typeof model === 'string' ? model : model?.name ?? model?.id)).find(Boolean);
  return fromCatalog ?? null;
}

function actionableConnectionError(stack) {
  return [
    `No READY chat provider connection is visible on stack ${stack}.`,
    'Create one first (UI: Settings → Provider, or `node scripts/xihe.mjs provider add default --scope USER --label "<label>"`',
    'then `node scripts/xihe.mjs provider verify <connectionId>`), and re-run `xihe verify`.',
  ].join(' ');
}

function actionableTemplateError(connection) {
  const apiType = connection?.apiTypeId
    ? ` for API type ${connection.apiTypeId}@${connection.apiTypeVersion ?? 1}`
    : '';
  return [
    `No published api-request-template is available${apiType}.`,
    'Publish one first (UI: Settings → Configuration → API request templates → create + publish),',
    'or import a configuration file that contains a published `templates` entry, then re-run `xihe verify`.',
    'CP rejects chat without an explicit template binding (409 API_TYPE_REBIND_REQUIRED).',
  ].join(' ');
}

/**
 * Resolves the Session binding for chat.
 *
 * @returns {Promise<{binding: object}|{error: {code: string, message: string}}>}
 */
export async function resolveSessionBinding({ client, stack = 'unknown', fetchModels = true }) {
  const connectionsResponse = await client.call('GET', '/api/v1/provider-connections');
  if (connectionsResponse.status !== 200 || !Array.isArray(connectionsResponse.body?.connections)) {
    return {
      error: {
        code: 'VERIFY_CONNECTION_UNAVAILABLE',
        message: `Reading the provider connection list failed (HTTP ${connectionsResponse.status}${connectionsResponse.code ? ` ${connectionsResponse.code}` : ''}).`,
      },
    };
  }
  const connection = pickChatConnection(connectionsResponse.body.connections);
  if (!connection) {
    return { error: { code: 'VERIFY_CONNECTION_MISSING', message: actionableConnectionError(stack) } };
  }

  let template = null;
  let templateLayer = null;
  for (const layer of TEMPLATE_LAYERS) {
    const catalog = await client.call(
      'GET',
      `/api/v1/config/api-request-templates?layer=${encodeURIComponent(layer)}`,
    );
    if (catalog.status !== 200) continue;
    const candidates = publishedTemplates(parseTemplateCatalog(catalog.body), {
      apiTypeId: connection.apiTypeId,
      apiTypeVersion: connection.apiTypeVersion,
    });
    if (candidates.length > 0) {
      template = candidates[0];
      templateLayer = layer;
      break;
    }
  }
  if (!template) {
    return { error: { code: 'VERIFY_TEMPLATE_MISSING', message: actionableTemplateError(connection) } };
  }

  let models = [];
  if (fetchModels) {
    const modelResponse = await client.call('GET', '/api/v1/models');
    // task-32: the fetch gate must accept the same shapes as pickModelName/countModels —
    // CP returns ProviderModelCatalog.models as a connectionId-keyed object, not an array.
    const rawModels = modelResponse.body?.models;
    if (modelResponse.status === 200 && (Array.isArray(rawModels) || (rawModels && typeof rawModels === 'object'))) {
      models = rawModels;
    }
  }
  const modelName = pickModelName(connection, models);
  if (!modelName) {
    return {
      error: {
        code: 'VERIFY_MODEL_MISSING',
        message: `Connection ${connection.id} exposes no usable chat model (catalog empty or only non-chat models such as ASR/TTS/embedding/image); register or discover a chat model for it, then re-run \`xihe verify\`.`,
      },
    };
  }

  return {
    binding: {
      connectionId: connection.id,
      providerId: connection.providerId ?? 'custom-openai-compatible',
      modelName,
      templateLayer,
      templateId: template.id,
      templateVersion: template.version,
      apiTypeId: connection.apiTypeId ?? template.apiTypeId ?? null,
      apiTypeVersion: connection.apiTypeVersion ?? template.apiTypeVersion ?? null,
    },
  };
}

/** The POST /api/v1/sessions fields that satisfy `admissionSnapshot`. */
export function bindingRequestBody(binding, base = {}) {
  return {
    ...base,
    providerConnectionId: binding.connectionId,
    modelProvider: binding.providerId,
    modelName: binding.modelName,
    contextTemplateLayer: binding.templateLayer,
    contextTemplateId: binding.templateId,
    contextTemplateVersion: binding.templateVersion,
  };
}

/** One-line description for evidence/logs (no secrets). */
export function describeBinding(binding) {
  return `connection=${binding.connectionId} provider=${binding.providerId} model=${binding.modelName} template=${binding.templateLayer}:${binding.templateId}:${binding.templateVersion}`;
}
