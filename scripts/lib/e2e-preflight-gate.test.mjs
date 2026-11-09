#!/usr/bin/env node
/**
 * 缺陷 1 + 缺陷 2 的单测（`scripts/lib/e2e-preflight-gate.mjs`）。
 *
 * 缺陷 1 的验收要六格决策矩阵：`jarMode` ∈ {auto, use, rebuild} × jar ∈ {fresh, stale}，
 * 每格给出「是否拒绝 / 是否触发重建 / 最终 entry」。这里把矩阵**算出来再逐格断言**，
 * 并额外覆盖两条负例：
 *   - 端口冲突（非 build 类）在**每一格**都必须仍然拒绝 —— 证明没把非产物类顺手放行；
 *   - 产物段被跳过却仍有 build 类阻塞项 ⇒ 拒绝（`--ignore-build` 与输出不一致时不假绿）。
 *
 * 缺陷 2 的验收要"跳过其余检查、磁盘段仍照跑"，以及**磁盘段自己跑不了**时才允许整体跳过、
 * 且必须记录 `diskGate: bypassed`（不许静默）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { decideCpBoot } from './cp-boot-plan.mjs';
import {
  artifactGatePolicy,
  decidePreflightGate,
  decideSkipPreflightDisk,
  describeDiskGate,
  describePreflightGate,
  diskGateRecord,
  evaluateGateFindings,
  parseBlockingScopes,
  parseDiskLine,
  preflightGatePolicy,
} from './e2e-preflight-gate.mjs';

/**
 * 复刻 `e2e-host.mjs main()` 的真实接线顺序（这是本缺陷的核心）：
 *   决定 boot entry（auto 的 build-then-use 会先重建）→ 门决定产物段要不要跑 → 跑 preflight
 *   → 拿真实阻塞 scope 判拒绝。
 *
 * @param {object} input
 * @param {string} input.jarMode
 * @param {boolean} [input.hasJar]
 * @param {boolean} input.stale
 * @param {boolean} [input.externalServer]
 * @param {boolean} [input.rebuildFails] 预重建失败 ⇒ runner 回落 `mvn spring-boot:run`
 * @param {boolean} [input.rebuildSkipped] 模拟旧实现：门跑在重建之前（缺陷形态）
 * @param {string[]} [input.extraBlocking] 其它段落（端口/残留/磁盘）的阻塞 scope
 */
function simulateRun({
  jarMode,
  hasJar = true,
  stale,
  externalServer = false,
  rebuildFails = false,
  rebuildSkipped = false,
  extraBlocking = [],
}) {
  const boot = externalServer ? null : decideCpBoot({ jarMode, hasJar, stale });
  let entry;
  let rebuild = false;
  if (externalServer) entry = 'reuse';
  else if (boot.action === 'native') entry = 'native';
  else if (boot.action === 'run') entry = 'run';
  else if (boot.action === 'use') entry = 'jar';
  else {
    rebuild = true;
    entry = rebuildFails ? 'run' : 'jar';
  }

  const cpBootMode = externalServer ? 'jar' : entry;
  const policy = artifactGatePolicy({ jarMode, externalServer, cpBootMode });

  // 预重建之后 jar 还旧吗？（缺陷形态 rebuildSkipped：门先跑，jar 仍是旧的）
  const jarStillStale = rebuild && !rebuildFails && !rebuildSkipped ? false : hasJar && stale && entry === 'jar';
  const blockingScopes = [];
  if (policy.buildSection === 'checked' && jarStillStale) blockingScopes.push('build');
  blockingScopes.push(...extraBlocking);

  const findings = evaluateGateFindings({ policy, blockingScopes });
  return { boot, entry: externalServer ? 'reuse' : cpBootMode, rebuild, policy, findings, blockingScopes };
}

