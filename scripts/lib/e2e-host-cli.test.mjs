#!/usr/bin/env node
/**
 * PLAN-0664 (BL-267): e2e-host CLI 三处易错的守卫测试。
 *
 * 结构（对应 design.md §8）：
 * - **纯判定**（T1–T13）：直接测 `lib/e2e-host-cli.mjs`，覆盖 warn / refuse / ok 三类返回，
 *   断言消息里同时有"冲突双方取值"与"可执行修法"（只说"参数冲突"等于没解决问题）。
 * - **真进程**（I1–I9）：用 `spawnSync` 跑 `scripts/e2e-host.mjs --check-cli`，断言真实退出码与
 *   stderr/stdout。这一层是这块功能唯一可信的验收方式 —— 判定写对了但接线错了，单测全绿也一样
 *   拦不住坑。
 * - **"绝不启动任何进程"硬断言**（I9）：固定端口 + 前后目录快照 + 输出无 boot 标记 + 用时上限。
 *   为什么这些合起来算硬断言：
 *   1. 若 runner 真的 boot 了，它会打印 `runId=` 与 `CP boot:`（`main()` 里紧挨着的两行）；
 *   2. 若它起了 UI/CP/Agent/Runtime/PG，固定端口（28090–28094）会进入 LISTEN；
 *   3. 若它开始写 host root，`.tmp/e2e-host/` 下会多出目录；
 *   4. 一次真实 boot 至少十几秒（PG initdb + Flyway），而 `--check-cli` 必须在数秒内返回。
 *   四条同时为真才可能"起了进程却观测不到"，成本远高于直接不信。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  RETRY_HELP_LINES,
  decideLlmMode,
  decideRetrySemantics,
  formatCheckCliSummary,
  resolveOnlyPatterns,
  warnBatchPlusSpecs,
} from './e2e-host-cli.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SCRIPT = fileURLToPath(new URL('../e2e-host.mjs', import.meta.url))

const SMOKE_SPECS = ['e2e/real/ui-health.spec.ts', 'e2e/real/chat-availability.spec.ts']

/** 跑真进程；显式清掉会改变判定的环境变量，避免宿主 shell 把测试污染成假绿/假红。 */
function runCli(args, overrides = {}) {
  const env = { ...process.env, ...overrides }
  for (const key of ['XIHE_E2E_LLM_MODE', 'XIHE_E2E_RETRY_ROUNDS', 'XIHE_E2E_CLI_STRICT',
    'XIHE_E2E_EXTERNAL_SERVER', 'XIHE_E2E_HEADED']) {
    if (!(key in overrides)) delete env[key]
  }
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30_000,
    env,
  })
}

