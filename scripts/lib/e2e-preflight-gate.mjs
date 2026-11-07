#!/usr/bin/env node
/**
 * 开窗门的**判据**（PLAN-0680 / task-76 缺陷 1 + 缺陷 2），纯函数、可喂假数据单测。
 *
 * 缺陷 1 的形状（"检查指向了一条永远走不到的路"）：`--jar-mode=auto`（默认）承诺
 * build-then-use —— 陈旧 jar 就重建、再复用；但 `runPreflightGate()` 只认
 * `preflight.code !== 0`，而 preflight 的产物段（第 3 段）会把"jar 比源码旧"判 FAIL。
 * 于是一条**本可自愈**的条件把门锁死：门先拒绝，自动重建永远走不到；报错读起来像
 * "环境脏了"，实际是门把自己锁死了。
 *
 * 本模块把"门的拒绝必须能区分'可自愈'与'不可自愈'"写成判据（Lead 明确要求写进代码）：
 *
 * 1. **产物段的判定对象必须是"这一轮真的要启动的那个产物"**。
 *    - `--jar-mode=native`：启动的是 native 可执行文件，fat jar 与本次运行无关 ⇒ 跳过产物段；
 *    - CP 实际 entry 是 `mvn spring-boot:run`（auto 重建失败回落 / `--jar-mode=run`）：
 *      这一轮不启动 jar ⇒ 跳过产物段；
 *    - `--jar-mode=use`：操作员**显式**选择"照原样启动现有 jar"（runner 已打 STALE WARN）
 *      ⇒ 跳过产物段，否则 `use` 这个 mode 永远存在不了；
 *    - reuse run（`XIHE_E2E_EXTERNAL_SERVER=1`）：本轮不启动自己的产物，持久栈自己的构建目录
 *      由 `externalCpBuildCheck` 单独校验 ⇒ 跳过产物段。**这条是 2026-11-07 夜里真实锁死的形状**：
 *      复用跑到 `C:/xihe-build/e2e` 里找一个本轮根本不会启动的 jar，谁也没打算重建它。
 * 2. **可自愈的产物条件在门之前就已经被修**：`resolveCpBootPlan()` 先跑（`mvn package` 重建），
 *    门在它之后跑。所以产物段若**仍然**有阻塞项，那条恰恰**不是**可自愈的（重建失败或重建后仍旧）
 *    ⇒ 拒绝，并在信息里写明"不是自愈能解决的"。
 * 3. 非产物类阻塞（端口冲突、docker 残留、活跃 run、磁盘）**任何 mode 都拒绝**：门不许因为
 *    产物类可延期就顺手把别的也放过去。
 *
 * 缺陷 2 的形状：`--skip-preflight` 只打印一句"skipping the read-only preflight"，连磁盘门
 * 一起静默放行 —— 于是"开窗时磁盘剩 12%"这种事在事后取证里看不见。本模块给出替代判据：
 * 跳过其余检查，但**磁盘段照跑**；磁盘段自己也跑不了时才允许整体跳过，且必须显式记录
 * `diskGate: bypassed`（不许静默）。
 *
 * 两段式 API：`artifactGatePolicy()`（只看"这一轮启动哪个产物"，决定是否给 preflight 加
 * `--ignore-build`）→ 跑 preflight → `evaluateGateFindings()`（拿真实 scope 判拒绝）。
 */

import { JAR_MODES } from './cp-boot-plan.mjs';

/** preflight 的产物/源码新鲜度段落名（`add('FAIL', 'build', …)` 里的 scope）。 */
export const BUILD_SCOPE = 'build';

/**
 * 不许被产物类延期一并放过的 scope（`evaluateGateFindings` 对**任何**非 `build` scope 都拒绝，
 * 这里只是把当前已知的几条写下来，便于下次加检查时对照）：
 *
 * - `ports` 端口冲突 / `docker` 残留 / `runs` 活跃 run / `disk` 磁盘 —— 环境真的有问题；
 * - `runtime-target`：**每一轮** host E2E 都要启动 Rust runtime，所以"解析不出 runtime 产物在哪"
 *   与 CP jar 的模式无关，不许因为"本轮不启动 jar"就放过（这条是缺陷 3 的落地位置）。
 * - `artifact-truth`：共享产物（`C:/xihe-build/e2e` 的 CP jar）的**内容**无法与源码对照（没有
 *   git 判据、读不出 jar 条目、mtime 也不可用）—— 这类"核不了"**重建一次也不会变绿**，所以不能
 *   跟 `build` 一样被延期（这是缺陷 4 的落地位置，见 scripts/lib/e2e-build-artifact.mjs）。
 */