test('T1 六格决策矩阵：auto/use/rebuild × fresh/stale', () => {
  const matrix = [
    // jarMode, stale, expected
    ['auto', false, { rebuild: false, entry: 'jar', buildSection: 'checked', verdict: 'proceed' }],
    ['auto', true, { rebuild: true, entry: 'jar', buildSection: 'checked', verdict: 'proceed' }],
    ['use', false, { rebuild: false, entry: 'jar', buildSection: 'skipped', verdict: 'proceed' }],
    ['use', true, { rebuild: false, entry: 'jar', buildSection: 'skipped', verdict: 'proceed' }],
    ['rebuild', false, { rebuild: true, entry: 'jar', buildSection: 'checked', verdict: 'proceed' }],
    ['rebuild', true, { rebuild: true, entry: 'jar', buildSection: 'checked', verdict: 'proceed' }],
  ];
  const rows = matrix.map(([jarMode, stale, expected]) => {
    const run = simulateRun({ jarMode, stale });
    assert.equal(run.rebuild, expected.rebuild, `${jarMode}/${stale ? 'stale' : 'fresh'}: rebuild?`);
    assert.equal(run.entry, expected.entry, `${jarMode}/${stale ? 'stale' : 'fresh'}: entry`);
    assert.equal(run.policy.buildSection, expected.buildSection, `${jarMode}/${stale ? 'stale' : 'fresh'}: build section`);
    assert.equal(run.findings.verdict, expected.verdict, `${jarMode}/${stale ? 'stale' : 'fresh'}: verdict`);
    return { jarMode, jar: stale ? 'stale' : 'fresh', ...expected };
  });

  // 矩阵本身的行为契约：auto 必须"缺/旧 jar 就重建"，绝不因为门而永远走不到重建。
  assert.deepEqual(
    rows.filter((row) => row.jarMode === 'auto' && row.jar === 'stale')[0],
    { jarMode: 'auto', jar: 'stale', rebuild: true, entry: 'jar', buildSection: 'checked', verdict: 'proceed' },
  );
  // use 是显式 opt-in：产物段跳过，但理由必须写"操作员已明确接受现有 jar"。
  const useStale = simulateRun({ jarMode: 'use', stale: true });
  assert.match(useStale.policy.reason, /explicitly asked|as-is/);
  // 六格全部 proceed（没有任何一格该因为产物条件被拒绝）。
  assert.deepEqual(rows.map((row) => row.verdict), Array(6).fill('proceed'));
});

test('T2 缺陷形态对照：门跑在重建之前（旧顺序）⇒ 陈旧 jar 判"不可自愈"而拒绝', () => {
  // 旧实现：重建还没发生，preflight 已看到 stale jar ⇒ build 阻塞项。
  // 因为它出现在**预重建之后**才是"不可自愈"，出现在预重建之前就是门自己锁死自己。
  const legacy = simulateRun({ jarMode: 'auto', stale: true, rebuildSkipped: true });
  assert.deepEqual(legacy.blockingScopes, ['build']);
  assert.equal(legacy.findings.verdict, 'refuse');
  assert.match(legacy.findings.reason, /NOT self-healable/);
  assert.match(legacy.findings.reason, /pre-gate rebuild/);

  // 现实现：预重建跑完再进闸，同一格变成 proceed。
  const fixed = simulateRun({ jarMode: 'auto', stale: true });
  assert.deepEqual(fixed.blockingScopes, []);
  assert.equal(fixed.findings.verdict, 'proceed');
});

test('T3 负例：端口冲突（非 build 类）在每一格都必须仍然拒绝', () => {
  const cells = [];
  for (const jarMode of ['auto', 'use', 'rebuild']) {
    for (const stale of [false, true]) {
      for (const externalServer of [false, true]) {
        const run = simulateRun({ jarMode, stale, externalServer, extraBlocking: ['ports'] });
        assert.equal(run.findings.verdict, 'refuse', `${jarMode}/${stale}/${externalServer}: must refuse`);
        assert.deepEqual(run.findings.refusals, ['ports']);
        assert.match(run.findings.reason, /ports/);
        cells.push({ jarMode, stale, externalServer, verdict: run.findings.verdict });
      }
    }
  }
  assert.equal(cells.length, 12);
});

