import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { generateE2EPassword } from "./helpers/password";
import { CP_URL, evidenceDir } from "./helpers/journey";
import { provisionWorkspaceAgentPrincipal } from "./helpers/agent-principal";

// PLAN-0608 M3 — C′ 会话归属的**浏览器侧**证据。
// 判据映射（编号以 `plans/PLAN-0608-XH-session-workspace-ownership/verify.md` V10 原文为准）：
//   test 1 → V2 硬断言（必修 4）：登录后「未导航前」tab 上下文不存在/未选择
//   test 2 → V2 正向（UI 主路径建会话落 target，且正常路径无 400/409）；V10 ①③ 的 UI 形态
//   test 3 → V5：0559 多标签隔离不回归 + 登出清理 + 再登录不继承
//   test 4 → V6 / T3.1：双 `browser.newContext()`，B、C 同进 workspace A 各自建会话
// 网络断言口径（Lead 2026-10-31 裁定）：**以浏览器侧 page.on("response") 为准**，
// CP 侧 API 查询只作交叉佐证，不得单独作为「UI 发出了什么」的证据。
// 跑法：见 `.local/xh-m3-browser-batch-plan.md` §9（`--persistent` 起栈 + `XIHE_E2E_EXTERNAL_SERVER=1`）。

const SHARED_PASSWORD = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword();
const LLM_MODE = process.env.XIHE_E2E_LLM_MODE ?? "mock";
const EVIDENCE = evidenceDir("plan-0608-browser");

type Account = {
    accessToken: string;
    workspaceId: string;
    userId: string;
    email: string;
    username: string;
};

async function registerAccount(request: APIRequestContext, name: string): Promise<Account> {
    const username = `${name}${Date.now().toString(36).slice(-5)}`;
    const email = `${username}@test.com`;
    const reg = await request.post(`${CP_URL}/api/v1/auth/register`, {
        data: { email, password: SHARED_PASSWORD, username },
    });
    expect(
        [200, 201],
        `register ${username} failed: ${reg.status()} ${await reg.text()}`,
    ).toContain(reg.status());
    const body = (await reg.json()) as {
        accessToken: string;
        workspaceId: string;
        user?: { id?: string };
        userId?: string;
    };
    const userId = body.user?.id ?? body.userId;
    expect(userId, "register must return the user id").toBeTruthy();
    return {
        accessToken: body.accessToken,
        workspaceId: body.workspaceId,
        userId: userId as string,
        email,
        username,
    };
}

async function addMember(
    request: APIRequestContext,
    owner: Account,
    workspaceId: string,
    username: string,
    role: "EDITOR" | "VIEWER" = "EDITOR",
): Promise<void> {
    const res = await request.post(`${CP_URL}/api/v1/workspaces/${workspaceId}/members`, {
        headers: { Authorization: `Bearer ${owner.accessToken}` },
        data: { username, role },
    });
    expect([200, 201], `add member failed: ${res.status()} ${await res.text()}`).toContain(
        res.status(),
    );
}

/**
 * 构造「B 的回退 workspace ≠ 目标 workspace」：
 * 先注册 B（wsB 最早创建），再注册 G，G 把 B 加进 wsG 为 EDITOR ⇒ 回退 = wsB，target = wsG。
 * 硬门 1（比 createdAt 更强）= `GET /workspaces/current`(B) == wsB 且 ≠ target；
 * 硬门 2 = `createdAt(target) > createdAt(fallback)`。任一不成立即判构造失败。
 */
