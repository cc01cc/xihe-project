/**
 * gate-screenshot-preflight（拍图前置门，task-2 / 原 task-97）的用例。
 *
 * <p><b>为什么用例里必须有一条「变异腿」和一条「pass 腿」</b>：本门的全部意义是
 * 「未检查不许当 pass」。只证明它敢报错是不够的 —— 一个永远报错的门也能通过那种用例。
 * 所以每条判据都成对出现：能 pass 的那条证明门没被写死成红色，报错的那几条证明它咬得住。</p>
 *
 * <p>夹具里的 commit 是<b>真 sha</b>（不是编的）：</p>
 * <ul>
 *   <li>0cfd5304d 的 packages/control-plane 子树 = 1b4d1d75…（HEAD 那笔改了 CP）；</li>
 *   <li>d24b153ba 及更早 = fdd302bf…（同一棵树，只动了 UI/runtime/测试）。</li>
 * </ul>
 * <p>所以「behind&gt;0 但 treeVerdict=equal」这条能用真实历史造出来（判据④：behind&gt;0 不是失败），
 * 不用给门塞后门开关。</p>
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { CODES, GATES, validateReceipt } from "./lib/gate-receipt.mjs";
import { evaluate, overlapOf } from "./gate-screenshot-preflight.mjs";

/** evaluate() 直调的最小 opts（CLI parseArgs 的产物形状；command 必须非空否则自校 E_SCHEMA）。 */
const evalOpts = (fx, extra = {}) => ({
    stack: "stack-2",
    pages: ["WorkspaceView.vue"],
    stackStatus: fx,
    command: "node scripts/gate-screenshot-preflight.test.mjs (evaluate 直调)",
    ...extra,
});

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "gate-screenshot-preflight.mjs");
const TMP = mkdtempSync(join(tmpdir(), "xh-preflight-"));
process.on("exit", () => {
    try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 清不掉不影响判据 */ }
});

/* 真实 sha（2026-11-16 19:2x 实测） */
const HEAD_CP_CHANGED = "0cfd5304d0ab6f5f386e6c8e8b549edd071164a6"; // CP 子树 1b4d1d75…
const PREV_CP_SAME = "d24b153ba941ae6c3125fdbcdd5b969134ef1fb3";    // CP 子树 fdd302bf…
const OLDER_CP_SAME = "001bb9d16f787824bcb803abe1497c4fa3b6e3e2";   // 同上（比 PREV 更老一笔）

const PORTS = { cp: 12641, runtime: 12643, agent: 12642, ui: 12640 };

function serviceRow(service, { status = 200, listening = true } = {}) {
    return {
        service,
        port: PORTS[service],
        listening,
        alive: listening,
        ready: listening && status === 200,
        httpStatus: listening ? status : null,
        pid: 1000 + PORTS[service],
    };
}

/** 一个栈的 dev-stack status 行（形状取自 scripts/dev-stack.mjs status --all --json 实测）。 */
function stackRow({ stackId = "stack-2", cpBuild = {}, services = null, ...rest } = {}) {
    return {
        stackId,
        ok: true,
        ...rest, // 允许用例在**行上**塞一个「戳」（例如 treeVerdict: "equal"）来验伪造检测
        cpBuild: {
            runningCommit: PREV_CP_SAME,
            headCommit: PREV_CP_SAME,
            behind: 0,
            stale: false,
            verdict: "fresh",
            builtAt: "2026-11-16T10:41:38.914Z",
            dirty: false,
            ...cpBuild,
        },
        services: services ?? Object.keys(PORTS).map((s) => serviceRow(s)),
    };
}

function writeFixture(name, rows) {
    const p = join(TMP, name + ".json");
    writeFileSync(p, JSON.stringify({ stacks: rows }, null, 2) + "\n");
    return p;
}