test('T4 负例：产物段被跳过却仍有 build 阻塞项 ⇒ 拒绝（不假绿，指向没接 --ignore-build 的新检查）', () => {
  const policy = artifactGatePolicy({ jarMode: 'run', cpBootMode: 'run' });
  assert.equal(policy.buildSection, 'skipped');
  const findings = evaluateGateFindings({ policy, blockingScopes: ['build'] });
  assert.equal(findings.verdict, 'refuse');
  assert.match(findings.reason, /gate inconsistency/);
  assert.match(findings.reason, /ignore-build/);
});

test('T5 reuse run（XIHE_E2E_EXTERNAL_SERVER=1）不再被"本轮不会启动的 jar"锁死', () => {
  // 2026-11-07 夜里真实锁死的形状：复用跑 + C:/xihe-build/e2e 的 jar 陈旧 ⇒ 旧实现拒绝，
  // 而本轮启动的是持久栈，谁也不会去重建那个 jar。
  for (const jarMode of ['auto', 'use', 'rebuild', 'run', 'native']) {
    const run = simulateRun({ jarMode, stale: true, externalServer: true });
    assert.equal(run.entry, 'reuse');
    assert.equal(run.rebuild, false, `${jarMode}: reuse run must not rebuild anything`);
    assert.equal(run.policy.buildSection, 'skipped');
    assert.equal(run.findings.verdict, 'proceed', `${jarMode}: reuse run must not be gated on a foreign jar`);
    assert.match(run.policy.reason, /reuse run/);
  }
});

test('T6 run/native 与重建失败回落：只要这一轮不启动 jar，产物段就跳过', () => {
  const run = simulateRun({ jarMode: 'run', stale: true });
  assert.equal(run.entry, 'run');
  assert.equal(run.policy.buildSection, 'skipped');
  assert.match(run.policy.reason, /fat jar is not booted/);

  const native = simulateRun({ jarMode: 'native', stale: true });
  assert.equal(native.entry, 'native');
  assert.equal(native.policy.buildSection, 'skipped');
  assert.match(native.policy.reason, /native executable/);

  // auto + 重建失败 ⇒ 回落 spring-boot:run，jar 不启动 ⇒ 不再因为 jar 陈旧被拒。
  const fallback = simulateRun({ jarMode: 'auto', stale: true, rebuildFails: true });
  assert.equal(fallback.entry, 'run');
  assert.equal(fallback.rebuild, true);
  assert.equal(fallback.policy.buildSection, 'skipped');
  assert.equal(fallback.findings.verdict, 'proceed');
});

test('T7 非法入参 fail-fast（不静默当成 auto）', () => {
  assert.throws(() => artifactGatePolicy({ jarMode: 'bogus' }), /unknown jarMode/);
  assert.throws(() => artifactGatePolicy({ cpBootMode: 'bogus' }), /unknown cpBootMode/);
  assert.throws(() => evaluateGateFindings({ policy: null }), /policy/);
});

test('T8 日志措辞：跳过产物段时必须把 deferred 与理由一起打出来', () => {
  const skipped = decidePreflightGate({ jarMode: 'use', cpBootMode: 'jar' });
  assert.match(describePreflightGate(skipped), /artifact section skipped/);
  assert.match(describePreflightGate(skipped), /deferred: build/);
  const checked = decidePreflightGate({ jarMode: 'auto', cpBootMode: 'jar' });
  assert.match(describePreflightGate(checked), /artifact section checked/);
});

