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

import { GATES, validateReceipt } from "./lib/gate-receipt.mjs";

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
    // 脏树里正好有 WorkspaceMembersView.vue ⇒ 必须记进交集（记录不判红）
    assert.ok(receipt.numbers.dirtyOverlapCount >= 1, "所审页面在脏树里却没记交集");
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
