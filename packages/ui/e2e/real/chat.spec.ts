// lane: 非 host —— 两条用例体内嵌视觉断言（helpers/visual.ts 非 linux 平台 skip，host 车道 BL-421 fail-on-skip）；夹具重种已由 a4d30b0ca 真栈实测（all-profile external stack-2）。原 compose 车道已冻结（2026-10-07），现仅 profile=all 直跑可达（T-2318 分类表）。
import { randomUUID } from "node:crypto";
import { agentName } from "./helpers/agent-name";
import { generateE2EPassword } from "./helpers/password";
import { ensureFakeUserProvider } from "./helpers/fake-provider";
import { gotoWorkspaceWithChat } from "./helpers/chat";
import { isolatedWorkspaceHostPath } from "./helpers/workspace";
import { EXPECT_TIMEOUT_MS } from "../timeouts";
import { test, expect, type APIRequestContext } from "@playwright/test";
import { expectPlatformScreenshot } from "../helpers/visual";

const SHARED_PASSWORD = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword();

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`;

type ChatFixture = {
    authToken: string;
    workspaceId: string;
    sessionId: string;
};

/**
 * Seed a `direct_attach` workspace (PLAN-0614: `POST /auth/register` no longer creates one).
 *
 * Docker workspace backend is frozen (DEV-018), so this goes straight to `direct_attach` with a
 * real capability preflight — no `managed_import` probe, and no silent downgrade: when neither
 * backend reports `available` the fixture fails instead of guessing.
 */
async function seedWorkspace(request: APIRequestContext, authToken: string): Promise<string> {
    const headers = {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
    };
    const list = await request.get(`${CP_URL}/api/v1/workspaces`, { headers });
    expect(list.status(), await list.text()).toBe(200);
    const existing = (await list.json()) as Array<{ id?: string }>;
    const first = Array.isArray(existing) ? existing[0]?.id : undefined;
    if (first) return first;

    // task-49 的隔离根去重后只剩一处实现（task-71）。本文件原先自带一份手写拷贝：叶子名只由
    // 「时间戳」拼成，而 Date.now() 在同一同步块内连续调用返回同一毫秒 ⇒ 两个 seed 出来的工作区
    // 会**静默**共用同一个宿主目录；它还自己重算根目录、绕开 helper 的序号 + 随机 nonce，即 task-68
    // 修掉的那条缺陷在这里原封不动（D-1722）。
    // 现在两条车道都走 isolatedWorkspaceHostPath()（有 RUN_ID 用 run-id、否则进程级隔离根），并由它
    // 打印实际使用的根与车道 —— 碰撞原本是静默的，不打印等于跑完没人知道文件写到了哪。
    const hostPath = isolatedWorkspaceHostPath();
    const preflight = async (executionMode: "windows-mxc" | "windows-host") => {
        const response = await request.post(`${CP_URL}/api/v1/workspaces/capabilities/preflight`, {
            headers,
            data: { storageMode: "direct_attach", hostPath, executionMode },
        });
        expect(response.ok(), await response.text()).toBeTruthy();
        return (await response.json()) as { available?: boolean; reason?: string };
    };
    const mxc = await preflight("windows-mxc");
    const host = mxc.available === true ? null : await preflight("windows-host");
    const executionMode =
        mxc.available === true ? "windows-mxc" : host?.available === true ? "windows-host" : null;
    if (!executionMode) {
        throw new Error(
            `no direct_attach execution backend available (mxc=${String(mxc.reason)}, host=${String(host?.reason)})`,
        );
    }

    const created = await request.post(`${CP_URL}/api/v1/workspaces`, {
        headers: { ...headers, "Idempotency-Key": randomUUID() },
        data: {
            name: `e2e-workspace-${Date.now()}`,
            storageMode: "direct_attach",
            hostPath,
            executionMode,
        },
    });
    expect(created.status(), await created.text()).toBe(201);
    const { id } = (await created.json()) as { id?: string };
    expect(id, "created workspace must carry an id").toMatch(/^[0-9a-f-]{36}$/i);
    return id as string;
}

/**
 * Seed the state the composer actually needs (task-49).
 *
 * Baseline failure: `beforeAll` registered a brand-new account and stopped there. Registration
 * creates no workspace (PLAN-0614) and the workspace-first landing never auto-creates a Session
 * (PLAN-0328 M3 T3.7), so the page rendered `WorkspacePicker` ("你还没有工作区") where the
 * composer is not mounted at all — the asserted `textarea` could never appear.
 *
 * Registering a fresh identity per run is this spec's design, so the fixture keeps that and seeds
 * the missing state instead of borrowing a pre-seeded admin workspace. Three facts are required and
 * each fails hard on its own (measured on the host stack, not assumed):
 * - a READY USER-scope provider connection **and** a user llm profile: without both,
 *   `POST /workspaces/{id}/sessions` answers 409 `LLM_PROFILE_CONFLICT`;
 * - a bound agent principal: a Session must carry `agentPrincipalId` (400 `INVALID_REQUEST`
 *   otherwise), and creation + binding are two calls;
 * - the Session itself, seeded through the API — the documented route in `helpers/chat.ts` for
 *   tests that need a live composer.
 */
async function seedChatFixture(
    request: APIRequestContext,
    authToken: string,
): Promise<ChatFixture> {
    const workspaceId = await seedWorkspace(request, authToken);
    await ensureFakeUserProvider(request, { accessToken: authToken, workspaceId });

    const headers = {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
        // D21: WORKSPACE-scope principal creation takes the workspace context via header.
        "X-Workspace-Id": workspaceId,
    };
    // PLAN-0661: principal names are `^[A-Za-z\u4e00-\u9fff][A-Za-z0-9\u4e00-\u9fff]*$`;
    // agentName() is the e2e single implementation (a kebab-case name is 400 INVALID_NAME_FORMAT).
    const created = await request.post(`${CP_URL}/api/v1/agent-principals`, {
        headers,
        data: { name: agentName("ChatFixture", Date.now()) },
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
        data: { title: `chat-fixture-${Date.now()}`, agentPrincipalId: principalId },
    });
    expect(session.status(), await session.text()).toBe(201);
    const { id: sessionId } = (await session.json()) as { id?: string };
    expect(sessionId, "session id must be returned").toBeTruthy();
    return { authToken, workspaceId, sessionId: sessionId as string };
}

test.describe("Chat — Real Backend", () => {
    let fixture: ChatFixture;

    test.beforeAll(async ({ request }) => {
        const r = await request.post(`${CP_URL}/api/v1/auth/register`, {
            data: {
                email: `real-chat-${Date.now()}@test.com`,
                password: SHARED_PASSWORD,
                name: "ChatTest",
            },
        });
        // A register without a token must fail here: keeping an empty token would turn every
        // downstream assertion into "the page has no composer", hiding the actual cause.
        expect([200, 201], `register: ${r.status()} ${await r.text()}`).toContain(r.status());
        const body = (await r.json()) as { accessToken?: string };
        expect(body.accessToken, "register must return an access token").toBeTruthy();
        fixture = await seedChatFixture(request, body.accessToken as string);
    });

    test.beforeEach(async ({ page }) => {
        await page.addInitScript((t) => {
            localStorage.setItem("xihe-token", t);
        }, fixture.authToken);
        // Workspace context is tab-scoped (sessionStorage `xihe-workspace`); this legacy
        // localStorage seed is migrated on boot. Without it `/workspace` renders the picker.
        await page.addInitScript(
            (ws) => localStorage.setItem("xihe-workspace", JSON.stringify(ws)),
            { id: fixture.workspaceId, name: "e2e-chat-fixture" },
        );
        await gotoWorkspaceWithChat(page);
    });

    test("chat page renders with sidebar and input area", async ({ page }) => {
        // task-49 acceptance ③: prove the composer is reached *inside the seeded workspace*,
        // not on some page state that merely happens to contain a textarea.
        await expect(
            page.getByTestId(`sidebar-workspace-group-${fixture.workspaceId}`),
            "the seeded workspace must be the page's active workspace",
        ).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        await expect(page.locator("textarea")).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        await expectPlatformScreenshot(page, "real-chat-page.png");
    });

    test("creates new session and shows in sidebar", async ({ page }) => {
        const sidebar = page.locator("aside").first();
        await expect(sidebar).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        // New session button
        const newBtn = page
            .locator("button")
            .filter({ hasText: /new|新建/i })
            .first();
        if ((await newBtn.count()) > 0) {
            await newBtn.click();
            await page.waitForTimeout(500);
            await expectPlatformScreenshot(page, "real-chat-new-session.png");
        }
    });
});
