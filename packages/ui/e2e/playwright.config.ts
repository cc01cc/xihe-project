import { defineConfig, type ReporterDescription } from "@playwright/test";
import { SERVER_START_TIMEOUT_MS, TEST_TIMEOUT_MS } from "./timeouts";
import { mockApiEnvFor, resolveExpectedChain } from "./helpers/chain";

// task-368 / D-1226：默认端口不得落在共享 stack 段（事实源 scripts/lib/stack-ports.mjs）。
// 旧默认 12630 = stack-1 ui ⇒ 未设 XIHE_UI_PORT 的调用静默绑到 stack-1，读数指向别的对象
// （假信号生成器，D-1219 同族）。改用非栈端口 12750；未设 env 时下方明示正在用默认值。
const UI_PORT = process.env.XIHE_UI_PORT || "12750",
    externalServer = process.env.XIHE_E2E_EXTERNAL_SERVER === "1";
const e2eProfile = process.env.XIHE_E2E_PROFILE || "all",
    headed = process.env.XIHE_E2E_HEADED === "1";

// task-368 / D-1226：未设 XIHE_UI_PORT 时明示正在使用默认端口（避免「有个 ui 在 12750」被误读成栈）。
if (!process.env.XIHE_UI_PORT) {
    console.log(
        `[e2e] XIHE_UI_PORT 未设置 ⇒ 使用默认端口 ${UI_PORT}（非 stack 段；task-368 / D-1226）`,
    );
}

/**
 * task-80：**链路声明 + 自证**。
 *
 * mock 车道的 `webServer.command` 是 `pnpm dev`，而 `/settings|/workspace/**` 的 HTML 入口
 * 由 vite 的 mock 中间件是否挂载决定（`XIHE_UI_MOCK_API=1`）。此前这个开关靠**调用者 shell 里恰好有**
 * ⇒ 同一个命令可能跑在 `index.html` 上，也可能跑在 `preview-real.html` 上，报告里看不出来
 * （`green-light-audit.md` §A4.3 的 6 passed 事故）。
 *
 * 现在：期望链路由 `resolveExpectedChain()` 决定（显式 `XIHE_E2E_EXPECT_CHAIN` 优先，
 * 否则从 `XIHE_UI_MOCK_API` 推导），并由本文件的 `webServer.env` **显式**写成对应值 ——
 * 不再继承 shell 里的模糊态；随后 `globalSetup` 用一次真实请求证明实际链路，不符即整轮 fail-fast。
 */
const expectedChain = resolveExpectedChain();
const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => value !== undefined),
) as Record<string, string>;

const browserChannel = process.env.XIHE_E2E_BROWSER_CHANNEL;
const viewport = (() => {
    const match = /^(\d+)x(\d+)$/.exec(process.env.XIHE_E2E_VIEWPORT ?? "");
    if (match) return { width: Number(match[1]), height: Number(match[2]) };
    return { width: 1920, height: 1080 };
})();
// BL-148: traces can capture APIRequestContext request bodies; turn them off
// whenever real provider credentials are present in the test process.

// task-48（2026-11-11）：**全量报告与子集报告必须分文件写**。
// 子集跑（显式列 spec 文件，例如 `test:mock:smoke` 的 30 文件、排障时的单文件复跑）过去会把整份
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
    // 链路自证：mock 车道必跑；显式声明了链路（可用于 external server 的反向验证）也跑。
    globalSetup:
        !externalServer && e2eProfile === "mock"
            ? "./chain-proof.setup.ts"
            : process.env.XIHE_E2E_EXPECT_CHAIN
              ? "./chain-proof.setup.ts"
              : undefined,
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
              // task-80：显式注入（而不是继承 shell），让"实际服务哪个 HTML"与"声明链路"同源。
              // task-428 / task-421 根因修：XIHE_UI_PORT 显式注入，与 webServer.port 同源（单一事实源）。
              // 未设 env 时 baseEnv 无 XIHE_UI_PORT，vite 回落自身默认 12630 ⇒ 与等待端口失配超时。
              env: {
                  ...baseEnv,
                  XIHE_UI_PORT: UI_PORT,
                  XIHE_UI_MOCK_API: mockApiEnvFor(expectedChain.chain),
              },
          },
});
