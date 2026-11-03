#!/usr/bin/env node
/**
 * PLAN-0632 M2-3: build the Agent payload for the installer — a PyInstaller **onedir** tree.
 *
 * Why onedir (D32-05, measured in M1-T1): p50 4.00 s vs 8.17 s for onefile, no 152.7 MiB
 * unpack into %TEMP% per start, no `_MEI*` leftovers after a forced kill.  The payload is what
 * `scripts/pkg/launcher.mjs` expects at `<install>/agent/xihe-agent-onedir.exe` (+ `_internal/`),
 * so this script's default `--out` is the same install-relative shape.
 *
 * What it owns (and what it deliberately does not):
 *   owns  -> production-closure venv (`uv sync --no-dev --frozen`), pinned PyInstaller,
 *            the spec template (inlined below), the entry asset, the build, the payload layout,
 *            the JSON summary;
 *   does  -> NOT touch package manifests or lockfiles (a `--frozen` mismatch is a stop-and-report,
 *            never an `uv lock`), does NOT build CP/UI/Runtime, does NOT run the payload.
 *
 * Spec provenance: the datas/binaries/hiddenimports below are copied from the M1-T1 generator
 * (`.tmp/plan-0632-t1/gen-specs.mjs`, onedir branch), which is the spike spec that boots. The
 * one intentional change: every `copy_metadata()` goes through `_metadata()` so a distribution
 * that the current lock no longer has (PLAN-0633 4a382898 removed `langgraph-supervisor`) is
 * skipped with a log line instead of aborting the whole build.
 *
 * Usage:
 *   node scripts/pkg/build-agent-payload.mjs [--out DIR] [--venv DIR] [--work DIR] [--logdir DIR]
 *                                            [--skip-sync] [--timeout-ms N]
 *
 * Re-runnable: `uv sync` is idempotent, PyInstaller runs with `--noconfirm` (old dist/work are
 * replaced), and the two payload entries (`xihe-agent-onedir.exe`, `_internal/`) are replaced in
 * place. Nothing is committed; the default `--out` lives under `.tmp/` (gitignored).
 *
 * Zero dependencies: Node 24 built-ins only. Progress goes to stderr, the final JSON summary to
 * stdout (so `node ... | jq` stays parseable). Exit code 1 on any failure, with the log path.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/* --------------------------------------------------------------- constants */

const SCRIPT_DIR = import.meta.dirname; // <repo>/scripts/pkg
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..');
const AGENT_DIR = join(REPO_ROOT, 'packages', 'agent');
const AGENT_SRC = join(AGENT_DIR, 'src');
const ENTRY_ASSET = join(SCRIPT_DIR, 'assets', 'agent-entry.py');

/** Pinned to the M1-T1 spike so size/startup numbers stay comparable (RESULT.md §2.2). */
const PYINSTALLER_VERSION = '6.22.3';
/**
 * `pyinstaller-hooks-contrib` is a separate distribution that PyInstaller pulls in; the spike
 * resolved 2026.7, the lock-free install today resolves 2026.9. Pin it so two runs of this script
 * produce the same payload (an unpinned contrib silently changes which hooks/datas get collected).
 */
const HOOKS_CONTRIB_VERSION = '2026.9';
const PYTHON_VERSION = '3.14';
const ONEDIR_NAME = 'xihe-agent-onedir';
const IS_WINDOWS = process.platform === 'win32';
const EXE_NAME = IS_WINDOWS ? `${ONEDIR_NAME}.exe` : ONEDIR_NAME;
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

/* ------------------------------------------------------------------- args */

const USAGE = `Usage: node scripts/pkg/build-agent-payload.mjs [options]

  --out DIR         payload output dir (default: <repo>/.tmp/pkg/payload/agent)
  --venv DIR        production-closure venv    (default: <repo>/.tmp/pkg/venv-prod)
  --work DIR        PyInstaller dist/work/spec  (default: <repo>/.tmp/pkg/work)
  --logdir DIR      build logs                  (default: <repo>/.tmp/pkg/logs)
  --skip-sync       reuse the venv as-is (no uv sync / no PyInstaller install)
  --timeout-ms N    per-command timeout (default: ${DEFAULT_TIMEOUT_MS})
  -h, --help        this text`;