export const ALWAYS_BLOCKING_SCOPES = Object.freeze(['ports', 'docker', 'runs', 'disk', 'runtime-target', 'artifact-truth']);

/** `--skip-preflight` 时仍然执行的段落（用户 2026-11-05 定的硬阈值，不许被顺手跳过）。 */
export const ALWAYS_ENFORCED_SCOPES = Object.freeze(['disk']);

/**
 * 只决定"产物段要不要跑 / 为什么"，不看任何阻塞项（那是 preflight 之后的事）。
 *
 * @param {object} input
 * @param {string} [input.jarMode] `auto` | `use` | `rebuild` | `run` | `native`
 * @param {boolean} [input.externalServer] `XIHE_E2E_EXTERNAL_SERVER=1`（复用持久栈）
 * @param {'jar'|'run'|'native'} [input.cpBootMode] `resolveCpBootPlan()` 实际给出的启动入口
 * @returns {{
 *   ignoreBuild: boolean,
 *   buildSection: 'checked'|'skipped',
 *   cpBootMode: 'jar'|'run'|'native'|'reuse',
 *   reason: string,
 *   deferred: string[],
 * }}
 */
export function artifactGatePolicy({ jarMode = 'auto', externalServer = false, cpBootMode = 'jar' } = {}) {
  if (!JAR_MODES.includes(jarMode)) {
    throw new TypeError(
      `artifactGatePolicy: unknown jarMode ${JSON.stringify(jarMode)} (expected one of ${JAR_MODES.join('|')})`,
    );
  }
  if (!['jar', 'run', 'native'].includes(cpBootMode)) {
    throw new TypeError(`artifactGatePolicy: unknown cpBootMode ${JSON.stringify(cpBootMode)}`);
  }
  let ignoreBuild = false;
  let reason = '';
  let effectiveBoot = cpBootMode;
  if (externalServer) {
    ignoreBuild = true;
    effectiveBoot = 'reuse';
    reason = 'reuse run (XIHE_E2E_EXTERNAL_SERVER=1): this process boots nothing from the E2E build dir; the persistent stack asserts its own build dir';
  } else if (jarMode === 'native') {
    ignoreBuild = true;
    reason = '--jar-mode=native: the boot artifact is the native executable, the fat jar is not involved';
  } else if (jarMode === 'use') {
    ignoreBuild = true;
    reason = '--jar-mode=use: the operator explicitly asked to boot the existing jar as-is (runner already printed the STALE WARN)';
  } else if (cpBootMode !== 'jar') {
    ignoreBuild = true;
    reason = `CP boot entry is ${cpBootMode}: the fat jar is not booted this run, so jar freshness cannot describe it`;
  }
  return {
    ignoreBuild,
    buildSection: ignoreBuild ? 'skipped' : 'checked',
    cpBootMode: effectiveBoot,
    reason: ignoreBuild ? reason : 'artifact section checked after the pre-gate rebuild (the runner heals stale/missing jars before the gate)',
    deferred: ignoreBuild ? [BUILD_SCOPE] : [],
  };
}

/**
 * preflight 跑完之后：拿真实阻塞 scope 判拒绝。**只有**可延期/不适用产物类的条件被放行。
 *
 * @param {object} input
 * @param {ReturnType<typeof artifactGatePolicy>} input.policy
 * @param {string[]} [input.blockingScopes]
 * @param {number|null} [input.preflightExitCode] preflight 的真实退出码（`null` = 没拿到）
 * @returns {{verdict: 'proceed'|'refuse', reason: string, refusals: string[], deferred: string[]}}
 */
