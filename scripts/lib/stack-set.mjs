/**
 * PLAN-0574 M4 (design decision #17): `stack-run.mjs --set KEY=VALUE`.
 *
 * The launcher is the only place that accepts `--set`. It validates against a
 * frozen, per-key non-sensitive allowlist, then writes the value directly into
 * the spawned subprocess environment (overriding the same-named OS env and the
 * derived stack defaults). The three module loaders are NOT changed: they see
 * the value as ordinary process env, which removes the Java
 * System-property/getenv split, the Agent import-order trap and the Rust
 * `--file-worker` bypass in one move.
 *
 * Port matrix (design.md M4): each key has a *listening* target and
 * *connection-side* consumers, and both must receive the override or the stack
 * wires up broken. `stackEnvDefaults` also derives explicit URL keys, which the
 * consumers treat as taking precedence over ports — so when the URL in the
 * target env is a *derived* value (absent from the user's OS env), it is
 * re-pointed to the new port; when the user set it explicitly, it is left alone
 * and a warning explains that only the listening side moves.
 *
 * Security contract:
 * - only the three bootstrap port keys are accepted (no regex guesses, no
 *   arbitrary env passthrough, no credential channel);
 * - values must be decimal ASCII integers 1..65535; empty, signed, whitespace,
 *   non-numeric or out-of-range values are rejected;
 * - duplicate keys are rejected (last-one-wins hiding is not allowed);
 * - a key is only injected into targets that actually consume it (listening or
 *   connection side); any other combination fails loudly instead of silently
 *   succeeding;
 * - error messages never echo the provided value.
 */

const PORT_PATTERN = /^(https?:\/\/[^/:]+):\d+(.*)$/u;

export const STACK_SET_ALLOWLIST = Object.freeze({
  XIHE_CP_PORT: Object.freeze({
    // cp listens; the Agent derives its CP address (app_state.py:134).
    targets: Object.freeze(['cp', 'agent']),
    connectionUrlKeys: Object.freeze(['XIHE_CP_URL', 'XIHE_CP_BASE_URL']),
  }),
  XIHE_AGENT_PORT: Object.freeze({
    // agent listens; CP derives the agent chat/base URLs (application.properties:77-78,
    // cp.agent-url AND cp.agent-base-url). XIHE_AGENT_URL is launcher-derived; the
    // base URL is not, so a user-provided value is kept with a warning.
    targets: Object.freeze(['agent', 'cp']),
    connectionUrlKeys: Object.freeze(['XIHE_AGENT_URL', 'XIHE_AGENT_BASE_URL']),
  }),
  XIHE_RUNTIME_PORT: Object.freeze({
    // runtime listens; CP derives the runtime URL (application.properties:71).
    targets: Object.freeze(['runtime', 'cp']),
    connectionUrlKeys: Object.freeze(['XIHE_RUNTIME_URL']),
  }),
});

function reject(message) {
  throw new Error(message);
}

function validatePortValue(key, value) {
  if (typeof value !== 'string' || value === '') {
    reject(`--set ${key} requires a decimal port value (1..65535); the provided value was rejected.`);
  }
  if (!/^\d{1,5}$/u.test(value)) {
    reject(`--set ${key} must be a decimal ASCII integer without sign, whitespace or separators (1..65535).`);
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    reject(`--set ${key} is out of range (1..65535).`);
  }
  return String(port);
}

export function applySetToEnv(env, values) {
  for (const [key, value] of Object.entries(values)) {
    env[key] = value;
  }
  return env;
}

// Applies the derived-URL re-points computed by parseStackSetArgs. Only URLs
// that existed as launcher-derived values are rewritten; user-provided URLs are
// never touched (they produce warnings instead).
export function applyUrlSyncToEnv(env, urlSyncs) {
  for (const { key, value } of urlSyncs) {
    env[key] = value;
  }
  return env;
}

function rewirePort(url, port) {
  const match = PORT_PATTERN.exec(url);
  if (!match) return null;
  return `${match[1]}:${port}${match[2] ?? ''}`;
}

// Parses the launcher's `--set KEY=VALUE` / `--set=KEY=VALUE` occurrences for
// one target. `env` is the fully assembled base env (OS env + derived stack
// defaults); `userEnv` is the launcher's own process.env and decides whether a
// URL was user-provided. Returns `{ values, warnings, urlSyncs }`: `values` and
// `urlSyncs` must be applied to the base env before spawning.
export function parseStackSetArgs({ args, target, env, userEnv = process.env }) {
  const values = {};
  const warnings = [];
  const urlSyncs = [];
  if (!Array.isArray(args)) return { values, warnings, urlSyncs };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    let pair;
    if (arg.startsWith('--set=')) {
      pair = arg.slice('--set='.length);
    } else if (arg === '--set') {
      pair = args[index + 1];
      if (pair === undefined) {
        reject('--set requires KEY=VALUE (for example --set XIHE_CP_PORT=12699).');
      }
      index += 1;
    } else {
      continue;
    }

    const eq = typeof pair === 'string' ? pair.indexOf('=') : -1;
    if (eq <= 0) {
      reject('--set requires KEY=VALUE (for example --set XIHE_CP_PORT=12699).');
    }
    const key = pair.slice(0, eq).trim();
    const rawValue = pair.slice(eq + 1);

    const rule = STACK_SET_ALLOWLIST[key];
    if (!rule) {
      reject(`--set key ${JSON.stringify(key)} is not on the bootstrap allowlist `
        + `(allowed: ${Object.keys(STACK_SET_ALLOWLIST).join(', ')}); secrets and unknown keys are refused.`);
    }
    if (key in values) {
      reject(`--set ${key} was provided more than once; duplicate overrides are refused.`);
    }
    if (!rule.targets.includes(target)) {
      reject(`--set ${key} is not consumed by target ${JSON.stringify(target)} `
        + `(consumed by: ${rule.targets.join(', ')}); nothing was started.`);
    }
    values[key] = validatePortValue(key, rawValue);

    // Connection-side URLs: re-point launcher-derived ones so the consuming
    // target follows the new port; keep user-provided ones and warn.
    for (const urlKey of rule.connectionUrlKeys) {
      const current = env?.[urlKey];
      if (typeof current !== 'string' || current === '') continue;
      if (typeof userEnv?.[urlKey] === 'string' && userEnv[urlKey] !== '') {
        warnings.push(`${urlKey} is set explicitly; --set ${key} only changes the listening side `
          + `and the connection target stays on ${urlKey} (the stack may not wire up end to end).`);
        continue;
      }
      const rewired = rewirePort(current, values[key]);
      if (rewired === null || rewired === current) continue;
      urlSyncs.push({ key: urlKey, value: rewired });
    }
  }

  return { values, warnings, urlSyncs };
}
