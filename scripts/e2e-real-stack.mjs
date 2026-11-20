#!/usr/bin/env node
/**
 * 真栈 e2e 跑批入口（task-161）。
 *
 * Why: 对既有真栈跑 `packages/ui/e2e/real/**` 时，**两个环境变量是必需的**，缺任一个
 * 读数都会像产品红而不是配置错：
 * - `XIHE_UI_PORT`：`e2e/playwright.config.ts:8` 的默认端口是 12750（不是任何栈段），
 *   不设就会 goto 到没人监听的端口 ⇒ `net::ERR_CONNECTION_REFUSED`。
 * - `XIHE_E2E_EXTERNAL_SERVER=1`：不设则 config 的 `webServer` 自己起 `pnpm dev`，
 *   对已占用的栈端口直接报 `http://localhost:12640 is already used`。
 * 本 runner 把这层「端口 + 外部服务」的推导固化成一条命令：栈 id 由 `--stack` 给，
 * 端口从 SSOT `scripts/lib/stack-ports.mjs` 派生（**不硬编码 12640**），起跑前先探活，
 * 端口没人听就**显式失败**（退出码 3）并给出起栈命令，绝不静默回落 12750。
 *
 * 契约：
 * - 不改 `e2e/playwright.config.ts` 的任何既有值（mock 车道共用该 config）。
 * - 子进程 env = SSOT `deriveStack(id).env` **覆盖**外来值（real spec 会读 XIHE_CP_PORT 等，其缺省
 *   值是 stack-1 段；壳里残留的旧栈变量正是要防的失败模式），再钉 XIHE_UI_PORT 与 external=1。
 * - 不引新依赖；不读栈租约文件、不探活以外的系统状态（复用 `dev-stack.mjs status` 只做诊断打印）。
 * - 参数与退出码透传给 playwright：本脚本自己只用 2 = 参数/环境错，3 = 栈未就绪。
 *
 * Usage:
 *   node scripts/e2e-real-stack.mjs --stack 2 e2e/real/ui-health.spec.ts
 *   node scripts/e2e-real-stack.mjs --stack 2 e2e/real/container-persistence.spec.ts --reporter=line
 *   node scripts/e2e-real-stack.mjs --stack 2 --dry-run e2e/real/ui-health.spec.ts   # 只打印解析结果
 *
 * 选项（其余参数原样透传给 `playwright test`）：
 *   --stack <n|stack-n>   目标栈，缺省取 XIHE_STACK_ID，再缺省 stack-1；端口来自 SSOT
 *   --ui-port <port>      覆盖 UI 端口（仅用于非标准栈；与 SSOT 不一致时打 WARN）
 *   --dry-run             只打印解析出的端口与命令行，不探活、不跑
 *   --help / -h           本说明
 *
 * 退出码：0 playwright 全绿；2 参数/环境错；3 目标栈没人听；其它 = playwright 原样。
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_STACK_ID,
  STACK_IDS,
  deriveStack,
  normalizeStackArg,
} from './lib/stack-ports.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI_DIR = path.join(PROJECT_ROOT, 'packages', 'ui');
const PLAYWRIGHT_CONFIG = 'e2e/playwright.config.ts';
const PROBE_TIMEOUT_MS = 1500;
const PNPM = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

const TAG = '[e2e-real-stack]';

function usage(code = 0) {
  const out = code === 0 ? console.log : console.error; // eslint-disable-line no-console
  out(`${TAG} 真栈 e2e 跑批（task-161）：按栈 id 从 SSOT 派生 XIHE_UI_PORT，强制 external=1`);
  out('usage: node scripts/e2e-real-stack.mjs --stack <n|stack-n> [--ui-port <port>] [--dry-run] <spec...> [playwright args...]');
  out('');
  out('  --stack      目标栈；缺省 XIHE_STACK_ID，再缺省 ' + DEFAULT_STACK_ID + '；可选 ' + STACK_IDS.join(' / '));
  out('  --ui-port    覆盖 UI 端口（非标准栈用；与 SSOT 不一致会 WARN）');
  out('  --dry-run    只打印解析结果与命令行，不探活、不跑');
  out('');
  out('退出码：0 全绿 / 2 参数或环境错 / 3 目标栈端口没人听 / 其它 = playwright 原样');
  process.exit(code);
}

function badArgs(message) {
  console.error(`${TAG} FAIL ${message}`);
  console.error(`${TAG} 用法见 node scripts/e2e-real-stack.mjs --help`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = { stack: undefined, uiPort: undefined, dryRun: false, help: false, passthrough: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      options.passthrough.push(...argv.slice(i + 1));
      break;
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--stack') {
      options.stack = argv[i + 1];
      if (options.stack === undefined) badArgs('--stack 需要一个值');
      i += 1;
      continue;
    }
    if (arg.startsWith('--stack=')) {
      options.stack = arg.slice('--stack='.length);
      continue;
    }
    if (arg === '--ui-port') {
      options.uiPort = argv[i + 1];
      if (options.uiPort === undefined) badArgs('--ui-port 需要一个值');
      i += 1;
      continue;
    }
    if (arg.startsWith('--ui-port=')) {
      options.uiPort = arg.slice('--ui-port='.length);
      continue;
    }
    options.passthrough.push(arg);
  }
  return options;
}

/** TCP 探活（无新依赖；先例 `scripts/xihe-cli/host.mjs:149 probeTcp`，那个是私有函数故此处自写）。 */
function probeListening(port, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const done = (state) => {
      socket.destroy();
      resolve(state);
    };
    socket.setTimeout(timeoutMs, () => done('timeout'));
    socket.once('connect', () => done('listening'));
    socket.once('error', (error) => done(error?.code === 'ECONNREFUSED' ? 'refused' : (error?.code ?? 'error')));
  });
}