function parseArgs(argv) {
  const defaults = {
    out: join(REPO_ROOT, '.tmp', 'pkg', 'payload', 'agent'),
    venv: join(REPO_ROOT, '.tmp', 'pkg', 'venv-prod'),
    work: join(REPO_ROOT, '.tmp', 'pkg', 'work'),
    logdir: join(REPO_ROOT, '.tmp', 'pkg', 'logs'),
    skipSync: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  const opts = { ...defaults };
  const valued = new Map([
    ['out', 'out'],
    ['venv', 'venv'],
    ['work', 'work'],
    ['logdir', 'logdir'],
    ['timeout-ms', 'timeoutMs'],
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (raw === '-h' || raw === '--help') return { help: true };
    if (raw === '--skip-sync') {
      opts.skipSync = true;
      continue;
    }
    if (!raw.startsWith('--')) throw new Error(`unexpected argument: ${raw}`);
    const eq = raw.indexOf('=');
    const name = eq > 0 ? raw.slice(2, eq) : raw.slice(2);
    const key = valued.get(name);
    if (!key) throw new Error(`unknown option: --${name}`);
    const value = eq > 0 ? raw.slice(eq + 1) : argv[(i += 1)];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value`);
    opts[key] = key === 'timeoutMs' ? Number.parseInt(value, 10) : resolve(value);
  }
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) {
    throw new Error(`--timeout-ms must be a positive integer, got ${opts.timeoutMs}`);
  }
  return opts;
}

/* --------------------------------------------------------------- plumbing */

const startedAt = Date.now();

function log(message) {
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1).padStart(6);
  process.stderr.write(`[+${elapsed}s] ${message}\n`);
}

function byteSizeToMiB(bytes) {
  return Math.round((bytes / (1024 * 1024)) * 100) / 100;
}

function killTree(pid) {
  if (IS_WINDOWS) {
    // Windows has no process-group signal here; taskkill /T is the tree kill the repo uses.
    const res = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    if (res.error) log(`warning: taskkill failed for pid ${pid}: ${res.error.message}`);
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    log(`warning: SIGKILL group ${pid} failed: ${error.message}`);
    try {
      process.kill(pid, 'SIGKILL');
    } catch (inner) {
      log(`warning: SIGKILL ${pid} failed too: ${inner.message}`);
    }
  }
}

/**
 * Run one external command with **file-redirected** stdio (never a pipe — a packaged Python build
 * writes megabytes and a full pipe blocks it), a hard timeout, and a tree kill on timeout.
 * Returns { code, elapsedMs, logPath }.
 */
function runLogged({ label, cmd, args, cwd, env, logPath, timeoutMs }) {
  mkdirSync(dirname(logPath), { recursive: true });
  const fd = openSync(logPath, 'w');
  const header = [
    `# label:  ${label}`,
    `# cmd:    ${cmd} ${args.join(' ')}`,
    `# cwd:    ${cwd}`,
    `# start:  ${new Date().toISOString()}`,
    '# ---- output ----',
    '',
  ].join('\n');
  writeFileSync(fd, header);

  const t0 = Date.now();
  log(`${label}: ${cmd} ${args.join(' ')}`);
  log(`${label}: log -> ${logPath}`);

  return new Promise((resolvePromise, rejectPromise) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        env,
        stdio: ['ignore', fd, fd],
        windowsHide: true,
      });
    } catch (error) {
      closeSync(fd);
      rejectPromise(new Error(`${label}: spawn failed: ${error.message}\n  log: ${logPath}`));
      return;
    }

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      log(`${label}: TIMEOUT after ${timeoutMs} ms — killing pid ${child.pid} (tree)`);
      if (child.pid) killTree(child.pid);
    }, timeoutMs);

    child.on('error', (error) => {
      clearTimeout(timer);
      closeSync(fd);
      rejectPromise(new Error(`${label}: spawn error: ${error.message}\n  log: ${logPath}`));
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const elapsedMs = Date.now() - t0;
      const footer = [
        '',
        '# ---- end ----',
        `# exit:   ${code}${signal ? ` (signal ${signal})` : ''}${timedOut ? ' TIMEOUT' : ''}`,
        `# elapsed_ms: ${elapsedMs}`,
      ].join('\n');
      try {
        writeFileSync(fd, `${footer}\n`);
        closeSync(fd);
      } catch {
        // fd may already be closed when 'error' fired; the log content is what matters.
      }
      resolvePromise({ code: code ?? -1, signal, timedOut, elapsedMs, logPath });
    });
  });
}

function tailLines(file, count) {
  try {
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n').filter((line) => line.length > 0);
    return lines.slice(-count);
  } catch (error) {
    return [`<unreadable log ${file}: ${error.message}>`];
  }
}

