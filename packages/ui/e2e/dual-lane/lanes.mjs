/**
 * 双侧轨迹对账（task-50）—— 车道。两个车道**共用同一个录波器**（`recordHttpLane`）：
 * 差别只有 `baseUrl` 与桩服务，所以「两侧读数」是同一把尺子量出来的。
 *
 * mock 车道 = 本地 `node:http` 桩服务，桩体来自 `cases.mjs`（与 `e2e/mock/*.spec.ts` 的
 * `route.fulfill` 同源）。为什么不用 Playwright：本轮判据是 **HTTP 形状**（method/path/status/键集），
 * 浏览器只是多一层不确定性；真栈车道要登录态，那部分等窗口时再加，不影响这里的对账口径。
 *
 * real 车道 = `--base-url <真栈地址> --token <bearer>`，代码已就位、本轮未跑（`stack-1` 被 R13 占着）。
 */

import http from "node:http";
import { makeRow, normalizePath } from "./normalize.mjs";
import { isCompared } from "./cases.mjs";

/** `principals=agents` -> `{ from: "principals", to: "agents" }`；反例开关就是它。 */
export function parseMutation(raw) {
    if (!raw) return null;
    const eq = raw.indexOf("=");
    if (eq <= 0) throw new Error("--mutate 需要 from=to 形式，收到: " + raw);
    return { from: raw.slice(0, eq), to: raw.slice(eq + 1) };
}

/** 只在该响应的**顶层**键上改名（反例要抓的正是顶层键集合）。 */
export function applyMutation(body, mutation) {
    if (!mutation || !body || typeof body !== "object" || Array.isArray(body)) return body;
    if (!(mutation.from in body)) return body;
    const next = {};
    for (const [key, value] of Object.entries(body)) {
        next[key === mutation.from ? mutation.to : key] = value;
    }
    return next;
}

/** 起一个只认本用例桩体的 HTTP 服务（未登记的路径一律 404 `{}`，且不参与对账）。 */
export async function startMockLane(testCase, options = {}) {
    const mutation = options.mutation ?? null;
    const server = http.createServer((req, res) => {
        const url = req.url ?? "/";
        const key = normalizePath(url);
        const body = testCase.stubs[key];
        res.setHeader("content-type", "application/json");
        if (!body) {
            res.statusCode = 404;
            res.end(JSON.stringify({}));
            return;
        }
        res.statusCode = 200;
        res.end(JSON.stringify(applyMutation(body, mutation)));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return {
        baseUrl: "http://127.0.0.1:" + port,
        close: () => new Promise((resolve) => server.close(resolve)),
    };
}

function readBody(response) {
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("json")) return Promise.resolve(null);
    return response.text().then((text) => {
        if (!text) return null;
        try {
            return JSON.parse(text);
        } catch {
            return null;
        }
    });
}

/** 车道录波：按用例的 `calls` 逐条打过去，记 `{method, 归一化 path, status, 顶层键集}`。 */
export async function recordHttpLane(testCase, options) {
    const headers = { accept: "application/json", ...(options.headers ?? {}) };
    const rows = [];
    for (const call of testCase.calls) {
        const target = options.baseUrl + call.path;
        const response = await fetch(target, { method: call.method, headers });
        const body = await readBody(response);
        const row = makeRow({
            method: call.method,
            url: target,
            status: response.status,
            body,
            compared: isCompared(testCase, normalizePath(target)),
        });
        row.layer = call.layer ?? null;
        rows.push(row);
    }
    return rows;
}