/**
 * 栈没听时的诊断：`dev-stack.mjs status --json` 的 verdict/services 一行摘要。
 * 栈没起时 status 是纯读（只有全绿才会刷新心跳），所以这里安全。诊断失败不影响退出码。
 */
function diagnoseStack(stackId) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/dev-stack.mjs', 'status', '--stack', String(stackId), '--json'], {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: false,
    });
    let buffer = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, 20000);
    child.stdout?.on('data', (chunk) => { buffer += String(chunk); });
    child.once('error', () => { clearTimeout(timer); resolve(null); });
    child.once('close', () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(buffer);
        resolve(parsed);
      } catch {
        resolve(null);
      }
    });
  });
}

/** shell 单串命令里的最小引号处理（只用在我们自己拼的 cmd + 透传参数上）。 */
function shellQuote(arg) {
  const value = String(arg);
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `"${value.replace(/"/g, '""')}"`;
}

function stackIndex(stackId) {
  return Number(stackId.slice('stack-'.length));
}

function describeStatus(status) {
  if (!status) return null;
  const services = Array.isArray(status.services) ? status.services : [];
  const parts = services.map((row) => `${row.service}=${row.listening ? 'listening' : 'down'}`);
  return `verdict=${status.verdict ?? 'null'} ok=${status.ok === true} ${parts.join(' ') || 'services=?'}`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) usage(0);

  const rawStack = options.stack ?? process.env.XIHE_STACK_ID;
  const stackId = normalizeStackArg(rawStack);
  let derived;
  try {
    derived = deriveStack(stackId);
  } catch (error) {
    badArgs(`无法解析栈 id：${error.message}（可选 ${STACK_IDS.join(' / ')}）`);
  }

  let uiPort = derived.ports.ui;
  if (options.uiPort !== undefined) {
    if (!/^\d+$/.test(String(options.uiPort).trim())) badArgs(`--ui-port 必须是正整数，收到 ${JSON.stringify(options.uiPort)}`);
    uiPort = Number(options.uiPort);
    if (!Number.isInteger(uiPort) || uiPort < 1 || uiPort > 65535) badArgs(`--ui-port 超出范围：${uiPort}`);
    if (uiPort !== derived.ports.ui) {
      console.warn(`${TAG} WARN --ui-port=${uiPort} 与 SSOT(${derived.stackId}.ui=${derived.ports.ui}) 不一致：跑的是非标准栈，读数不可当栈读数`);
    }
  }

  if (!options.dryRun && options.passthrough.length === 0) badArgs('至少要给一个 spec（例: e2e/real/ui-health.spec.ts）');
  if (!existsSync(path.join(UI_DIR, PLAYWRIGHT_CONFIG))) badArgs(`找不到 ${path.join(UI_DIR, PLAYWRIGHT_CONFIG)}`);

  const specCount = options.passthrough.filter((arg) => !arg.startsWith('-')).length;
  const playwrightArgv = ['exec', 'playwright', 'test', ...options.passthrough, '--config', PLAYWRIGHT_CONFIG];
  // 整段栈 env 从 SSOT 派生（real spec 会读 XIHE_CP_PORT 等，缺省值是 stack-1 段 ⇒ 不注入就是跑错对象）。
  // 这里是**显式覆盖**而非 stackEnvDefaults 的「只补缺省」：外来的旧栈变量正是要防的失败模式。
  const childEnv = { ...process.env, ...derived.env, XIHE_UI_PORT: String(uiPort), XIHE_E2E_EXTERNAL_SERVER: '1' };
  const shadowed = Object.keys(derived.env).filter((key) => {
    const ambient = process.env[key];
    return ambient !== undefined && ambient !== '' && ambient !== String(derived.env[key]);
  });

  console.log(`${TAG} stack=${stackIndex(derived.stackId)} ui=${uiPort} external=1 spec=${specCount}`);
  console.log(`${TAG} cwd=${UI_DIR} cmd=${PNPM} ${playwrightArgv.join(' ')}`);
  if (shadowed.length > 0) {
    console.log(`${TAG} env: 已按栈覆盖外来值 ${shadowed.map((key) => `${key}=${process.env[key]}->${childEnv[key]}`).join(' ')}`);
  }

  if (options.dryRun) {
    console.log(`${TAG} dry-run：未探活、未执行`);
    return 0;
  }

  const state = await probeListening(uiPort);
  if (state !== 'listening') {
    console.error(`${TAG} FAIL 目标栈 ${derived.stackId} 的 UI 端口 ${uiPort} 没人听（probe=${state}）`);
    const status = await diagnoseStack(derived.index);
    const summary = describeStatus(status);
    if (summary) console.error(`${TAG} dev-stack status: ${summary}`);
    console.error(`${TAG} 先起栈：node scripts/dev-stack.mjs start --stack ${derived.index}`);
    console.error(`${TAG} 查现状：node scripts/dev-stack.mjs status --stack ${derived.index}`);
    console.error(`${TAG} 不会回落 12750（e2e/playwright.config.ts 的默认端口不属于任何栈段）`);
    return 3;
  }

  return await new Promise((resolve) => {
    // Windows 上 pnpm 是 pnpm.cmd：Node 24 起 spawn 不允许直接执行 .cmd（EINVAL），需 shell 解析扩展名。
    // 这里传**单条命令串**而不是 argv：Node 对「argv + shell:true」会打 DEP0190（日志里刷噪），故自行按需加引号。
    const child = process.platform === 'win32'
      ? spawn([PNPM, ...playwrightArgv].map(shellQuote).join(' '), { cwd: UI_DIR, env: childEnv, stdio: 'inherit', shell: true })
      : spawn(PNPM, playwrightArgv, { cwd: UI_DIR, env: childEnv, stdio: 'inherit' });
    child.once('error', (error) => {
      console.error(`${TAG} FAIL 无法启动 playwright：${error.message}`);
      resolve(2);
    });
    child.once('exit', (code, signal) => {
      if (signal) {
        console.error(`${TAG} playwright 被信号终止：${signal}`);
        resolve(1);
        return;
      }
      console.log(`${TAG} playwright 退出码 ${code}`);
      resolve(code ?? 1);
    });
  });
}

process.exitCode = await main();