test('T9 缺陷 2（解析）：从 preflight 输出里取出机器可读磁盘行', () => {
  const stdout = [
    'XH host E2E preflight (read-only)  2026-11-08T00:00:00.000Z',
    '[4/5] disk headroom (window admission)',
    '  disk  {"name":"disk","ok":false,"skipped":false,"unverifiable":false,"detail":{"H":{"freeGB":120.3,"totalGB":500,"pctFree":24},"C":{"freeGB":230,"totalGB":500,"pctFree":46}},"reasons":["H free 24% (120.3/500 GB) < 25% block threshold"],"findings":[]}',
    '  FAIL  H drive has only 24% free',
  ].join('\n');
  const parsed = parseDiskLine(stdout);
  assert.equal(parsed.name, 'disk');
  assert.equal(parsed.detail.H.pctFree, 24);
  assert.equal(parseDiskLine('no disk line here'), null);
  assert.equal(parseDiskLine('  disk  {broken json'), null);
});

test('T10 缺陷 2（判据）：--skip-preflight 下磁盘段仍然说了算', () => {
  const blocked = {
    name: 'disk',
    ok: false,
    skipped: false,
    unverifiable: false,
    detail: { H: { freeGB: 120, totalGB: 500, pctFree: 24 }, C: { freeGB: 230, totalGB: 500, pctFree: 46 } },
    reasons: ['H free 24% (120/500 GB) < 25% block threshold'],
    findings: [],
  };
  const decision = decideSkipPreflightDisk({ exitCode: 1, diskResult: blocked });
  assert.equal(decision.proceed, false);
  assert.equal(decision.record.mode, 'enforced');
  assert.equal(decision.record.verdict, 'blocked');
  assert.match(decision.reason, /does NOT skip the disk gate/);
  assert.match(describeDiskGate(decision.record), /H 24% free/);

  const unverifiable = { name: 'disk', ok: false, skipped: false, unverifiable: true, detail: null, reasons: ['disk sampling failed: Get-PSDrive failed'], findings: [] };
  const unknown = decideSkipPreflightDisk({ exitCode: 1, diskResult: unverifiable });
  assert.equal(unknown.proceed, false);
  assert.equal(unknown.record.verdict, 'unverifiable');
  assert.match(unknown.reason, /unknown disk state/);

  const healthy = { ...blocked, ok: true, reasons: [], detail: { H: { freeGB: 305.2, totalGB: 500, pctFree: 61 }, C: { freeGB: 230, totalGB: 500, pctFree: 46 } } };
  const ok = decideSkipPreflightDisk({ exitCode: 0, diskResult: healthy });
  assert.equal(ok.proceed, true);
  assert.equal(ok.record.mode, 'enforced');
  assert.equal(ok.record.verdict, 'ok');

  const skipped = decideSkipPreflightDisk({ exitCode: 0, diskResult: { name: 'disk', ok: true, skipped: true, unverifiable: false, detail: null, reasons: ['disk gate skipped on linux (Windows-only check)'], findings: [] } });
  assert.equal(skipped.proceed, true);
  assert.equal(skipped.record.verdict, 'skipped');
});

test('T11 缺陷 2（留痕）：磁盘段自己跑不了 ⇒ 放行但必须记 diskGate: bypassed', () => {
  const decision = decideSkipPreflightDisk({ exitCode: null, diskResult: null });
  assert.equal(decision.proceed, true);
  assert.equal(decision.record.mode, 'bypassed');
  assert.equal(decision.record.verdict, 'unknown');
  assert.match(decision.record.reason, /no machine-readable line/);

  // 记录形态就是 run 头要写的字段（固定契约，不许改名）。
  const record = diskGateRecord({ exitCode: 1, diskResult: { name: 'disk', ok: false, skipped: false, unverifiable: false, detail: { H: { freeGB: 120, totalGB: 500, pctFree: 24 }, C: { freeGB: 230, totalGB: 500, pctFree: 46 } }, reasons: ['H free 24%'], findings: [] } });
  assert.deepEqual(Object.keys(record).sort(), ['detail', 'exitCode', 'mode', 'reason', 'verdict']);
  assert.deepEqual(Object.keys(record.detail.H).sort(), ['freeGB', 'pctFree', 'totalGB']);
});

