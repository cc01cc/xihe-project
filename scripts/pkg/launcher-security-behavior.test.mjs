#!/usr/bin/env node
/**
 * BL-204 A（2026-11-04）behavioral proof for the three packaging security gates.
 *
 * `launcher-security.test.mjs` proves the *source* invariants (a typo fails there). This file proves
 * the *behaviour*: it compiles `Launcher.java` with the JDK that builds the installer and drives the
 * real `self-check` entry point against a throw-away install directory and a throw-away
 * `LOCALAPPDATA`, so nothing touches the operator's real `%LOCALAPPDATA%\Xihe`.
 *
 *   A① 出厂态安全可证明 — a CP log line from the explicit security list fails the start (exit 4);
 *       a clean log passes. Both signatures of the list are exercised separately, and the failure
 *       message must name the source (file:line) of the signature that fired.
 *   A② secrets ACL — the generated `launcher.properties` is owner-only (no inherited ACEs).
 *   A③ 缺 key 显式失败 — deleting one key from the generated file turns the next start into a
 *       named refusal (`LAUNCHER_INSECURE_SECRETS_MISSING`) instead of a null in the child env.
 *   B① 失败态不弹窗 — 失败仍要写 `install/logs/diagnostic.html`，但**不得**打开默认浏览器；否则每跑一次
 *       就在操作员桌面弹一个窗口，浏览器 profile 还会锁住沙盒目录、让 after() 清理失败（task-21 回归）。
 *
 * No skipping: the JDK is a hard prerequisite of the packaging lane, so a missing `javac`/`java`
 * fails here rather than reporting a green run that proved nothing.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PKG_DIR = dirname(fileURLToPath(import.meta.url));
const LAUNCHER = join(PKG_DIR, 'launcher', 'src', 'com', 'cc01cc', 'xihe', 'pkg', 'Launcher.java');
const MAIN_CLASS = 'com.cc01cc.xihe.pkg.Launcher';
const CP_VALIDATOR = 'SecurityDefaultsValidator.java';

function findTool(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const candidates = [];
  if (process.env.JAVA_HOME) {
    candidates.push(join(process.env.JAVA_HOME, 'bin', exe));
  }
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' });
  if (probe.status === 0) {
    candidates.push(...probe.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  }
  const found = candidates.find((candidate) => existsSync(candidate));
  assert.ok(found, `${name} not found (JAVA_HOME or PATH): the packaging lane requires a JDK`);
  return found;
}

let work;
let java;
let classes;

before(() => {
  const javac = findTool('javac');
  java = findTool('java');
  work = mkdtempSync(join(tmpdir(), 'xihe-bl204-'));
  classes = join(work, 'classes');
  mkdirSync(classes, { recursive: true });
  execFileSync(javac, ['-d', classes, LAUNCHER], { stdio: 'pipe' });
});

after(() => {
  if (work) {
    // 句柄有时比进程晚一步释放（AV/索引器/上一个 case 的 JVM）：重试几次，别让清理失败把整组安全断言报红。
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

/** One isolated install dir + LOCALAPPDATA, so the generated secrets never reach the real machine. */
function sandbox(name) {
  const root = join(work, name);
  const install = join(root, 'install');
  mkdirSync(join(install, 'app'), { recursive: true });
  const localAppData = join(root, 'localappdata');
  mkdirSync(localAppData, { recursive: true });
  const secretsFile = join(localAppData, 'Xihe', 'secrets', 'launcher.properties');
  const launcherLog = join(install, 'logs', 'launcher.log');
  return { root, install, localAppData, secretsFile, launcherLog };
}