async function buildTwoWorkspaceFixture(request: APIRequestContext) {
    const b = await registerAccount(request, "p0608b");
    const g = await registerAccount(request, "p0608g");
    const targetWs = g.workspaceId;
    await addMember(request, g, targetWs, b.username, "EDITOR");

    const current = await request.get(`${CP_URL}/api/v1/workspaces/current`, {
        headers: { Authorization: `Bearer ${b.accessToken}` },
    });
    expect(current.ok(), await current.text()).toBe(true);
    const fallback = ((await current.json()) as { id: string }).id;
    expect(fallback, "B 的回退 workspace 必须是 wsB").toBe(b.workspaceId);
    expect(fallback, "回退值必须 ≠ target，否则本批结论无效").not.toBe(targetWs);

    const list = await request.get(`${CP_URL}/api/v1/workspaces`, {
        headers: { Authorization: `Bearer ${b.accessToken}` },
    });
    expect(list.ok(), await list.text()).toBe(true);
    const workspaces = (await list.json()) as unknown as { id: string; createdAt: string }[];
    const createdAt = (id: string) =>
        workspaces.find((w) => w.id === id)?.createdAt ?? "1970-01-01T00:00:00Z";
    expect(
        Date.parse(createdAt(targetWs)),
        `CONSTRUCTION_FAILED: createdAt(target)=${createdAt(targetWs)} 必须晚于 createdAt(fallback)=${createdAt(b.workspaceId)}`,
    ).toBeGreaterThan(Date.parse(createdAt(b.workspaceId)));

    const principalId = await provisionWorkspaceAgentPrincipal(
        request,
        { accessToken: g.accessToken, workspaceId: targetWs },
        { name: `p0608-agent-${Date.now().toString(36).slice(-5)}` },
    );

    return { b, g, fallback, targetWs, principalId };
}

type SessionCall = { method: string; path: string; status: number };

/** 浏览器侧会话相关请求记录器（判据以它为准）。 */
function trackSessionCalls(page: Page): SessionCall[] {
    const calls: SessionCall[] = [];
    page.on("response", (response) => {
        const pathname = new URL(response.url()).pathname;
        if (!/^\/api\/v1\/(workspaces\/[^/]+\/)?sessions$/.test(pathname)) return;
        calls.push({
            method: response.request().method(),
            path: pathname,
            status: response.status(),
        });
    });
    return calls;
}

async function loginThroughUi(page: Page, email: string): Promise<void> {
    await page.goto("/login");
    await page.fill('input[name="identifier"]', email);
    await page.fill('input[name="password"]', SHARED_PASSWORD);
    await page.press('input[name="password"]', "Enter");
    await expect(page).toHaveURL(/\/workspace(?!\/)/);
}

async function tabContext(page: Page): Promise<{ id?: string } | null> {
    return page.evaluate(() => JSON.parse(sessionStorage.getItem("xihe-workspace") ?? "null"));
}

async function createSessionThroughUi(page: Page, workspaceId: string, principalId: string) {
    await page.getByTestId("workspace-create-session").click();
    const principalSelect = page.getByTestId("workspace-agent-principal-select");
    await expect(principalSelect).toBeVisible();
    await principalSelect.selectOption(principalId);
    const created = page.waitForResponse(
        (response) =>
            response.request().method() === "POST" &&
            new URL(response.url()).pathname === `/api/v1/workspaces/${workspaceId}/sessions`,
    );
    await page.getByTestId("workspace-create-agent-session").click();
    return created;
}

