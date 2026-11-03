import { CliError, confirmAction, getApiBase, login, parseOptions } from './provider.mjs';

// PLAN-0643 T1.1/T1.6 (design D19–D22, spec/cli-contract.md §6): the escape hatch.
// It exists to unblock commands the CLI has not wrapped yet — it is NOT a second
// authorization path. Authorization is still the caller's user JWT, so the gates here
// only protect the *CLI's own* discipline: tool execution, plaintext secrets,
// destructive calls without impact preview, and bodies in argv.

export const API_ESCAPE_DISABLE_ENV = 'XIHE_CLI_DISABLE_API_ESCAPE';

const VALUE_OPTIONS = ['--body-file', '--timeout', '--max-bytes', '--email'];
const BOOLEAN_OPTIONS = ['--yes', '--allow-dangerous', '--include-secrets', '--raw', '--stdin'];

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const KNOWN_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);

const REVEAL_PATH = /^\/api\/v1\/credentials\/[^/]+\/reveal$/;
const MCP_PATH = /^\/api\/v1\/mcp(\/|$)/;
const CONFIG_EXPORT_PATH = '/api/v1/config/export';

function enabled(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return text === '1' || text === 'true' || text === 'yes' || text === 'on';
}

function splitPath(rawPath) {
  const value = String(rawPath ?? '').trim();
  if (value === '') throw new CliError('INVALID_ARGUMENT', 'xihe api requires a path (for example /api/v1/status).');
  const [pathname, query = ''] = value.split('?');
  return { pathname, query, raw: value };
}

function setQueryParam(query, name, value) {
  const params = new URLSearchParams(query);
  params.set(name, value);
  return params.toString();
}

function assertAllowedTarget(pathname) {
  if (!pathname.startsWith('/api/v1/')) {
    throw new CliError(
      'API_TARGET_INVALID',
      'xihe api only forwards /api/v1/** paths (the internal service surface is never reachable).',
    );
  }
  if (pathname.startsWith('/internal/') || pathname.includes('/internal/')) {
    throw new CliError('API_TARGET_INVALID', 'xihe api never forwards /internal/** service endpoints.');
  }
  if (pathname.includes('..')) {
    throw new CliError('API_TARGET_INVALID', 'xihe api rejects paths containing "..".');
  }
  if (REVEAL_PATH.test(pathname)) {
    throw new CliError(
      'API_TARGET_INVALID',
      'Credential reveal is not available through xihe api; use `xihe credential reveal <id> --mode stdout --yes`.',
    );
  }
}

export function resolveApiInvocation(rawArgs) {
  const parsed = parseOptions(rawArgs, VALUE_OPTIONS, BOOLEAN_OPTIONS);
  if (parsed.values['--body-file'] !== undefined && parsed.values['--body-file'] === '') {
    throw new CliError('INVALID_ARGUMENT', '--body-file requires a path.');
  }
  if (parsed.positionals.length === 0 || parsed.positionals.length > 2) {
    throw new CliError('INVALID_ARGUMENT', 'Usage: xihe api [METHOD] <path> [--yes] [--allow-dangerous] [--body-file <file> | --stdin] [--raw]');
  }
  let method = 'GET';
  let rawPath;
  if (parsed.positionals.length === 2) {
    method = String(parsed.positionals[0]).toUpperCase();
    rawPath = parsed.positionals[1];
    if (!KNOWN_METHODS.has(method)) {
      throw new CliError('INVALID_ARGUMENT', `Unsupported HTTP method ${parsed.positionals[0]}; use GET/HEAD/POST/PUT/PATCH/DELETE.`);
    }
  } else {
    rawPath = parsed.positionals[0];
  }
  const target = splitPath(rawPath);
  assertAllowedTarget(target.pathname);
  return {
    method,
    pathname: target.pathname,
    rawPath: target.raw,
    query: target.query,
    values: parsed.values,
  };
}

function parseBody(text) {
  const trimmed = String(text ?? '').trim();
  if (trimmed === '') return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new CliError('API_BODY_INVALID', 'The request body must be valid JSON (stdin or --body-file).');
  }
}

