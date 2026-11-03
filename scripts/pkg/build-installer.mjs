#!/usr/bin/env node
/**
 * PLAN-0632 M2-3: build the XH MVP Windows installer (NSIS) from already-built payloads.
 *
 * This is the one re-runnable command for the installer. It does NOT compile the four services:
 * CP, Agent, Runtime and UI each have their own build lane (Maven / PyInstaller / Cargo / Vite),
 * and re-running them from here would hide their failures behind a five-minute NSIS run. What it
 * does do is make the *packaging* step deterministic and self-checking:
 *
 *   1. render app/ports.json from scripts/lib/stack-ports.mjs (D32-11) and re-parse it;
 *   2. compile the Java launcher (scripts/pkg/launcher) with the JDK that built the package;
 *   3. assemble <stage>/app + <stage>/payload from the four service artifacts + PG payload
 *      (zonky server-only .txz, D32-15) + the pgvector ABI artifacts (D32-13/18) + a jlink JRE
 *      (D32-02: no GraalVM on this machine, so CP ships as fat jar + trimmed runtime);
 *   4. generate the NSIS script (finish-page text and NOT-INCLUDED.txt from capabilities.json);
 *   5. run makensis, then measure installer + installed-disk sizes and write dist/size-report.json.
 *
 * Every step fails loudly with the command that fixes it. Nothing is written outside
 * `<repo>/.tmp/pkg/` (gitignored), and the stage directory is rebuilt from scratch on each run.
 *
 * Usage:
 *   node scripts/pkg/build-installer.mjs [options]
 *     --stage-only          stop after assembling/validating the stage (no makensis)
 *     --version <v>         installer version label (default: read from packages/ui/package.json)
 *     --cp-jar <path>       use a specific CP fat jar
 *     --agent-dir <path>    use a specific agent onedir payload
 *     --runtime-exe <path>  use a specific runtime exe
 *     --ui-dist <path>      use a specific UI dist
 *     --pgvector <dir>      pgvector dist dir (vector.dll/vector.control/…)
 *     --makensis <path>     makensis.exe (default: PATH or C:\Program Files (x86)\NSIS)
 *     --skip-jre            reuse the cached jlink JRE even if the module list changed
 *     --jobs <n>            reserved (reserved for future parallel file staging)
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_STACK_ID } from '../lib/stack-ports.mjs';
import { parsePortsJson, renderPortsJson } from './ports-json.mjs';

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)));
const REPO = resolve(PKG_DIR, '..', '..');
const TMP = join(REPO, '.tmp', 'pkg');
const STAGE = join(TMP, 'stage');
const CACHE = join(TMP, 'cache');
const DIST = join(TMP, 'dist');
const WORK = join(TMP, 'work');

/**
 * Pinned inputs. Each one is a distribution artifact identifier, never a "latest": a build that
 * silently picks another PostgreSQL minor or another pgvector DLL is a different product.
 */
const PINS = Object.freeze({
  pg: {
    jarUrl:
      'https://repo1.maven.org/maven2/io/zonky/test/postgres/embedded-postgres-binaries-windows-amd64/17.11.0/embedded-postgres-binaries-windows-amd64-17.11.0.jar',
    jarSha256: '98040FAE18DD9633FF95932125B0CECF0A45A1A9312E216E2A33AD03A31D4251',
    jarName: 'embedded-postgres-binaries-windows-amd64-17.11.0.jar',
    txzName: 'pgsql-17.11.0.txz',
    // The txz entry name inside the zonky jar; extracted with bsdtar (Windows tar.exe reads zip).
    txzEntry: 'postgres-windows-x86_64.txz',
  },
  pgvector: {
    dllSha256: '871814F1FBB339DDDA953CA2C2C19C23CDF0334CED6F451692A1665D93574254',
    controlSha256: '9F7D0FCADA5E68AA41ADF9D5B3AB3FD43C83F2EDD462C391A0F715D72A9941EC',
    version: '0.8.7',
  },
});

/**
 * jlink module set. `java.desktop` is not optional: Spring's bean introspection needs
 * `java.beans`, which lives there. Kept deliberately narrow (51.7 MiB measured) — every module
 * added here is paid for twice (installer + installed disk).
 */
