/**
 * PLAN-0632 M2-1: ordered service supervisor with a readiness gate per step.
 *
 * Why this exists (measured 2026-11-02, PLAN-0632 T1): the Agent's startup is an atomic
 * path that fetches 8 config domains and fails closed on `llm-provider`. With the Control
 * Plane reachable that sync costs **0.025 s**; with the CP absent the retry ladder takes
 * **58.46 s** before the Agent degrades. A launcher that starts the Agent in parallel with
 * the CP therefore shows the user ~1 minute of nothing (which reads as "hung"). This module
 * makes the order explicit and gated: each phase must be *ready* before the next one spawns.
 *
 * Design constraints this file honours:
 * - **No fixed sleeps as a wait mechanism.** Waiting is a bounded poll loop (explicit
 *   deadline + poll interval + retry ceiling); every probe is recorded, so a failure can be
 *   explained after the fact instead of guessed.
 * - **Pure logic, injected I/O.** `spawnService`, `probe`, `now`, `sleep`, `log` come from
 *   the caller, so the "no CP => Agent is never started" contract is testable without a
 *   real CP, Docker, Java or PostgreSQL (see service-supervisor.test.mjs).
 * - **Diagnosable failure, not silent retry.** A failed phase returns which step failed,
 *   what the last probe saw, how long it waited, and which services are still running.
 * - Stops are reverse-order and process-tree based (`taskkill /PID /T /F` on Windows): on
 *   Windows killing only the parent leaves orphans that keep the port bound.
 *
 * The packaged launcher (`scripts/pkg/launcher.mjs`) owns the manifest/probes; this module
 * owns the ordering, the gate, and the diagnostics.
 */

/**
 * Explicit readiness budgets. Every number is a constant with the evidence next to it —
 * never a guess buried in a loop.
 */
export const DEFAULT_TIMEOUTS = Object.freeze({
  // TCP accept only. The bundled PostgreSQL payload is the zonky server-only runtime and has
  // no psql/pg_dump/pg_isready/pg_config (PLAN-0632 D32-15), so there is nothing to ask. The
  // real gate is the CP phase: the CP runs Flyway on boot and cannot start without PG.
  // `postgres --single` is NOT a readiness signal either — it exits 0 even on SQL errors (D32-13).
  pgMs: 45_000,
  // CP cold start: it runs Flyway migrations after boot. Packaged native image reaches
  // /actuator/health UP in ~3 s (PLAN-0632 T0 smoke), dev `mvn spring-boot:run` needs
  // ~60-120 s, and a first run against a fresh database migrates from scratch — so the
  // budget covers the slow end rather than failing a legitimate first start.
  cpMs: 240_000,
  // Agent: with the CP gate in place this is mostly the packaging cost itself — onedir cold
  // start p50 4.00 s (PLAN-0632 T1). The budget is deliberately much larger than that so a
  // slow disk cannot turn a healthy start into a failure; it must NOT be relied on to paper
  // over a missing CP (that is the CP phase's job, and it is 58.46 s of retry ladder).
  agentMs: 90_000,
  runtimeMs: 60_000,
  uiMs: 60_000,
  pollMs: 500,
});

/** Ordered phase ids the launcher uses; exported so tests and docs cannot drift. */
export const PHASE_ORDER = Object.freeze(['pg', 'cp', 'agent', 'runtime', 'ui']);

const stamp = (now) => new Date(now()).toISOString();

/**
 * Poll one phase until ready or the deadline passes. Readiness is delegated to `probe`, so
 * a TCP gate (PostgreSQL) and an HTTP gate (everything else) share one loop and one log.
 *
 * `alive` (optional) reports whether the process we just spawned still exists: a CP that
 * crashes on boot (bad Flyway migration, wrong exe) must fail in seconds with "process
 * exited" instead of burning the whole readiness budget against a process that is gone.
 *
 * @returns {{ready: boolean, attempts: number, elapsedMs: number, lastProbe: object|null, exited?: boolean}}
 */
