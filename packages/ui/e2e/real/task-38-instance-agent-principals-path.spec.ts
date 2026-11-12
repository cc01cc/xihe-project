// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { LONG_TIMEOUT_MS } from "../timeouts";

/**
 * task-38 R1（P0 真栈 404）—— **real-lane 断言**，不能用 mock 绿代替。
 *
 * 缺陷成因值得写在这里，因为它决定这条 spec 必须存在：UI 把实例层路径写死成
 * `/api/v1/instance/agents`，而契约（`docs/api/openapi.yaml:4876`）与 CP
 * （`InstanceAgentPrincipalController.java:52`）都是 `/api/v1/instance/agent-principals`；
 * **mock 夹具当时也写了 `/instance/agents`** ⇒ mock 车道全绿、真栈 404。
 * 只在 mock 上加断言，等于让「两边各有一份路径」继续成立。
 *
 * 三条断言缺一不可：
 *   ① 正向：点进 `/resources/agents?layer=INSTANCE` 后，网络里**真的出现**契约路径且 **200**；
 *   ② 信封：响应体是契约的 `AgentPrincipalListResponse`（`principals` 数组）—— 路径对了但信封错，
 *      列表会静默空掉，症状与 404 不同、但一样是假绿；
 *   ③ 反向：**不该再出现**旧路径 `/api/v1/instance/agents`（这条才是「修好了」的判据，
 *      只断言 200 的话，两处都写对才算过，反之也过）。
 *
 * 环境（同其他 real-lane spec）：
 *   XIHE_E2E_EXTERNAL_SERVER=1 复用已起的 UI；`XIHE_CP_BASE_URL`/`XIHE_CP_PORT`、
 *   `XIHE_UI_BASE_URL`/`XIHE_UI_PORT` 决定两端口（本文件不硬编码端口）；
 *   `XIHE_E2E_ADMIN_TOKEN` 优先，否则 `XIHE_E2E_ADMIN_EMAIL|USERNAME` + `XIHE_E2E_ADMIN_PASSWORD` 登录。
 * 缺凭据 ⇒ skip 并给可执行提示（保持 `--list` 与其余 real lane 可跑）。
 * 不使用 `waitForTimeout`：等待一律是 `waitForResponse` 或 locator 超时。
 */
const CP_URL = (() => {
    const explicit = process.env.XIHE_CP_BASE_URL;
    if (explicit) return explicit.replace(/\/$/, "");
    return `http://127.0.0.1:${process.env.XIHE_CP_PORT || "12631"}`;
})();

const UI_URL = (() => {
    const explicit = process.env.XIHE_UI_BASE_URL;
    if (explicit) return explicit.replace(/\/$/, "");
    return `http://localhost:${process.env.XIHE_UI_PORT || "12630"}`;
})();

const ADMIN_EMAIL =
    process.env.XIHE_E2E_ADMIN_EMAIL || process.env.XIHE_E2E_ADMIN_USERNAME || "admin@xihe.local";
const ADMIN_PASSWORD = process.env.XIHE_E2E_ADMIN_PASSWORD ?? "";
const ADMIN_TOKEN = process.env.XIHE_E2E_ADMIN_TOKEN ?? "";

const CONTRACT_PATH = "/api/v1/instance/agent-principals";
const RETIRED_PATH = "/api/v1/instance/agents";

interface LoginResult {
    accessToken: string;
    user: Record<string, unknown>;
    workspaceId: string;
}

async function adminSession(request: APIRequestContext): Promise<LoginResult> {
    if (ADMIN_TOKEN) {
        const me = await request.get(`${CP_URL}/api/v1/auth/me`, {
            headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
        });
        expect(me.ok(), await me.text()).toBe(true);
        const meBody = (await me.json()) as Record<string, unknown>;
        const workspaces = await request.get(`${CP_URL}/api/v1/workspaces`, {
            headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
        });
        const list = (await workspaces.json()) as Array<{ id?: string }>;
        return {
            accessToken: ADMIN_TOKEN,
            user: meBody,
            workspaceId: list?.[0]?.id ?? "",
        };
    }
    const login = await request.post(`${CP_URL}/api/v1/auth/login`, {
        data: { identifier: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(login.ok(), await login.text()).toBe(true);
    return (await login.json()) as LoginResult;
}

/** 与 `stores/auth.ts` 的 localStorage 契约一致（`xihe-token` / `xihe-user` / `xihe-workspace`）。 */
async function injectSession(page: Page, auth: LoginResult) {
    await page.addInitScript(
        ({ token, user, workspaceId }) => {
            localStorage.setItem("xihe-token", token);
            localStorage.setItem("xihe-user", JSON.stringify(user));
            if (workspaceId) {
                localStorage.setItem(
                    "xihe-workspace",
                    JSON.stringify({ id: workspaceId, name: "E2E" }),
                );
            }
        },
        { token: auth.accessToken, user: auth.user, workspaceId: auth.workspaceId },
    );
}

test("@host 资源区全平台智能体读到契约路径 /instance/agent-principals（200）且不再打 /instance/agents", async ({
    page,
    request,
}) => {
    test.skip(
        !ADMIN_TOKEN && !ADMIN_PASSWORD,
        "需要 XIHE_E2E_ADMIN_TOKEN 或 XIHE_E2E_ADMIN_PASSWORD（由 e2e-host / 窗口会话注入）",
    );

    const auth = await adminSession(request);
    await injectSession(page, auth);

    const instancePaths: string[] = [];
    page.on("request", (req) => {
        if (req.method() !== "GET") return;
        const pathname = new URL(req.url()).pathname;
        if (pathname.startsWith("/api/v1/instance/")) instancePaths.push(pathname);
    });

    /**
     * 证据串（不是断言）：把「实际请求的 URL 原文 + 状态码」印进 report/log，
     * 因为「断言过了」与「能把那条请求原文贴给别人看」是两件事（本 bug 就是靠 mock 断言过了）。
     */
    const observed: string[] = [];
    page.on("response", (response) => {
        const pathname = new URL(response.url()).pathname;
        if (pathname.startsWith("/api/v1/instance/")) {
            observed.push(
                `${response.request().method()} ${response.url()} => ${response.status()}`,
            );
        }
    });

    const responsePromise = page.waitForResponse(
        (response) =>
            response.request().method() === "GET" &&
            new URL(response.url()).pathname === CONTRACT_PATH,
        { timeout: LONG_TIMEOUT_MS },
    );

    await page.goto(`${UI_URL}/resources/agents?layer=INSTANCE`);

    // ① 正向：契约路径必须真被请求且 200
    const response = await responsePromise;
    expect(response.status()).toBe(200);

    // ② 信封：契约的 AgentPrincipalListResponse（`principals` 数组）
    const body = (await response.json()) as { principals?: unknown };
    expect(Array.isArray(body.principals)).toBe(true);

    // ③ 反向：旧路径一次都不许出现
    expect(instancePaths).toContain(CONTRACT_PATH);
    expect(instancePaths.filter((pathname) => pathname === RETIRED_PATH)).toEqual([]);

    console.log(`[task-38 evidence] UI=${UI_URL} CP=${CP_URL} 观察到的实例层请求：`);
    for (const line of observed) console.log(`[task-38 evidence]   ${line}`);
});