test('T12 parseBlockingScopes：只认 findings 汇总行的 scope，认不出来的一律不冒充', () => {
  const stdout = [
    '[3/5] build artifacts (source mtime vs artifact mtime)',
    '  FAIL  CP jar control-plane-1.jar is STALE vs H:/x/src/main/java',
    '  FAIL  container xihe-e2e-host-abc-postgres-1 (running) — run abc',
    'findings: 3 blocking / 1 warning',
    '  FAIL  [build] CP jar is older than CP sources by 2h',
    '  FAIL  [ports] 27601 listening (pid 4242)',
    '  FAIL  [build] runtime debug binary is stale',
    '  WARN  [build] whatever',
  ].join('\r\n');
  // 逐段的行（没有 [scope]）不算：它可能是任何一段打的，认了就等于凭空放行。
  assert.deepEqual(parseBlockingScopes(stdout), ['build', 'ports']);
  assert.deepEqual(parseBlockingScopes(''), []);
  assert.deepEqual(parseBlockingScopes(null), []);
  // 没有已解析 scope 时调用方必须 fail closed（这里只固定"解析结果为空"这一事实）。
  assert.deepEqual(parseBlockingScopes('  FAIL  opaque finding without a scope'), []);
});

test('T13 runtime-target 是"每轮都启动"的产物：任何 jar 模式下都必须拒绝（不许被 --ignore-build 延期）', () => {
  for (const jarMode of ['auto', 'use', 'rebuild', 'run', 'native']) {
    for (const externalServer of [false, true]) {
      const decision = decidePreflightGate({ jarMode, externalServer, cpBootMode: 'jar', blockingScopes: ['runtime-target'] });
      assert.equal(decision.verdict, 'refuse', `jarMode=${jarMode} external=${externalServer} 必须拒绝`);
      assert.deepEqual(decision.refusals, ['runtime-target']);
      assert.match(decision.reason, /non-self-healable/);
    }
  }
});

// 2026-11-08 用真实 preflight 输出（exit 1、findings 里只有一行带 scope）驱动判定时发现：
// 失效即关闭的兜底原本只写在 e2e-host.mjs 里，库本身对"退出码非 0 但解析不出 scope"是放行的
// ⇒ 下一个调用方必然假绿。兜底下沉到库里，这里把它钉住。
test('T14 fail-closed：退出码非 0 但解析不出任何 scope ⇒ 拒绝（不许读成"大概只是产物陈旧"）', () => {
  for (const jarMode of ['auto', 'use', 'rebuild', 'run', 'native']) {
    for (const exitCode of [1, 2, null]) {
      const decision = decidePreflightGate({ jarMode, cpBootMode: 'jar', blockingScopes: [], preflightExitCode: exitCode });
      assert.equal(decision.verdict, 'refuse', `jarMode=${jarMode} exit=${exitCode} 必须拒绝`);
      assert.deepEqual(decision.refusals, ['unclassified']);
      assert.match(decision.reason, /fail-closed/);
      assert.match(decision.reason, /FAIL {2}\[scope\]/); // 提示下一个检查该怎么打 scope 行
    }
  }
  // 退出码 0 + 无 scope 才是真正的"全绿"：不能把这条兜底写成恒拒绝。
  for (const jarMode of ['auto', 'use', 'rebuild']) {
    const decision = decidePreflightGate({ jarMode, cpBootMode: 'jar', blockingScopes: [], preflightExitCode: 0 });
    assert.equal(decision.verdict, 'proceed', `jarMode=${jarMode} 退出码 0 时必须放行`);
    assert.deepEqual(decision.refusals, []);
  }
  // 有 scope 时退出码不参与判据（scope 说了算），避免两条判据互相打架。
  const withScope = decidePreflightGate({ jarMode: 'auto', cpBootMode: 'jar', blockingScopes: ['ports'], preflightExitCode: 1 });
  assert.deepEqual(withScope.refusals, ['ports']);
  assert.match(withScope.reason, /non-self-healable/);
});