export function evaluateGateFindings({ policy, blockingScopes = [], preflightExitCode = 0 } = {}) {
  if (!policy || typeof policy.ignoreBuild !== 'boolean') {
    throw new TypeError('evaluateGateFindings: a policy from artifactGatePolicy() is required');
  }
  const scopes = [...new Set(blockingScopes)];
  // 失效即关闭（fail-closed）：退出码非 0 却解析不出任何 scope，说明那几行 FAIL 不是
  // `  FAIL  [scope] message` 形式（新加的检查忘了打 scope）。这种"归属不明"绝不能读成
  // "大概只是产物陈旧" —— 兜底必须在本库内，不能只写在某个调用方里（否则下一个调用方就会假绿）。
  if (scopes.length === 0 && preflightExitCode !== 0) {
    return {
      verdict: 'refuse',
      reason: `preflight exited ${preflightExitCode === null ? 'without a code' : preflightExitCode} but no blocking scope could be parsed from its output — an unattributed FAIL must not be read as "probably just the artifact section" (fail-closed; the check that fired needs a \`  FAIL  [scope]\` line)`,
      refusals: ['unclassified'],
      deferred: policy.ignoreBuild ? [BUILD_SCOPE] : [],
    };
  }
  const buildBlockers = scopes.filter((scope) => scope === BUILD_SCOPE);
  const refusals = scopes.filter((scope) => scope !== BUILD_SCOPE);
  const deferred = policy.ignoreBuild ? [BUILD_SCOPE] : [];

  // 门的一致性自检：产物段被跳过时，产物类阻塞项不该存在。存在 ⇒ 说明调用方的
  // `--ignore-build` 与输出不一致（有新的 build 类检查没接上 --ignore-build），
  // 宁可拒绝也不假绿。
  if (policy.ignoreBuild && buildBlockers.length > 0) {
    return {
      verdict: 'refuse',
      reason: `gate inconsistency: a build-scope blocker survived although the artifact section is skipped (${policy.reason}) — a new build-class check is probably not honouring --ignore-build`,
      refusals,
      deferred,
    };
  }
  // 顺序有意如此：先报**不可自愈**的那些，再单独报"重建后仍陈旧"。两类同时出现时，
  // 把理由写成"产物类"会误导排障（真实 preflight 同时给 build + runtime-target 时踩到过）。
  if (refusals.length > 0) {
    const buildNote = buildBlockers.length > 0 ? ` (plus a build-scope blocker that also survived the pre-gate rebuild: ${buildBlockers.join(', ')})` : '';
    return {
      verdict: 'refuse',
      reason: `non-self-healable blocking finding(s): ${refusals.join(', ')} — a deferrable artifact condition must never buy a pass for these${buildNote}`,
      refusals,
      deferred,
    };
  }
  if (!policy.ignoreBuild && buildBlockers.length > 0) {
    return {
      verdict: 'refuse',
      reason: 'build-class finding survived the pre-gate rebuild: NOT self-healable (the runner already ran `mvn package` before the gate, so a stale/missing jar here means the rebuild failed or did not produce a newer jar)',
      refusals,
      deferred,
    };
  }
  return { verdict: 'proceed', reason: policy.reason, refusals: [], deferred };
}

/** 便利组合（两段式仍可分别调用；测试与日志都用得到单次判定）。 */
export function decidePreflightGate(input = {}) {
  const policy = artifactGatePolicy(input);
  const findings = evaluateGateFindings({
    policy,
    blockingScopes: input.blockingScopes ?? [],
    // `null` 是"没拿到退出码"（spawn 失败），必须保持 fail-closed；不能用 `?? 0`
    // 把它当成成功退出码 —— 那正是 T14 抓到的假绿路径。
    preflightExitCode: input.preflightExitCode === undefined ? 0 : input.preflightExitCode,
  });
  return { ...policy, ...findings };
}

/** 一行日志：把判据本身打出来（不然下次又只能靠猜）。 */
export function describePreflightGate(decision) {
  const head = `gate: ${decision.verdict} — artifact section ${decision.buildSection}`;
  return decision.buildSection === 'skipped'
    ? `${head} (deferred: ${decision.deferred.join(', ') || '—'}; ${decision.reason})`
    : `${head}; ${decision.reason}`;
}

/**
 * 纯解析：preflight 的机器可读磁盘行 `  disk  {"name":"disk",…}`（`e2e-preflight.mjs`
 * 头部注释里承诺的下游契约；不要去解析它下面的人读散文）。
 * @param {string} stdout
 * @returns {object|null}
 */
