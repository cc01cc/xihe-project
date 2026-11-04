import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// PLAN-0656 R3/R5: orphan-process sweep, shared by `dev-stack.mjs` and `stack-run.mjs`.
//
// Root cause class (窗口1 / 0648 第二次现场): a crashed or partial stop leaves the
// runtime executable holding the stack's port, so the next start fails with "port
// already in use". Ownership is decided by TWO conditions and both must hold:
//   1. the process listens on one of THIS stack's ports (ports are the stack's SSOT
//      identity — never shared across stacks); and
//   2. its name/cmdline matches the service's identity profile (guards against
//      killing a stranger that happens to squat our port).
// A listener that fails either check is reported and left untouched. Callers that
// can prove the listener is a HEALTHY dev-stack-managed service (live pid record)
// should classify it as 'recorded' and skip the kill — restarting a healthy service
// mid-flight is not the sweep's job.

export const SERVICE_OWNER = {
  runtime: /xihe-runtime/i,
  // `mvn spring-boot:run` forks a JVM whose cmdline hides the classpath in an
  // @argfile, leaving only the main class (`com.cc01cc.p.xihe.cp.CpApplication`).
  cp: /spring-boot:run|control-plane|xihe-cp|xihe\.cp|CpApplication/i,
  agent: /xihe_agent|xihe-agent/i,
  ui: /dev-ui-host|vite\b|xihe-ui/i,
};

/** LISTEN processes on the given ports: [{port, pid, name, cmdline}] (Windows only). */
export function stackListeners(portList, { isWindows = process.platform === 'win32' } = {}) {
  if (!isWindows || portList.length === 0) return [];
  const ps =
    `$ports=@(${portList.join(',')});` +
    'Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |' +
    ' Where-Object { $ports -contains $_.LocalPort } |' +
    ' ForEach-Object { $proc = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue;' +
    ' if ($proc) { $c = (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)").CommandLine;' +
    ' [pscustomobject]@{ port=[int]$_.LocalPort; pid=[int]$_.OwningProcess; name=[string]$proc.ProcessName; cmdline=[string]$c } } }' +
    ' | ConvertTo-Json -Compress';
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) return [];
  const text = String(result.stdout || '').trim();
  if (text === '') return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

export function serviceForPort(ports, port) {
  return Object.keys(ports).find((service) => ports[service] === port);
}

/**
 * Pure ownership decision for one listener — unit-testable without PowerShell.
 * `ports` maps service → port (only cp/runtime/agent/ui/pg keys are meaningful);
 * `services` optionally restricts the sweep to a subset (stack-run guards one
 * service at a time).
 */
export function classifyListener(listener, { ports, services, isWindows = process.platform === 'win32' } = {}) {
  if (!isWindows) return { kind: 'unsupported' };
  const service = serviceForPort(ports, listener.port);
  // Scoped sweeps (stack-run guards ONE service) ignore the stack's other listeners:
  // they are healthy siblings, not this guard's business, and certainly not "foreign".
  if (services !== undefined && (service === undefined || !services.includes(service))) {
    return { kind: 'ignored', service: service ?? null };
  }
  const profile = service ? SERVICE_OWNER[service] : undefined;
  const identity = `${listener.name ?? ''} ${listener.cmdline ?? ''}`;
  if (service && profile && profile.test(identity)) return { kind: 'kill', service };
  return { kind: 'foreign', service: service ?? null };
}

/**
 * Kill orphaned processes of a stack. Every outcome is logged with pid/profile/port
 * so a later failure can be attributed without guessing.
 *
 * @param {object} options
 * @param {{stackId:string, ports:Object<string,number>}} options.derived  deriveStack() result
 * @param {string} options.reason    log prefix, e.g. 'stop' / 'start' / 'stack-run runtime'
 * @param {string[]} [options.services]  restrict to these services (default: all)
 * @param {boolean} [options.quietWhenIdle]  skip the "no orphan listeners" line
 * @returns {{killed:Array, foreign:Array}}
 */
export function sweepOrphanProcesses({ derived, reason, services, quietWhenIdle = false } = {}) {
  const ports = derived.ports;
  const killed = [];
  const foreign = [];
  for (const listener of stackListeners(Object.values(ports))) {
    const decision = classifyListener(listener, { ports, services });
    if (decision.kind === 'unsupported') break;
    if (decision.kind === 'ignored') continue;
    if (decision.kind === 'kill') {
      console.log(
        `[dev-stack] ${reason}: orphan ${decision.service} pid=${listener.pid} name=${listener.name} ` +
          `port=${listener.port} (${derived.stackId}) — killing (stack port + service profile)`,
      );
      const result = spawnSync('taskkill', ['/PID', String(listener.pid), '/T', '/F'], { windowsHide: true });
      if (result.status === 0) {
        killed.push(listener);
      } else {
        console.error(`[dev-stack] ${reason}: taskkill pid=${listener.pid} failed (exit ${result.status})`);
      }
    } else {
      console.warn(
        `[dev-stack] ${reason}: WARN port ${listener.port} held by a FOREIGN process ` +
          `(pid=${listener.pid} name=${listener.name}) — not ours to kill; stop it manually if the port stays busy`,
      );
      foreign.push(listener);
    }
  }
  if (!quietWhenIdle && killed.length === 0 && foreign.length === 0) {
    console.log(`[dev-stack] ${reason}: no orphan listeners on ${derived.stackId} ports`);
  }
  return { killed, foreign };
}

/** Read this stack's dev-stack pid record (may be null). */
export function readStackPidRecord(projectRoot, derived) {
  try {
    return JSON.parse(readFileSync(join(projectRoot, derived.logDir, 'dev-stack-pids.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** Is the service currently managed by a live dev-stack supervisor (do NOT sweep it)? */
export function recordedServiceAlive(projectRoot, derived, service) {
  const record = readStackPidRecord(projectRoot, derived);
  const pid = record?.services?.[service]?.pid;
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
