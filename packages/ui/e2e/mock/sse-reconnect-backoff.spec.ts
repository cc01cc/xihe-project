// timeout-exempt: 判据要看「退避增长」，必须真等过几次重连（第 5 次连接约 7.8 s），按设计超默认 10 s 预算
import { expect, test } from "./helpers/mock-test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";

/**
 * task-101 ②：工作区 SSE 重连必须**退避**，不是恒速重连。
 *
 * 背景：旧实现 `chatTransport` 的 `onopen` 无条件把 `reconnectAttempt` 归零 ⇒ 服务端每次
 * 正常关流后都以 250 ms 档重连。task-98 在旧桩上实测 **101 次 / 30 s**（规范值应远小于此）。
 *
 * 判据为什么用「第 1→5 次连接的跨度」而不是「连接次数」：
 * - 恒速重连（每次归零）：1→5 次约 **1.0 s**（0.25×4）；
 * - 指数退避（寿命 < 阈值不归零）：1→5 次约 **3.75 s**（0.25+0.5+1+2，加抖动实测 4.17 s）。
 * 相差约 4 倍，阈值取中间的 2.5 s；而「30 s 内连接数」需要把用例拖到 30 s 才分辨得出。
 *
 * 实测校准（2026-11-11）：同一夹具下「旧产品 + 新桩」= **105 次 / 30 s**，「R1」= **9 次 / 30 s**。
 */
const SESSION_ID = "reconnect-backoff-session";
/**
 * 第 1 次与第 5 次连接的时间跨度判据。
 *
 * 阈值 2.5 s：实测「旧产品 1173 ms / R1 4167 ms」，2.5 s 落在两者之间且两侧各有 >2× 余量。
 * 曾用 5 s（按「第 6 次连接」误算成 7.75 s），真跑时对 R1 **假红**（4167 < 5000）后按实测改。
 * **不要把它调回 5 s** —— 那个数是算错的，不是保守取值。
 */
const FIRST_TO_FIFTH_CONNECT_MS = 2_500;

test.setTimeout(60_000); // timeout-exempt: 等第 5 次重连出现（指数退避 0.25/0.5/1/2 s）

test("workspace SSE 重连按指数退避，不是恒速重连", async ({ page }) => {
    const connectTimes: number[] = [];
    page.on("console", (message) => {
        const text = message.text();
        if (/chat_sse_connect_started/.test(text) && /sessionId: workspace:/.test(text)) {
            connectTimes.push(Date.now());
        }
    });

    // 场景**写死在代码里**，不靠环境变量：靠 env 的用例在没设 env 时会跑在 `hold`（永不关流）上，
    // 那时它照样"绿"，但什么都没测到 —— 那种绿不携带信息。
    await setupMockAuth(page, { workspaceEventsScenario: { kind: "closeSoon" } });
    await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: "reconnect backoff" }] });
    await page.goto(`/workspace/workspace-1/chat/${SESSION_ID}`);
    await expect(page.getByTestId("chat-input"), "composer 挂载").toBeVisible({ timeout: 10_000 });

    await expect
        .poll(() => connectTimes.length, {
            timeout: 10_000,
            intervals: [100, 200, 250],
            message: "工作区 SSE 应至少重连到第 5 次",
        })
        .toBeGreaterThanOrEqual(5);

    const span = connectTimes[4]! - connectTimes[0]!;
    expect(
        span,
        `第 1→5 次连接跨度 ${span} ms：恒速重连约 1.0 s（应红），指数退避实测约 4.2 s（应绿）`,
    ).toBeGreaterThan(FIRST_TO_FIFTH_CONNECT_MS);
});
