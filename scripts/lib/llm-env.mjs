/**
 * PLAN-0650 B-1: the Agent's LLM environment, built in exactly one place.
 *
 * Why this module exists: `e2e-host.mjs` used to derive the Agent LLM env twice — once for the
 * initial launch and once for the restart contract (`XIHE_E2E_AGENT_RESTART_ENV`) that
 * workspace rebinds consume. Two copies drifted exactly the way copies do: the **fake** lane
 * learned to set `XIHE_API_BASE` (PLAN-0504 decision #9) while the **real** lane never did, so
 * `--llm-mode=real` hit whatever endpoint the provider default picked. For the `native` route
 * that default happens to be the MiMo base, so it looked fine; for `openai-compat` the provider
 * is `openai`, whose default is `api.openai.com`, and the lane reported
 * `llmReady=invalid_credentials` for a perfectly good key (BL-205 ①, measured 2026-11-03: eight
 * walkthrough rounds burned ~40 min on it).
 *
 * Contract (no I/O, no `process.env` reads — the caller passes everything in):
 * - real lane (`realKey` non-empty): provider + provider key + **`XIHE_API_BASE` on both routes**.
 *   `XIHE_API_BASE` is the env-only endpoint channel frozen by `xihe_agent/llm/base.py:248-256`
 *   (`XIHE_API_BASE` > caller fallback), so pinning it here does **not** touch the PLAN-0504
 *   "base URLs never travel through config" rule.
 * - fake lane: provider (`mock`/`openai`) and, for the lanes that actually reach a fake server,
 *   the fake keys plus the per-provider fake base (`/openai/v1`, matching the old config keys).
 * - `missing` / `mock` intentionally carry **no** keys and **no** base: those lanes must stay
 *   not-ready (`LLM_NOT_CONFIGURED`) for the readiness gate to be meaningful.
 */

/** The MiMo endpoint both real routes use (PLAN-0372 decisions #A/#B: same key, same host). */
export const DEFAULT_REAL_API_BASE = 'https://api.xiaomimimo.com/v1';

/**
 * @param {object} options
 * @param {string} [options.realKey]      real provider key (`XIHE_E2E_REAL_XIAOMI_KEY`); empty = fake lane
 * @param {string} [options.realRoute]    `native` (default) | `openai-compat`
 * @param {string} [options.llmMode]      fake-lane mode: mock | missing | invalid | any other name
 * @param {number|string} [options.fakeLlmPort] port of the fake LLM fixture (required by the fake key lanes)
 * @param {string} [options.realApiBase]  override for the real endpoint (`XIHE_E2E_REAL_API_BASE`)
 * @returns {Record<string, string>} the LLM portion of the Agent env
 */
export function llmEnv({
    realKey = '',
    realRoute = 'native',
    llmMode = 'mock',
    fakeLlmPort,
    realApiBase,
} = {}) {
    if (realKey) {
        const openAiCompat = realRoute === 'openai-compat';
        return {
            XIHE_LLM_PROVIDER: openAiCompat ? 'openai' : 'xiaomi',
            ...(openAiCompat
                ? { XIHE_OPENAI_API_KEY: realKey }
                : { XIHE_XIAOMI_API_KEY: realKey }),
            XIHE_API_BASE: nonBlank(realApiBase) ?? DEFAULT_REAL_API_BASE,
        };
    }
    const provider = llmMode === 'mock' ? 'mock' : 'openai';
    if (llmMode === 'missing' || llmMode === 'mock') {
        // No profile, no fake server: the lane must stay not-ready on purpose.
        return { XIHE_LLM_PROVIDER: provider };
    }
    const port = Number(fakeLlmPort);
    if (!Number.isInteger(port) || port <= 0) {
        throw new TypeError(
            `llmEnv: the fake lane needs a positive fakeLlmPort, got ${JSON.stringify(fakeLlmPort)}`,
        );
    }
    return {
        XIHE_LLM_PROVIDER: provider,
        XIHE_OPENAI_API_KEY: llmMode === 'invalid' ? 'sk-fake-invalid-key' : 'sk-fake-openai-key',
        XIHE_DEEPSEEK_API_KEY: 'fake-deepseek-key',
        XIHE_API_BASE: `http://127.0.0.1:${port}/openai/v1`,
    };
}

/** Trimmed non-empty string, or `undefined` (so `??` fallbacks keep working). */
function nonBlank(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    return text.length > 0 ? text : undefined;
}
