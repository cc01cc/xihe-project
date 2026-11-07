#!/usr/bin/env node
/**
 * 开窗准入的磁盘门 —— `scripts/e2e-preflight.mjs` 的第 4 段检查（PLAN-0680 施行缺口）。
 *
 * 为什么单独成模块：`scripts/e2e-preflight.mjs` 是**纯脚本**（import 它就会真跑 docker/端口/
 * 产物检查），所以仓库里对它的既有办法只能"读源码断言"（见
 * `scripts/e2e-host-readiness.test.mjs:150-162` 的注释）。磁盘判据是**会被门禁消费的数值逻辑**，
 * 必须能喂假数据单测，故按仓库既有先例（`lib/e2e-host-cli.mjs` + 同名 `.test.mjs`）抽到 lib。
 *
 * 阈值是用户 2026-11-05 定的，**不许改**（性质不同，不能合成一个数）：
 * - H 剩余 `< 25%` ⇒ 硬伤（开窗会跑到一半炸，且现场污染会被误判成"测试红"）
 * - C 剩余 `< 10%` ⇒ 硬伤（工作区经验规则里唯一有共识的红线）
 * - H 剩余 `< 30%` ⇒ 只警告（"该清理了"的线，不是"已经会炸"的线）
 *
 * 采盘失败/超时/缺盘 ⇒ 判 **不可验证** 并阻塞（宁可拦住，也不在未知磁盘状态下开窗）。
 * 非 Windows ⇒ `skipped`，不阻塞（别让非 Windows 环境全红）。
 *
 * 返回结构（机器可读，下游拿它当门禁判据，不能只在文本里塞一句话）：
 *   {
 *     name: 'disk',
 *     ok: boolean,            // 无阻塞项 = 可开窗
 *     skipped: boolean,       // 平台不适用
 *     unverifiable: boolean,  // 采盘失败/缺盘 ⇒ ok 恒 false
 *     detail: { H: { freeGB, totalGB, pctFree } | null, C: …| null } | null,
 *     reasons: string[],      // 判定理由（人读，逐条含取值与阈值）
 *     findings: [{ severity: 'FAIL' | 'WARN', message, hint }],
 *   }
 */

/** 用户 2026-11-05 定的阈值；卡面明令不许改。 */
export const DISK_THRESHOLDS = Object.freeze({
  /** H 剩余低于该百分比 ⇒ 硬伤。 */
  hBlocksBelowPct: 25,
  /** C 剩余低于该百分比 ⇒ 硬伤。 */
  cBlocksBelowPct: 10,
  /** H 剩余低于该百分比 ⇒ 仅警告。 */
  hWarnsBelowPct: 30,
})

/** 必须采到余量的盘：两个都要有结论，缺一个就算"不可验证"。 */
export const DISK_TARGETS = Object.freeze(['H', 'C'])

/**
 * 纯解析：`Get-PSDrive` 输出的 `H:120.3/500.0 C:230/500` 形态。
 * 解析不出/取值非法的一律丢弃（由 evaluateDisks 判"不可验证"），不猜、不补 0。
 * @returns {Record<string, {freeGB: number, totalGB: number, pctFree: number}>}
 */