const JLINK_MODULES = [
  'java.base',
  'java.logging',
  'java.naming',
  'java.sql',
  'java.management',
  'java.instrument',
  'java.desktop',
  // Spring Data's AOT processors resolve `javax.lang.model.SourceVersion` at runtime; without
  // java.compiler the CP dies during context refresh with NoClassDefFoundError (measured).
  'java.compiler',
  'java.security.sasl',
  'java.security.jgss',
  'java.xml',
  'java.transaction.xa',
  'java.net.http',
  'jdk.crypto.ec',
  'jdk.unsupported',
  'jdk.zipfs',
  'jdk.charsets',
];

const args = parseArgs(process.argv.slice(2));

function parseArgs(argv) {
  const parsed = { stageOnly: false, skipJre: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${token} expects a value`);
      return argv[i];
    };
    if (token === '--stage-only') parsed.stageOnly = true;
    else if (token === '--skip-jre') parsed.skipJre = true;
    else if (token === '--version') parsed.version = next();
    else if (token === '--cp-jar') parsed.cpJar = next();
    else if (token === '--agent-dir') parsed.agentDir = next();
    else if (token === '--runtime-exe') parsed.runtimeExe = next();
    else if (token === '--ui-dist') parsed.uiDist = next();
    else if (token === '--pgvector') parsed.pgvector = next();
    else if (token === '--makensis') parsed.makensis = next();
    else if (token === '--jobs') parsed.jobs = Number(next());
    else if (token === '--help' || token === '-h') parsed.help = true;
    else throw new Error(`unknown argument ${JSON.stringify(token)}`);
  }
  return parsed;
}

const log = (message) => console.log(`[pkg] ${message}`);

function fail(message, hint) {
  console.error(`[pkg] ERROR: ${message}`);
  if (hint) console.error(`[pkg] next: ${hint}`);
  process.exit(2);
}

function run(command, commandArgs, { cwd = REPO, timeout = 20 * 60_000, allowFailure = false } = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd,
    encoding: 'utf8',
    timeout,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    if (!allowFailure) fail(`${command} failed to start: ${result.error.message}`);
    return { code: -1, stdout: '', stderr: String(result.error.message) };
  }
  if (result.status !== 0 && !allowFailure) {
    console.error(result.stdout?.slice(-4000) ?? '');
    console.error(result.stderr?.slice(-4000) ?? '');
    fail(`${command} exited ${result.status}`);
  }
  return { code: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex').toUpperCase();

function human(bytes) {
  const mib = bytes / (1024 * 1024);
  return `${mib.toFixed(2)} MiB`;
}

function dirStats(dir) {
  let bytes = 0;
  let files = 0;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        bytes += statSync(full).size;
        files += 1;
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return { bytes, files };
}

function newestMatching(dir, pattern) {
  if (!existsSync(dir)) return null;
  const matches = readdirSync(dir)
    .filter((name) => pattern.test(name))
    .map((name) => join(dir, name))
    .map((path) => ({ path, mtimeMs: statSync(path).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return matches[0]?.path ?? null;
}

function newestSourceMtime(dir, extensions) {
  let newest = 0;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (extensions.some((ext) => entry.name.endsWith(ext))) {
        newest = Math.max(newest, statSync(full).mtimeMs);
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return newest;
}

function copyTree(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
}

async function download(url, destination, expectedSha256) {
  if (existsSync(destination)) {
    const actual = sha256(destination);
    if (!expectedSha256 || actual === expectedSha256) return destination;
    log(`cached ${relative(REPO, destination)} has sha ${actual}, expected ${expectedSha256}; re-downloading`);
    rmSync(destination, { force: true });
  }
  mkdirSync(dirname(destination), { recursive: true });
  log(`downloading ${url}`);
  const started = Date.now();
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) fail(`download failed: HTTP ${response.status} ${url}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const seconds = Math.max(0.001, (Date.now() - started) / 1000);
  const mib = buffer.length / (1024 * 1024);
  log(`downloaded ${mib.toFixed(2)} MiB in ${seconds.toFixed(1)}s (${(mib / seconds).toFixed(2)} MiB/s)`);
  if (mib / seconds < 1) {
    log(`WARN: download speed below 1 MiB/s — network looks abnormal (${(mib / seconds).toFixed(2)} MiB/s)`);
  }
  writeFileSync(destination, buffer);
  if (expectedSha256) {
    const actual = sha256(destination);
    if (actual !== expectedSha256) {
      rmSync(destination, { force: true });
      fail(`sha256 mismatch for ${url}: got ${actual}, expected ${expectedSha256}`);
    }
  }
  return destination;
}

/* ------------------------------------------------------------------ inputs */

function resolveInputs() {
  const cpJar =
    args.cpJar ??
    newestMatching(join(REPO, 'packages', 'control-plane', 'target'), /^control-plane-.*\.jar$/);
  if (!cpJar || !existsSync(cpJar)) {
    fail('CP fat jar not found', 'run `mvn -o -q -DskipTests package` in packages/control-plane (or pass --cp-jar)');
  }
  const cpNewestSource = newestSourceMtime(join(REPO, 'packages', 'control-plane', 'src'), ['.java', '.properties', '.sql']);
  if (cpNewestSource > statSync(cpJar).mtimeMs) {
    log(`WARN: ${relative(REPO, cpJar)} is older than the newest CP source — the packaged UI filter may be stale`);
  }

  const agentDir = args.agentDir ?? join(TMP, 'payload', 'agent');
  if (!existsSync(join(agentDir, 'xihe-agent-onedir.exe'))) {
    fail(`agent onedir payload not found: ${agentDir}`, 'run `node scripts/pkg/build-agent-payload.mjs` first (or pass --agent-dir)');
  }

  const runtimeExe =
    args.runtimeExe ??
    join(CACHE, 'cargo-target', 'release', 'xihe-runtime.exe');
  const runtimeExeFallback = join(REPO, 'packages', 'runtime', 'target', 'release', 'xihe-runtime.exe');
  const runtimePath = existsSync(runtimeExe) ? runtimeExe : runtimeExeFallback;
  if (!existsSync(runtimePath)) {
    fail('runtime exe not found', 'run `cargo build --release --bin xihe-runtime` in packages/runtime (or pass --runtime-exe)');
  }

  const uiDist = args.uiDist ?? join(REPO, 'packages', 'ui', 'dist');
  if (!existsSync(join(uiDist, 'index.html'))) {
    fail(`UI dist not found: ${uiDist}`, 'run `pnpm build` in packages/ui (or pass --ui-dist)');
  }

  return { cpJar, agentDir, runtimePath, uiDist };
}

/**
 * pgvector artifacts come from the M1 build (D32-18). They are a *distribution* artifact with a
 * pinned sha256 because the DLL is MSVC-built against exactly the bundled PostgreSQL version: a
 * different DLL is a different ABI, and the failure mode (missing symbol at CREATE EXTENSION) is
 * far away from the cause.
 */
function resolvePgvector() {
  const candidates = [
    args.pgvector,
    join(REPO, '.tmp', 'plan-0632-pgvector', 'build', 'dist'),
    // The worktree lives at <main-checkout>/.worktrees/<name>; the M1 artifacts are in the main checkout.
    join(REPO, '..', '..', '.tmp', 'plan-0632-pgvector', 'build', 'dist'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'vector.dll'))) {
      const dllSha = sha256(join(candidate, 'vector.dll'));
      if (dllSha !== PINS.pgvector.dllSha256) {
        fail(`pgvector vector.dll sha256 mismatch in ${candidate}: ${dllSha}`, 'use the M1 artifact (PLAN-0632 D32-19) or rebuild it; do not ship an unverified ABI');
      }
      const control = join(candidate, 'vector.control');
      if (!existsSync(control) || sha256(control) !== PINS.pgvector.controlSha256) {
        fail(`pgvector vector.control missing or sha mismatch in ${candidate}`, 'use the complete M1 dist directory (DLL + control + --0.8.7.sql + LICENSE)');
      }
      const sql = join(candidate, `vector--${PINS.pgvector.version}.sql`);
      if (!existsSync(sql)) fail(`pgvector SQL missing: ${sql}`, 'use the complete M1 dist directory');
      return candidate;
    }
  }
  fail('pgvector dist not found', 'pass --pgvector <dir>, or keep the M1 artifact at A03-xihe/.tmp/plan-0632-pgvector/build/dist');
}