/** 跑一次门（子进程，走真实入口：参数解析 + 退出码 + stdout 一起覆盖）。 */
function runGate(args) {
    const r = spawnSync(process.execPath, [SCRIPT, ...args, "--json", "--no-write"], {
        encoding: "utf8",
        timeout: 120000,
    });
    const stdout = r.stdout ?? "";
    const start = stdout.indexOf("{");
    let receipt = null;
    if (start >= 0) {
        try { receipt = JSON.parse(stdout.slice(start)); } catch { receipt = null; }
    }
    return { exitCode: r.status, receipt, stdout, stderr: r.stderr ?? "" };
}

/* ───────────────── ① pass 腿：behind&gt;0 + treeVerdict=equal 必须 PASS ───────────────── */

test("pass 腿：behind>0 但 CP 子树与 HEAD 一致 + 4 服务 200 ⇒ pass（behind 不是失败）", () => {
    // running=001bb9d16（子树 fdd302bf）比 head=d24b153ba（子树 fdd302bf）老一笔 ⇒ behind=1 且 equal
    const fx = writeFixture("pass", [
        stackRow({ cpBuild: { runningCommit: OLDER_CP_SAME, headCommit: PREV_CP_SAME, behind: 1, stale: true, verdict: "stale" } }),
    ]);
    const { exitCode, receipt, stdout } = runGate(["--pages", "WorkspaceMembersView.vue", "--stack-status", fx]);
    assert.equal(exitCode, 0, "pass 腿必须 exit 0（收到 " + exitCode + "）");
    assert.equal(receipt.verdict, "pass");
    assert.equal(receipt.code, "OK");
    assert.equal(receipt.numbers.treeVerdict, "equal");
    assert.equal(receipt.numbers.behind, 1);
    // numbers 齐全（卡面要求的六个字段）
    for (const k of ["treeVerdict", "behind", "head", "builtAt", "servicesReady", "dirtyCount"]) {
        assert.ok(k in receipt.numbers, "numbers 缺 " + k);
    }
    assert.equal(receipt.numbers.head, PREV_CP_SAME);
    assert.equal(receipt.numbers.servicesReady, "4/4");
    assert.equal(typeof receipt.numbers.dirtyCount, "number");
    // T-2327 树态稳健化：不再假设「所审页面此刻恰好在脏树里」（旧断言 :113 是环境态红的根源，
    // 8673077e0 因此把本文件登记 EXCLUDED）。改为与**现场脏树对账**的恒真不变量：
    // 脏树里有该页 ⇒ 必须记进交集；没有 ⇒ 交集必须为 0。两种树态下都成立，且仍能抓「漏记交集」。
    // 命中口径必须与门的 overlapOf 完全一致（等值/后缀/子串三写法，宁可多报）——
    // 只按后缀判会在「探针文件名内嵌页面名」这类子串命中形态下造出测试自身的假红。
    const q = "workspacemembersview.vue";
    const dirtyHasPage = (receipt.numbers.dirtyPaths ?? []).some((p) => {
        const n = p.replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();
        return n === q || n.endsWith("/" + q) || n.includes(q);
    });
    if (dirtyHasPage) {
        assert.ok(receipt.numbers.dirtyOverlapCount >= 1, "所审页面在脏树里却没记交集");
    } else {
        assert.equal(receipt.numbers.dirtyOverlapCount, 0, "所审页面不在脏树里却记了交集");
    }
    // T-2327②：夹具腿豁免 head 比对，但必须显式留痕 headVerified:false（豁免≠验过）
    assert.equal(receipt.numbers.liveStatus, false);
    assert.equal(receipt.numbers.headVerified, false, "夹具腿必须写 headVerified:false");
    assert.ok(validateReceipt(receipt).ok, "receipt 必须过 task-93 的 validateReceipt");

    // 同一份 stdout 喂给 task-93 的门表解析器：reader 不会判它假绿
    const parsed = GATES["screenshot-preflight"].parse(stdout);
    assert.equal(parsed.parsed, true);
    assert.ok(parsed.executed.checks > 0, "executed.checks 必须正数，否则 reader 判假绿");
});

