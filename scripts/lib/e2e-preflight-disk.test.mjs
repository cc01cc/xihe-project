#!/usr/bin/env node
/**
 * 开窗准入磁盘门的单测（`scripts/lib/e2e-preflight-disk.mjs`）。
 *
 * **绝不真的填盘**：所有用例喂注入的假采样（`sampler`），只看判定与退出码映射。
 * 判据来自用户 2026-11-05 的阈值（H<25% 拦 / C<10% 拦 / H<30% 只警告），卡面明令不许改。
 *
 * 每个用例都同时断言三件事，因为门禁消费的是三者合起来的行为：
 * 1. `ok`（下游拿它判定能不能开窗）；
 * 2. `diskExitCode`（= 0/1，`e2e-preflight.mjs` 的退出契约，0=可开窗 / 1=需处理）；
 * 3. `reasons` 里出现**取值与阈值两个数**（只说"磁盘不够"等于没告诉人怎么处理）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DISK_THRESHOLDS,
  diskExitCode,
  evaluateDisks,
  parsePsDriveOutput,
  sampleDisksViaPsDrive,
} from './e2e-preflight-disk.mjs'

/** 造采样：`H: 120/500` = 24% free。 */
function sample(hFree, hTotal, cFree, cTotal) {
  return {
    H: { freeGB: hFree, totalGB: hTotal, pctFree: Math.round((hFree / hTotal) * 100) },
    C: { freeGB: cFree, totalGB: cTotal, pctFree: Math.round((cFree / cTotal) * 100) },
  }
}
const healthyC = [230, 500] // 46%

test('T1 H 24% ⇒ 硬伤，exit 1（低于 25% 拦截线）', () => {
  const result = evaluateDisks({ sampler: () => sample(120, 500, ...healthyC), platform: 'win32' })
  assert.equal(result.detail.H.pctFree, 24)
  assert.equal(result.ok, false)
  assert.equal(result.unverifiable, false)
  assert.equal(diskExitCode(result), 1)
  assert.deepEqual(
    result.findings.map((f) => f.severity),
    ['FAIL'],
  )
  assert.match(result.findings[0].message, /24%/)
  assert.match(result.findings[0].message, /25%/)
  assert.match(result.reasons.join('\n'), /H free 24% .*< 25%/)
  // create/clean 两个盘都要出现在 detail 里：缺一个就是"不可验证"
  assert.deepEqual(Object.keys(result.detail), ['H', 'C'])
  assert.deepEqual(Object.keys(result.detail.H), ['freeGB', 'totalGB', 'pctFree'])
})

test('T2 C 9% ⇒ 硬伤，exit 1（C 拦截线 10%，与 H 的 25% 不是同一个数）', () => {
  const result = evaluateDisks({ sampler: () => sample(200, 500, 45, 500), platform: 'win32' })
  assert.equal(result.detail.C.pctFree, 9)
  assert.equal(result.detail.H.pctFree, 40)
  assert.equal(result.ok, false)
  assert.equal(diskExitCode(result), 1)
  assert.equal(result.findings.length, 1)
  assert.equal(result.findings[0].severity, 'FAIL')
  assert.match(result.findings[0].message, /C drive has only 9% free/)
  assert.match(result.findings[0].message, /10%/)
})

test('T3 H 26% ⇒ 只警告不拦，exit 0（"该清理"与"已经会炸"是两条线）', () => {
  const result = evaluateDisks({ sampler: () => sample(130, 500, ...healthyC), platform: 'win32' })
  assert.equal(result.detail.H.pctFree, 26)
  assert.equal(result.ok, true)
  assert.equal(diskExitCode(result), 0)
  assert.deepEqual(
    result.findings.map((f) => f.severity),
    ['WARN'],
  )
  assert.match(result.findings[0].message, /26%/)
  assert.match(result.findings[0].message, /30%/)
  assert.match(result.findings[0].hint, /not blocking/)
})

test('T4 H 31% + C 46% ⇒ 全绿，exit 0，无任何 finding', () => {
  const result = evaluateDisks({ sampler: () => sample(155, 500, ...healthyC), platform: 'win32' })
  assert.equal(result.detail.H.pctFree, 31)
  assert.equal(result.ok, true)
  assert.equal(result.diskExitCode, undefined) // 结果对象不带方法，退出码只走 diskExitCode()
  assert.equal(diskExitCode(result), 0)
  assert.deepEqual(result.findings, [])
  assert.deepEqual(result.reasons, [])
})

test('T5 采盘失败（抛错）⇒ 判不可验证并 exit 1 —— 不允许在未知磁盘状态下开窗', () => {
  const boom = () => {
    throw new Error('Get-PSDrive failed: powershell not found')
  }
  const result = evaluateDisks({ sampler: boom, platform: 'win32' })
  assert.equal(result.unverifiable, true)
  assert.equal(result.ok, false)
  assert.equal(diskExitCode(result), 1)
  assert.equal(result.detail, null)
  assert.match(result.reasons.join('\n'), /disk sampling failed: Get-PSDrive failed: powershell not found/)
  assert.equal(result.findings[0].severity, 'FAIL')
  assert.match(result.findings[0].message, /could not be verified/)
})

test('T6 非 Windows ⇒ skipped 且 exit 0（不让别的平台全红）', () => {
  const result = evaluateDisks({ sampler: () => assert.fail('sampler must not run off-Windows'), platform: 'linux' })
  assert.equal(result.skipped, true)
  assert.equal(result.ok, true)
  assert.equal(diskExitCode(result), 0)
  assert.deepEqual(result.findings, [])
  assert.match(result.reasons.join('\n'), /skipped on linux/)
})