/* ------------------------------------------------------------------- steps */

function buildJre() {
  const jre = join(CACHE, 'jre');
  const stamp = join(jre, '.modules');
  const wanted = JLINK_MODULES.join(',') + '|zip-6|strip';
  if (args.skipJre && existsSync(join(jre, 'bin', 'java.exe'))) {
    log('jre: reusing cached jlink runtime (--skip-jre)');
    return jre;
  }
  if (existsSync(join(jre, 'bin', 'java.exe')) && existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === wanted) {
    log('jre: cached jlink runtime matches the module list');
    return jre;
  }
  const jlink = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', 'jlink.exe') : 'jlink';
  rmSync(jre, { recursive: true, force: true });
  log(`jre: jlink ${JLINK_MODULES.length} modules -> ${relative(REPO, jre)}`);
  run(jlink, [
    '--add-modules', JLINK_MODULES.join(','),
    '--strip-debug',
    '--no-header-files',
    '--no-man-pages',
    '--compress=zip-6',
    '--output', jre,
  ], { timeout: 240_000 });
  writeFileSync(stamp, `${wanted}\n`, 'utf8');
  return jre;
}

function compileLauncher() {
  const source = join(PKG_DIR, 'launcher', 'src', 'com', 'cc01cc', 'xihe', 'pkg', 'Launcher.java');
  const classes = join(WORK, 'launcher-classes');
  const jar = join(WORK, 'xihe-launcher.jar');
  rmSync(classes, { recursive: true, force: true });
  mkdirSync(classes, { recursive: true });
  const javac = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', 'javac.exe') : 'javac';
  const jarTool = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', 'jar.exe') : 'jar';
  log('launcher: javac');
  run(javac, ['-encoding', 'UTF-8', '-d', classes, source], { timeout: 120_000 });
  run(jarTool, ['--create', '--file', jar, '--main-class', 'com.cc01cc.xihe.pkg.Launcher', '-C', classes, '.'], {
    timeout: 120_000,
  });
  return jar;
}

