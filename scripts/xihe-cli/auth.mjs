import { CliError, login, parseOptions, promptSecret as defaultPromptSecret, requestJson } from './provider.mjs';
import { clearToken, describeToken, persistToken, readStore, resolveTokenPath, tokenEntryFor, TOKEN_ENV } from './token-store.mjs';

// PLAN-0643 T1.2–T1.5: the `xihe auth` group. It only owns the token *cache*
// (access token, per base URL). Authorization is still CP's user JWT; nothing here
// can widen it. Status prints metadata only — never the token value or a fragment.

function mask() {
  return '<redacted>';
}

function requireTokenFileFlag(values) {
  return values['--force'] === true;
}

/**
 * PLAN-0643 T1.5 invalidation matrix (design D17/D8, spec §5):
 *  - expired cache      → one silent password re-login, then rewrite the entry
 *  - CP 401 on the token → drop the entry, one re-login, retry once
 *  - CP 403              → keep the token (identity is fine, permission is not), no retry
 *  - network failure     → keep the token, no cache mutation
 */
export async function verifyToken({ apiBase, fetchImpl, token }) {
  try {
    await requestJson('/api/v1/status', { apiBase, fetchImpl, token });
    return { outcome: 'ok' };
  } catch (error) {
    if (!(error instanceof CliError)) return { outcome: 'network', detail: 'unknown error' };
    const status = error.details?.status;
    if (status === 401) return { outcome: 'unauthorized', code: error.code };
    if (status === 403) return { outcome: 'forbidden', code: error.code };
    if (error.code === 'CP_UNREACHABLE' || error.code === 'CP_TIMEOUT' || error.code === 'CONNECT_FAILED') {
      return { outcome: 'network', code: error.code };
    }
    return { outcome: 'network', code: error.code, detail: error.message };
  }
}

export async function runAuthCommand({
  command,
  rest,
  env,
  fetchImpl,
  apiBase,
  promptSecret = defaultPromptSecret,
  fsImpl,
  aclRunner,
  platform,
  now,
  stderr = process.stderr,
}) {
  if (command === 'login') {
    const parsed = parseOptions(rest, ['--email'], ['--force', '--no-cache', '--yes']);
    if (parsed.positionals.length !== 0) throw new CliError('INVALID_ARGUMENT', 'auth login takes no positional arguments.');
    const envToken = typeof env?.[TOKEN_ENV] === 'string' ? env[TOKEN_ENV].trim() : '';
    if (envToken !== '') {
      stderr.write(`# note: ${TOKEN_ENV} is set and takes precedence over the cache; the file will not be used.\n`);
    }
    const token = await login({
      apiBase,
      fetchImpl,
      env,
      options: { ...parsed.values },
      promptSecret,
      forcePassword: true,
      strictCache: true,
    });
    if (parsed.values['--no-cache'] === true) {
      return { kind: 'auth-login', baseUrl: apiBase, persisted: false, reason: '--no-cache', token: mask() };
    }
    // login() writes the cache for the ordinary path; --force re-writes it here so an
    // existing-but-unwritable file reports the real cause instead of being skipped.
    const persisted = persistToken(env, {
      baseUrl: apiBase,
      token,
      email: parsed.values['--email'],
      fsImpl,
      platform,
      aclRunner,
      now,
    });
    if (!persisted.ok) throw new CliError(persisted.code, persisted.message);
    const verification = await verifyToken({ apiBase, fetchImpl, token });
    if (verification.outcome === 'unauthorized') {
      clearToken(env, { baseUrl: apiBase, fsImpl, platform });
      throw new CliError('AUTH_TOKEN_REJECTED', 'CP rejected the freshly issued token; the cached entry was dropped.');
    }
    if (verification.outcome === 'forbidden') {
      stderr.write('# warn: the token is valid but lacks permission for /api/v1/status (403); the cache was kept.\n');
    }
    if (verification.outcome === 'network') {
      stderr.write('# warn: CP is unreachable, so the token was not verified; the cache was kept.\n');
    }
    return {
      kind: 'auth-login',
      baseUrl: apiBase,
      persisted: true,
      path: persisted.path,
      verified: verification.outcome,
      email: parsed.values['--email'] ?? null,
    };
  }

  if (command === 'status') {
    const parsed = parseOptions(rest, [], ['--check']);
    if (parsed.positionals.length !== 0) throw new CliError('INVALID_ARGUMENT', 'auth status takes no positional arguments.');
    const status = { kind: 'auth-status', baseUrl: apiBase, ...describeToken(env, apiBase, { fsImpl, platform, now }) };
    if (parsed.values['--check'] === true && status.hasToken) {
      const entry = tokenEntryFor(env, apiBase, { fsImpl, platform, now });
      const token = entry.kind === 'hit' ? entry.token : (env?.[TOKEN_ENV] ?? '').trim();
      const verification = await verifyToken({ apiBase, fetchImpl, token });
      if (verification.outcome === 'unauthorized') {
        clearToken(env, { baseUrl: apiBase, fsImpl, platform });
      }
      status.verification = verification.outcome;
      status.entryDropped = verification.outcome === 'unauthorized';
    }
    return status;
  }

  if (command === 'logout') {
    const parsed = parseOptions(rest, [], ['--force', '--yes']);
    if (parsed.positionals.length !== 0) throw new CliError('INVALID_ARGUMENT', 'auth logout takes no positional arguments.');
    const state = readStore(env, { fsImpl, platform });
    if ((state.kind === 'corrupt' || state.kind === 'unsafe') && !requireTokenFileFlag(parsed.values)) {
      throw new CliError(
        state.kind === 'unsafe' ? 'TOKEN_FILE_UNSAFE' : 'TOKEN_FILE_CORRUPT',
        `${state.path} is ${state.kind} (${state.reason}); re-run \`xihe auth logout --force\` to remove it.`,
      );
    }
    const cleared = clearToken(env, { baseUrl: apiBase, fsImpl, platform });
    if (!cleared.ok) throw new CliError(cleared.code, cleared.message);
    return { kind: 'auth-logout', baseUrl: apiBase, path: cleared.path, removed: cleared.removed, fileDeleted: cleared.fileDeleted === true };
  }

  throw new CliError('INVALID_ARGUMENT', 'Unknown auth command; use login/status/logout.');
}

export { resolveTokenPath };
export const AUTH_COMMANDS = ['login', 'status', 'logout'];