function fail(detail, logPath) {
  const payload = {
    ok: false,
    error: detail,
    log: logPath ?? null,
    hint: logPath ? `tail: ${tailLines(logPath, 25).join('\n')}` : undefined,
    elapsedMs: Date.now() - startedAt,
  };
  process.stderr.write(`\nFAILED: ${detail}\n`);
  if (logPath) {
    process.stderr.write(`--- last 25 lines of ${logPath} ---\n`);
    process.stderr.write(`${tailLines(logPath, 25).join('\n')}\n`);
  }
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exit(1);
}

/* ----------------------------------------------------------- spec template */

/**
 * One onedir spec, single-sourced here so the payload cannot drift from the launcher's expected
 * layout. Body borrowed from `.tmp/plan-0632-t1/gen-specs.mjs` (onedir branch); UPX stays off
 * everywhere (D32-10: AV false positives) and `console=True` keeps stdout/stderr capturable by
 * the launcher's log redirection.
 */
function renderSpec({ name, entryPath, srcPath }) {
  const q = JSON.stringify;
  return `# -*- mode: python ; coding: utf-8 -*-
# GENERATED by scripts/pkg/build-agent-payload.mjs — DO NOT EDIT (edit the template in the script).
# Shape: onedir   Entry: ${entryPath}
# Name:  ${name}
from PyInstaller.utils.hooks import collect_all
from PyInstaller.utils.hooks import collect_data_files
from PyInstaller.utils.hooks import collect_submodules
from PyInstaller.utils.hooks import copy_metadata

datas = []
binaries = []
hiddenimports = [
    'tiktoken_ext.openai_public',
    'uvicorn.logging',
    'uvicorn.loops.auto',
    'uvicorn.protocols.http.auto',
    'uvicorn.protocols.websockets.auto',
    'uvicorn.lifespan.on',
    'xihe_agent.main',
]


def _metadata(spec):
    """copy_metadata() that tolerates distributions the current lock no longer carries.

    PLAN-0633 (4a382898) dropped langgraph-supervisor; a bare copy_metadata() for it aborts the
    whole build. Distribution presence belongs to the lock, not to this spec, so a miss is logged
    and treated as "no metadata to copy" — the spec then builds for both old and new dependency sets.
    """
    try:
        return copy_metadata(spec)
    except Exception as exc:  # noqa: BLE001 - a removed dependency must not break packaging
        print('[spec] copy_metadata(%r) skipped: %s' % (spec, exc))
        return []


datas += collect_data_files('litellm')
for _dist in (
    'fastmcp',
    'litellm',
    'langchain-core',
    'langchain',
    'langgraph',
    'langgraph-supervisor',  # removed in PLAN-0633; kept so an older lock still builds
    'langchain-litellm',
    'langchain-postgres',
    'pydantic',
    'loguru',
    'uvicorn',
    'httpx',
    'watchdog',
    'pyyaml',
    'python-dotenv',
):
    datas += _metadata(_dist)

hiddenimports += collect_submodules('tiktoken_ext')
_tiktoken = collect_all('tiktoken')
datas += _tiktoken[0]
binaries += _tiktoken[1]
hiddenimports += _tiktoken[2]

a = Analysis(
    [${q(entryPath)}],
    pathex=[${q(srcPath)}],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name=${q(name)},
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,           # PLAN-0632 D32-10: no UPX anywhere (AV false positives)
    console=True,        # launcher redirects stdout/stderr to logs; console=True keeps them capturable
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name=${q(name)},
)
`;
}

/* -------------------------------------------------------------- payload io */

function walkFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      throw new Error(`cannot read ${dir}: ${error.message}`);
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) files.push(full);
      else files.push(full); // symlink/junction: counted, size taken by statSync below
    }
  }
  return files;
}

function fileSizeSafe(file) {
  try {
    return statSync(file).size;
  } catch (error) {
    throw new Error(`cannot stat ${file}: ${error.message}`);
  }
}

/** Replace `dst` with `src` (rename first; Windows AV/indexer occasionally holds a handle briefly). */
function moveEntry(src, dst, attempts = 3) {
  if (existsSync(dst)) {
    rmSync(dst, { recursive: true, force: true });
    log(`relocate: replaced existing ${dst}`);
  }
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      renameSync(src, dst);
      return;
    } catch (error) {
      lastError = error;
      log(`relocate: ${src} -> ${dst} attempt ${attempt}/${attempts} failed: ${error.message}`);
      if (attempt < attempts) sleepSync(400 * attempt);
    }
  }
  throw new Error(`cannot move ${src} -> ${dst}: ${lastError?.message}`);
}