/* ───────────────── ② 变异腿 1：treeVerdict != equal ⇒ error ───────────────── */

test("变异腿：running 是 HEAD 的祖先但 CP 子树已变 ⇒ error E_CP_NOT_AT_HEAD", () => {
    const fx = writeFixture("differs", [
        stackRow({ cpBuild: { runningCommit: PREV_CP_SAME, headCommit: HEAD_CP_CHANGED, behind: 1, stale: true, verdict: "stale" } }),
    ]);
    const { exitCode, receipt } = runGate(["--pages", "WorkspaceView.vue", "--stack-status", fx]);
    assert.equal(exitCode, 2);
    assert.equal(receipt.verdict, "error");
    assert.equal(receipt.code, "E_CP_NOT_AT_HEAD");
    assert.equal(receipt.numbers.treeVerdict, "differs");
});

test("变异腿：子树哈希读不出（rev 不在库）⇒ unverified ⇒ error，不许当 pass", () => {
    const fx = writeFixture("unverified", [
        stackRow({ cpBuild: { runningCommit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", headCommit: HEAD_CP_CHANGED, behind: 3, stale: true, verdict: "stale" } }),
    ]);
    const { receipt } = runGate(["--pages", "WorkspaceView.vue", "--stack-status", fx]);
    assert.equal(receipt.verdict, "error");
    assert.equal(receipt.code, "E_CP_NOT_AT_HEAD");
    assert.equal(receipt.numbers.treeVerdict, "unverified");
});

/* ───────────────── ③ 变异腿 2：伪造的 equal 戳 ⇒ error ───────────────── */

test("变异腿：输入自称 treeVerdict=equal 而现算是 differs ⇒ error E_FORGED_STAMP", () => {
    const fx = writeFixture("forged", [
        stackRow({
            treeVerdict: "equal", // ← 伪造的戳：不许被采信
            cpBuild: { runningCommit: PREV_CP_SAME, headCommit: HEAD_CP_CHANGED, behind: 1, stale: true, verdict: "stale" },
        }),
    ]);
    const { receipt } = runGate(["--pages", "WorkspaceView.vue", "--stack-status", fx]);
    assert.equal(receipt.verdict, "error");
    assert.equal(receipt.code, "E_FORGED_STAMP", "伪造的 equal 戳必须报 E_FORGED_STAMP");
    assert.equal(receipt.numbers.treeVerdict, "differs", "现算结论必须盖过输入里的戳");
});

/* ───────────────── ④ 变异腿 3：服务 / 栈 / 输入 的「未检查」 ───────────────── */

test("变异腿：4 服务里有一个 http!=200、一个连服务行都没有 ⇒ E_STACK_NOT_READY", () => {
    const fx = writeFixture("svc-down", [
        stackRow({
            services: [
                serviceRow("cp"),
                serviceRow("agent"),
                serviceRow("ui", { status: 500 }),
                // runtime 行故意不给 = 「没检查」
            ],
        }),
    ]);
    const { receipt } = runGate(["--pages", "WorkspaceView.vue", "--stack-status", fx]);
    assert.equal(receipt.verdict, "error");
    assert.equal(receipt.code, "E_STACK_NOT_READY");
    assert.equal(receipt.numbers.servicesReady, "2/4");
    assert.match(receipt.reason, /runtime/);
    assert.match(receipt.reason, /ui/);
});

test("变异腿：一个不存在的栈 ⇒ E_STACK_NOT_FOUND（不是 pass）", () => {
    const fx = writeFixture("one-stack", [stackRow()]);
    const { receipt } = runGate(["--pages", "WorkspaceView.vue", "--stack", "stack-9", "--stack-status", fx]);
    assert.equal(receipt.verdict, "error");
    assert.equal(receipt.code, "E_STACK_NOT_FOUND");
});

test("变异腿：没给 --pages ⇒ E_NO_PAGES（交集没检查就不许 pass）", () => {
    const fx = writeFixture("no-pages", [
        stackRow({ cpBuild: { runningCommit: OLDER_CP_SAME, headCommit: PREV_CP_SAME, behind: 1, stale: true, verdict: "stale" } }),
    ]);
    const { receipt } = runGate(["--stack-status", fx]);
    assert.equal(receipt.verdict, "error");
    assert.equal(receipt.code, "E_NO_PAGES");
});

test("变异腿：状态读不出（坏 JSON）⇒ E_STATUS_UNREADABLE", () => {
    const bad = join(TMP, "broken.json");
    writeFileSync(bad, "{ this is not json\n");
    const { receipt } = runGate(["--pages", "WorkspaceView.vue", "--stack-status", bad]);
    assert.equal(receipt.verdict, "error");
    assert.equal(receipt.code, "E_STATUS_UNREADABLE");
});

/* ───────────────── ⑤ schema：每条腿的 receipt 都过 validateReceipt ───────────────── */

test("schema：所有腿的 receipt 都过 validateReceipt 且不触发假绿", () => {
    const fx = writeFixture("schema", [
        stackRow({ cpBuild: { runningCommit: OLDER_CP_SAME, headCommit: PREV_CP_SAME, behind: 1, stale: true, verdict: "stale" } }),
    ]);
    const legs = [
        ["--pages", "WorkspaceView.vue", "--stack-status", fx],
        ["--pages", "WorkspaceView.vue", "--stack", "stack-9", "--stack-status", fx],
        ["--stack-status", fx],
    ];
    for (const args of legs) {
        const { receipt } = runGate(args);
        const v = validateReceipt(receipt);
        assert.ok(v.ok, "receipt 不合 schema：" + v.problems.join("; ") + "  args=" + args.join(" "));
        assert.equal(receipt.gate, "screenshot-preflight");
        assert.equal(receipt.schemaVersion, 1);
        assert.ok(receipt.command.includes("gate-screenshot-preflight.mjs"), "command 必须能复现");
    }
});

/* ───────────────── ⑥ T-2327①：cpBuild.verdict=dirty ⇒ E_CP_DIRTY（BL-325 口径） ───────────────── */

test("T-2327 变异腿：cpBuild.verdict=dirty（commit==HEAD、treeVerdict=equal）⇒ error E_CP_DIRTY，绝不按 stale", () => {
    // dirty 的典型形态：running==head ⇒ 现算 treeVerdict=equal（same-commit 短路）。
    // 旧门只看 treeVerdict ⇒ 这种「构建时树脏」的 CP 会漏成 pass —— 本腿钉住它必须红。
    const fx = writeFixture("cp-dirty", [
        stackRow({ cpBuild: { runningCommit: PREV_CP_SAME, headCommit: PREV_CP_SAME, behind: 0, stale: false, verdict: "dirty", dirty: true } }),
    ]);
    const { exitCode, receipt } = runGate(["--pages", "WorkspaceView.vue", "--stack-status", fx]);
    assert.equal(exitCode, 2);
    assert.equal(receipt.verdict, "error");
    assert.equal(receipt.code, CODES.E_CP_DIRTY, "dirty 必须报专属码，不许混进 E_CP_NOT_AT_HEAD（stale 语义）");
    assert.equal(receipt.numbers.treeVerdict, "equal", "子树维度读数照记（两维不可互推）");
    assert.equal(receipt.numbers.cpBuildVerdict, "dirty", "源词表原样记录");
    assert.match(receipt.reason, /BL-325/);
    assert.match(receipt.reason, /非 fresh/);
    assert.ok(validateReceipt(receipt).ok, "E_CP_DIRTY 必须在码表内（reader 不得报 E_SCHEMA）");
});

test("T-2327 正例腿：verdict=fresh + commit==HEAD + 4 服务 200 ⇒ pass（dirty 检查不误伤 fresh）", () => {
    const fx = writeFixture("cp-fresh", [stackRow()]); // 默认夹具即 fresh：running==head==PREV_CP_SAME
    const { exitCode, receipt } = runGate(["--pages", "WorkspaceView.vue", "--stack-status", fx]);
    assert.equal(exitCode, 0, "fresh 正例必须 exit 0（收到 " + exitCode + "）");
    assert.equal(receipt.verdict, "pass");
    assert.equal(receipt.code, "OK");
    assert.equal(receipt.numbers.treeVerdict, "equal");
    assert.equal(receipt.numbers.headVerified, false, "夹具腿一律 headVerified:false");
    assert.ok(validateReceipt(receipt).ok);
});

/* ───────────────── ⑦ T-2327②：numbers.head == git rev-parse HEAD（仅 liveStatus=true 判） ───────────────── */

test("T-2327 变异腿：liveStatus=true 且 numbers.head != 现场 HEAD ⇒ error E_HEAD_MISMATCH", async () => {
    const fx = writeFixture("head-drift", [stackRow()]); // headCommit=PREV_CP_SAME ≠ 现场 HEAD
    const { receipt } = await evaluate(evalOpts(fx, { liveStatus: true }));
    assert.equal(receipt.verdict, "error");
    assert.equal(receipt.code, CODES.E_HEAD_MISMATCH);
    assert.equal(receipt.numbers.liveStatus, true);
    assert.equal(receipt.numbers.headVerified, false);
    assert.equal(receipt.numbers.head, PREV_CP_SAME);
    assert.match(receipt.numbers.gitHead ?? "", /^[0-9a-f]{40}$/, "现场 HEAD 必须真读出来写进 numbers");
    assert.notEqual(receipt.numbers.gitHead, receipt.numbers.head);
    assert.ok(validateReceipt(receipt).ok, "E_HEAD_MISMATCH 必须在码表内（reader 不得报 E_SCHEMA）");
});

test("T-2327 正例腿：liveStatus=true 且 numbers.head == 现场 HEAD ⇒ headVerified:true 且 pass", async () => {
    // 现场 HEAD 动态取（不硬编码 sha —— 那会造出新的「基线漂移」耦合）；
    // running==head ⇒ treeVerdict=equal（same-commit），与 CP 子树内容无关，任何 HEAD 下都成立。
    const liveHead = spawnSync("git", ["-C", resolve(dirname(SCRIPT), ".."), "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    assert.match(liveHead, /^[0-9a-f]{40}$/, "前置：git rev-parse HEAD 必须可读");
    const fx = writeFixture("head-live-ok", [
        stackRow({ cpBuild: { runningCommit: liveHead, headCommit: liveHead, behind: 0, stale: false, verdict: "fresh", dirty: false } }),
    ]);
    const { receipt } = await evaluate(evalOpts(fx, { liveStatus: true }));
    assert.equal(receipt.verdict, "pass", "同源正例必须 pass：" + (receipt.reason ?? ""));
    assert.equal(receipt.code, "OK");
    assert.equal(receipt.numbers.headVerified, true, "live 且同源必须显式 headVerified:true");
    assert.equal(receipt.numbers.gitHead, liveHead);
    assert.equal(receipt.numbers.head, liveHead);
    assert.ok(validateReceipt(receipt).ok);
});

test("T-2327 夹具豁免腿：同一份 head≠现场 的夹具，不带 liveStatus ⇒ 不判 E_HEAD_MISMATCH（但 headVerified:false）", async () => {
    // 与上一条变异腿**同一夹具形状**，唯一差别是 liveStatus —— 钉住「仅 live 判」的边界，
    // 防止把夹具腿也拖进 head 比对（那会让全部既有夹具用例环境态红）。
    const fx = writeFixture("head-fixture-exempt", [stackRow()]);
    const { receipt } = await evaluate(evalOpts(fx));
    assert.equal(receipt.numbers.liveStatus, false);
    assert.equal(receipt.verdict, "pass", "夹具豁免必须保持 pass：" + (receipt.reason ?? ""));
    assert.equal(receipt.numbers.headVerified, false, "豁免≠验过：必须显式 false 留痕");
    assert.ok(!("gitHead" in receipt.numbers), "夹具腿不做现场比对，不产 gitHead 读数");
});

/* ───────────────── ⑧ T-2327：报码顺序钉死 ②CP → ③服务 → ④脏树 ───────────────── */

test("T-2327 报码顺序：CP+服务+脏树三维同时坏 ⇒ code 取 ②E_CP_NOT_AT_HEAD，reason 按 ②→③→④ 排", () => {
    const fx = writeFixture("order-all-bad", [
        stackRow({
            cpBuild: { runningCommit: PREV_CP_SAME, headCommit: HEAD_CP_CHANGED, behind: 1, stale: true, verdict: "stale" }, // ② differs
            services: [serviceRow("cp"), serviceRow("agent"), serviceRow("ui", { status: 500 })], // ③ runtime 行缺失 + ui 500
        }),
    ]);
    const { receipt } = runGate(["--stack-status", fx]); // ④ 不给 --pages
    assert.equal(receipt.verdict, "error");
    assert.equal(receipt.code, "E_CP_NOT_AT_HEAD", "首码必须是 ②CP（顺序钉死）");
    const iCp = receipt.reason.indexOf("[E_CP_NOT_AT_HEAD]");
    const iSvc = receipt.reason.indexOf("[E_STACK_NOT_READY]");
    const iPg = receipt.reason.indexOf("[E_NO_PAGES]");
    assert.ok(iCp >= 0 && iSvc > iCp && iPg > iSvc, "reason 必须按 ②CP→③服务→④脏树 排：" + receipt.reason);
});

test("T-2327 报码顺序：②内部 dirty 先于子树码；②整体先于 ③服务", () => {
    const fx = writeFixture("order-dirty-first", [
        stackRow({
            // dirty + running≠head 且子树 differs：②内部两条都触发，E_CP_DIRTY 必须先点名
            cpBuild: { runningCommit: PREV_CP_SAME, headCommit: HEAD_CP_CHANGED, behind: 1, stale: true, verdict: "dirty", dirty: true },
            services: [serviceRow("cp")], // ③ 三行缺失
        }),
    ]);
    const { receipt } = runGate(["--pages", "WorkspaceView.vue", "--stack-status", fx]);
    assert.equal(receipt.code, "E_CP_DIRTY", "dirty 是更具体成因，必须先于 E_CP_NOT_AT_HEAD");
    const iDirty = receipt.reason.indexOf("[E_CP_DIRTY]");
    const iTree = receipt.reason.indexOf("[E_CP_NOT_AT_HEAD]");
    const iSvc = receipt.reason.indexOf("[E_STACK_NOT_READY]");
    assert.ok(iDirty >= 0 && iTree > iDirty && iSvc > iTree, "顺序必须 dirty→子树→服务：" + receipt.reason);
});

/* ───────────────── ⑨ T-2327：交集命中机制（纯函数，零树态依赖） ───────────────── */

test("T-2327 纯函数腿：overlapOf 等值/后缀/子串三种写法都命中（承接旧 pass 腿的机制断言）", () => {
    const dirty = [{ code: " M", path: "packages/ui/src/features/workspace/pages/WorkspaceMembersView.vue" }];
    for (const q of ["WorkspaceMembersView.vue", "pages/WorkspaceMembersView.vue", "workspacemembersview"]) {
        const hits = overlapOf(dirty, [q]);
        assert.equal(hits.length, 1, "写法 " + q + " 必须命中");
        assert.deepEqual(hits[0].paths, [dirty[0].path]);
    }
    assert.deepEqual(overlapOf(dirty, ["ChatView.vue"]), [], "不相干页面不得命中");
    assert.deepEqual(overlapOf([], ["WorkspaceMembersView.vue"]), [], "干净树零交集");
});
