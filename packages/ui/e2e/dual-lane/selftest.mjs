/**
 * 双侧轨迹对账（task-50）—— 自测（`--selftest` 风格的夹具集，跟 `check-docs-index.mjs --selftest` 同一形态）。
 *
 * 为什么必须有它：`D-1074`「开不了的门等于没有门」的下一句是「不会被红过的门也等于没有门」。
 * 这里逐条证明比对器**真的会红**：键改名、少一条、多一条、状态不同，每一种都给一条夹具。
 * 跑法：`node e2e/dual-lane/selftest.mjs`（不起服务、不读 openapi，纯函数，秒级）。
 */

import { applyMutation, parseMutation } from "./lanes.mjs";
import { diffTraces } from "./diff.mjs";
import { makeRow, normalizePath, normalizeQuery, topKeys } from "./normalize.mjs";

let failed = 0;
let passed = 0;

function check(name, actual, expected) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a === b) {
        passed += 1;
        console.log("  ok   " + name);
        return;
    }
    failed += 1;
    console.log("  FAIL " + name);
    console.log("       expected " + b);
    console.log("       actual   " + a);
}

function row(method, url, status, body) {
    return makeRow({ method, url: "http://127.0.0.1:1" + url, status, body });
}

console.log("normalize：路径与 query");
check(
    "uuid -> {id}",
    normalizePath("/api/v1/agent-principals/3f2b9a10-1111-2222-3333-444455556666/roles"),
    "/api/v1/agent-principals/{id}/roles",
);
check(
    "夹具 slug-id -> {id}",
    normalizePath("/api/v1/workspaces/workspace-1/agents"),
    "/api/v1/workspaces/{id}/agents",
);
check(
    "纯数字 -> {id}",
    normalizePath("/api/v1/sessions/42/messages"),
    "/api/v1/sessions/{id}/messages",
);
check("资源名不被误伤", normalizePath("/api/v1/agent-principals"), "/api/v1/agent-principals");
check(
    "query 丢易变键 + 排序 + id 值归一",
    normalizeQuery("/api/v1/agent-principals?workspaceId=workspace-1&locale=zh-CN&b=2&a=1"),
    "a=1&b=2&workspaceId={id}",
);

console.log("normalize：顶层键集合");
check("对象键排序", topKeys({ principals: [] }).keys, ["principals"]);
check("数组 -> <array>（元素键另存）", topKeys([{ principalId: "x", name: "y" }]).keys, [
    "<array>",
]);
check("数组元素键", topKeys([{ principalId: "x", name: "y" }]).itemKeys, ["name", "principalId"]);
check("空对象 -> 空数组（不是 null）", topKeys({}).keys, []);
check("非对象 -> null（没读到 ≠ 形状一致）", topKeys(null).keys, null);
check("字符串 body -> null", topKeys("ok").keys, null);

console.log("diff：三条判据各自会红");
const baseRows = [
    row("GET", "/api/v1/agent-principals", 200, { principals: [] }),
    row("GET", "/api/v1/workspaces/workspace-1/agents", 200, { agents: [] }),
];
check("两侧一致 -> 空 diff", diffTraces(baseRows, baseRows).length, 0);

const renamed = [row("GET", "/api/v1/agent-principals", 200, { agents: [] })];
const keyDiff = diffTraces([baseRows[0]], renamed);
check("③ 顶层键改名 -> 1 条 KEYS", keyDiff.length, 1);
check(
    "③ 报告里两侧键集都在",
    keyDiff[0].includes("[principals]") && keyDiff[0].includes("[agents]"),
    true,
);

const wrongStatus = [row("GET", "/api/v1/agent-principals", 500, { principals: [] })];
check("② 状态不同 -> 1 条 STATUS", diffTraces([baseRows[0]], wrongStatus).length, 1);

check("① 右少一条", diffTraces(baseRows, [baseRows[0]]).length, 1);
check("① 左少一条", diffTraces([baseRows[0]], baseRows).length, 1);
check(
    "① 少一条时点名方向",
    diffTraces(baseRows, [baseRows[0]])[0].startsWith("REQ-MISSING-IN-RIGHT"),
    true,
);

console.log("diff：compared:false 不参与对账");
const ignored = [{ ...baseRows[0], compared: false }];
check("忽略行 -> 空 diff", diffTraces(ignored, []).length, 0);

console.log("卡片原例：{agents,count} vs {principals}");
const shapeLeft = [row("GET", "/api/v1/agent-principals", 200, { agents: [], count: 0 })];
const shapeRight = [row("GET", "/api/v1/agent-principals", 200, { principals: [] })];
const shapeDiff = diffTraces(shapeLeft, shapeRight);
check("被抓出来", shapeDiff.length, 1);
check(
    "两条键集都打印",
    shapeDiff[0].includes("[agents, count]") && shapeDiff[0].includes("[principals]"),
    true,
);

console.log("反例开关本身");
check("parseMutation", parseMutation("principals=agents"), { from: "principals", to: "agents" });
check(
    "applyMutation 改顶层键",
    Object.keys(applyMutation({ principals: [] }, parseMutation("principals=agents"))),
    ["agents"],
);
check(
    "applyMutation 不动其它键",
    applyMutation({ agents: [], count: 0 }, parseMutation("principals=agents")),
    { agents: [], count: 0 },
);

console.log("");
console.log(String(passed) + " passed, " + String(failed) + " failed");
if (failed > 0) process.exit(1);
