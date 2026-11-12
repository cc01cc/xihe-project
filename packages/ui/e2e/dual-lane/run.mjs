/**
 * 双侧轨迹对账（task-50）—— 编排器。
 *
 * 一次执行同时产出三样东西（同目录、同一次运行，所以「两侧读数」不会来自不同时刻）：
 *   traces/mock-<case>.json      mock 车道轨迹（本地桩服务）
 *   traces/contract-<case>.json  契约车道轨迹（openapi.yaml）
 *   traces/diff-<case>.txt       两侧逐条对账结果；**非空 ⇒ exit 1**
 *
 * 真栈车道（traces/real-<case>.json）留到有窗口：`--real-base-url` + `--token` 已接线，
 * 见 `lanes.mjs` 的 `recordHttpLane`。
 *
 * 用法：
 *   node e2e/dual-lane/run.mjs --case resources-agents
 *   node e2e/dual-lane/run.mjs --case resources-agents --mutate principals=agents   # 反例
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getCase } from "./cases.mjs";
import { recordContract } from "./contract.mjs";
import { renderDiffReport, diffTraces } from "./diff.mjs";
import { parseMutation, recordHttpLane, startMockLane } from "./lanes.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..", "..");

function arg(name, fallback) {
    const index = process.argv.indexOf(name);
    return index === -1 ? fallback : process.argv[index + 1];
}

function writeTrace(file, lane, testCase, rows, extra = {}) {
    const payload = { lane, case: testCase.id, title: testCase.title, ...extra, rows };
    fs.writeFileSync(file, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

async function main() {
    const caseId = arg("--case", "resources-agents");
    const testCase = getCase(caseId);
    const mutation = parseMutation(arg("--mutate", ""));
    const outDir = path.resolve(arg("--out-dir", path.join(REPO, ".tmp", "xh", "dual-lane")));
    fs.mkdirSync(outDir, { recursive: true });

    const mockFile = path.join(outDir, "mock-" + caseId + ".json");
    const contractFile = path.join(outDir, "contract-" + caseId + ".json");
    const diffFile = path.join(outDir, "diff-" + caseId + ".txt");

    const mockLane = await startMockLane(testCase, { mutation });
    let mockRows;
    try {
        mockRows = await recordHttpLane(testCase, { baseUrl: mockLane.baseUrl });
    } finally {
        await mockLane.close();
    }
    writeTrace(mockFile, "mock", testCase, mockRows, {
        baseUrl: mockLane.baseUrl,
        mutation: mutation ? mutation.from + "->" + mutation.to : null,
    });

    const realBaseUrl = arg("--real-base-url", "");
    let realFile = null;
    if (realBaseUrl) {
        const token = arg("--token", process.env.XIHE_E2E_TOKEN ?? "");
        const realRows = await recordHttpLane(testCase, {
            baseUrl: realBaseUrl.replace(/\/$/, ""),
            headers: token ? { authorization: "Bearer " + token } : {},
        });
        realFile = path.join(outDir, "real-" + caseId + ".json");
        writeTrace(realFile, "real", testCase, realRows, { baseUrl: realBaseUrl });
    }

    const contractRows = recordContract(testCase);
    writeTrace(contractFile, "contract", testCase, contractRows);

    const rightFile = realFile ?? contractFile;
    const rightRows = realFile ? JSON.parse(fs.readFileSync(realFile, "utf8")).rows : contractRows;
    const leftName = "mock";
    const rightName = realFile ? "real" : "contract";
    const lines = diffTraces(mockRows, rightRows, { left: leftName, right: rightName });
    const report = renderDiffReport(lines, {
        case: caseId,
        leftFile: mockFile,
        rightFile: rightFile,
        leftRows: mockRows.length,
        rightRows: rightRows.length,
    });
    fs.writeFileSync(diffFile, report, "utf8");
    process.stdout.write(report);

    if (mutation) {
        process.stdout.write(
            "\n注意: 本轮带反例开关 --mutate " + mutation.from + "=" + mutation.to,
        );
        process.stdout.write("\n");
    }
    process.stdout.write("\n轨迹目录: " + outDir + "\n");
    return lines.length === 0 ? 0 : 1;
}

main()
    .then((code) => process.exit(code))
    .catch((error) => {
        console.error("dual-lane run failed: " + (error && error.message ? error.message : error));
        process.exit(2);
    });