function isListening(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    const finish = (value) => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(750, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

function hostRootDirs() {
  const dir = join(ROOT, '.tmp', 'e2e-host')
  return existsSync(dir) ? readdirSync(dir).sort() : []
}

// ---------------------------------------------------------------- 坑 1（batch ∪ 位置参数）

test('warnBatchPlusSpecs: batch + positional spec 会警告"整批运行"并给出三种收窄手段', () => {
  const result = warnBatchPlusSpecs({ batchName: 'session-matrix', batchSpecs: [...SMOKE_SPECS, 'e2e/real/x.spec.ts'], positionalSpecs: ['e2e/real/journey-a.spec.ts'] })
  assert.equal(result.action, 'warn')
  assert.match(result.message, /--batch=session-matrix/)
  assert.match(result.message, /含 3 个 spec/)
  assert.match(result.message, /只是追加，不会收窄/)
  assert.match(result.message, /--only=/)
  assert.match(result.message, /--grep=/)
})

test('warnBatchPlusSpecs: 位置参数已在批内时仍警告（句子区分）', () => {
  const result = warnBatchPlusSpecs({ batchName: 'smoke', batchSpecs: SMOKE_SPECS, positionalSpecs: [SMOKE_SPECS[0]] })
  assert.equal(result.action, 'warn')
  assert.match(result.message, /已在批内/)
})

test('warnBatchPlusSpecs: 无 batch / 无位置参数都不发声', () => {
  assert.equal(warnBatchPlusSpecs({ batchName: '', batchSpecs: SMOKE_SPECS, positionalSpecs: ['a.spec.ts'] }).action, 'ok')
  assert.equal(warnBatchPlusSpecs({ batchName: 'smoke', batchSpecs: SMOKE_SPECS, positionalSpecs: [] }).action, 'ok')
})

// ---------------------------------------------------------------- 坑 2（llm-mode 冲突）

test('decideLlmMode: 与批声明相等时不判定', () => {
  const result = decideLlmMode({ batchName: 'real-full', batchLlmMode: 'real', argMode: 'real' })
  assert.equal(result.action, 'ok')
})

test('decideLlmMode: --llm-mode 与批声明不一致 ⇒ refuse，消息含双方取值与修法', () => {
  const result = decideLlmMode({ batchName: 'real-full', batchLlmMode: 'real', argMode: 'mock' })
  assert.equal(result.action, 'refuse')
  assert.match(result.message, /llmMode=real/)
  assert.match(result.message, /--llm-mode=mock/)
  assert.match(result.message, /去掉 --llm-mode/)
  assert.match(result.message, /--allow-llm-mode-override/)
})

test('decideLlmMode: XIHE_E2E_LLM_MODE 与批声明不一致同样 refuse，并指名来源', () => {
  const result = decideLlmMode({ batchName: 'session-matrix', batchLlmMode: 'success', envMode: 'mock' })
  assert.equal(result.action, 'refuse')
  assert.match(result.message, /XIHE_E2E_LLM_MODE=mock/)
})

test('decideLlmMode: 逃生阀降级为 warn（不是静默）', () => {
  const result = decideLlmMode({ batchName: 'real-full', batchLlmMode: 'real', argMode: 'mock', allowOverride: true })
  assert.equal(result.action, 'warn')
  assert.match(result.message, /--allow-llm-mode-override/)
})

test('decideLlmMode: 无批 / 批无 llmMode / 未显式指定都不判定', () => {
  assert.equal(decideLlmMode({ batchName: '', batchLlmMode: 'real', argMode: 'mock' }).action, 'ok')
  assert.equal(decideLlmMode({ batchName: 'x', batchLlmMode: undefined, argMode: 'mock' }).action, 'ok')
  assert.equal(decideLlmMode({ batchName: 'x', batchLlmMode: 'real' }).action, 'ok')
})

// ---------------------------------------------------------------- 坑 3（两种重试语义）

test('decideRetrySemantics: --retries 与 RETRY_ROUNDS>1 同时生效时警告总尝试数', () => {
  const result = decideRetrySemantics({ retriesArg: '0', retryRoundsEnv: '2' })
  assert.equal(result.action, 'warn')
  assert.match(result.message, /两处都会生效/)
  assert.match(result.message, /2 轮/)
  assert.match(result.message, /2 次尝试/)
})

test('decideRetrySemantics: 单独设置 / 默认轮次 / 轮次=1 都不发声', () => {
  assert.equal(decideRetrySemantics({ retriesArg: '0' }).action, 'ok', '只设 --retries')
  assert.equal(decideRetrySemantics({ retryRoundsEnv: '2' }).action, 'ok', '只设轮次')
  assert.equal(decideRetrySemantics({ retriesArg: '0', retryRoundsEnv: '1' }).action, 'ok', '轮次=1 时不叠加')
  assert.equal(decideRetrySemantics({ retriesArg: '1', retryRoundsEnv: 'abc' }).action, 'ok', '非法轮次不猜')
})

test('RETRY_HELP_LINES: 两行分别定义两个开关，并写明可叠加', () => {
  assert.equal(RETRY_HELP_LINES.length, 2)
  assert.match(RETRY_HELP_LINES[0], /--retries=/)
  assert.match(RETRY_HELP_LINES[0], /Playwright/)
  assert.match(RETRY_HELP_LINES[1], /XIHE_E2E_RETRY_ROUNDS=/)
  assert.match(RETRY_HELP_LINES.join('\n'), /可叠加/)
})

// ---------------------------------------------------------------- --only 收窄

test('resolveOnlyPatterns: 精确相对路径 / basename / 路径后缀都命中', () => {
  const specs = [...SMOKE_SPECS, 'e2e/real/journey-a.spec.ts']
  assert.deepEqual(resolveOnlyPatterns({ batchName: 'b', batchSpecs: specs, onlyPatterns: ['e2e/real/ui-health.spec.ts'] }).specs, [SMOKE_SPECS[0]])
  assert.deepEqual(resolveOnlyPatterns({ batchName: 'b', batchSpecs: specs, onlyPatterns: ['ui-health.spec.ts'] }).specs, [SMOKE_SPECS[0]])
  assert.deepEqual(resolveOnlyPatterns({ batchName: 'b', batchSpecs: specs, onlyPatterns: ['real/journey-a.spec.ts'] }).specs, ['e2e/real/journey-a.spec.ts'])
})

test('resolveOnlyPatterns: 唯一子串命中；多个 --only 取并集', () => {
  const single = resolveOnlyPatterns({ batchName: 'b', batchSpecs: SMOKE_SPECS, onlyPatterns: ['availability'] })
  assert.equal(single.action, 'ok')
  assert.deepEqual(single.specs, [SMOKE_SPECS[1]])

  const union = resolveOnlyPatterns({ batchName: 'b', batchSpecs: SMOKE_SPECS, onlyPatterns: ['ui-health', 'availability'] })
  assert.deepEqual(union.specs, SMOKE_SPECS)
})

test('resolveOnlyPatterns: 子串命中 >1 ⇒ refuse 并列出候选（不许静默全跑）', () => {
  const result = resolveOnlyPatterns({ batchName: 'smoke', batchSpecs: SMOKE_SPECS, onlyPatterns: ['real'] })
  assert.equal(result.action, 'refuse')
  assert.match(result.message, /子串命中 2 个 spec/)
  assert.match(result.message, /ui-health\.spec\.ts/)
  assert.match(result.message, /chat-availability\.spec\.ts/)
})

test('resolveOnlyPatterns: 零命中 ⇒ refuse 并列出该批可用 specs', () => {
  const result = resolveOnlyPatterns({ batchName: 'smoke', batchSpecs: SMOKE_SPECS, onlyPatterns: ['nope'] })
  assert.equal(result.action, 'refuse')
  assert.match(result.message, /零命中/)
  assert.match(result.message, /ui-health\.spec\.ts/)
})

test('resolveOnlyPatterns: 无 --batch 使用 --only ⇒ refuse；无模式时原样返回', () => {
  const noBatch = resolveOnlyPatterns({ batchName: '', batchSpecs: SMOKE_SPECS, onlyPatterns: ['ui-health'] })
  assert.equal(noBatch.action, 'refuse')
  assert.match(noBatch.message, /需要配合 --batch/)

  const passthrough = resolveOnlyPatterns({ batchName: 'smoke', batchSpecs: SMOKE_SPECS, onlyPatterns: [] })
  assert.equal(passthrough.action, 'ok')
  assert.deepEqual(passthrough.specs, SMOKE_SPECS)
})

test('formatCheckCliSummary: 报告批次/模式/数量，批展开用 - 前缀、位置参数用 + 前缀', () => {
  const summary = formatCheckCliSummary({
    batchName: 'smoke', llmMode: 'mock', specs: SMOKE_SPECS, positionalSpecs: ['e2e/real/journey-a.spec.ts'],
  })
  assert.match(summary, /batch=smoke llmMode=mock batchSpecs=2 positionalSpecs=1/)
  assert.match(summary, /^ {2}- e2e\/real\/ui-health\.spec\.ts$/m)
  assert.match(summary, /^ {2}\+ e2e\/real\/journey-a\.spec\.ts$/m)
})

// ---------------------------------------------------------------- 真进程（--check-cli）

test('I1: --batch 与 --llm-mode 冲突 ⇒ 真进程 exit 2 + REFUSE', () => {
  const result = runCli(['--batch=real-full', '--llm-mode=mock', '--check-cli'])
  assert.equal(result.status, 2, result.stderr)
  assert.match(result.stderr, /\[e2e-host\] REFUSE/)
  assert.match(result.stderr, /llmMode=real/)
  assert.match(result.stderr, /--allow-llm-mode-override/)
})

test('I2: 模式一致 ⇒ exit 0 且无 REFUSE', () => {
  const result = runCli(['--batch=real-full', '--llm-mode=real', '--check-cli'])
  assert.equal(result.status, 0, result.stderr)
  assert.doesNotMatch(result.stderr, /REFUSE/)
  assert.match(result.stdout, /batch=real-full llmMode=real/)
})

test('I3: --only 把批收窄到 1 个 spec', () => {
  const result = runCli(['--batch=smoke', '--only=ui-health', '--check-cli'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /batchSpecs=1/)
  assert.match(result.stdout, /ui-health\.spec\.ts/)
  assert.doesNotMatch(result.stdout, /chat-availability\.spec\.ts/)
})

test('I4: --batch + 位置参数 ⇒ exit 0 + WARN（不阻断）', () => {
  const result = runCli(['--batch=smoke', 'e2e/real/journey-a.spec.ts', '--check-cli'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stderr, /WARN/)
  assert.match(result.stderr, /不会收窄/)
  assert.match(result.stdout, /positionalSpecs=1/)
  assert.match(result.stdout, /^ {2}\+ e2e\/real\/journey-a\.spec\.ts$/m)
})

test('I5: --only 缺 --batch ⇒ exit 2', () => {
  const result = runCli(['--only=ui-health', '--check-cli'])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /需要配合 --batch/)
})

test('I6: --retries 与 XIHE_E2E_RETRY_ROUNDS 同时生效 ⇒ exit 0 + WARN', () => {
  const result = runCli(['--batch=smoke', '--retries=0', '--check-cli'], { XIHE_E2E_RETRY_ROUNDS: '2' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stderr, /两处都会生效/)
})

test('I7: --only 子串多命中 ⇒ exit 2 并列出候选（0660 的 8 spec 场景）；basename 精确仍可收窄', () => {
  const ambiguous = runCli(['--batch=session-matrix', '--only=session-matrix', '--check-cli'])
  assert.equal(ambiguous.status, 2, ambiguous.stdout)
  assert.match(ambiguous.stderr, /子串命中 8 个 spec/)
  assert.match(ambiguous.stderr, /session-matrix-to\.spec\.ts/)

  const exact = runCli(['--batch=session-matrix', '--only=session-matrix-to.spec.ts', '--check-cli'])
  assert.equal(exact.status, 0, exact.stderr)
  assert.match(exact.stdout, /batchSpecs=1/)
  assert.match(exact.stdout, /session-matrix-to\.spec\.ts/)
})

test('I8: XIHE_E2E_CLI_STRICT=1 把警告升级为 exit 2', () => {
  const result = runCli(['--batch=smoke', 'e2e/real/ui-health.spec.ts', '--check-cli'], { XIHE_E2E_CLI_STRICT: '1' })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /REFUSE \(XIHE_E2E_CLI_STRICT=1\)/)
})

test('I9: --check-cli 绝不启动进程/端口/目录（四条硬断言同时成立）', async () => {
  const ports = [28090, 28091, 28092, 28093, 28094]
  const before = hostRootDirs()
  const startedAt = Date.now()
  const result = runCli(['--batch=smoke', '--check-cli'], {
    XIHE_UI_PORT: String(ports[0]),
    XIHE_CP_PORT: String(ports[1]),
    XIHE_AGENT_PORT: String(ports[2]),
    XIHE_RUNTIME_PORT: String(ports[3]),
    XIHE_PG_PORT: String(ports[4]),
  })
  const elapsedMs = Date.now() - startedAt

  assert.equal(result.status, 0, result.stderr)
  // 1) boot 会打印的标记一律不出现
  assert.doesNotMatch(result.stdout + result.stderr, /CP boot:/)
  assert.doesNotMatch(result.stdout + result.stderr, /runId=/)
  // 2) 固定端口没有任何监听
  for (const port of ports) {
    assert.equal(await isListening(port), false, `port ${port} must stay closed in --check-cli`)
  }
  // 3) host root 没有新增目录
  assert.deepEqual(hostRootDirs(), before)
  // 4) 在 far below a real boot's wall-clock
  assert.ok(elapsedMs < 8_000, `--check-cli took ${elapsedMs}ms; a boot would need far longer`)
})
