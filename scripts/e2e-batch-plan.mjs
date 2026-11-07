#!/usr/bin/env node
// XH L2 window planner — read-only. Answers one question before an L2 window:
// "for this batch and this pinned SHA, exactly what will be run, under which
// preconditions, and where does the evidence land?"
//
// Discipline (task-44 / internal/A03-xihe/docs/l2-window-protocol.md §6):
// this script is a **planner, not a runner**. It reads the batch manifest and the
// member spec sources, prints commands, and exits. It never starts a stack, never
// runs Playwright, never writes a file, and never calls a child process — the
// window itself is opened by the operator (or by the Lead) with the printed
// commands.
//
// Usage:
//   node scripts/e2e-batch-plan.mjs --list [--json]
//   node scripts/e2e-batch-plan.mjs --batch=<name> [--sha=<12位>] [--json]
//   node scripts/e2e-batch-plan.mjs --help
//
//   --list          list every batch with member count and the exclusive marker
//   --batch=<name>  print the plan for one batch
//   --sha=<sha>     pinned commit (7–40 hex); printed as the expected CP commit
//   --json          machine-readable plan (same information, no prose)
//
// Exit codes: 0 = plan printed and executable; 2 = usage error / unknown batch;
// 3 = a blocking precondition was found (member spec missing, or the spec has no
// @host lane tag so the host profile grep would filter it out).
//
// Facts this planner relies on (read from the runner, not from memory):
//   - batch fields actually consumed by the runner: description / llmMode / specs
//     (scripts/e2e-host.mjs:195, :277, :279);
//   - host profile filters Playwright by /@host/ (packages/ui/e2e/playwright.config.ts:42)
//     and the runner pins XIHE_E2E_PROFILE=host for the Playwright child
//     (scripts/e2e-host.mjs:1950) — a member without the tag executes nothing;
//   - --report-name lands under .local/dev/ (scripts/e2e-host.mjs:1836-1837);
//   - --expect-tests pins how many tests must actually execute (e2e-host.mjs:104-109);
//   - --only narrows an expanded batch (e2e-host.mjs:280);
//   - default build root is C:/xihe-build/e2e, per-run override is
//     XIHE_CP_TARGET_DIR (scripts/e2e-host.mjs:59-63).

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const projectDir = dirname(import.meta.dirname)
const uiDir = join(projectDir, 'packages', 'ui')
const batchesFile = join(projectDir, 'scripts', 'e2e-batches.jsonc')
const defaultBuildRoot = 'C:/xihe-build/e2e'
const perRunBuildRoot = 'C:/xihe-build/e2e-runs/<runId>'

// Same JSONC stripper the runner uses (scripts/e2e-host.mjs:145-172). The manifest
// is JSONC by contract, so the planner must read it exactly like the runner does;
// copying the known-good implementation keeps both sides in step instead of adding
// a second, subtly different parser.
function stripJsonComments(text) {
  let out = ''
  let inString = false
  let inLineComment = false
  let inBlockComment = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    const next = text[i + 1]
    if (inLineComment) {
      if (ch === '\n') { inLineComment = false; out += ch }
      continue
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') { inBlockComment = false; i += 1 }
      continue
    }
    if (inString) {
      out += ch
      if (ch === '\\') { out += next ?? ''; i += 1 } else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; out += ch; continue }
    if (ch === '/' && next === '/') { inLineComment = true; i += 1; continue }
    if (ch === '/' && next === '*') { inBlockComment = true; i += 1; continue }
    out += ch
  }
  return out
}

function failUsage(message) {
  console.error(`[e2e-batch-plan] ${message}`)
  process.exit(2)
}

function loadBatches() {
  if (!existsSync(batchesFile)) throw new Error(`batch manifest not found: ${batchesFile}`)
  const parsed = JSON.parse(stripJsonComments(readFileSync(batchesFile, 'utf8')))
  if (!parsed || typeof parsed.batches !== 'object' || parsed.batches === null) {
    throw new Error(`batch manifest has no "batches" object: ${batchesFile}`)
  }
  return parsed.batches
}

function hasLaneTag(specPath) {
  const absolute = join(uiDir, specPath)
  if (!existsSync(absolute)) return { exists: false, laneTag: false }
  const source = readFileSync(absolute, 'utf8')
  return { exists: true, laneTag: /@host\b/.test(source) }
}

