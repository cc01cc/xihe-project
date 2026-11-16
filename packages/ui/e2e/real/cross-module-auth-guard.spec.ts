import { generateE2EPassword } from "./helpers/password";
import { gotoWorkspaceWithChat } from "./helpers/chat";
import { ensureWorkspace } from "./helpers/workspace";
import { ensureFakeUserProvider } from "./helpers/fake-provider";
import { agentName } from "./helpers/agent-name";
import { ACTION_TIMEOUT_MS, EXPECT_TIMEOUT_MS } from "../timeouts";
import { seedSession } from "../helpers/session-seed";
import { test, expect } from "@playwright/test";

const SHARED_PASSWORD = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword();

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`;

test.describe("@host Cross-Module — Auth Guard", () => {
    test("authenticated user can access chat page", async ({ page, request }) => {
        const email = `auth-${Date.now()}@test.com`;
        const reg = await fetch(`${CP_URL}/api/v1/auth/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password: SHARED_PASSWORD, name: "AuthTest" }),
        });
        const { accessToken } = await reg.json();

        // 只种 token = **有意**造半个会话（本用例之后的路径不依赖 user）⇒ 显式声明。
        // task-33：登录态种子保持 session-seed 单一来源不动；下面补的是**服务端前置数据**。
        await seedSession(page, { token: accessToken, halfSession: true });

        // task-33（方案 B，lead 批准 2026-11-17）：PLAN-0614 起注册不再创建 workspace，
        // 新账号会停在 WorkspacePicker 空态（task-11(b) 真栈实测：helpers/chat.ts 等
        // textarea 10s 超时）。而且光有 workspace 还不够——没有 bound agent 时
        // `createSessionForWorkspace` 走 none-bound 分支只 toast（WorkspaceView.vue），
        // 没有 USER 连接 + user profile 时建会话 409 LLM_PROFILE_CONFLICT /
        // 400 PROVIDER_REQUIRED（SessionProviderDefaults.resolve）。所以这里按
        // chat.spec.ts `seedChatFixture`（task-49）同款链路经 CP API 补齐五件前置：
        // workspace → fake USER 连接 + user llm profile → principal 创建并绑定 → Session。
        // 不走 UI 建工作区（方案 A 否决）：守卫用例的被测面是「已认证可达 chat」，
        // 创建流已有专门覆盖面；且 A 只解决五分之一，其余四件仍要 API seed。
        // 不用 provisionWorkspaceAgentPrincipal / createApprovalAgent：它们依赖
        // docker exec psql 的 grant seed（user-grants.ts），external 直跑车道没有
        // XIHE_E2E_PG_CONTAINER；本路径 creator 自动 WS_OWNER（V87），权限天然够。
        const workspaceId = await ensureWorkspace(request, accessToken);
        await ensureFakeUserProvider(request, { accessToken, workspaceId });

        const headers = {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            // D21：WORKSPACE 上下文经显式头传递（principal 创建与绑定都要求）。
            "X-Workspace-Id": workspaceId,
        };
        // templateId 不传 ⇒ CP defaultSnapshot（AgentTemplateService.resolveForCreation），
        // 免写 agent-templates 域；名字必须过 PLAN-0661 正则 ⇒ agentName() 单一实现。
        const created = await request.post(`${CP_URL}/api/v1/agent-principals`, {
            headers,
            data: { name: agentName("AuthGuard", Date.now()) },
        });
        expect(created.status(), await created.text()).toBe(201);
        const { principalId } = (await created.json()) as { principalId: string };

        const bound = await request.put(
            `${CP_URL}/api/v1/workspaces/${workspaceId}/agents/${principalId}`,
            { headers, data: { permissions: [{ actionClass: "read", resource: "*" }] } },
        );
        expect(bound.status(), await bound.text()).toBe(200);

        const session = await request.post(`${CP_URL}/api/v1/workspaces/${workspaceId}/sessions`, {
            headers,
            data: { title: `auth-guard-${Date.now()}`, agentPrincipalId: principalId },
        });
        expect(session.status(), await session.text()).toBe(201);

        // PLAN-0559/0608 C′：tab 上下文（sessionStorage xihe-workspace）是「打开哪个
        // 工作区」的唯一权威；只种 token 时 /workspace 渲染选择面（I6：登录响应不回填）。
        // 这里把**真实建成**的工作区经 seedSession 单一来源写进 tab 上下文（不是手写
        // storage、也不是伪造归属——id 来自上面 CP 201 响应），路由守卫据此落
        // /workspace/<id>（router/index.ts:632-636），mount 自动选中唯一 Session。
        await seedSession(page, {
            token: accessToken,
            halfSession: true,
            workspace: { id: workspaceId },
        });
        await gotoWorkspaceWithChat(page);
        // 钉「composer 在 seed 的工作区里」而不是恰好某个含 textarea 的页面
        // （chat.spec.ts task-49 验收③同款判据）。
        await expect(page.getByTestId(`sidebar-workspace-group-${workspaceId}`)).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
    });

    test("unauthenticated user is redirected to login", async ({ page }) => {
        await page.goto("/workspace");
        await page.waitForURL(/\/login/, { timeout: ACTION_TIMEOUT_MS });
        expect(page.url()).toContain("/login");
    });

    // task-373 / D-1228 + D-1236（router/index.ts:546-558）：/chat/:sessionId 自 f36c85895
    // 起是**真实产品路由**（StandaloneChatView，meta.requiresAuth: true），不再 redirect 到
    // workspace landing。原用例「legacy chat route recovers to workspace landing」的前提被
    // 这两条决策取消（该 spec 末次实质修改 0d57f664c / 2026-09-23，前提失效约 7.5 周）。
    // ⇒ E 类处置：按新契约**重写**，而不是把断言改到另一个 URL 蒙过去 —— 本文件是
    //   「Cross-Module — Auth Guard」，/chat 这条路线在守卫面要验的本来就是「需要登录」。
    test("standalone chat route is guarded: unauthenticated access lands on login", async ({
        page,
    }) => {
        await page.goto("/chat/legacy-session");
        await page.waitForURL(/\/login/, { timeout: ACTION_TIMEOUT_MS });
        expect(page.url()).toContain("/login");
    });
});
