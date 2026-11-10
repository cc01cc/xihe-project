import { defineConfig, type ReporterDescription } from "@playwright/test";
import { SERVER_START_TIMEOUT_MS, TEST_TIMEOUT_MS } from "./timeouts";

const UI_PORT = process.env.XIHE_UI_PORT || "12630",
    externalServer = process.env.XIHE_E2E_EXTERNAL_SERVER === "1";
const e2eProfile = process.env.XIHE_E2E_PROFILE || "all",
    headed = process.env.XIHE_E2E_HEADED === "1";
const browserChannel = process.env.XIHE_E2E_BROWSER_CHANNEL;
const viewport = (() => {
    const match = /^(\d+)x(\d+)$/.exec(process.env.XIHE_E2E_VIEWPORT ?? "");
    if (match) return { width: Number(match[1]), height: Number(match[2]) };
    return { width: 1920, height: 1080 };
})();
// BL-148: traces can capture APIRequestContext request bodies; turn them off
// whenever real provider credentials are present in the test process.

// task-48（2026-11-11）：**全量报告与子集报告必须分文件写**。
// 子集跑（显式列 spec 文件，例如 `test:mock:smoke` 的 29 文件、排障时的单文件复跑）过去会把整份
// 全量报告覆盖成子集 ⇒ `check:mock-baseline` 读到的是子集数字。这是**门的输入源能被旁路写入污染**，
// 与「`.tmp` 阈值门量错目录」同一类病：门算得对，但算的不是那件事。
// 判据不靠人记得设环境变量，而是**从 argv 推**：给了具体 `*.spec.ts` 就是子集跑。
const EXPLICIT_SPEC_FILES = process.argv
    .slice(2)
    .some((arg) => /(^|[\\/])[^\\/]+\.spec\.ts$/.test(arg));
const REPORT_FILE =
    process.env.XIHE_MOCK_REPORT_FILE ??
    (EXPLICIT_SPEC_FILES ? ".mock-report.subset.json" : ".mock-report.json");
const REPORTERS: ReporterDescription[] | undefined =
    process.env.XIHE_MOCK_REPORT === "1"
        ? [["list"], ["json", { outputFile: REPORT_FILE }]]
        : undefined;

export default defineConfig({
    testDir: "..",
    testMatch: ["e2e/mock/*.spec.ts", "e2e/real/*.spec.ts", "e2e/headed/*.spec.ts"],
    ...(REPORTERS ? { reporter: REPORTERS } : {}),
    timeout: TEST_TIMEOUT_MS,
    retries: 1,
    use: {
        baseURL: `http://localhost:${UI_PORT}`,
        headless: !headed,
        ...(browserChannel ? { channel: browserChannel } : {}),
        viewport,
        deviceScaleFactor: 2,
        screenshot: "only-on-failure",
        trace:
            process.env.XIHE_E2E_REAL_KEY ||
            process.env.XIHE_E2E_REAL_XIAOMI_KEY ||
            process.env.XIHE_E2E_REAL_DASHSCOPE_KEY
                ? "off"
                : "retain-on-failure",
    },
    expect: {
        toHaveScreenshot: {
            animations: "disabled",
            threshold: 0.2,
            maxDiffPixelRatio: 0.01,
        },
    },
    grep: e2eProfile === "host" ? /@host/ : undefined,
    grepInvert: e2eProfile === "compose" ? /@host/ : undefined,
    webServer: externalServer
        ? undefined
        : {
              command: "pnpm dev",
              port: Number(UI_PORT),
              timeout: SERVER_START_TIMEOUT_MS,
              // 2026-10-31 用户批准：多车道并行时禁止复用既有 dev server。
              // 复用会让测试跑在「别人 worktree 的代码」上却报本车道的结果（假绿）；
              // 端口被占时应显式失败并换一个已登记 stack 端口，而不是静默复用。
              reuseExistingServer: false,
          },
});