// 2026-11-08（缺陷 4）：产物**内容**核不了（`artifact-truth`）与"产物陈旧"（`build`）是两种事——
// 前者重建一次也不会变绿，所以任何 mode 都不许把它当可自愈项延期。
test('T15 artifact-truth 是"核不了"而不是"可自愈"：任何 jar 模式/任何延期设置下都必须拒绝', () => {
  for (const jarMode of ['auto', 'use', 'rebuild', 'run', 'native']) {
    for (const externalServer of [false, true]) {
      for (const ignoreBuild of [false, true]) {
        const decision = decidePreflightGate({
          jarMode,
          externalServer,
          cpBootMode: 'jar',
          ignoreBuild,
          blockingScopes: ['artifact-truth'],
        });
        assert.equal(decision.verdict, 'refuse', `jarMode=${jarMode} external=${externalServer} ignoreBuild=${ignoreBuild} 必须拒绝`);
        assert.deepEqual(decision.refusals, ['artifact-truth']);
        assert.match(decision.reason, /non-self-healable/);
      }
    }
  }
  // 同一行里同时出现 build + artifact-truth 时，拒绝理由必须落在不可自愈的那条上。
  const mixed = decidePreflightGate({ jarMode: 'auto', cpBootMode: 'jar', blockingScopes: ['build', 'artifact-truth'] });
  assert.equal(mixed.verdict, 'refuse');
  assert.deepEqual(mixed.refusals, ['artifact-truth']);
});

// D-763② / PLAN-0682 M2 回归：ed1f3dab 让 e2e-host 把门的**输出**值 `reuse` 回灌成了**输入**。
// external-server 模式下 `cpBootPlan` 恒为 null ⇒ 每个 reuse 跑都同步抛 TypeError，测量窗
// Route A 开窗第一步就死（`--persistent` boot 因 `cpBootPlan` 非空而幸免）。修复前本用例必死
// （组合函数不存在/组合里带 'reuse'），修复后必须全绿。
test('T16 回归：reuse run 无 boot plan 时不得把输出值 reuse 回灌成 cpBootMode 输入', () => {
  // 修复前：`cpBootPlan?.mode ?? (externalServer ? 'reuse' : 'jar')` —— reuse 跑恒抛。
  assert.throws(
    () => artifactGatePolicy({ externalServer: true, cpBootMode: 'reuse' }),
    /unknown cpBootMode/,
    '输入口径仍是 jar|run|native：修的是调用方，不是放宽白名单',
  );
  // 修复后：reuse 是 externalServer 派生的**输出**，入参回落到中性 'jar'。
  for (const jarMode of ['auto', 'use', 'rebuild', 'run', 'native']) {
    const policy = preflightGatePolicy({ jarMode, externalServer: true, cpBootPlan: null });
    assert.equal(policy.cpBootMode, 'reuse', `${jarMode}: reuse 是派生输出`);
    assert.equal(policy.ignoreBuild, true);
    assert.match(policy.reason, /reuse run/);
  }
  // 自有跑仍用 resolveCpBootPlan() 给出的入口（三种都在输入口径内）。
  for (const mode of ['jar', 'run', 'native']) {
    const policy = preflightGatePolicy({ jarMode: 'auto', externalServer: false, cpBootPlan: { mode } });
    assert.equal(policy.cpBootMode, mode);
  }
  // 合法的 owned 组合不许被顺手改坏：fresh jar + auto 仍然核产物段。
  const fresh = preflightGatePolicy({ jarMode: 'auto', externalServer: false, cpBootPlan: { mode: 'jar' } });
  assert.equal(fresh.buildSection, 'checked');
});