function specChecks(batch) {
  const checks = []
  for (const specPath of batch.specs) {
    if (!specPath.endsWith('.spec.ts')) {
      // Directory members are legal for the runner (`specs: ["e2e/real"]`), but a
      // batch table entry must be explicit to keep the runId ↔ PLAN mapping honest.
      checks.push({ spec: specPath, exists: true, laneTag: null, blocking: false, note: 'directory member — expand before use' })
      continue
    }
    const probe = hasLaneTag(specPath)
    const problems = []
    if (!probe.exists) problems.push('spec file not found under packages/ui')
    if (probe.exists && !probe.laneTag) problems.push('no @host lane tag — host profile grep would run 0 tests')
    checks.push({
      spec: specPath,
      exists: probe.exists,
      laneTag: probe.laneTag,
      blocking: problems.length > 0,
      note: problems.join('; '),
    })
  }
  return checks
}

function substituteSha(value, shaToken) {
  return String(value).replaceAll('{sha}', shaToken)
}

function buildPlan(name, batch, shaToken, shaProvided) {
  const specs = Array.isArray(batch.specs) ? batch.specs : []
  const env = batch.env && typeof batch.env === 'object' ? batch.env : {}
  const requiredEnv = Array.isArray(batch.requiredEnv) ? batch.requiredEnv : []
  const exclusive = batch.exclusive === true
  const expectTests = Number.isInteger(batch.expectTests) ? batch.expectTests : null
  const reportNames = batch.reportNames && typeof batch.reportNames === 'object' ? batch.reportNames : {}
  const evidence = typeof batch.evidence === 'string' ? substituteSha(batch.evidence, shaToken) : ''
  const batchReport = `${name}-${shaToken}.json`

  const envLines = [`$env:XIHE_E2E_EXPECT_CP_COMMIT = '${shaToken}'`]
  for (const [key, value] of Object.entries(env)) {
    envLines.push(`$env:${key} = '${String(value)}'`)
  }
  for (const key of requiredEnv) envLines.push(`$env:${key} = '<由操作员按窗口目标填写>'`)

  const mainCommand = [
    'node scripts/e2e-host.mjs',
    `--batch=${name}`,
    `--report-name=${batchReport}`,
    ...(expectTests === null ? [] : [`--expect-tests=${expectTests}`]),
  ].join(' ')

  const rerunCommands = specs.map((specPath) => ({
    spec: specPath,
    command: [
      'node scripts/e2e-host.mjs',
      `--batch=${name}`,
      `--only=${specPath}`,
      `--report-name=${substituteSha(reportNames[specPath] ?? `${name}-rerun-{sha}.json`, shaToken)}`,
    ].join(' '),
  }))

  const preconditions = [
    `钉靶 SHA：${shaProvided ? shaToken : '<未提供 --sha>'} 必须等于本 checkout 的 git rev-parse HEAD（窗口期间 develop 禁合入）`,
    'preflight：node scripts/e2e-preflight.mjs 必须 exit 0（阻塞项：e2e 残留资源 / e2e 段被占 / 12633 被占 / CP jar 过期 / docker 不可达 / 有在跑的 run）',
    `构建根：${exclusive ? `独占 ${defaultBuildRoot}（或独占 ${perRunBuildRoot}）—— 本 run 不得与任何 run 共用构建根` : `默认共用 ${defaultBuildRoot}，前提是该构建根此刻只有一个 run；要并行则改为 ${perRunBuildRoot}`}`,
    `报告与证据：报告落 .local/dev/${batchReport}；证据落 ${evidence || '.local/evidence/<batch>-<sha>/'}`,
  ]
  if (exclusive) {
    preconditions.push('独占 run：本 run 存活期间不得启动第二个 run（任何批次、任何 XIHE_CP_TARGET_DIR），也不得开浏览器走查')
  }

  const checks = specChecks(batch)
  const blocking = []
  for (const check of checks) {
    if (check.blocking) blocking.push(`${check.spec}: ${check.note}`)
  }
  if (!specs.length) blocking.push(`${name}: batch has no specs`)
  if (!shaProvided) blocking.push('缺少 --sha=<12位>：planner 不会替你猜钉靶 SHA')

  return {
    batch: name,
    description: batch.description ?? '',
    stack: batch.stack ?? 'isolated',
    exclusive,
    sha: shaProvided ? shaToken : null,
    expect: expectTests === null ? null : { executed: expectTests, flaky: 0, skipped: 0 },
    specs,
    env,
    requiredEnv,
    preconditions,
    envLines,
    command: mainCommand,
    rerunCommands,
    evidence,
    specChecks: checks,
    blocking,
  }
}

