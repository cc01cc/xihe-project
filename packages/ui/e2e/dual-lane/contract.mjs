/**
 * 双侧轨迹对账（task-50）—— 契约车道（Node 侧薄壳）。
 *
 * 为什么这一侧现在就做：真栈录波要窗口（`stack-1` 被 R13 占着），而**契约是当前离线能拿到的唯一
 * 「另一侧读数」**，且它比 mock 侧权威 —— mock 桩是人写的，契约是产品承诺。
 *
 * YAML 解析交给 `openapi-shape.py`（PyYAML）：workspace 明令禁止手写 parser，本仓唯一先例就是
 * `A03-xihe/scripts/gen-api-docs.mjs:14-18` 的做法。解释器发现顺序与它的 `PYTHON_CANDIDATES`
 * （`gen-api-docs.mjs:57-61`）保持一致，改一处要同批改另一处。
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizePath } from "./normalize.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** e2e/dual-lane -> packages/ui -> A03-xihe */
const REPO = path.resolve(HERE, "..", "..", "..", "..");
export const OPENAPI = path.join(REPO, "docs", "api", "openapi.yaml");
const SHAPE_PY = path.join(HERE, "openapi-shape.py");

function findPython() {
    const candidates = [
        process.env.XH_PYTHON,
        path.join(REPO, "packages", "agent", ".venv", "Scripts", "python.exe"),
        path.join(REPO, "packages", "agent", ".venv", "bin", "python"),
    ].filter(Boolean);
    const found = candidates.find((candidate) => fs.existsSync(candidate));
    if (!found) {
        throw new Error("PyYAML interpreter not found; tried: " + candidates.join(", "));
    }
    return found;
}

/** 契约车道录波：返回与 mock 车道同形的 rows（`compared` 恒 true）。 */
export function recordContract(testCase) {
    const wanted = testCase.calls.map((call) => ({
        method: call.method,
        path: normalizePath(call.path),
    }));
    const result = spawnSync(findPython(), [SHAPE_PY, OPENAPI, JSON.stringify(wanted)], {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
    });
    if (result.status !== 0) {
        throw new Error(
            "contract-lane python failed: " + String(result.stderr || "").slice(0, 800),
        );
    }
    const parsed = JSON.parse(result.stdout);
    return parsed.map((row) => ({
        method: row.method,
        path: row.path,
        query: "",
        status: row.status,
        keys: row.keys,
        itemKeys: row.itemKeys,
        compared: true,
        operationId: row.operationId ?? null,
        error: row.error ?? null,
    }));
}