test.describe("@host PLAN-0608 — C′ 会话归属的浏览器侧证据", () => {
    test.skip(LLM_MODE === "missing", "missing 模式无可选模型，UI 无法建会话");

    test("1. [V2 硬断言] 登录后未导航前 tab 上下文不存在（不得是回退值）", async ({
        page,
        request,
    }) => {
        test.setTimeout(180_000);
        const { b } = await buildTwoWorkspaceFixture(request);
        const calls = trackSessionCalls(page);

        await loginThroughUi(page, b.email);

        expect(
            await page.evaluate(() => sessionStorage.getItem("xihe-workspace")),
            "登录不得把回退值写进 tab 上下文（I6）",
        ).toBeNull();
        expect(new URL(page.url()).pathname, "未选择前应停在选择面路由").toBe("/workspace");
        await expect(page.getByTestId("workspace-picker")).toBeVisible();
        await expect(page.getByTestId(`workspace-picker-item-${b.workspaceId}`)).toBeVisible();
        expect(
            calls.filter((c) => c.method === "POST"),
            "选择面阶段不得建会话",
        ).toHaveLength(0);

        await page.screenshot({ path: `${EVIDENCE}/01-picker-no-context.png` });
    });

    test("2. [V2 正向 / V10 ①③] 选非回退 ws 后，UI 建会话走路径形式并落在该 ws", async ({
        page,
        request,
    }) => {
        test.setTimeout(240_000);
        const { b, targetWs, principalId } = await buildTwoWorkspaceFixture(request);
        const calls = trackSessionCalls(page);

        await loginThroughUi(page, b.email);
        await page.getByTestId(`workspace-picker-item-${targetWs}`).click();
        await expect(page).toHaveURL(new RegExp(`/workspace/${targetWs}`));
        expect((await tabContext(page))?.id, "选择后 tab 上下文必须是目标 ws").toBe(targetWs);

        const response = await createSessionThroughUi(page, targetWs, principalId);
        expect(response.status(), await response.text()).toBe(201);
        const session = (await response.json()) as { id: string; workspaceId: string };
        expect(session.workspaceId, "会话必须落在目标 ws").toBe(targetWs);

        const bad = calls.filter((c) => c.status === 400 || c.status === 409);
        expect(bad, `UI 正常路径不得出现 400/409：${JSON.stringify(bad)}`).toHaveLength(0);

        // 交叉佐证（不作判据）：目标 ws 可见、回退 ws 不可见
        const headers = { Authorization: `Bearer ${b.accessToken}` };
        const inTarget = await request.get(`${CP_URL}/api/v1/sessions`, {
            headers: { ...headers, "X-Workspace-Id": targetWs },
        });
        const targetIds = ((await inTarget.json()) as { sessions: { id: string }[] }).sessions.map(
            (s) => s.id,
        );
        expect(targetIds).toContain(session.id);
        const inFallback = await request.get(`${CP_URL}/api/v1/sessions`, {
            headers: { ...headers, "X-Workspace-Id": b.workspaceId },
        });
        const fallbackIds = (
            (await inFallback.json()) as { sessions: { id: string }[] }
        ).sessions.map((s) => s.id);
        expect(fallbackIds).not.toContain(session.id);

        await page.screenshot({ path: `${EVIDENCE}/02-session-in-target.png` });
    });

    test("3. [V5] 多标签隔离；登出清空 tab 上下文；再登录不继承", async ({
        page,
        context,
        request,
    }) => {
        test.setTimeout(240_000);
        const { b, targetWs } = await buildTwoWorkspaceFixture(request);

        await loginThroughUi(page, b.email);
        await page.getByTestId(`workspace-picker-item-${b.workspaceId}`).click();
        await expect(page).toHaveURL(new RegExp(`/workspace/${b.workspaceId}`));

        // 同 context 的第二 tab：共享登录态，但 sessionStorage 逐 tab 隔离
        const second = await context.newPage();
        await second.goto("/workspace");
        await second.getByTestId(`workspace-picker-item-${targetWs}`).click();
        await expect(second).toHaveURL(new RegExp(`/workspace/${targetWs}`));

        expect((await tabContext(page))?.id, "tab1 上下文").toBe(b.workspaceId);
        expect((await tabContext(second))?.id, "tab2 上下文").toBe(targetWs);

        // 登出：清空并回登录页
        await page.getByRole("button", { name: "退出登录" }).click();
        await expect(page).toHaveURL(/\/login/);
        expect(await page.evaluate(() => sessionStorage.getItem("xihe-workspace"))).toBeNull();
        await second.close();

        // 再登录不继承上一次选择
        await loginThroughUi(page, b.email);
        expect(
            await page.evaluate(() => sessionStorage.getItem("xihe-workspace")),
            "重新登录后不得继承上一次选择",
        ).toBeNull();
        await expect(page.getByTestId("workspace-picker")).toBeVisible();
    });

    test("4. [V6 / T3.1] 双上下文：B、C 同进 workspace A 各建会话，均落 A", async ({
        browser,
        request,
    }) => {
        test.setTimeout(300_000);
        const owner = await registerAccount(request, "p0608a0");
        const workspaceA = owner.workspaceId;
        const b = await registerAccount(request, "p0608bb");
        const c = await registerAccount(request, "p0608cc");
        await addMember(request, owner, workspaceA, b.username, "EDITOR");
        await addMember(request, owner, workspaceA, c.username, "EDITOR");
        const principalId = await provisionWorkspaceAgentPrincipal(
            request,
            { accessToken: owner.accessToken, workspaceId: workspaceA },
            { name: `p0608-a-agent-${Date.now().toString(36).slice(-5)}` },
        );

        const results: { label: string; sessionId: string; workspaceId: string }[] = [];

        for (const account of [
            { label: "B", ...b },
            { label: "C", ...c },
        ]) {
            const ctx = await browser.newContext();
            const page = await ctx.newPage();
            const calls = trackSessionCalls(page);

            await loginThroughUi(page, account.email);
            await page.getByTestId(`workspace-picker-item-${workspaceA}`).click();
            await expect(page).toHaveURL(new RegExp(`/workspace/${workspaceA}`));

            const response = await createSessionThroughUi(page, workspaceA, principalId);
            expect(response.status(), await response.text()).toBe(201);
            const session = (await response.json()) as { id: string; workspaceId: string };
            results.push({
                label: account.label,
                sessionId: session.id,
                workspaceId: session.workspaceId,
            });

            expect(
                calls.filter((x) => x.status === 404),
                `${account.label} 上下文出现 404：${JSON.stringify(calls)}`,
            ).toHaveLength(0);
            expect(
                calls.filter((x) => x.status === 400 || x.status === 409),
                `${account.label} 上下文出现 400/409：${JSON.stringify(calls)}`,
            ).toHaveLength(0);

            await page.screenshot({ path: `${EVIDENCE}/04-context-${account.label}.png` });
            await ctx.close();
        }

        expect(results).toHaveLength(2);
        for (const r of results) expect(r.workspaceId, `${r.label} 的会话落点`).toBe(workspaceA);
        expect(results[0].sessionId).not.toBe(results[1].sessionId);

        // 交叉佐证：B 的会话不得被 C 读到（同一 workspace，不同 user）
        const crossRead = await request.get(`${CP_URL}/api/v1/sessions/${results[0].sessionId}`, {
            headers: {
                Authorization: `Bearer ${c.accessToken}`,
                "X-Workspace-Id": workspaceA,
            },
        });
        expect(crossRead.status(), "B 的会话不得被 C 读到").toBe(404);
    });

    // ─────────────────── 以下是 **API 级**补测（不需要浏览器） ───────────────────
    // 依据 Lead 2026-10-31 指令补齐 verify 剩余便宜项：V3 三形态、V4 幂等 + 零成员、V1 列表隔离。
    // 判据取自 `verify.md` V1/V3/V4 原文，不新增判据。

    test("5. [V3 单成员零回归] 三种调用形态均 201 且落在唯一 ws", async ({ request }) => {
        test.setTimeout(120_000);
        const solo = await registerAccount(request, "p0608solo");
        const principalId = await provisionWorkspaceAgentPrincipal(
            request,
            { accessToken: solo.accessToken, workspaceId: solo.workspaceId },
            { name: `p0608-solo-agent-${Date.now().toString(36).slice(-5)}` },
        );
        const body = { agentPrincipalId: principalId };
        const headers = { Authorization: `Bearer ${solo.accessToken}` };
        const results: { form: string; status: number; workspaceId?: string }[] = [];

        const noInput = await request.post(`${CP_URL}/api/v1/sessions`, { headers, data: body });
        results.push({
            form: "无输入（legacy）",
            status: noInput.status(),
            workspaceId: ((await noInput.json()) as { workspaceId?: string }).workspaceId,
        });

        const headerOnly = await request.post(`${CP_URL}/api/v1/sessions`, {
            headers: { ...headers, "X-Workspace-Id": solo.workspaceId },
            data: body,
        });
        results.push({
            form: "只带 X-Workspace-Id",
            status: headerOnly.status(),
            workspaceId: ((await headerOnly.json()) as { workspaceId?: string }).workspaceId,
        });

        const pathForm = await request.post(
            `${CP_URL}/api/v1/workspaces/${solo.workspaceId}/sessions`,
            { headers, data: body },
        );
        results.push({
            form: "路径形式",
            status: pathForm.status(),
            workspaceId: ((await pathForm.json()) as { workspaceId?: string }).workspaceId,
        });

        for (const r of results) {
            expect(r.status, `${r.form} 必须 201：${JSON.stringify(results)}`).toBe(201);
            expect(r.workspaceId, `${r.form} 必须落在唯一 ws`).toBe(solo.workspaceId);
        }
        expect(
            results.filter((r) => r.status === 409 || r.status === 400),
            `单成员三形态不得出现 409/400：${JSON.stringify(results)}`,
        ).toHaveLength(0);
    });

    test("6. [V4 无输入确定性] 多成员连发 3 次都是 409 且行数不变；零成员按 V4 降级", async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const { b, fallback } = await buildTwoWorkspaceFixture(request);
        const headers = { Authorization: `Bearer ${b.accessToken}` };

        const countSessions = async () => {
            const res = await request.get(`${CP_URL}/api/v1/sessions`, {
                headers: { ...headers, "X-Workspace-Id": fallback },
            });
            expect(res.ok(), await res.text()).toBe(true);
            return ((await res.json()) as { sessions: unknown[] }).sessions.length;
        };

        const before = await countSessions();
        const statuses: number[] = [];
        const codes: string[] = [];
        for (let i = 0; i < 3; i += 1) {
            const res = await request.post(`${CP_URL}/api/v1/sessions`, { headers, data: {} });
            statuses.push(res.status());
            codes.push(((await res.json()) as { code?: string }).code ?? "");
        }
        const after = await countSessions();

        expect(statuses, `连发 3 次必须都是 409：${JSON.stringify({ statuses, codes })}`).toEqual([
            409, 409, 409,
        ]);
        expect(codes, "三次都必须是 WORKSPACE_CONTEXT_REQUIRED").toEqual([
            "WORKSPACE_CONTEXT_REQUIRED",
            "WORKSPACE_CONTEXT_REQUIRED",
            "WORKSPACE_CONTEXT_REQUIRED",
        ]);
        expect(after, `会话行数必须不变（前 ${before} / 后 ${after}）`).toBe(before);
    });

    // 零成员（verify V4 原文允许降级）：登录路径会自动建默认 workspace
    // （`AuthController#withDefaultWorkspace` → `getOrCreateDefaultWorkspace`），
    // 故产品路径**不可构造**「0 个成员 ws 的已登录用户」；该态由
    // `SessionWorkspaceResolverTest`（no-input + memberCount=0 → USE(null) → 下游 401）单测覆盖。
    test("6b. [V4 零成员 → 401] 产品路径不可构造，按 verify V4 降级为单测覆盖", () => {
        test.skip(
            true,
            "零成员态不可构造（登录自动 getOrCreateDefaultWorkspace），已由 SessionWorkspaceResolverTest 覆盖",
        );
    });

    test("7. [V1 列表隔离] 同一 ws 内 B/C 的会话列表互不包含对方", async ({ request }) => {
        test.setTimeout(180_000);
        const owner = await registerAccount(request, "p0608v1a");
        const workspaceA = owner.workspaceId;
        const b = await registerAccount(request, "p0608v1b");
        const c = await registerAccount(request, "p0608v1c");
        await addMember(request, owner, workspaceA, b.username, "EDITOR");
        await addMember(request, owner, workspaceA, c.username, "EDITOR");
        const principalId = await provisionWorkspaceAgentPrincipal(
            request,
            { accessToken: owner.accessToken, workspaceId: workspaceA },
            { name: `p0608-v1-agent-${Date.now().toString(36).slice(-5)}` },
        );

        const createInA = async (account: typeof b) => {
            const res = await request.post(`${CP_URL}/api/v1/workspaces/${workspaceA}/sessions`, {
                headers: { Authorization: `Bearer ${account.accessToken}` },
                data: { agentPrincipalId: principalId, title: `v1-${account.username}` },
            });
            expect(res.status(), await res.text()).toBe(201);
            return ((await res.json()) as { id: string }).id;
        };
        const sessionB = await createInA(b);
        const sessionC = await createInA(c);

        const listFor = async (account: typeof b) => {
            const res = await request.get(`${CP_URL}/api/v1/sessions`, {
                headers: {
                    Authorization: `Bearer ${account.accessToken}`,
                    "X-Workspace-Id": workspaceA,
                },
            });
            expect(res.ok(), await res.text()).toBe(true);
            return ((await res.json()) as { sessions: { id: string }[] }).sessions.map((s) => s.id);
        };

        const listB = await listFor(b);
        const listC = await listFor(c);
        expect(listB, "B 的列表必须含自己的会话").toContain(sessionB);
        expect(listB, "B 的列表不得含 C 的会话").not.toContain(sessionC);
        expect(listC, "C 的列表必须含自己的会话").toContain(sessionC);
        expect(listC, "C 的列表不得含 B 的会话").not.toContain(sessionB);

        // 遗留（承接 L1/L2）：V1 的另一条「各跑一次纯 chat + 双 run 快照对照 user 层」
        // 需要 `--llm-mode=success` 与 run 配置快照比对，成本高，不在本批。
    });
});