function printPlan(plan) {
  const out = []
  out.push(`[batch] ${plan.batch}${plan.exclusive ? '  (EXCLUSIVE)' : ''}`)
  out.push(`[what] ${plan.description || '(no description)'}`)
  out.push(`[stack] ${plan.stack} · 一个 run = 一套隔离栈 + 一个钉靶 SHA`)
  out.push(`[sha] ${plan.sha ?? '<未提供 --sha>'}`)
  out.push('')
  out.push('[preconditions]')
  for (const line of plan.preconditions) out.push(`  - ${line}`)
  out.push('')
  out.push('[env] (# runner 不会自动应用批次 env，逐行设置)')
  for (const line of plan.envLines) out.push(`  ${line}`)
  out.push('')
  out.push('[command]')
  out.push(`  ${plan.command}`)
  if (plan.expect) {
    out.push(`[expect] executed=${plan.expect.executed} flaky=${plan.expect.flaky} skipped=${plan.expect.skipped}`)
  }
  out.push(`[evidence] ${plan.evidence || '.local/evidence/<batch>-<sha>/'}`)
  if (plan.rerunCommands.length) {
    out.push('')
    out.push('[per-spec rerun] (# 失败定位到 PLAN 用；--only 收窄批次，报告名按成员固定)')
    for (const rerun of plan.rerunCommands) {
      out.push(`  ${rerun.command}`)
    }
  }
  if (plan.blocking.length) {
    out.push('')
    out.push('[blocking]')
    for (const line of plan.blocking) out.push(`  ! ${line}`)
  }
  out.push('')
  out.push(plan.blocking.length ? '[verdict] BLOCKED — 修完上面每条再开窗' : '[verdict] READY — 按上面的命令开窗')
  console.log(out.join('\n'))
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('node scripts/e2e-batch-plan.mjs --list [--json] | --batch=<name> [--sha=<12位>] [--json]')
    console.log('退出码：0 可打印 / 2 用法或未知批次 / 3 阻塞前置')
    return
  }
  const asJson = argv.includes('--json')
  const batchArg = argv.find((arg) => arg.startsWith('--batch='))
  const shaArg = argv.find((arg) => arg.startsWith('--sha='))
  const wantsList = argv.includes('--list')
  const known = new Set(['--json', '--list', '--help', '-h'])
  for (const arg of argv) {
    if (known.has(arg)) continue
    if (arg.startsWith('--batch=') || arg.startsWith('--sha=')) continue
    failUsage(`unknown argument ${arg}`)
  }
  if (wantsList && batchArg) failUsage('--list and --batch=<name> are mutually exclusive')

  let batches
  try {
    batches = loadBatches()
  } catch (error) {
    failUsage(error instanceof Error ? error.message : String(error))
    return
  }

  if (wantsList) {
    const rows = Object.entries(batches).map(([name, batch]) => ({
      batch: name,
      exclusive: Boolean(batch && batch.exclusive === true),
      stack: (batch && batch.stack) || 'isolated',
      specs: Array.isArray(batch?.specs) ? batch.specs.length : 0,
      description: (batch && batch.description) || '',
    }))
    if (asJson) {
      console.log(JSON.stringify(rows, null, 2))
      return
    }
    for (const row of rows) {
      console.log(`${row.batch}\t${row.exclusive ? 'EXCLUSIVE' : 'shareable'}\t${row.stack}\t${row.specs} spec(s)\t${row.description}`)
    }
    console.log(`\n${rows.length} batch(es) in scripts/e2e-batches.jsonc; 详细计划：node scripts/e2e-batch-plan.mjs --batch=<name> --sha=<12位>`)
    return
  }

  if (!batchArg) failUsage('need --list or --batch=<name>')
  const name = batchArg.slice('--batch='.length).trim()
  if (!name) failUsage('--batch= needs a batch name')
  const batch = batches[name]
  if (!batch) {
    console.error(`[e2e-batch-plan] unknown --batch=${name}; available: ${Object.keys(batches).join(', ')}`)
    process.exit(2)
  }

  let shaToken = '<sha12>'
  let shaProvided = false
  if (shaArg) {
    const raw = shaArg.slice('--sha='.length).trim().toLowerCase()
    if (!/^[0-9a-f]{7,40}$/.test(raw)) failUsage(`invalid --sha=${raw}; expected 7–40 hex characters of the pinned commit`)
    shaToken = raw.slice(0, 12)
    shaProvided = true
  }

  const plan = buildPlan(name, batch, shaToken, shaProvided)
  if (asJson) console.log(JSON.stringify(plan, null, 2))
  else printPlan(plan)
  if (plan.blocking.length) process.exit(3)
}

main(process.argv.slice(2))
