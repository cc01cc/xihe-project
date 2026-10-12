import { CliError, getApiBase, requestJson } from './provider.mjs';

const SERVICE_TOKEN_ENV = 'XIHE_CP_API_TOKEN';
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_MAX_BATCHES = 200;
const MAX_BATCH_SIZE = 500;

export const ROTATION_STATUS_PATH = '/internal/v1/credentials/rotation/status';
export const ROTATION_RUNS_PATH = '/internal/v1/credentials/rotation/runs';

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
