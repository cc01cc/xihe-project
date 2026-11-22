#!/usr/bin/env node
/**
 * check-decision-test-map.mjs - 决策条款 → 测试追溯门（D 号条款必须挂在真实存在的测试上）
 *
 * 依据：task-124（用户 2026-11-20 00:50 裁定「决策不能只停在文本」）；首批覆盖
 *   D-1904（UI 基线 F-1/F-2/F-3）、D-1907 rev9（UI 基线 v2 A–G + G-9~G-12）、
 *   D-1908 rev2（会话权限三档模型）。清单 = A03-xihe/config/decision-test-map.json。
 *
 * 判据：
 *   1) 每条 clause 的 status ∈ covered | pending | not-testable，clause id 全局唯一
 *   2) covered ⇒ file 存在 + title（空白归一后）在文件里命中 + assert 子串命中
 *      ⇒ 测试被改名/删除/断言搬走时本门立刻红，而不是「文档里说测了」
 *   3) pending ⇒ 必须有 card（承接卡号）；给了 file 就必须给 title
 *   4) not-testable ⇒ 必须有 reason（≥10 字），且占比 ≤ 20%
 *   5) file 白名单（五类前缀，task-53 放宽 + task-173 加 CP；越界仍报 E_PATH_OUTSIDE）：
 *        A03-xihe/packages/ui/** · A12-arbiter/packages/arbiter/tests/** ·
 *        internal/A03-xihe/scripts/** · scripts/**（one 仓仓库级门禁脚本的自测）·
 *        A03-xihe/packages/control-plane/src/test/**（CP 的 JUnit 判据）
 *      且必须是测试文件（禁止 .tmp/.local/node_modules 副本误绿）。测试文件两族口径见 TEST_FILE_RE /
 *      JAVA_TEST_FILE_RE：JS/TS 认 *.{spec,test}.[cm]?[jt]sx?，Java 只认 *Test.java 且文件内必须有 @Test
 *      （AbstractIntegrationTest.java / *Fixture.java 这类基类夹具叫得像测试，但不是判据 ⇒ 仍然拒）。
 *      为什么放开这四类：门**本身**的判据只能挂在自己的测试上 —— DSD-1474（D 号/DSD 前缀解析）与
 *      DSD-1475（投影缺失自愈）的判据分别落在 one 根 scripts/ 与 internal/A03-xihe/scripts/ 的 .test.mjs，
 *      只允许 ui/ 时这两类条款根本登记不进来（只能人工读文本，等于「决策只停在文本」）。
 *      为什么**不**放开 A03-xihe/scripts/**：当前没有任何登记需要它；每多一个前缀就多一片「测试可被算作判据」的面，
 *      等真有卡需要再加，加的时候同批补越界反例（自检里已有一条断言它仍然越界）。
 *      为什么加 CP（task-173）：DSD-1513 ①②（空库种子三组 / 超管口令一次性披露）的判据全部是 CP 的
 *      Spring 集成测试，只允许 ui/ 时它们一律 E_PATH_OUTSIDE ⇒ 「裁定固化成测试」（DSD-1476）在 Java 面失效。
 *      前缀只到 src/test/：src/main/ 下的同名文件不是判据；Java 侧再叠 @Test 注解判据，防止把夹具当判据。
 *   6) 决策号两条登记处（task-59）：DSD-1474 起新裁定一律写 `DSD-NNNN`，历史台账号保持 `D-####`。
 *      · `D-####`：台账未冻结 ⇒ 须在 lead-decisions-ledger.md 命中；台账已冻结（D-1903 起登记处迁 DSD）
 *        ⇒ 须给 decisions[].dsd（DSD decisions.id），并尽力核对 revision（库不可读则 SKIP 不判红）
 *      · `DSD-NNNN`：**不做台账查重**（DSD 库与台账是两套独立登记处且号段重叠，互判红等于把
 *        DSD-1461 与台账 D-1461 当成同一裁定 —— 与 scripts/check-decision-refs.mjs 的 DSD- 只解析
 *        DSD 侧同口径）。dsd 字段**可省略**，省略时由 id 里的 NNNN 推导；给了就必须等于 NNNN
 *        （不等报 E_DSD_ID_MISMATCH）；库可读时仍核对 revision（E_DSD_REV_MISMATCH），不可读 SKIP。
 *   7) clause id 跟随决策 id 形态：必须是决策 id 本身或 `<决策 id>/<子标签>`（DSD-1463/1、D-1907/A-1），
 *      否则 E_CLAUSE_ID_PREFIX（否则「条款挂在哪个决策下」只能靠人眼）
 *
 * 用法：
 *   node scripts/check-decision-test-map.mjs [--map <json>] [--root <one 根>]
 *        [--json] [--enforce] [--selftest] [--quiet]
 *   --enforce  追加「pending > 0 即红」（条款全部落地后的严格档）
 *   --selftest 内存内自检（基线绿 / title 错 / assert 错 / pending 缺 card / not-testable 缺 reason /
 *              clause id 重复 / 路径越界 / 比例超限 + file 白名单四类正向 + 缺文件 / 非测试文件 / DSD 号不存在反例
 *              + DSD- 号正向（dsd 省略可推导）、DSD 与 dsd 不一致、DSD- 号不被台账判红、clause id 前缀不符
 *              + task-173 CP 面：*Test.java 可登记 / *Fixture.java 仍拒 / 抽象基类（无 @Test）仍拒 / src/main 越界仍拒
 *                / JS/TS 老路径回归；正向类用例按「清单结构」判，不因并行在飞卡改产品 spec 而染色）
 *
 * 退出码：0 无硬违规；1 有硬违规（或 --enforce 下 pending > 0、--selftest 失败）；2 用法或 IO 错。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

const TOOL = 'check-decision-test-map'
const A03_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ONE_ROOT = path.resolve(A03_ROOT, '..')
const DEFAULT_MAP = path.join(A03_ROOT, 'config', 'decision-test-map.json')
const LEDGER = path.join('internal', 'A03-xihe', 'docs', 'lead-decisions-ledger.md')
// file 白名单（task-53 四类 + task-173 加 CP）：放宽的判据不是「路径更像测试就能算判据」，
// 而是「这条判据的测试就在它该在的地方」。
const TEST_PREFIXES = [
    'A03-xihe/packages/ui/',
    'A12-arbiter/packages/arbiter/tests/',
    'internal/A03-xihe/scripts/',
    'scripts/',
    // task-173：DSD-1513 ①② 的判据是 CP 的 Spring 集成测试。前缀止于 src/test/ ——
    // src/main/ 下的同名文件不是判据，必须仍然越界（自检里有一条钉住它）。
    'A03-xihe/packages/control-plane/src/test/'
]
const isAllowedPath = (rel) => TEST_PREFIXES.some((p) => rel.startsWith(p))
// 测试文件两族，显式清单，不用一个宽正则把夹具一起吞掉：
//   ① JS/TS：*.{spec,test}.[cm]?[jt]sx?（原口径，一个字都没动）
//   ② Java：只认 Maven surefire 的默认命名 *Test.java，且文件内必须有 @Test 注解 ——
//      AbstractIntegrationTest.java（抽象基类）与 *Fixture.java 都叫得像测试，但都不是判据。
const TEST_FILE_RE = /\.(spec|test)\.[cm]?[jt]sx?$/
const JAVA_TEST_FILE_RE = /Test\.java$/
const JAVA_ANNOTATION_RE = /@Test\b/
const isTestFilePath = (rel) => TEST_FILE_RE.test(rel) || JAVA_TEST_FILE_RE.test(rel)
const NT_RATIO_MAX = 0.2
const NT_REASON_MIN = 10
const STATUSES = ['covered', 'pending', 'not-testable']
// 决策 id 两种形态（task-59）：历史台账号 D-<3~4 位>，DSD-1474 起新裁定 DSD-<3~5 位>。
const DECISION_ID_RE = /^(?:D-\d{3,4}|DSD-\d{3,5})$/
const dsdNumFromId = (did) => {
    const m = /^DSD-(\d{3,5})$/.exec(did)
    return m ? Number(m[1]) : null
}

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

function parseArgs(argv) {
    const opts = { map: DEFAULT_MAP, root: ONE_ROOT, json: false, enforce: false, selftest: false, quiet: false }
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]
        if (a === '--map') opts.map = path.resolve(argv[++i] ?? '')
        else if (a === '--root') opts.root = path.resolve(argv[++i] ?? '')
        else if (a === '--json') opts.json = true
        else if (a === '--enforce') opts.enforce = true
        else if (a === '--selftest') opts.selftest = true
        else if (a === '--quiet') opts.quiet = true
        else if (a === '-h' || a === '--help') opts.help = true
        else throw new Error('未知参数: ' + a)
    }
    return opts
}

function readText(p) {
    try {
        return fs.readFileSync(p, 'utf8')
    } catch {
        return null
    }
}

let dsdProbe = null
function probeDsd() {
    if (dsdProbe) return dsdProbe
    dsdProbe = { open: false }
    try {
        const { DatabaseSync } = require('node:sqlite')
        const dbPath = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'decision.sqlite')
        if (!fs.existsSync(dbPath)) return dsdProbe
        const db = new DatabaseSync(dbPath, { readOnly: true })
        dsdProbe = {
            open: true,
            get: (id) => {
                try {
                    return db.prepare('SELECT id, revision, status FROM decisions WHERE id = ?').get(id) ?? null
                } catch {
                    return null
                }
            }
        }
    } catch {
        dsdProbe = { open: false }
    }
    return dsdProbe
}

function checkRegistration(d, did, ctx) {
    const { ledgerText, ledgerFrozen, dsd } = ctx
    // —— DSD- 号：只解析 DSD 侧（task-59）。台账已冻结/缺失都不影响这条分支 ——
    const fromId = dsdNumFromId(did)
    if (fromId !== null) {
        const declared = d?.dsd
        if (declared != null && norm(declared) !== '' && Number(declared) !== fromId) {
            return {
                code: 'E_DSD_ID_MISMATCH',
                msg: 'id=' + did + ' 与 dsd=' + declared + ' 不一致（DSD- 前缀号的 NNNN 必须与 dsd 字段同值；也可省掉 dsd 由 id 推导）'
            }
        }
        if (!dsd.open) return { skip: true }
        const row = dsd.get(fromId)
        if (!row) return { code: 'E_DSD_MISSING', msg: 'DSD 库（decision.sqlite）无 id=' + fromId }
        if (d.rev != null && Number(row.revision) !== Number(d.rev)) {
            return { code: 'E_DSD_REV_MISMATCH', msg: 'map rev=' + d.rev + ' 与 DSD id=' + fromId + ' 的 revision=' + row.revision + ' 不一致（决策已改版，条款需重新核对）' }
        }
        return {}
    }
    // —— D- 号：现行并集解析（台账冻结前查台账文本，冻结后查 DSD 库）——
    if (!ledgerText) return { skip: true }
    if (!ledgerFrozen) {
        return ledgerText.includes(did) ? {} : { code: 'E_DECISION_UNREGISTERED', msg: '台账里找不到该 D 号（' + LEDGER + '）' }
    }
    const id = Number(d?.dsd)
    if (!Number.isInteger(id) || id <= 0) {
        return { code: 'E_DSD_ID', msg: '台账已冻结（D-1903）⇒ 决策必须给 dsd（DSD decisions.id）' }
    }
    if (!dsd.open) return { skip: true }
    const row = dsd.get(id)
    if (!row) return { code: 'E_DSD_MISSING', msg: 'DSD 库（decision.sqlite）无 id=' + id }
    if (d.rev != null && Number(row.revision) !== Number(d.rev)) {
        return { code: 'E_DSD_REV_MISMATCH', msg: 'map rev=' + d.rev + ' 与 DSD id=' + id + ' 的 revision=' + row.revision + ' 不一致（决策已改版，条款需重新核对）' }
    }
    return {}
}

export function validate(map, opts = {}) {
    const root = opts.root ?? ONE_ROOT
    const violations = []
    const add = (code, where, msg) => violations.push({ code, where, msg })
    const fileCache = new Map()
    const readTest = (rel) => {
        if (!fileCache.has(rel)) fileCache.set(rel, readText(path.join(root, rel)))
        return fileCache.get(rel)
    }

    if (!map || typeof map !== 'object') {
        add('E_MAP_SHAPE', '-', '清单根必须是对象')
        return { violations, decisions: [], totals: { clauses: 0, covered: 0, pending: 0, notTestable: 0 }, ledger: 'absent' }
    }
    if (!Array.isArray(map.decisions) || map.decisions.length === 0) add('E_MAP_SHAPE', '-', 'decisions 必须是非空数组')
    if (!map.note) add('E_MAP_SHAPE', '-', '缺 note（写清 status 语义与路径约定）')

    const ledgerText = readText(path.join(root, LEDGER))
    const ledgerFrozen = ledgerText !== null && /起冻结|已冻结（D-1903）/.test(ledgerText)
    const dsd = probeDsd()
    const seen = new Set()
    const decisions = []
    const totals = { clauses: 0, covered: 0, pending: 0, notTestable: 0 }

    for (const d of map.decisions ?? []) {
        const did = norm(d?.id)
        const counts = { covered: 0, pending: 0, 'not-testable': 0 }
        if (!DECISION_ID_RE.test(did)) add('E_DECISION_ID', String(did), '决策号应为 D-<3~4 位数字>（历史台账号）或 DSD-<3~5 位数字>（DSD-1474 起的新裁定）')
        if (!Array.isArray(d?.clauses) || d.clauses.length === 0) add('E_NO_CLAUSES', did, '决策下必须有 clause')
        const reg = checkRegistration(d, did, { ledgerText, ledgerFrozen, dsd })
        if (reg.code) add(reg.code, did, reg.msg)

        for (const c of d?.clauses ?? []) {
            totals.clauses++
            const cid = norm(c?.id)
            const where = cid || did
            if (!cid) add('E_CLAUSE_ID', did, 'clause 缺 id')
            else if (seen.has(cid)) add('E_DUP_CLAUSE', cid, 'clause id 重复')
            else {
                seen.add(cid)
                // clause id 跟随决策 id 形态：<决策 id> 或 <决策 id>/<子标签>（task-59）
                if (did && cid !== did && !cid.startsWith(did + '/')) {
                    add('E_CLAUSE_ID_PREFIX', cid, 'clause id 必须以决策 id（' + did + '）开头，如 ' + did + '/1')
                }
            }
            if (!norm(c?.text)) add('E_CLAUSE_TEXT', where, 'clause 缺 text（条款正文摘要）')
            const status = norm(c?.status)
            if (!STATUSES.includes(status)) {
                add('E_STATUS_UNKNOWN', where, 'status 必须是 covered | pending | not-testable，实为 ' + JSON.stringify(c?.status))
                continue
            }
            counts[status]++
            const file = norm(c?.file)
            const title = norm(c?.title)

            if (status === 'covered') {
                totals.covered++
                if (!file) add('E_COVERED_NO_FILE', where, 'covered 必须给 file')
                if (!title) add('E_COVERED_NO_TITLE', where, 'covered 必须给 title（用例标题子串）')
                if (!norm(c?.assert)) add('E_COVERED_NO_ASSERT', where, 'covered 必须给 assert（断言锚点子串）')
                if (file && !isAllowedPath(file)) add('E_PATH_OUTSIDE', where, 'file 必须落在 ' + TEST_PREFIXES.join(' | ') + ' 内，实为 ' + file)
                if (file && /(^|\/)(\.tmp|\.local|node_modules)\//.test(file)) add('E_PATH_OUTSIDE', where, '禁止指向临时/副本目录（会误绿）：' + file)
                if (file && !isTestFilePath(file)) add('E_NOT_TEST_FILE', where, 'file 必须是 *.{spec,test}.[cm]?[jt]sx? 或 *Test.java：' + file)
                if (file && title) {
                    const body = readTest(file)
                    if (body === null) add('E_FILE_MISSING', where, '测试文件不存在：' + file)
                    else {
                        const nb = norm(body)
                        if (!nb.includes(title)) add('E_TITLE_MISSING', where, '在 ' + file + ' 里找不到用例标题：' + title)
                        const assert = norm(c?.assert)
                        if (assert && !nb.includes(assert)) add('E_ASSERT_MISSING', where, '在 ' + file + ' 里找不到断言锚点：' + assert)
                        // task-173：*Test.java 的命名不足以说明它是判据 —— 抽象基类（AbstractIntegrationTest）
                        // 也叫这个名字。要求真有一条 @Test，否则按「非测试文件」报。
                        if (JAVA_TEST_FILE_RE.test(file) && !JAVA_ANNOTATION_RE.test(body)) {
                            add('E_NOT_TEST_FILE', where, 'file 以 Test.java 结尾但没有任何 @Test 注解（抽象基类/夹具不是判据）：' + file)
                        }
                    }
                }
            } else if (status === 'pending') {
                totals.pending++
                if (!norm(c?.card)) add('E_PENDING_NO_CARD', where, 'pending 必须给 card（承接卡号）')
                if (file && !title) add('E_PENDING_NO_TITLE', where, 'pending 给了 file 就必须给 title（预期落点）')
                if (file && !isAllowedPath(file)) add('E_PATH_OUTSIDE', where, 'file 必须落在 ' + TEST_PREFIXES.join(' | ') + ' 内，实为 ' + file)
            } else {
                totals.notTestable++
                const reason = norm(c?.reason)
                if (reason.length < NT_REASON_MIN) add('E_NT_NO_REASON', where, 'not-testable 必须给 reason（≥' + NT_REASON_MIN + ' 字），说明为何无渲染/DOM 可判属性')
                if (file || title) add('E_NT_HAS_TARGET', where, 'not-testable 不应给 file/title')
            }
        }
        decisions.push({ id: did, rev: d?.rev, clauses: (d?.clauses ?? []).length, ...counts })
    }

    const ratio = totals.clauses ? totals.notTestable / totals.clauses : 0
    if (ratio > NT_RATIO_MAX) {
        add('E_NT_RATIO', '-', 'not-testable ' + totals.notTestable + '/' + totals.clauses + ' = ' + (ratio * 100).toFixed(1) + '%，上限 ' + NT_RATIO_MAX * 100 + '%')
    }
    return { violations, decisions, totals, ledger: ledgerText ? (ledgerFrozen ? 'frozen' : 'found') : 'absent', dsd: dsd.open ? 'open' : 'unreadable', ratio }
}

function report(res, opts) {
    const { totals } = res
    const pct = (n) => (totals.clauses ? ((n / totals.clauses) * 100).toFixed(1) : '0.0') + '%'
    const lines = []
    lines.push(TOOL + '  ' + path.relative(ONE_ROOT, opts.map).replace(/\\/g, '/'))
    lines.push('  条款 ' + totals.clauses + ' 条 / 决策 ' + res.decisions.length + ' 个  ⇒ covered ' + totals.covered + ' (' + pct(totals.covered) + ') · pending ' + totals.pending + ' (' + pct(totals.pending) + ') · not-testable ' + totals.notTestable + ' (' + pct(totals.notTestable) + '，上限 20%)')
    for (const d of res.decisions) {
        lines.push('  ' + (d.id || '?') + ' rev' + (d.rev ?? '?') + '  ' + String(d.clauses).padStart(2) + ' 条  covered ' + d.covered + '  pending ' + d.pending + '  not-testable ' + d['not-testable'])
    }
    if (res.ledger === 'absent') lines.push('  SKIP 台账缺失（' + LEDGER + '），未校验 D 号登记')
    else if (res.ledger === 'frozen' && res.dsd === 'unreadable') lines.push('  SKIP DSD 库不可读，仅校验 decisions[].dsd 字段存在')
    else if (res.ledger === 'frozen') lines.push('  台账已冻结（D-1903）⇒ D 号登记按 DSD 库核对（id + revision）；DSD- 号只解析 DSD 侧，不做台账查重（task-59）')
    if (res.violations.length) {
        lines.push('  违规 ' + res.violations.length + ' 条：')
        for (const v of res.violations) lines.push('    [' + v.code + '] ' + v.where + ' — ' + v.msg)
    } else {
        lines.push('  违规 0 条')
    }
    if (totals.pending > 0) {
        lines.push('  pending ' + totals.pending + ' 条' + (opts.enforce ? '（--enforce ⇒ 判红）' : '（report-only，--enforce 时判红）'))
    }
    return lines.join('\n')
}

function selftest() {
    const mapText = readText(DEFAULT_MAP)
    if (mapText === null) {
        console.log(TOOL + ' --selftest: 读不到清单 ' + DEFAULT_MAP)
        return 2
    }
    const base = JSON.parse(mapText)
    const clone = () => JSON.parse(JSON.stringify(base))
    const findCovered = (m, i = 0) => {
        const out = []
        for (const d of m.decisions) for (const c of d.clauses) if (c.status === 'covered') out.push(c)
        return out[i]
    }
    const findStatus = (m, st) => {
        for (const d of m.decisions) for (const c of d.clauses) if (c.status === st) return c
        return null
    }
    const has = (res, code) => res.violations.some((v) => v.code === code)
    // 产品树内容漂移（并行在飞卡正在改 ui-baseline.spec.ts 一类的 spec）不该让「这条路径/这个形态能不能登记」
    // 的逻辑判定染红：内容类违规由门自身 exit 1 逐条承担，selftest 只判清单结构与登记判据。
    // 三类「测试文件里的子串对不上」= 内容漂移；其余（结构/登记/越界/比例）= 逻辑，一律判红。
    const DRIFT_CODES = new Set(['E_TITLE_MISSING', 'E_ASSERT_MISSING', 'E_FILE_MISSING'])
    const onlyDrift = (r) => r.violations.every((v) => DRIFT_CODES.has(v.code))
    const cases = []
    const run = (name, mutate, expect) => {
        const m = clone()
        mutate?.(m)
        const res = validate(m, { root: ONE_ROOT })
        const ok = expect(res)
        cases.push({ name, ok, violations: res.violations.map((v) => v.code + ':' + v.where) })
    }
    // 正向类用例用 onlyDrift 而不是「0 违规」：留痕（末尾打印漂移条数）但不让并行卡染色判定。
    // 漂移读数取**未变异**的基线清单，不掺本自检自己制造的 title/assert 错。
    const baseDrift = validate(clone(), { root: ONE_ROOT }).violations.filter((v) => DRIFT_CODES.has(v.code)).length
    run('基线绿（清单结构；产品树内容漂移不影响本判定）', null, (r) => onlyDrift(r))
    run('covered title 改错', (m) => { findCovered(m).title = '__不存在的用例标题__' }, (r) => has(r, 'E_TITLE_MISSING'))
    run('covered assert 改错', (m) => { findCovered(m).assert = '__不存在的断言锚点__' }, (r) => has(r, 'E_ASSERT_MISSING'))
    run('pending 缺 card', (m) => { delete findStatus(m, 'pending').card }, (r) => has(r, 'E_PENDING_NO_CARD'))
    run('not-testable 缺 reason', (m) => { delete findStatus(m, 'not-testable').reason }, (r) => has(r, 'E_NT_NO_REASON'))
    run('clause id 重复', (m) => { const c = findCovered(m, 1); c.id = findCovered(m, 0).id }, (r) => has(r, 'E_DUP_CLAUSE'))
    run('路径越界（.tmp 副本）', (m) => { const c = findCovered(m); c.file = '.tmp/ui-gates/copy/focusRingLayer.spec.ts' }, (r) => has(r, 'E_PATH_OUTSIDE'))
    run('not-testable 比例超 20%', (m) => {
        let n = 0
        for (const d of m.decisions) for (const c of d.clauses) {
            if (c.status === 'covered' && n < 9) { c.status = 'not-testable'; c.reason = '自检占位：设计取向陈述无渲染可判属性'; delete c.file; delete c.title; delete c.assert; n++ }
        }
    }, (r) => has(r, 'E_NT_RATIO'))
    // —— task-53：file 白名单四类（正向逐类各一例）+ 越界/缺文件/DSD 号不存在反例 ——
    // 定位判据：白名单不是「路径里出现 test 就算」，而是「这条条款的测试住在它该住的目录里」。
    // 每加一类前缀就必须有一条正向用例钉住它真的能登记，同时留一条「没开放的前缀仍然红」。
    const pointTo = (m, file, title, assert) => { const c = findCovered(m); c.file = file; c.title = title; c.assert = assert }
    run('白名单：A12 tests/** 可登记', (m) => {
        pointTo(m, 'A12-arbiter/packages/arbiter/tests/host/tools.test.mjs', 'T2.1: the six tools register in contract order with distinct names', 'distinct names')
    }, (r) => onlyDrift(r))
    run('白名单：internal/A03-xihe/scripts/** 可登记', (m) => {
        pointTo(m, 'internal/A03-xihe/scripts/trace-check.test.mjs', 'task-44: missing projection + working exporter => auto-regenerate once, then exit clean', '投影缺失，已自动重生成')
    }, (r) => onlyDrift(r))
    run('白名单：scripts/** 可登记', (m) => {
        pointTo(m, 'scripts/check-commit-msg.test.mjs', '③-d 投影缺失（默认落点）+ 导出器可用 ⇒ 自动重生成一次、exit 0，且真的写出投影', '投影缺失，已自动重生成')
    }, (r) => onlyDrift(r))
    run('白名单外：A03-xihe/scripts/**（未开放）仍红', (m) => {
        pointTo(m, 'A03-xihe/scripts/check-decision-test-map.mjs', 'x', 'x')
    }, (r) => has(r, 'E_PATH_OUTSIDE'))
    // —— task-173：CP（Java）面五例。放宽的是「CP 的判据能登记进来」，不是「凡 Java 都算判据」——
    // 每个正向都配一条反例（夹具 / 抽象基类 / src/main），否则这次放宽就是把判据换成路径长相。
    const CP = 'A03-xihe/packages/control-plane/src/test/java/com/cc01cc/p/xihe/cp'
    run('白名单：CP *Test.java 可登记（task-173）', (m) => {
        pointTo(m, CP + '/config/OrgUnitRootSeedIntegrationTest.java',
            'aBootedDatabaseHasTheRootUnitAndTheAdminIsPlacedInIt',
            'V167 must have created the root unit')
    }, (r) => onlyDrift(r) && !has(r, 'E_NOT_TEST_FILE'))
    run('CP 夹具 *Fixture.java 仍拒（不因放宽前缀而变判据）', (m) => {
        pointTo(m, CP + '/integration/WorkspaceFixture.java', 'x', 'x')
    }, (r) => has(r, 'E_NOT_TEST_FILE'))
    run('CP 抽象基类 *Test.java（无 @Test）仍拒', (m) => {
        pointTo(m, CP + '/AbstractIntegrationTest.java', 'x', 'x')
    }, (r) => has(r, 'E_NOT_TEST_FILE'))
    run('CP src/main/** 仍越界（前缀止于 src/test/）', (m) => {
        pointTo(m, 'A03-xihe/packages/control-plane/src/main/java/com/cc01cc/p/xihe/cp/config/DataSeeder.java', 'x', 'x')
    }, (r) => has(r, 'E_PATH_OUTSIDE'))
    run('JS/TS 老路径回归：ui spec 仍可登记（口径未动）', (m) => {
        pointTo(m, 'A03-xihe/packages/ui/src/features/workspace/chat/__tests__/sessionSettingsExpandedUnique.spec.ts',
            'desktop: the summary row is the only activate-able node in the family',
            '会话设置入口应为 1 个且必须是 session-settings-summary')
    }, (r) => onlyDrift(r) && !has(r, 'E_PATH_OUTSIDE') && !has(r, 'E_NOT_TEST_FILE'))
    run('covered 指向不存在的测试文件 ⇒ 红', (m) => {
        pointTo(m, 'scripts/__no-such-test__.test.mjs', 'x', 'x')
    }, (r) => has(r, 'E_FILE_MISSING'))
    run('登记了 DSD 库不存在的号 ⇒ 红', (m) => {
        m.decisions.push({ id: 'D-9999', rev: 1, dsd: 999999, clauses: [{ id: 'D-9999/1', text: '自检占位条款', status: 'pending', card: 'task-53' }] })
    }, (r) => has(r, 'E_DSD_MISSING'))
    // —— task-59：DSD- 号形态（正向 + 三条反向）——
    // 夹具用清单里**没有**的号（DSD-1470 rev1 真在库里），否则会撞上真实条目的 clause id。
    // 正向钉「新裁定真能登记进来」：省略 dsd 由 id 推导、clause 指向真存在的 covered 判据。
    run('DSD-NNNN 号可登记（省略 dsd 由 id 推导）', (m) => {
        m.decisions.push({
            id: 'DSD-1470', rev: 1,
            clauses: [{
                id: 'DSD-1470/1', text: '自检占位条款（真实条目见清单）', status: 'covered',
                file: 'A03-xihe/packages/ui/src/features/workspace/chat/__tests__/sessionSettingsExpandedUnique.spec.ts',
                title: 'desktop: the summary row is the only activate-able node in the family',
                assert: '会话设置入口应为 1 个且必须是 session-settings-summary'
            }]
        })
    }, (r) => onlyDrift(r))
    run('DSD-NNNN 与 dsd 字段不一致 ⇒ E_DSD_ID_MISMATCH', (m) => {
        m.decisions.push({ id: 'DSD-1470', rev: 1, dsd: 1463, clauses: [{ id: 'DSD-1470/1', text: '自检占位条款', status: 'pending', card: 'task-59' }] })
    }, (r) => has(r, 'E_DSD_ID_MISMATCH'))
    // 反向钉「两个登记处互不判红」：台账文本里根本没有 DSD-1470 这个字面（台账是 D-#### 号段），
    // 若哪天有人给 DSD- 号补一条「须在台账命中」的判据，这条会立刻红。
    run('DSD-NNNN 号不被台账判红（两个登记处互不查重）', (m) => {
        m.decisions.push({ id: 'DSD-1470', rev: 1, clauses: [{ id: 'DSD-1470/1', text: '自检占位条款', status: 'pending', card: 'task-59' }] })
    }, (r) => !r.violations.some((v) => v.code === 'E_DECISION_UNREGISTERED'))
    // 反向钉 clause id 前缀判据（否则改了决策号而 clause 号没跟，只能靠人眼发现）
    run('clause id 不以决策 id 开头 ⇒ E_CLAUSE_ID_PREFIX', (m) => {
        findCovered(m).id = 'D-9999/1'
    }, (r) => has(r, 'E_CLAUSE_ID_PREFIX'))
    if (baseDrift > 0) {
        console.log('  NOTE  产品树内容漂移 ' + baseDrift + ' 条（基线清单上测试文件里的 title/assert 对不上；由门 exit 1 逐条报出，本自检不因此判红）')
    }
    let failed = 0
    for (const c of cases) {
        if (!c.ok) failed++
        console.log((c.ok ? '  PASS  ' : '  FAIL  ') + c.name + (c.ok ? '' : '  ← ' + (c.violations.join(', ') || '无违规')))
    }
    console.log(TOOL + ' --selftest: ' + (cases.length - failed) + '/' + cases.length + ' 通过')
    return failed === 0 ? 0 : 1
}

function main() {
    let opts
    try {
        opts = parseArgs(process.argv.slice(2))
    } catch (e) {
        console.error(TOOL + ': ' + e.message)
        return 2
    }
    if (opts.help) {
        console.log('用法: node scripts/check-decision-test-map.mjs [--map <json>] [--root <one 根>] [--json] [--enforce] [--selftest] [--quiet]')
        return 0
    }
    if (opts.selftest) return selftest()

    const text = readText(opts.map)
    if (text === null) {
        console.error(TOOL + ': 读不到清单 ' + opts.map)
        return 2
    }
    let map
    try {
        map = JSON.parse(text)
    } catch (e) {
        console.error(TOOL + ': 清单 JSON 解析失败 — ' + e.message)
        return 2
    }
    const res = validate(map, { root: opts.root })
    if (opts.json) {
        console.log(JSON.stringify({ tool: TOOL, map: opts.map, ...res }, null, 2))
    } else if (!opts.quiet) {
        console.log(report(res, opts))
    }
    const red = res.violations.length > 0 || (opts.enforce && res.totals.pending > 0)
    return red ? 1 : 0
}

process.exit(main())
