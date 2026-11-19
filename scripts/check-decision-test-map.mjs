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
 *   5) file 必须落在 A03-xihe/packages/ui/ 内且是测试文件（禁止 .tmp/.local 副本误绿）
 *   6) D 号登记：台账未冻结 ⇒ 须在 lead-decisions-ledger.md 命中；台账已冻结（D-1903 起登记处迁 DSD）
 *      ⇒ 须给 decisions[].dsd（DSD decisions.id），并尽力核对 revision（库不可读则 SKIP 不判红）
 *
 * 用法：
 *   node scripts/check-decision-test-map.mjs [--map <json>] [--root <one 根>]
 *        [--json] [--enforce] [--selftest] [--quiet]
 *   --enforce  追加「pending > 0 即红」（条款全部落地后的严格档）
 *   --selftest 内存内 8 例自检（基线绿 / title 错 / assert 错 / pending 缺 card /
 *              not-testable 缺 reason / clause id 重复 / 路径越界 / 比例超限）
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
const TEST_PREFIX = 'A03-xihe/packages/ui/'
const TEST_FILE_RE = /\.(spec|test)\.[cm]?[jt]sx?$/
const NT_RATIO_MAX = 0.2
const NT_REASON_MIN = 10
const STATUSES = ['covered', 'pending', 'not-testable']

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
    } catch (e) {
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
                } catch (e) {
                    return null
                }
            }
        }
    } catch (e) {
        dsdProbe = { open: false }
    }
    return dsdProbe
}

function checkRegistration(d, did, ctx) {
    const { ledgerText, ledgerFrozen, dsd } = ctx
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
        if (!/^D-\d{3,4}$/.test(did)) add('E_DECISION_ID', String(did), 'D 号格式应为 D-<3~4 位数字>')
        if (!Array.isArray(d?.clauses) || d.clauses.length === 0) add('E_NO_CLAUSES', did, '决策下必须有 clause')
        const reg = checkRegistration(d, did, { ledgerText, ledgerFrozen, dsd })
        if (reg.code) add(reg.code, did, reg.msg)

        for (const c of d?.clauses ?? []) {
            totals.clauses++
            const cid = norm(c?.id)
            const where = cid || did
            if (!cid) add('E_CLAUSE_ID', did, 'clause 缺 id')
            else if (seen.has(cid)) add('E_DUP_CLAUSE', cid, 'clause id 重复')
            else seen.add(cid)
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
                if (file && !file.startsWith(TEST_PREFIX)) add('E_PATH_OUTSIDE', where, 'file 必须落在 ' + TEST_PREFIX + ' 内，实为 ' + file)
                if (file && /(^|\/)(\.tmp|\.local|node_modules)\//.test(file)) add('E_PATH_OUTSIDE', where, '禁止指向临时/副本目录（会误绿）：' + file)
                if (file && !TEST_FILE_RE.test(file)) add('E_NOT_TEST_FILE', where, 'file 必须是 *.{spec,test}.[cm]?[jt]sx?：' + file)
                if (file && title) {
                    const body = readTest(file)
                    if (body === null) add('E_FILE_MISSING', where, '测试文件不存在：' + file)
                    else {
                        const nb = norm(body)
                        if (!nb.includes(title)) add('E_TITLE_MISSING', where, '在 ' + file + ' 里找不到用例标题：' + title)
                        const assert = norm(c?.assert)
                        if (assert && !nb.includes(assert)) add('E_ASSERT_MISSING', where, '在 ' + file + ' 里找不到断言锚点：' + assert)
                    }
                }
            } else if (status === 'pending') {
                totals.pending++
                if (!norm(c?.card)) add('E_PENDING_NO_CARD', where, 'pending 必须给 card（承接卡号）')
                if (file && !title) add('E_PENDING_NO_TITLE', where, 'pending 给了 file 就必须给 title（预期落点）')
                if (file && !file.startsWith(TEST_PREFIX)) add('E_PATH_OUTSIDE', where, 'file 必须落在 ' + TEST_PREFIX + ' 内，实为 ' + file)
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
    else if (res.ledger === 'frozen') lines.push('  台账已冻结（D-1903）⇒ D 号登记按 DSD 库核对（id + revision）')
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
    const cases = []
    const run = (name, mutate, expect) => {
        const m = clone()
        mutate?.(m)
        const res = validate(m, { root: ONE_ROOT })
        const ok = expect(res)
        cases.push({ name, ok, violations: res.violations.map((v) => v.code + ':' + v.where) })
    }
    run('基线绿', null, (r) => r.violations.length === 0)
    run('covered title 改错', (m) => { findCovered(m).title = '__不存在的用例标题__' }, (r) => has(r, 'E_TITLE_MISSING'))
    run('covered assert 改错', (m) => { findCovered(m).assert = '__不存在的断言锚点__' }, (r) => has(r, 'E_ASSERT_MISSING'))
    run('pending 缺 card', (m) => { delete findStatus(m, 'pending').card }, (r) => has(r, 'E_PENDING_NO_CARD'))
    run('not-testable 缺 reason', (m) => { delete findStatus(m, 'not-testable').reason }, (r) => has(r, 'E_NT_NO_REASON'))
    run('clause id 重复', (m) => { const c = findCovered(m, 1); c.id = findCovered(m, 0).id }, (r) => has(r, 'E_DUP_CLAUSE'))
    run('路径越界（.tmp 副本）', (m) => { const c = findCovered(m); c.file = '.tmp/ui-gates/copy/focusRingLayer.spec.ts' }, (r) => has(r, 'E_PATH_OUTSIDE'))
    run('not-testable 比例超 20%', (m) => {
        let n = 0
        for (const d of m.decisions) for (const c of d.clauses) {
            if (c.status === 'covered' && n < 8) { c.status = 'not-testable'; c.reason = '自检占位：设计取向陈述无渲染可判属性'; delete c.file; delete c.title; delete c.assert; n++ }
        }
    }, (r) => has(r, 'E_NT_RATIO'))
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