function selfCheck(box, scanLog) {
  // task-21：self-check 的失败态会写 install/logs/diagnostic.html，并在没有 --no-browser 时**打开默认
  // 浏览器**（Launcher.writeDiagnostic）。没有这个开关，每跑一次测试就在操作员桌面上弹一个窗口，且浏览器
  // 的 user-data-dir 落在本沙盒的 LOCALAPPDATA 里、持续占着句柄，让 after() 的 rmSync 报 EPERM/ENOTEMPTY。
  const args = ['-cp', classes, MAIN_CLASS, 'self-check', '--install', box.install, '--quiet', '--no-browser'];
  if (scanLog) {
    args.push('--scan-log', scanLog);
  }
  const result = spawnSync(java, args, {
    encoding: 'utf8',
    env: { ...process.env, LOCALAPPDATA: box.localAppData },
  });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function writeLog(box, name, body) {
  const file = join(box.install, 'logs', name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body, 'utf8');
  return file;
}

test('A(3)+A(1): a clean run passes, attests 5/5 keys, and writes the secrets file', () => {
  const box = sandbox('clean');
  const log = writeLog(box, 'clean.log', 'INFO starting control-plane\nINFO Flyway applied\n');
  const result = selfCheck(box, log);
  assert.equal(result.code, 0, `clean self-check must pass, got ${result.code}: ${result.stderr}`);
  assert.match(result.stdout, /self-check OK/);
  assert.ok(existsSync(box.secretsFile), 'the first run must create launcher.properties');
  const launcherLog = readFileSync(box.launcherLog, 'utf8');
  assert.match(launcherLog, /security: env=prod keys=5\/5 allowDevKeys=false/,
    'the attestation line must state the env, the key count and the dev-key switches');
  assert.match(launcherLog, /security: acl launcher\.properties\.tmp entries=/,
    'the tmp file must be hardened BEFORE the atomic move (BL-204 A②)');
  assert.match(launcherLog, /secrets: wrote .*\(7 keys, atomic move, owner-only ACL\)/,
    'the write must report the atomic move and the owner-only ACL');
});

test('A(1): the WARN signature from the explicit list fails the start with exit 4 and names its source', () => {
  const box = sandbox('warn');
  const secretsBefore = (() => {
    selfCheck(box, null); // create the secrets file first: a security failure must not depend on it
    return readFileSync(box.secretsFile, 'utf8');
  })();
  const log = writeLog(box, 'cp.out.log',
    'INFO Starting ControlPlane\n'
    + 'WARN 1 --- [main] c.c.p.x.c.SecurityDefaultsValidator : Insecure default configuration detected '
    + '(dev mode: WARN only; a prod start would refuse)\nINFO Tomcat started on port 12631\n');
  const result = selfCheck(box, log);
  assert.equal(result.code, 4, `a security WARN must be exit 4 (security refusal), got ${result.code}`);
  assert.match(result.stderr, /LAUNCHER_SECURITY_DEFAULTS_REJECTED/,
    'the refusal must carry the named code, not a generic failure');
  assert.ok(result.stderr.includes(`${CP_VALIDATOR}:49`),
    `the refusal must name the CP source of the signature, got: ${result.stderr}`);
  assert.equal(readFileSync(box.secretsFile, 'utf8'), secretsBefore,
    'a security refusal must not touch the existing secrets file');
});

test('A(1): the prod-refusal signature is matched too (narrowed literal, own source line)', () => {
  const box = sandbox('refused');
  selfCheck(box, null);
  const log = writeLog(box, 'cp.err.log',
    'ERROR 1 --- [main] c.c.p.x.c.SecurityDefaultsValidator : Refusing to start: insecure default '
    + 'configuration in prod mode:\n - XIHE_CP_JWT_SECRET is blank\n');
  const result = selfCheck(box, log);
  assert.equal(result.code, 4, `the prod refusal must be exit 4, got ${result.code}`);
  assert.ok(result.stderr.includes(`${CP_VALIDATOR}:45`),
    `the refusal must cite the ERROR source line, got: ${result.stderr}`);
});

test('A(3): a missing key is a named refusal, not a null in the child environment', () => {
  const box = sandbox('missing-key');
  assert.equal(selfCheck(box, null).code, 0, 'the seeded run must succeed');
  const truncated = readFileSync(box.secretsFile, 'utf8')
    .split(/\r?\n/)
    .filter((line) => !line.startsWith('jwt.secret'))
    .join('\n');
  writeFileSync(box.secretsFile, truncated, 'utf8');
  const result = selfCheck(box, null);
  assert.equal(result.code, 4, `a missing key must be exit 4 (security refusal), got ${result.code}`);
  assert.match(result.stderr, /LAUNCHER_INSECURE_SECRETS_MISSING/);
  assert.match(result.stderr, /jwt\.secret/, 'the refusal must name the missing key');
});

test('A(2): the generated secrets file carries no inherited ACEs (owner-only)', () => {
  if (process.platform !== 'win32') {
    return; // POSIX mode is asserted by the source gate (hardenPosix → 600); icacls is Windows-only
  }
  const box = sandbox('acl');
  assert.equal(selfCheck(box, null).code, 0, 'the seeding run must succeed');
  const icacls = execFileSync('icacls', [box.secretsFile], { encoding: 'utf8' });
  assert.ok(!/\(I\)/.test(icacls),
    `the secrets file still inherits ACEs (a copied DACL leaks the file to other users):\n${icacls}`);
  assert.ok(!/BUILTIN\\Users/i.test(icacls) && !/Everyone/i.test(icacls),
    `the secrets file is readable beyond the owner:\n${icacls}`);
});

/** 浏览器把 profile 写进 %LOCALAPPDATA%：沙盒 LOCALAPPDATA 里出现这些目录 = 本次运行有浏览器被拉起过。 */
const BROWSER_PROFILE_PATHS = [
  ['Google', 'Chrome'],
  ['Google', 'Chrome Beta'],
  ['Microsoft', 'Edge'],
  ['BraveSoftware'],
  ['Mozilla', 'Firefox'],
];

function browserProfileDirs(box) {
  return BROWSER_PROFILE_PATHS.map((parts) => join(box.localAppData, ...parts)).filter((dir) => existsSync(dir));
}

/** win32：命令行指向本次运行沙盒的活浏览器进程 —— 本测试若弹窗，命令行里一定带着沙盒下的 diagnostic.html。 */
function liveBrowserProcesses(needle) {
  if (process.platform !== 'win32') {
    return [];
  }
  const script =
    'Get-CimInstance Win32_Process'
    + ' | Where-Object { $_.Name -match "^(chrome|msedge|brave|firefox|vivaldi)" -and $_.CommandLine -like "*'
    + needle
    + '*" }'
    + ' | ForEach-Object { "$($_.ProcessId):$($_.Name)" }';
  const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  return out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

test('B(1): a failing self-check writes diagnostic.html but never opens a browser', () => {
  const box = sandbox('no-browser');
  const log = writeLog(box, 'cp.out.log',
    'INFO Starting ControlPlane\n'
    + 'WARN 1 --- [main] c.c.p.x.c.SecurityDefaultsValidator : Insecure default configuration detected '
    + '(dev mode: WARN only; a prod start would refuse)\nINFO Tomcat started on port 12631\n');
  const result = selfCheck(box, log);
  assert.equal(result.code, 4, 'this scenario must still fail — the failure is what triggers the diagnostic page');

  assert.ok(existsSync(join(box.install, 'logs', 'diagnostic.html')),
    'the diagnostic page must still be written: --no-browser suppresses the window, not the artifact');

  const profiles = browserProfileDirs(box);
  assert.deepEqual(profiles, [],
    'self-check opened a browser: its profile landed under the throw-away LOCALAPPDATA ('
    + profiles.join(', ') + ')');

  const live = liveBrowserProcesses(work);
  assert.deepEqual(live, [],
    'self-check left browser processes whose command line points into this run\'s sandbox '
    + '(one visible window per failure): ' + live.join(', '));
});
