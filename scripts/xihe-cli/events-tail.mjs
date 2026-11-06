import { CliError } from './provider.mjs';

// PLAN-0643 T4.6 (M6-3): `events tail` — session-scoped SSE readback
// (GET /api/v1/events?sessionId=…, OpenAPI operationId chatEvents).
//
// Default (no --follow): read the live stream until the server closes it or
// --timeout seconds pass (default 5), print one JSON line per event, exit 0.
// --follow: stream until the client aborts (Ctrl-C in main(); exit 0).
// --since <n> maps to the Last-Event-ID request header (v1: the session SSE
// may ignore it; kept for the workspace-SSE parity noted in tasks.md T4.6).
//
// Frames follow the SSE grammar: `event:`/`data:`/`id:` fields, `:` comment
// lines (heartbeats may arrive as comments and are skipped), blank line = dispatch.

function parseSeconds(raw, fallback) {
  if (raw === undefined) return fallback;
  if (!/^\d{1,5}$/.test(String(raw))) {
    throw new CliError('INVALID_ARGUMENT', '--timeout must be a non-negative integer (seconds).');
  }
  return Number(raw);
}

export function createSseParser(onEvent) {
  let eventName = null;
  let id = null;
  let dataLines = [];
  const dispatch = () => {
    if (dataLines.length === 0 && eventName === null) return;
    const raw = dataLines.join('\n');
    let parsed;
    try {
      parsed = raw === '' ? null : JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    onEvent({
      event: eventName ?? 'message',
      ...(id !== null ? { id } : {}),
      ...(parsed !== undefined ? { data: parsed } : { raw }),
    });
    eventName = null;
    id = null;
    dataLines = [];
  };
  return (chunk) => {
    for (const line of chunk.split('\n')) {
      if (line.startsWith(':')) continue; // comment / heartbeat comment
      if (line === '') {
        dispatch();
        continue;
      }
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') eventName = value;
      else if (field === 'data') dataLines.push(value);
      else if (field === 'id') id = value;
    }
  };
}

function problemFromResponse(body, httpStatus) {
  const code = typeof body?.code === 'string' ? body.code : `HTTP_${httpStatus}`;
  const message = typeof body?.message === 'string' ? body.message : `CP answered HTTP ${httpStatus}.`;
  return new CliError(code, message, { status: httpStatus }, 1);
}

export async function runEventsTail({
  apiBase, fetchImpl, token, sessionId, options = {}, output, signal,
}) {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    throw new CliError('INVALID_ARGUMENT', 'events tail requires one session ID.');
  }
  const follow = options['--follow'] === true;
  const timeoutSeconds = parseSeconds(options['--timeout'], 5);
  const sink = output ?? process.stdout;

  const headers = { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' };
  if (options['--since'] !== undefined) headers['Last-Event-ID'] = String(options['--since']);

  const timeoutSignal = follow
    ? null
    : AbortSignal.timeout(Math.max(timeoutSeconds, 0) * 1000);
  const requestSignal = signal && timeoutSignal
    ? AbortSignal.any([signal, timeoutSignal])
    : (signal ?? timeoutSignal ?? undefined);

  let response;
  try {
    response = await fetchImpl(
      `${apiBase}/api/v1/events?sessionId=${encodeURIComponent(sessionId.trim())}`,
      { headers, ...(requestSignal ? { signal: requestSignal } : {}) },
    );
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      // connect-phase timeout/Ctrl-C before any event: not an error, just silence
      return { kind: 'events-tail', events: 0, follow, timeoutSeconds };
    }
    throw new CliError('CONNECTION_FAILED', `Cannot reach the CP event stream: ${error?.message ?? error}`, {}, 1);
  }
  if (!response.ok) {
    let body = null;
    try { body = await response.json(); } catch { /* status carries the result */ }
    throw problemFromResponse(body, response.status);
  }

  let delivered = 0;
  const parser = createSseParser((event) => {
    sink.write(`${JSON.stringify(event)}\n`);
    delivered += 1;
  });
  const reader = response.body?.getReader();
  if (!reader) {
    throw new CliError('EVENTS_STREAM_FAILED', 'The CP event stream has no body.', {}, 1);
  }
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) parser(line.endsWith('\r') ? line.slice(0, -1) : line);
    }
    buffer += decoder.decode();
    if (buffer !== '') parser(buffer);
    parser('');
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      // Ctrl-C (--follow) or --timeout elapse: a designed exit, not a failure.
      return { kind: 'events-tail', events: delivered, follow, timeoutSeconds };
    }
    throw new CliError('EVENTS_STREAM_FAILED',
      `The event stream failed mid-read: ${error?.message ?? error}`, {}, 1);
  }
  return { kind: 'events-tail', events: delivered, follow, timeoutSeconds };
}