export function parsePsDriveOutput(stdout) {
  const parsed = {}
  for (const token of String(stdout ?? '').split(/\s+/).filter(Boolean)) {
    const match = /^([A-Za-z]):(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/.exec(token)
    if (!match) continue
    const freeGB = Number(match[2])
    const totalGB = Number(match[3])
    if (!Number.isFinite(freeGB) || !Number.isFinite(totalGB) || totalGB <= 0) continue
    if (freeGB < 0 || freeGB > totalGB) continue
    parsed[match[1].toUpperCase()] = {
      freeGB,
      totalGB,
      pctFree: Math.round((freeGB / totalGB) * 100),
    }
  }
  return parsed
}

/**
 * 默认采盘实现：`Get-PSDrive H,C`（与 `internal/A03-xihe/scripts/xh-monitor.mjs:235-247` 同形态）。
 * 失败一律 throw —— 让 evaluateDisks 把"采不到"与"余量不够"区分开。
 * @param {{runCapture: (program: string, args: string[], timeoutMs?: number) => {ok: boolean, code: number|null, stdout: string, stderr: string}, timeoutMs?: number, drives?: readonly string[]}} options
 */
export function sampleDisksViaPsDrive({ runCapture, timeoutMs = 10000, drives = DISK_TARGETS } = {}) {
  if (typeof runCapture !== 'function') throw new TypeError('sampleDisksViaPsDrive needs a runCapture function')
  const driveList = drives.join(',')
  const script = `Get-PSDrive ${driveList} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Name):$([math]::Round($_.Free/1GB,1))/$([math]::Round(($_.Used+$_.Free)/1GB,1))" }`
  const result = runCapture('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], timeoutMs)
  if (!result || !result.ok) {
    const detail = String(result?.stderr ?? '').trim().split('\n')[0] || `exit ${result?.code ?? 'null'}`
    throw new Error(`Get-PSDrive failed: ${detail}`)
  }
  const sample = parsePsDriveOutput(result.stdout)
  if (Object.keys(sample).length === 0) throw new Error('Get-PSDrive returned no usable drive rows')
  return sample
}

/**
 * 判定：采样 → 阈值 → 阻塞/警告。`sampler` 可注入（单测喂假数据，绝不真的去填盘）。
 * @param {{sampler?: () => Record<string, {freeGB: number, totalGB: number, pctFree?: number}>, platform?: string, thresholds?: typeof DISK_THRESHOLDS}} [options]
 */
export function evaluateDisks({ sampler, platform = process.platform, thresholds = DISK_THRESHOLDS } = {}) {
  const result = {
    name: 'disk',
    ok: true,
    skipped: false,
    unverifiable: false,
    detail: null,
    reasons: [],
    findings: [],
  }
  if (platform !== 'win32') {
    result.skipped = true
    result.reasons.push(`disk gate skipped on ${platform} (Windows-only check)`)
    return result
  }
  const fail = (message, hint) => {
    result.ok = false
    result.findings.push({ severity: 'FAIL', message, hint })
  }

  let sample
  try {
    if (typeof sampler !== 'function') throw new TypeError('no disk sampler provided')
    sample = sampler()
  } catch (error) {
    result.unverifiable = true
    result.reasons.push(`disk sampling failed: ${error?.message ?? error}`)
    fail(
      'disk headroom could not be verified (sampling failed)',
      'do not open a window on unknown disk state; re-run the preflight, and if it keeps failing check PowerShell/Get-PSDrive availability',
    )
    return result
  }

  const missing = DISK_TARGETS.filter((drive) => !sample || !sample[drive])
  if (missing.length > 0) {
    result.unverifiable = true
    result.reasons.push(`drive(s) missing from the sample: ${missing.join(', ')}`)
    fail(
      `disk headroom could not be verified (no sample for ${missing.join('/')})`,
      'make sure the drive letters exist and PowerShell is reachable; an unsampled drive must not be treated as free',
    )
    return result
  }

  result.detail = {}
  for (const drive of DISK_TARGETS) {
    const entry = sample[drive]
    const freeGB = Number(entry.freeGB)
    const totalGB = Number(entry.totalGB)
    const usable = Number.isFinite(freeGB) && Number.isFinite(totalGB) && totalGB > 0
    const pctFree = usable ? Math.round((freeGB / totalGB) * 100) : null
    result.detail[drive] = usable ? { freeGB, totalGB, pctFree } : null
    if (!usable) {
      result.unverifiable = true
      result.reasons.push(`${drive} sample is not usable (freeGB=${entry.freeGB}, totalGB=${entry.totalGB})`)
      fail(
        `disk headroom could not be verified for ${drive}`,
        'the sampler returned a non-numeric or empty drive entry; treat it as unknown, not as free',
      )
    }
  }
  if (result.unverifiable) return result

  const h = result.detail.H
  const c = result.detail.C
  if (h.pctFree < thresholds.hBlocksBelowPct) {
    result.reasons.push(
      `H free ${h.pctFree}% (${h.freeGB}/${h.totalGB} GB) < ${thresholds.hBlocksBelowPct}% block threshold`,
    )
    fail(
      `H drive has only ${h.pctFree}% free (${h.freeGB}/${h.totalGB} GB), below the ${thresholds.hBlocksBelowPct}% block threshold`,
      'a host E2E window writes tens of GB to H; free space first (or move artifacts) instead of letting the run die mid-flight',
    )
  }
  if (c.pctFree < thresholds.cBlocksBelowPct) {
    result.reasons.push(
      `C free ${c.pctFree}% (${c.freeGB}/${c.totalGB} GB) < ${thresholds.cBlocksBelowPct}% block threshold`,
    )
    fail(
      `C drive has only ${c.pctFree}% free (${c.freeGB}/${c.totalGB} GB), below the ${thresholds.cBlocksBelowPct}% block threshold`,
      'Windows itself needs C headroom; free space before opening the window',
    )
  }
  if (result.ok && h.pctFree < thresholds.hWarnsBelowPct) {
    result.reasons.push(
      `H free ${h.pctFree}% (${h.freeGB}/${h.totalGB} GB) < ${thresholds.hWarnsBelowPct}% warn threshold (does not block)`,
    )
    result.findings.push({
      severity: 'WARN',
      message: `H drive has only ${h.pctFree}% free (${h.freeGB}/${h.totalGB} GB); below the ${thresholds.hWarnsBelowPct}% cleanup line`,
      hint: 'not blocking — but a long window may end with a full disk; clean the per-run host roots first',
    })
  }
  return result
}

/**
 * 结果 → preflight 退出码（契约与 `e2e-preflight.mjs` 一致：0 = 可开窗，1 = 需处理）。
 * 只有磁盘一段时用它；整脚本的退出码仍是 `0/1/2`，本函数不产出 2（那是参数错误）。
 */
export function diskExitCode(result) {
  return result && result.ok ? 0 : 1
}