export function parseDiskLine(stdout) {
  const match = /^ {2}disk {2}(\{.*\})\s*$/m.exec(String(stdout ?? ''));
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * preflight 输出 → 阻塞项的 scope 列表（`  FAIL  [scope] message`，见 e2e-preflight.mjs 的
 * findings 汇总行）。门的判据只关心"这些阻塞项属于哪一段"，所以这里只取 scope、去重。
 *
 * 严格按格式解析：认不出来的 `FAIL` 行**不**被当成某个 scope（否则会凭空放行）；
 * 这类"归属不明"由 `evaluateGateFindings` 按退出码 fail-closed 处理。
 * @param {string} stdout
 * @returns {string[]}
 */
export function parseBlockingScopes(stdout) {
  const scopes = [];
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const match = /^ {2}FAIL {2}\[([^\]\s]+)\]/.exec(line);
    if (match && !scopes.includes(match[1])) scopes.push(match[1]);
  }
  return scopes;
}

/**
 * 磁盘段结果 → 可写进 run 头（`artifacts.json` / `persistent-stack.json`）的记录。
 * `mode` 只有两种：`enforced`（照跑）与 `bypassed`（连磁盘段都没跑成 —— 必须留痕）。
 */
export function diskGateRecord({ exitCode, diskResult } = {}) {
  if (!diskResult) {
    return {
      mode: 'bypassed',
      verdict: 'unknown',
      exitCode: exitCode ?? null,
      reason: 'the disk segment produced no machine-readable line (preflight failed before/at the disk check)',
      detail: null,
    };
  }
  const verdict = diskResult.skipped
    ? 'skipped'
    : diskResult.unverifiable
      ? 'unverifiable'
      : diskResult.ok
        ? 'ok'
        : 'blocked';
  const detail = diskResult.detail && diskResult.detail.H && diskResult.detail.C
    ? {
        H: {
          freeGB: diskResult.detail.H.freeGB,
          totalGB: diskResult.detail.H.totalGB,
          pctFree: diskResult.detail.H.pctFree,
        },
        C: {
          freeGB: diskResult.detail.C.freeGB,
          totalGB: diskResult.detail.C.totalGB,
          pctFree: diskResult.detail.C.pctFree,
        },
      }
    : null;
  return {
    mode: verdict === 'unknown' ? 'bypassed' : 'enforced',
    verdict,
    exitCode: exitCode ?? null,
    reason: (diskResult.reasons ?? [])[0] ?? '',
    detail,
  };
}

/** 人读的一行磁盘门摘要（写日志/run 头都用同一份措辞）。 */
export function describeDiskGate(record) {
  if (!record) return 'disk gate: unknown';
  if (record.detail) {
    const { H, C } = record.detail;
    return `disk gate: ${record.verdict} — H ${H.pctFree}% free (${H.freeGB}/${H.totalGB} GB), C ${C.pctFree}% free (${C.freeGB}/${C.totalGB} GB)`;
  }
  return `disk gate: ${record.verdict}${record.reason ? ` — ${record.reason}` : ''}`;
}

/**
 * `--skip-preflight` 下磁盘段仍然说了算：只有 `ok` / `skipped` 才放行。
 * `unverifiable` 与 `blocked` 都拒绝（"未知不等于安全"），`bypassed` 表示磁盘段本身跑不了
 * —— 那时放行但记录 `diskGate: bypassed`（这是该开关唯一还剩下的"跳过"语义）。
 * @param {{exitCode: number|null, diskResult: object|null}} input
 */
export function decideSkipPreflightDisk({ exitCode, diskResult } = {}) {
  const record = diskGateRecord({ exitCode, diskResult });
  if (record.verdict === 'ok' || record.verdict === 'skipped' || record.mode === 'bypassed') {
    return { proceed: true, record };
  }
  return {
    proceed: false,
    record,
    reason: record.verdict === 'blocked'
      ? 'disk headroom is below the window-admission threshold; --skip-preflight does NOT skip the disk gate'
      : 'disk headroom is unverifiable and an unknown disk state must not open a window',
  };
}