export async function waitForPhase({
  phase,
  service,
  spec,
  probe,
  now,
  sleep,
  logProbe,
  alive,
  pollMs = DEFAULT_TIMEOUTS.pollMs,
}) {
  const startedAt = now();
  const deadline = startedAt + phase.timeoutMs;
  let attempts = 0;
  let lastState = null;
  for (;;) {
    attempts += 1;
    let result;
    try {
      result = await probe(service, spec);
    } catch (error) {
      result = {
        ready: false,
        state: `probe threw: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    // Every probe is persisted (the launcher writes this to <logDir>/launcher.log); the
    // console only hears about state changes so a 240 s wait does not scroll the terminal.
    logProbe({
      at: stamp(now),
      phase: phase.name,
      service,
      attempt: attempts,
      url: result.url ?? spec?.url ?? null,
      httpStatus: result.httpStatus ?? null,
      listening: result.listening ?? null,
      state: result.state ?? (result.ready ? 'ready' : 'not-ready'),
      elapsedMs: now() - startedAt,
    });
    if (result.ready) {
      return { ready: true, attempts, elapsedMs: now() - startedAt, lastProbe: result };
    }
    if (typeof alive === 'function' && !alive()) {
      // Fail fast: the process is gone, so more probes cannot possibly succeed.
      logProbe.console?.(
        `[supervisor] step=${phase.name} process exited before becoming ready (${attempts} probes, ` +
          `${((now() - startedAt) / 1000).toFixed(2)}s)`,
      );
      logProbe({
        at: stamp(now),
        phase: phase.name,
        service,
        attempt: attempts,
        url: result.url ?? spec?.url ?? null,
        httpStatus: null,
        listening: false,
        state: 'process exited',
        elapsedMs: now() - startedAt,
      });
      return { ready: false, exited: true, attempts, elapsedMs: now() - startedAt, lastProbe: result };
    }
    if (lastState !== result.state) {
      lastState = result.state;
      logProbe.console?.(
        `[supervisor] step=${phase.name} waiting (attempt ${attempts}): ${result.state}` +
          ` (${((deadline - now()) / 1000).toFixed(1)}s left)`,
      );
    }
    if (now() >= deadline) {
      return { ready: false, attempts, elapsedMs: now() - startedAt, lastProbe: result };
    }
    await sleep(pollMs);
  }
}

/**
 * Start phases in order, gating each on readiness.
 *
 * @param {object} options
 * @param {Array<{name: string, services: string[], timeoutMs: number, pollMs?: number,
 *   failureHint?: (ctx: object) => string}>} options.phases
 * @param {Record<string, object>} options.services service name -> spec passed to spawn/probe
 * @param {object} options.deps {spawnService, probe, now, sleep, log, logProbe, isServiceRunning}
 * @returns {Promise<{ok: boolean, events: object[], started: object[], failed?: object}>}
 */
export async function runPhases({ phases, services, deps }) {
  const { spawnService, probe, now, sleep, log, logProbe, isServiceRunning } = deps;
  const events = [];
  const started = [];

  if (typeof spawnService !== 'function' || typeof probe !== 'function') {
    throw new Error('runPhases requires deps.spawnService and deps.probe');
  }

  for (const phase of phases) {
    const phaseStart = now();
    const phaseServices = phase.services ?? [phase.name];

    for (const name of phaseServices) {
      const spec = services?.[name];
      if (!spec) {
        return {
          ok: false,
          events,
          started,
          failed: {
            phase: phase.name,
            service: name,
            reason: `no manifest entry for service ${JSON.stringify(name)}`,
            elapsedMs: 0,
            hint: `manifest 缺少 ${name}：用 --exe ${name}=<path> 覆盖，或检查 --install 目录布局`,
          },
        };
      }
      if (spec.spawn === false) {
        // Gated but not started by us: an externally-managed dependency, or the D32-06 UI that
        // the CP itself serves. The phase still gates readiness, it just has nothing to spawn.
        log(`[supervisor] step=${phase.name} ${name} is not launch-owned (spawn=false); gating only`);
        events.push({ event: 'external', phase: phase.name, service: name, at: stamp(now) });
        continue;
      }
      if (typeof isServiceRunning === 'function' && isServiceRunning(name, spec)) {
        log(`[supervisor] step=${phase.name} ${name} already running; gating on readiness instead of respawning`);
        events.push({ event: 'already-running', phase: phase.name, service: name, at: stamp(now) });
        continue;
      }
      let spawned;
      try {
        spawned = await spawnService(name, spec);
      } catch (error) {
        return {
          ok: false,
          events,
          started,
          failed: {
            phase: phase.name,
            service: name,
            reason: `spawn failed: ${error instanceof Error ? error.message : String(error)}`,
            elapsedMs: now() - phaseStart,
            hint: (phase.failureHint ?? defaultHint)({ phase, service: name, spawned: null, error }),
            logs: spec.logPaths ?? null,
          },
        };
      }
      const record = {
        service: name,
        pid: spawned?.pid ?? null,
        port: spec.port ?? null,
        exe: spec.exe ?? null,
        args: spec.args ?? [],
        cwd: spec.cwd ?? null,
        startedAt: stamp(now),
        logPaths: spec.logPaths ?? null,
      };
      started.push(record);
      // Keep the pid on the spec: the readiness loop uses it to notice an early exit, and a
      // re-entrant `start` uses it to avoid respawning a service that is already up.
      spec.pid = record.pid;
      events.push({ event: 'spawn', phase: phase.name, service: name, pid: record.pid, at: stamp(now) });
      log(`[supervisor] step=${phase.name} spawned ${name} pid=${record.pid} port=${record.port ?? '-'} log=${spec.logPaths?.out ?? '-'}`);
    }

    const gatedService = phaseServices[phaseServices.length - 1];
    const gatedSpec = services?.[gatedService];
    const gate = await waitForPhase({
      phase,
      service: gatedService,
      spec: gatedSpec,
      probe,
      now,
      sleep,
      logProbe,
      alive:
        typeof isServiceRunning === 'function'
          ? () => !gatedSpec?.pid || isServiceRunning(gatedService, gatedSpec)
          : undefined,
      pollMs: phase.pollMs ?? DEFAULT_TIMEOUTS.pollMs,
    });
    events.push({
      event: gate.ready ? 'ready' : gate.exited ? 'exited' : 'timeout',
      phase: phase.name,
      service: gatedService,
      attempts: gate.attempts,
      elapsedMs: gate.elapsedMs,
      at: stamp(now),
    });
    if (!gate.ready) {
      const hintBase = (phase.failureHint ?? defaultHint)({
        phase,
        service: gatedService,
        lastProbe: gate.lastProbe,
        attempts: gate.attempts,
      });
      return {
        ok: false,
        events,
        started,
        failed: {
          phase: phase.name,
          service: gatedService,
          reason: gate.exited ? 'process exited before becoming ready' : 'readiness timeout',
          attempts: gate.attempts,
          elapsedMs: gate.elapsedMs,
          lastProbe: gate.lastProbe,
          logs: gatedSpec?.logPaths ?? null,
          hint: gate.exited
            ? `进程已退出（不是超时）：先看 ${gatedSpec?.logPaths?.err ?? '<service>.err.log'} 的最后一段；${hintBase}`
            : hintBase,
        },
      };
    }
    log(
      `[supervisor] step=${phase.name} ready in ${(gate.elapsedMs / 1000).toFixed(2)}s (${gate.attempts} probes)`,
    );
  }

  return { ok: true, events, started };
}

function defaultHint({ phase, service, lastProbe }) {
  return (
    `step ${phase.name} did not become ready: ${lastProbe?.state ?? 'unknown'}; ` +
    `inspect the ${service} logs, then re-run \`status\` (the process is left running for inspection)`
  );
}

/**
 * Stop services in reverse start order, then verify nothing is still listening.
 *
 * Reverse order matters: the CP holds database connections and the Agent holds a CP client,
 * so tearing down in start order produces a burst of connection errors in the logs of the
 * services that are about to die anyway.
 *
 * @returns {Promise<{killed: object[], residual: object, ok: boolean}>}
 */
export async function stopServices({ started, deps, verifyPorts, residualDeadlineMs = 15_000 }) {
  const { killTree, now, sleep, log, isServiceRunning } = deps;
  const killed = [];
  for (const record of [...started].reverse()) {
    const alive = typeof isServiceRunning === 'function' ? isServiceRunning(record.service, record) : true;
    if (!alive) {
      log(`[supervisor] stop ${record.service} pid=${record.pid} already gone`);
      killed.push({ ...record, alreadyGone: true });
      continue;
    }
    const result = await killTree(record);
    killed.push({ ...record, killed: result?.ok !== false, exitCode: result?.exitCode ?? null });
    log(`[supervisor] stop ${record.service} pid=${record.pid} tree exit=${result?.exitCode ?? '-'}`);
  }

  // Residual check: a killed parent can leave a child that still owns the port (this is the
  // exact failure mode `taskkill /T` exists to prevent, so verify rather than assume).
  const deadline = now() + residualDeadlineMs;
  let residual = [];
  for (;;) {
    residual = await verifyPorts();
    if (residual.length === 0 || now() >= deadline) break;
    await sleep(500);
  }
  return { killed, residual, ok: residual.length === 0 };
}

/** Format the failure report the CLI prints. Kept here so the wording is testable. */
export function formatFailure({ failed, started, logDir }) {
  const lines = [];
  lines.push(
    `[launcher] FAILED at step=${failed.phase}${failed.service && failed.service !== failed.phase ? ` (service=${failed.service})` : ''}` +
      ` after ${((failed.elapsedMs ?? 0) / 1000).toFixed(1)}s${failed.attempts ? ` / ${failed.attempts} probes` : ''}`,
  );
  if (failed.reason) lines.push(`[launcher] reason: ${failed.reason}`);
  if (failed.lastProbe) {
    lines.push(
      `[launcher] last probe: ${failed.lastProbe.state ?? 'ready'}${failed.lastProbe.url ? ` url=${failed.lastProbe.url}` : ''}`,
    );
  }
  const stillUp = started.filter((s) => s.pid);
  lines.push(
    `[launcher] services started before the failure: ${stillUp.length ? stillUp.map((s) => `${s.service}(pid=${s.pid})`).join(', ') : 'none'}`,
  );
  if (failed.logs) lines.push(`[launcher] logs: ${failed.logs.out} | ${failed.logs.err}`);
  if (logDir) lines.push(`[launcher] launcher log: ${logDir}`);
  if (failed.hint) lines.push(`[launcher] next: ${failed.hint}`);
  return lines.join('\n');
}

/**
 * Strip bracketed IPv6 entries (`[::1]`) from NO_PROXY.
 *
 * The Agent's httpx turns NO_PROXY entries into URLPatterns; a bracketed literal is parsed as
 * a URL and aborts startup with `Invalid port ':1]'`. `scripts/stack-run.mjs` already does this
 * for the dev path — the packaged launcher must do it too, otherwise the bug only reproduces in
 * an installed build on a machine whose NO_PROXY contains `[::1]` (the hardest kind to diagnose).
 */
export function sanitizeNoProxyEnv(env) {
  const cleaned = { ...env };
  for (const key of ['NO_PROXY', 'no_proxy']) {
    const value = cleaned[key];
    if (typeof value !== 'string' || !/[[\]]/.test(value)) continue;
    cleaned[key] = value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry && !/[[\]]/.test(entry))
      .join(',');
  }
  return cleaned;
}