test('T7 阈值边界：H 正好 25% 只警告、C 正好 10% 不算硬伤、H 正好 30% 完全干净', () => {
  const atH25 = evaluateDisks({ sampler: () => sample(125, 500, 100, 500), platform: 'win32' })
  assert.equal(atH25.detail.H.pctFree, 25)
  assert.equal(atH25.ok, true)
  assert.deepEqual(
    atH25.findings.map((f) => f.severity),
    ['WARN'],
  )

  const atC10 = evaluateDisks({ sampler: () => sample(200, 500, 50, 500), platform: 'win32' })
  assert.equal(atC10.detail.C.pctFree, 10)
  assert.equal(atC10.ok, true)
  assert.deepEqual(atC10.findings, [])

  const atH30 = evaluateDisks({ sampler: () => sample(150, 500, ...healthyC), platform: 'win32' })
  assert.equal(atH30.detail.H.pctFree, 30)
  assert.deepEqual(atH30.findings, [])
  assert.equal(diskExitCode(atH30), 0)
})

test('T8 采样缺盘/取值不可用 ⇒ 不可验证 exit 1（缺的盘不能当"有空间"）', () => {
  const missingC = evaluateDisks({ sampler: () => ({ H: { freeGB: 200, totalGB: 500, pctFree: 40 } }), platform: 'win32' })
  assert.equal(missingC.unverifiable, true)
  assert.equal(diskExitCode(missingC), 1)
  assert.match(missingC.reasons.join('\n'), /drive\(s\) missing from the sample: C/)

  const bogus = evaluateDisks({
    sampler: () => ({ H: { freeGB: NaN, totalGB: 500 }, C: { freeGB: 230, totalGB: 500, pctFree: 46 } }),
    platform: 'win32',
  })
  assert.equal(bogus.unverifiable, true)
  assert.equal(diskExitCode(bogus), 1)
  assert.match(bogus.reasons.join('\n'), /H sample is not usable/)
})

test('T9 采盘接线：Get-PSDrive 输出解析 + 失败时抛出（两道都测，接线比判定更容易错）', () => {
  const ok = sampleDisksViaPsDrive({
    runCapture: (program, args) => {
      assert.equal(program, 'powershell.exe')
      assert.ok(args.includes('-NoProfile'))
      return { ok: true, code: 0, stdout: 'H:120.3/500\nC:230/500\n', stderr: '' }
    },
  })
  assert.deepEqual(ok, {
    H: { freeGB: 120.3, totalGB: 500, pctFree: 24 },
    C: { freeGB: 230, totalGB: 500, pctFree: 46 },
  })
  assert.equal(diskExitCode(evaluateDisks({ sampler: () => ok, platform: 'win32' })), 1)

  assert.throws(
    () => sampleDisksViaPsDrive({ runCapture: () => ({ ok: false, code: 1, stdout: '', stderr: 'Access denied\nmore' }) }),
    /Get-PSDrive failed: Access denied/,
  )
  assert.throws(
    () => sampleDisksViaPsDrive({ runCapture: () => ({ ok: true, code: 0, stdout: '\n\n', stderr: '' }) }),
    /returned no usable drive rows/,
  )
  assert.throws(() => sampleDisksViaPsDrive({}), /needs a runCapture function/)
})

test('T10 解析器：认形态、丢垃圾、不猜（0 总量/负余量/超总量一律丢弃）', () => {
  assert.deepEqual(parsePsDriveOutput('H:120.3/500 C:230/500'), {
    H: { freeGB: 120.3, totalGB: 500, pctFree: 24 },
    C: { freeGB: 230, totalGB: 500, pctFree: 46 },
  })
  assert.deepEqual(parsePsDriveOutput(''), {})
  assert.deepEqual(parsePsDriveOutput('garbage\nsome:thing/else'), {})
  assert.deepEqual(parsePsDriveOutput('H:10/0'), {}) // 总量 0
  assert.deepEqual(parsePsDriveOutput('H:-5/500'), {}) // 负余量
  assert.deepEqual(parsePsDriveOutput('H:600/500'), {}) // 余量大于总量
  // 小写盘符归一化，阈值按同一键取
  assert.deepEqual(Object.keys(parsePsDriveOutput('h:120/500')), ['H'])
})

test('T11 结果可被机器读：JSON 往返后字段与类型不变（下游拿它当门禁判据）', () => {
  const result = evaluateDisks({ sampler: () => sample(130, 500, ...healthyC), platform: 'win32' })
  const roundTrip = JSON.parse(JSON.stringify(result))
  assert.equal(roundTrip.name, 'disk')
  assert.equal(roundTrip.ok, true)
  assert.equal(roundTrip.skipped, false)
  assert.equal(roundTrip.unverifiable, false)
  assert.deepEqual(Object.keys(roundTrip.detail).sort(), ['C', 'H'])
  assert.equal(roundTrip.detail.H.pctFree, 26)
  assert.equal(typeof roundTrip.detail.H.freeGB, 'number')
  assert.equal(roundTrip.detail.H.totalGB, 500)
  assert.equal(roundTrip.reasons.length, 1)
  assert.equal(roundTrip.findings[0].severity, 'WARN')
  assert.equal(typeof roundTrip.findings[0].message, 'string')
  assert.equal(typeof roundTrip.findings[0].hint, 'string')
  // 阈值常量本身也要能被读出来（下游/报告要引用"25/10/30"这三个数）
  assert.deepEqual({ ...DISK_THRESHOLDS }, { hBlocksBelowPct: 25, cBlocksBelowPct: 10, hWarnsBelowPct: 30 })
  assert.equal(Object.isFrozen(DISK_THRESHOLDS), true)
})