/** Blocking sleep — only used between bounded Windows rename retries. */
function sleepSync(ms) {
  const shared = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(shared), 0, 0, ms);
}

/* ------------------------------------------------------------------- main */

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${USAGE}\n`);
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`);
    process.exit(2);
  }
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const pythonPath = IS_WINDOWS
    ? join(opts.venv, 'Scripts', 'python.exe')
    : join(opts.venv, 'bin', 'python');
  const pyinstallerPath = IS_WINDOWS
    ? join(opts.venv, 'Scripts', 'pyinstaller.exe')
    : join(opts.venv, 'bin', 'pyinstaller');
  const logDir = opts.logdir;
  const specDir = join(opts.work, 'spec');
  const distPath = join(opts.work, 'dist');
  const workPath = join(opts.work, 'build');
  const specPath = join(specDir, `${ONEDIR_NAME}.spec`);
  const entryPath = join(specDir, 'agent-entry.py');
  const summaryPath = join(logDir, 'build-summary.json');

  mkdirSync(logDir, { recursive: true });
  mkdirSync(specDir, { recursive: true });
  mkdirSync(opts.out, { recursive: true });

  const timings = {};
  const logs = {};

  // 1) production-closure venv: uv sync is exact — it also PRUNES the build tooling, which is why
  //    the PyInstaller install below runs unconditionally after it (instead of "only if missing").
  if (opts.skipSync) {
    log('sync: skipped (--skip-sync); venv used as-is');
    if (!existsSync(pythonPath)) fail(`--skip-sync but no interpreter at ${pythonPath}`);
  } else {
    const uvProbe = spawnSync('uv', ['--version'], { encoding: 'utf8' });
    if (uvProbe.error || uvProbe.status !== 0) {
      fail(`uv is not runnable (${uvProbe.error?.message ?? `exit ${uvProbe.status}`}); install uv first`);
    }
    log(`sync: ${uvProbe.stdout.trim()} | project=${AGENT_DIR} | UV_PROJECT_ENVIRONMENT=${opts.venv}`);
    const sync = await runLogged({
      label: 'uv-sync',
      cmd: 'uv',
      args: ['sync', '--no-dev', '--frozen', '--python', PYTHON_VERSION],
      cwd: AGENT_DIR,
      env: { ...process.env, UV_PROJECT_ENVIRONMENT: opts.venv },
      logPath: join(logDir, 'uv-sync.log'),
      timeoutMs: opts.timeoutMs,
    });
    timings.uvSyncMs = sync.elapsedMs;
    logs.uvSync = sync.logPath;
    if (sync.code !== 0) {
      fail(
        `uv sync --no-dev --frozen failed (exit ${sync.code}); if the log says the lock is out of ` +
          `date with pyproject, that is a stop-and-report, not something this script may fix (no uv lock)`,
        sync.logPath,
      );
    }

    const install = await runLogged({
      label: 'uv-pip-install',
      cmd: 'uv',
      args: [
        'pip',
        'install',
        '--python',
        pythonPath,
        `pyinstaller==${PYINSTALLER_VERSION}`,
        `pyinstaller-hooks-contrib==${HOOKS_CONTRIB_VERSION}`,
      ],
      cwd: REPO_ROOT,
      env: { ...process.env },
      logPath: join(logDir, 'uv-pip-pyinstaller.log'),
      timeoutMs: opts.timeoutMs,
    });
    timings.pyinstallerInstallMs = install.elapsedMs;
    logs.pyinstallerInstall = install.logPath;
    if (install.code !== 0) {
      fail(`pinned PyInstaller install failed (exit ${install.code})`, install.logPath);
    }
  }

  if (!existsSync(ENTRY_ASSET)) fail(`entry asset missing: ${ENTRY_ASSET}`);
  if (!existsSync(join(AGENT_SRC, 'xihe_agent', 'main.py'))) {
    fail(`agent source not found at ${join(AGENT_SRC, 'xihe_agent', 'main.py')}`);
  }

  // 2) spec + entry. The entry is an asset file rather than an inlined string: it is Python that a
  //    reviewer reads on its own, and the spec template stays free of embedded-source quoting.
  copyFileSync(ENTRY_ASSET, entryPath);
  writeFileSync(specPath, renderSpec({ name: ONEDIR_NAME, entryPath, srcPath: AGENT_SRC }), 'utf8');
  log(`spec: ${specPath}`);

  // 3) build. --noconfirm replaces a previous dist/work tree, so a second run always succeeds.
  const buildStart = Date.now();
  const args = [
    '--noconfirm',
    '--distpath',
    distPath,
    '--workpath',
    workPath,
    '--log-level',
    'INFO',
    specPath,
  ];
  const usePyinstallerExe = existsSync(pyinstallerPath);
  const build = await runLogged({
    label: 'pyinstaller-onedir',
    cmd: usePyinstallerExe ? pyinstallerPath : pythonPath,
    args: usePyinstallerExe ? args : ['-m', 'PyInstaller', ...args],
    cwd: REPO_ROOT,
    env: { ...process.env, PYTHONUTF8: '1' },
    logPath: join(logDir, 'pyinstaller-onedir.log'),
    timeoutMs: opts.timeoutMs,
  });
  timings.pyinstallerMs = build.elapsedMs;
  logs.pyinstaller = build.logPath;
  if (build.code !== 0) {
    fail(`pyinstaller failed (exit ${build.code}${build.timedOut ? ', timed out' : ''})`, build.logPath);
  }

  // 4) payload layout: the launcher wants <install>/agent/xihe-agent-onedir.exe + _internal/,
  //    i.e. the CONTENTS of PyInstaller's onedir folder, not the folder itself.
  const stagedDir = join(distPath, ONEDIR_NAME);
  const stagedExe = join(stagedDir, EXE_NAME);
  if (!existsSync(stagedExe)) fail(`pyinstaller produced no ${stagedExe}`, build.logPath);

  const stagedEntries = readdirSync(stagedDir, { withFileTypes: true });
  if (stagedEntries.length === 0) fail(`staged onedir is empty: ${stagedDir}`, build.logPath);
  for (const entry of stagedEntries) {
    if (!entry.isDirectory() && !entry.isFile()) {
      fail(`unexpected entry type in staged onedir: ${entry.name}`, build.logPath);
    }
    moveEntry(join(stagedDir, entry.name), join(opts.out, entry.name));
  }
  log(`payload: ${stagedEntries.map((e) => e.name).join(', ')} -> ${opts.out}`);

  // 5) summary: size, file count, exe hash. Measured on the relocated payload (what ships), not
  //    on the staging tree.
  const exePath = join(opts.out, EXE_NAME);
  if (!existsSync(exePath)) fail(`payload exe missing after relocation: ${exePath}`);
  const files = walkFiles(opts.out);
  let totalBytes = 0;
  for (const file of files) totalBytes += fileSizeSafe(file);
  const exeBytes = fileSizeSafe(exePath);
  const exeSha256 = createHash('sha256').update(readFileSync(exePath)).digest('hex');

  // package count, via a log file (not a pipe) so a chatty uv cannot block on a full buffer
  const freezeLog = join(logDir, 'uv-pip-freeze.txt');
  const freeze = await runLogged({
    label: 'uv-pip-freeze',
    cmd: 'uv',
    args: ['pip', 'freeze', '--python', pythonPath],
    cwd: REPO_ROOT,
    env: { ...process.env },
    logPath: freezeLog,
    timeoutMs: opts.timeoutMs,
  });
  logs.uvPipFreeze = freeze.logPath;
  const venvPackages = freeze.code === 0
    ? readFileSync(freezeLog, 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0 && !line.startsWith('#'))
        .length
    : null;

  const summary = {
    ok: true,
    exe: exePath,
    outDir: opts.out,
    exeBytes,
    exeMiB: byteSizeToMiB(exeBytes),
    exeSha256,
    totalBytes,
    totalMiB: byteSizeToMiB(totalBytes),
    fileCount: files.length,
    layout: { exe: EXE_NAME, internal: existsSync(join(opts.out, '_internal')) ? '_internal/' : null },
    kind: 'pyinstaller-onedir',
    spec: specPath,
    entry: entryPath,
    venv: { path: opts.venv, python: pythonPath, packages: venvPackages },
    toolchain: {
      python: PYTHON_VERSION,
      pyinstaller: PYINSTALLER_VERSION,
      'pyinstaller-hooks-contrib': HOOKS_CONTRIB_VERSION,
      upx: false,
    },
    timings: { ...timings, totalMs: Date.now() - buildStart },
    logs,
    summaryPath,
    synced: !opts.skipSync,
  };
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  log(`done: ${summary.fileCount} files, ${summary.totalMiB} MiB, exe ${summary.exeMiB} MiB`);
  log(`summary: ${summaryPath}`);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => {
  fail(error?.stack ?? String(error));
});