/**
 * First-run database bootstrap: a tiny JDBC program + the driver the CP already uses.
 *
 * Why this is packaged instead of being left to the CP's Flyway: Flyway only runs after the CP can
 * connect, and the CP cannot connect until role/database exist. The zonky payload has no psql or
 * createdb (D32-15), and `postgres --single` exits 0 on SQL errors (D32-13), so the only honest
 * first-run path is a real TCP connection with a SELECT after every step (DbBootstrap does that).
 *
 * The driver is extracted from the CP fat jar's BOOT-INF/lib rather than taken from a local Maven
 * repository: shipping the exact bytes the CP was built against is one less version to get wrong.
 */
function compileBootstrap(cpJar) {
  const javaHome = process.env.JAVA_HOME;
  const javac = javaHome ? join(javaHome, 'bin', 'javac.exe') : 'javac';
  const jarTool = javaHome ? join(javaHome, 'bin', 'jar.exe') : 'jar';
  const classes = join(WORK, 'bootstrap-classes');
  const outDir = join(STAGE, 'payload', 'bootstrap');
  rmSync(classes, { recursive: true, force: true });
  mkdirSync(classes, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  run(javac, ['-encoding', 'UTF-8', '-d', classes, join(PKG_DIR, 'java', 'DbBootstrap.java')], {
    timeout: 120_000,
  });
  const jar = join(outDir, 'db-bootstrap.jar');
  run(jarTool, ['--create', '--file', jar, '--main-class', 'DbBootstrap', '-C', classes, '.'], {
    timeout: 120_000,
  });

  const listing = run('tar.exe', ['-tf', cpJar], { allowFailure: true });
  const entry = (listing.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^BOOT-INF\/lib\/postgresql-[\d.]+\.jar$/.test(line));
  if (!entry) fail(`no postgresql driver inside ${cpJar}`, 'the CP fat jar should bundle BOOT-INF/lib/postgresql-<ver>.jar');
  const extract = join(WORK, 'pg-driver-extract');
  rmSync(extract, { recursive: true, force: true });
  mkdirSync(extract, { recursive: true });
  const extracted = run('tar.exe', ['-xf', cpJar, '-C', extract, entry], { allowFailure: true });
  if (extracted.code !== 0) fail(`could not extract ${entry} from ${cpJar}`);
  copyTree(join(extract, entry.replaceAll('/', '\\')), join(outDir, 'postgresql.jar'));
  log(`bootstrap: ${human(statSync(jar).size)} db-bootstrap.jar + ${human(statSync(join(outDir, 'postgresql.jar')).size)} ${entry}`);
  return jar;
}

/**
 * The finish-page text is the M2-4 deliverable: a user who installs and reads nothing else must
 * still see that this is a minimal build. Generated from the same capabilities.json as
 * app/NOT-INCLUDED.txt, so the two can never disagree.
 */
function renderFinishText(capabilities) {
  const items = capabilities.items;
  const bullets = items.slice(0, 6).map((item) => `• ${item.capability}`);
  return [
    '安装完成。开始菜单 / 桌面的「启动 XH」会依次启动 数据库 → 控制平面 → Agent → Runtime，然后自动打开浏览器。',
    '',
    '本版本未包含（最小可用版）：',
    ...bullets,
    `……共 ${items.length} 项。完整的「为什么这次不做 / 用户会看到什么 / 何时补」：`,
    '开始菜单 →「本版本未包含的能力」，或安装目录 app\\NOT-INCLUDED.html / NOT-INCLUDED.txt。',
  ].join('$\\r$\\n');
}

function renderNotIncluded(capabilities) {
  const lines = [];
  lines.push('XH（本版本安装包未包含的能力）');
  lines.push('='.repeat(60));
  lines.push('');
  lines.push('说明：以下清单专指「这个安装包没有提供的能力」，不是产品功能缺口清单。');
  lines.push(`范围裁定：用户 2026-11-03「最小可用版（3a）+ 记录缺少的能力」。共 ${capabilities.items.length} 项。`);
  lines.push('');
  for (const item of capabilities.items) {
    lines.push(`## ${item.capability}`);
    lines.push(`   为什么这次不做：${item.whyNot}`);
    lines.push(`   用户会看到什么：${item.impact}`);
    lines.push(`   何时需要补：${item.whenNeeded}`);
    lines.push('');
  }
  lines.push('排查提示：启动/运行问题的第一现场是安装目录 logs\\launcher.log（每次探针的时间、URL、HTTP 状态与失败原因）。');
  return lines.join('\r\n') + '\r\n';
}

function renderNotIncludedHtml(capabilities) {
  const items = capabilities.items
    .map(
      (item) => `      <li>
        <h2>${escapeHtml(item.capability)}</h2>
        <dl>
          <dt>为什么这次不做</dt><dd>${escapeHtml(item.whyNot)}</dd>
          <dt>用户会看到什么</dt><dd>${escapeHtml(item.impact)}</dd>
          <dt>何时需要补</dt><dd>${escapeHtml(item.whenNeeded)}</dd>
        </dl>
      </li>`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>XH — 本版本安装包未包含的能力</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.6 system-ui, "Segoe UI", sans-serif; max-width: 860px; margin: 40px auto; padding: 0 20px; }
  h1 { font-size: 1.6rem; }
  li { margin: 20px 0; }
  h2 { font-size: 1.05rem; margin: 0 0 6px; }
  dl { margin: 0; }
  dt { font-weight: 600; margin-top: 6px; }
  dd { margin: 0 0 0 1rem; }
  code { font-family: ui-monospace, Consolas, monospace; }
  .meta { color: #666; font-size: .9rem; }
</style>
</head>
<body data-product="Xihe" data-capability-count="${capabilities.items.length}">
<h1>本版本安装包未包含的能力</h1>
<p class="meta">这是「最小可用版」安装包的边界说明（用户 2026-11-03 裁定 3a）。共 ${capabilities.items.length} 项；每条都写清「为什么这次不做 / 你会看到什么 / 何时补」。这不是产品功能缺口清单。</p>
<ol>
${items}
</ol>
<p class="meta">排查：安装目录 <code>logs\\launcher.log</code> 记录每次启动的五个阶段与探针结果。本页由 <code>scripts/pkg/capabilities.json</code> 在构建时生成，不手工维护。</p>
</body>
</html>
`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function stage(inputs, capabilities) {
  rmSync(STAGE, { recursive: true, force: true });
  mkdirSync(join(STAGE, 'app'), { recursive: true });
  mkdirSync(join(STAGE, 'payload'), { recursive: true });
  mkdirSync(DIST, { recursive: true });

  // 1. ports.json from the single source of truth (D32-11), re-parsed immediately: a stage that
  //    cannot be parsed by the launcher's own contract must not reach makensis.
  const portsText = renderPortsJson(DEFAULT_STACK_ID);
  const ports = parsePortsJson(portsText);
  writeFileSync(join(STAGE, 'app', 'ports.json'), portsText, 'utf8');
  log(`app/ports.json: ${JSON.stringify(ports.ports)} (stack ${ports.stackId})`);

  // 2. launcher
  const launcherJar = compileLauncher();
  copyTree(launcherJar, join(STAGE, 'app', 'xihe-launcher.jar'));

  // 2b. first-run JDBC bootstrap (role/database/vector over a real TCP connection)
  compileBootstrap(inputs.cpJar);

  // 3. capability notice (M2-4): shipped next to the launcher, linked from the Start Menu.
  writeFileSync(join(STAGE, 'app', 'capabilities.json'), `${JSON.stringify(capabilities, null, 2)}\n`, 'utf8');
  writeFileSync(join(STAGE, 'app', 'NOT-INCLUDED.txt'), renderNotIncluded(capabilities), 'utf8');
  writeFileSync(join(STAGE, 'app', 'NOT-INCLUDED.html'), renderNotIncludedHtml(capabilities), 'utf8');

  // 4. CP: fat jar + the jlink runtime built above (D32-02: no GraalVM on this machine).
  const jre = buildJre();
  mkdirSync(join(STAGE, 'payload', 'cp'), { recursive: true });
  copyTree(inputs.cpJar, join(STAGE, 'payload', 'cp', 'xihe-control-plane.jar'));
  log(`payload/cp/xihe-control-plane.jar: ${human(statSync(inputs.cpJar).size)}`);
  log(`payload/jre: ${human(dirStats(jre).bytes)} (${dirStats(jre).files} files)`);
  copyTree(jre, join(STAGE, 'payload', 'jre'));

  // 5. Agent (onedir, D32-05), Runtime, UI.
  copyTree(inputs.agentDir, join(STAGE, 'payload', 'agent'));
  const agentStats = dirStats(join(STAGE, 'payload', 'agent'));
  log(`payload/agent: ${human(agentStats.bytes)} (${agentStats.files} files)`);
  mkdirSync(join(STAGE, 'payload', 'runtime'), { recursive: true });
  copyTree(inputs.runtimePath, join(STAGE, 'payload', 'runtime', 'xihe-runtime.exe'));
  log(`payload/runtime: ${human(statSync(inputs.runtimePath).size)}`);
  copyTree(inputs.uiDist, join(STAGE, 'payload', 'ui'));
  const uiStats = dirStats(join(STAGE, 'payload', 'ui'));
  log(`payload/ui: ${human(uiStats.bytes)} (${uiStats.files} files)`);

  // 6. PostgreSQL: ship the already-xz .txz (r=1.0 under LZMA, D32-25) + pgvector ABIs.
  const pgJar = join(CACHE, 'pg', PINS.pg.jarName);
  const matches = existsSync(pgJar) && sha256(pgJar) === PINS.pg.jarSha256;
  if (!matches) {
    // download() is async; this function is called from the async main, see ensurePgPayload().
    throw new Error('PostgreSQL jar cache is missing or has the wrong sha256 (should have been ensured before staging)');
  }
  const txz = ensurePgTxz(pgJar);
  copyTree(txz, join(STAGE, 'payload', 'pgsql.txz'));
  log(`payload/pgsql.txz: ${human(statSync(txz).size)} (extracts to ~104 MiB on first run)`);

  const pgvector = resolvePgvector();
  mkdirSync(join(STAGE, 'payload', 'pgvector', 'lib'), { recursive: true });
  mkdirSync(join(STAGE, 'payload', 'pgvector', 'share', 'extension'), { recursive: true });
  copyTree(join(pgvector, 'vector.dll'), join(STAGE, 'payload', 'pgvector', 'lib', 'vector.dll'));
  copyTree(join(pgvector, 'vector.control'), join(STAGE, 'payload', 'pgvector', 'share', 'extension', 'vector.control'));
  copyTree(
    join(pgvector, `vector--${PINS.pgvector.version}.sql`),
    join(STAGE, 'payload', 'pgvector', 'share', 'extension', `vector--${PINS.pgvector.version}.sql`),
  );
  copyTree(join(pgvector, 'LICENSE-pgvector.txt'), join(STAGE, 'payload', 'pgvector', 'LICENSE-pgvector.txt'));
}

async function ensurePgPayload() {
  const jar = await download(PINS.pg.jarUrl, join(CACHE, 'pg', PINS.pg.jarName), PINS.pg.jarSha256);
  return ensurePgTxz(jar);
}

function ensurePgTxz(jar) {
  const txz = join(CACHE, 'pg', PINS.pg.txzName);
  if (existsSync(txz)) return txz;
  mkdirSync(dirname(txz), { recursive: true });
  // Windows ships bsdtar, which reads zip archives as well as tar.* (measured PLAN-0632 T2).
  log(`pg: extracting ${PINS.pg.txzEntry} from ${PINS.pg.jarName}`);
  const result = run('tar.exe', ['-xf', jar, '-C', dirname(txz), PINS.pg.txzEntry], { allowFailure: true });
  const extracted = join(dirname(txz), PINS.pg.txzEntry);
  if (result.code !== 0 || !existsSync(extracted)) {
    fail(`could not extract ${PINS.pg.txzEntry} from the zonky jar`, 'use 7-Zip or `tar -xf <jar>` manually into .tmp/pkg/cache/pg');
  }
  if (extracted !== txz) writeFileSync(txz, readFileSync(extracted));
  return txz;
}

function versionFromUiPackage() {
  try {
    const parsed = JSON.parse(readFileSync(join(REPO, 'packages', 'ui', 'package.json'), 'utf8'));
    return String(parsed.version ?? '0.1.0');
  } catch {
    return '0.1.0';
  }
}

function gitShortSha() {
  const result = run('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD'], { allowFailure: true });
  return (result.stdout || 'unknown').trim() || 'unknown';
}

function resolveMakensis() {
  if (args.makensis) {
    if (!existsSync(args.makensis)) fail(`makensis not found: ${args.makensis}`);
    return args.makensis;
  }
  const fromPath = run('where.exe', ['makensis'], { allowFailure: true });
  const candidate = (fromPath.stdout || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (candidate && existsSync(candidate)) return candidate;
  const standard = 'C:\\Program Files (x86)\\NSIS\\makensis.exe';
  if (existsSync(standard)) return standard;
  fail('makensis not found', 'install NSIS (`winget install -e --id NSIS.NSIS`) or pass --makensis <path>');
}

function writeNsisScript({ version, installerPath, finishText, estimatedKb }) {
  const template = readFileSync(join(PKG_DIR, 'installer.nsi.template'), 'utf8');
  const generated = template
    .replaceAll('__APP_VERSION__', version)
    .replaceAll('__OUTFILE__', installerPath)
    .replaceAll('__FINISH_TEXT__', finishText)
    .replaceAll('__ESTIMATED_KB__', String(estimatedKb));
  const output = join(STAGE, 'installer.generated.nsi');
  // makensis (3.x, Unicode) reads UTF-8 scripts; the BOM makes the Chinese strings unambiguous.
  writeFileSync(output, `\ufeff${generated}`, 'utf8');
  return output;
}

function makeInstaller({ stageStats, version }) {
  const installerName = `XH-Setup-${version}-x64.exe`;
  const installerPath = join(DIST, installerName);
  rmSync(installerPath, { force: true });
  const nsi = writeNsisScript({
    version,
    installerPath,
    finishText: renderFinishText(capabilities),
    estimatedKb: Math.round(stageStats.bytes / 1024),
  });
  const makensis = resolveMakensis();
  log(`makensis ${makensis}`);
  const started = Date.now();
  const result = run(makensis, ['/V2', nsi], { cwd: STAGE, timeout: 45 * 60_000, allowFailure: true });
  if (result.code !== 0) {
    console.error(result.stdout?.split(/\r?\n/).slice(-40).join('\n') ?? '');
    console.error(result.stdout?.toLowerCase().includes('error') ? '' : result.stderr?.slice(-2000) ?? '');
    fail(`makensis exited ${result.code}`);
  }
  if (!existsSync(installerPath)) fail(`makensis reported success but ${installerPath} is missing`);
  return { installerPath, installerName, buildMs: Date.now() - started };
}

function report({ stageStats, installer, version }) {
  const installerBytes = statSync(installer.installerPath).size;
  const installedBytes = stageStats.bytes;
  const payload = {};
  for (const entry of readdirSync(join(STAGE, 'payload'))) {
    const full = join(STAGE, 'payload', entry);
    payload[entry] = statSync(full).isDirectory() ? dirStats(full).bytes : statSync(full).size;
  }
  const document = {
    generatedAt: new Date().toISOString(),
    version,
    gitSha: gitShortSha(),
    installer: {
      path: relative(REPO, installer.installerPath).split(sep).join('/'),
      bytes: installerBytes,
      mib: Number((installerBytes / (1024 * 1024)).toFixed(2)),
      sha256: sha256(installer.installerPath),
      buildSeconds: Number((installer.buildMs / 1000).toFixed(1)),
    },
    installedDisk: {
      bytes: installedBytes,
      mib: Number((installedBytes / (1024 * 1024)).toFixed(2)),
      files: stageStats.files,
    },
    compressionRatio: Number((installerBytes / installedBytes).toFixed(4)),
    payloadMib: Object.fromEntries(
      Object.entries(payload).map(([key, bytes]) => [key, Number((bytes / (1024 * 1024)).toFixed(2))]),
    ),
    budget: {
      d32_02_installer_target_mib: [160, 190],
      verdict: installerBytes / (1024 * 1024) <= 190 ? 'within 160-190 MiB' : 'OVER 190 MiB (see installer-scope.md §体积)',
    },
  };
  const reportPath = join(DIST, 'size-report.json');
  writeFileSync(reportPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  console.log('');
  log(`installer  : ${relative(REPO, installer.installerPath)}  ${human(installerBytes)}  sha256=${document.installer.sha256}`);
  log(`installed  : ${human(installedBytes)} in ${stageStats.files} files (compression ratio ${document.compressionRatio})`);
  log(`payload MiB: ${Object.entries(document.payloadMib).map(([key, value]) => `${key}=${value}`).join(' ')}`);
  log(`budget     : ${document.budget.verdict} (D32-02 target: installer 160-190 MiB)`);
  log(`report     : ${relative(REPO, reportPath)}`);
}

/* -------------------------------------------------------------------- main */

let capabilities;

async function main() {
  if (args.help) {
    console.log('usage: node scripts/pkg/build-installer.mjs [--stage-only] [--version v] [--cp-jar p] [--agent-dir p] [--runtime-exe p] [--ui-dist p] [--pgvector d] [--makensis p] [--skip-jre]');
    return;
  }
  capabilities = JSON.parse(readFileSync(join(PKG_DIR, 'capabilities.json'), 'utf8'));
  const version = args.version ?? versionFromUiPackage();
  log(`XH installer build — version ${version}, git ${gitShortSha()}, stage ${relative(REPO, STAGE)}`);

  const inputs = resolveInputs();
  await ensurePgPayload();
  stage(inputs, capabilities);
  const stageStats = dirStats(STAGE);
  log(`stage: ${human(stageStats.bytes)} in ${stageStats.files} files`);

  if (args.stageOnly) {
    log('stage-only: stopping before makensis');
    return;
  }
  const installer = makeInstaller({ stageStats, version });
  report({ stageStats, installer, version });

  // A last, cheap consistency check: the shipped notice must contain every capability the finish
  // page claims to summarize. A build that drifts the two apart must not produce an installer.
  const notice = readFileSync(join(STAGE, 'app', 'NOT-INCLUDED.txt'), 'utf8');
  for (const item of capabilities.items) {
    if (!notice.includes(item.capability)) {
      fail(`app/NOT-INCLUDED.txt is missing capability ${JSON.stringify(item.capability)}`, 'capabilities.json and the generated notice disagree');
    }
  }
  log(`NOT-INCLUDED.txt: ${capabilities.items.length} capabilities listed (M2-4)`);
}

main().catch((error) => {
  console.error(`[pkg] ERROR: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 2;
});