async function readStdin(stdin) {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(chunk);
  return parseBody(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8'));
}

function describePath(pathname, query) {
  return query ? `${pathname}?${query}` : pathname;
}

/**
 * One escape-hatch invocation. Returns `{ exitCode, envelope, bodyText }`; the caller
 * (xihe.mjs) decides how to print (json envelope vs raw body).
 */
export async function runApiEscape({
  args,
  env,
  fetchImpl = fetch,
  apiBase,
  promptSecret,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  fsImpl,
  confirm = confirmAction,
}) {
  if (enabled(env[API_ESCAPE_DISABLE_ENV])) {
    throw new CliError(
      'API_ESCAPE_DISABLED',
      `xihe api is disabled by ${API_ESCAPE_DISABLE_ENV}; ask an operator to enable it or use the wrapped commands.`,
    );
  }

  const invocation = resolveApiInvocation(args);
  const { method, pathname, values } = invocation;
  const allowDangerous = values['--allow-dangerous'] === true;
  let query = invocation.query;

  const dangerous = MCP_PATH.test(pathname);
  if (dangerous && !allowDangerous) {
    throw new CliError(
      'API_DANGEROUS_REQUIRES_ALLOW',
      'POST /api/v1/mcp executes tools; re-run with --allow-dangerous to acknowledge the audit trail.',
    );
  }
  if (pathname === CONFIG_EXPORT_PATH) {
    if (values['--include-secrets'] === true && !allowDangerous) {
      throw new CliError(
        'API_DANGEROUS_REQUIRES_ALLOW',
        'config/export can emit plaintext secrets; --include-secrets requires --allow-dangerous.',
      );
    }
    if (values['--include-secrets'] !== true) query = setQueryParam(query, 'includeSecrets', 'false');
  }

  if (MUTATING_METHODS.has(method)) {
    const target = describePath(pathname, query);
    if (values['--yes'] !== true) {
      const interactive = Boolean(stdin?.isTTY);
      if (!interactive) {
        throw new CliError(
          'API_METHOD_REQUIRES_YES',
          `${method} ${target} changes server state; pass --yes to confirm (non-interactive runs must be explicit).`,
        );
      }
      const approved = await confirm({ message: `Send ${method} ${target} to CP?`, stdin, output: stderr });
      if (!approved) throw new CliError('CONFIRMATION_DECLINED', 'The request was not sent.');
    }
    stderr.write(`# impact: ${method} ${describePath(pathname, query)}\n`);
  } else {
    stderr.write(`# api: ${method} ${describePath(pathname, query)}\n`);
  }
  if (allowDangerous) {
    stderr.write('# audit: --allow-dangerous was granted for this call; the request is logged by the CP audit trail.\n');
  }

  let body;
  if (values['--body-file'] !== undefined) {
    if (!fsImpl?.readFileSync) throw new CliError('API_BODY_INVALID', 'No filesystem reader is available for --body-file.');
    body = parseBody((() => {
      try {
        return fsImpl.readFileSync(values['--body-file'], 'utf8');
      } catch {
        throw new CliError('API_BODY_INVALID', `Cannot read body file ${values['--body-file']}.`);
      }
    })());
  } else if (values['--stdin'] === true) {
    // PLAN-0643 T1.1: stdin is only read on an explicit --stdin. Reading a
    // non-TTY stdin that never closes hangs unattended jobs, and `--body` is
    // banned (argv leaks), so an explicit opt-in is the deterministic contract.
    body = await readStdin(stdin);
  }

  const base = apiBase ?? getApiBase(env);
  const token = await login({ apiBase: base, fetchImpl, env, options: values, promptSecret });
  const timeoutMs = Number(values['--timeout'] ?? 0) > 0 ? Number(values['--timeout']) : 20_000;
  const maxBytes = Number(values['--max-bytes'] ?? 0) > 0 ? Number(values['--max-bytes']) : 2_000_000;
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (env.XIHE_WORKSPACE_ID) headers['X-Workspace-Id'] = env.XIHE_WORKSPACE_ID;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(`${base}${pathname}${query ? `?${query}` : ''}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new CliError('CP_TIMEOUT', `CP did not answer ${method} ${pathname} within ${timeoutMs}ms.`);
    }
    throw new CliError('CP_UNREACHABLE', `Could not reach CP at ${base}.`);
  } finally {
    clearTimeout(timer);
  }

  const contentType = String(response.headers?.get?.('content-type') ?? '').toLowerCase();
  if (contentType.includes('text/event-stream')) {
    throw new CliError(
      'API_RESPONSE_UNSUPPORTED',
      'xihe api does not follow SSE streams; use `xihe events tail` for event streams.',
    );
  }

  let text;
  try {
    text = await response.text();
  } catch {
    throw new CliError('CP_RESPONSE_INVALID', 'CP response could not be read.');
  }
  if (text.length > maxBytes) {
    throw new CliError('CP_RESPONSE_TOO_LARGE', 'CP response exceeded --max-bytes; re-run with a higher limit or --raw.');
  }

  let parsed;
  let parseFailed = false;
  if (text.trim() !== '') {
    try {
      parsed = JSON.parse(text);
    } catch {
      parseFailed = true;
    }
  }

  const raw = values['--raw'] === true;
  if (raw) {
    return {
      exitCode: response.ok ? 0 : 1,
      envelope: { ok: response.ok, status: response.status, body: text },
      bodyText: text,
    };
  }
  const looksJson = contentType.includes('json');
  if (parseFailed && !looksJson) {
    if (!response.ok) {
      throw new CliError(`HTTP_${response.status}`, `CP request failed (HTTP ${response.status}).`, { status: response.status });
    }
    throw new CliError(
      'API_RESPONSE_NOT_JSON',
      `CP returned ${contentType || 'an unknown content type'}; pass --raw to print it verbatim.`,
      { status: response.status },
    );
  }
  return {
    exitCode: response.ok ? 0 : 1,
    envelope: { ok: response.ok, status: response.status, body: parsed === undefined ? null : parsed },
    bodyText: parsed === undefined ? text : JSON.stringify(parsed, null, 2),
  };
}
