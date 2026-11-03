import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { generateE2EPassword } from "./helpers/password";
import { isolatedWorkspaceHostPath } from "./helpers/workspace";

const SHARED_PASSWORD = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword(),
    CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`,
    ALPHA_FILE = "alpha-root-a.md",
    BETA_FILE = "beta-root-b.md";

/** PLAN-0639 OpenAPI `Workspace.roots` projection: ordered [{id, alias, position}]. */
type WorkspaceRootView = {
    id?: string;
    alias?: string | null;
    position?: number;
};

type WorkspaceView = {
    id?: string;
    storageMode?: string;
    executionMode?: string;
    hostPath?: string | null;
    roots?: WorkspaceRootView[];
};

/**
 * PLAN-0639 M1 design.md §6 判据 6（real profile）：
 * 建双根工作区 → 树分组渲染 → 动作后截图复核。
 *
 * 覆盖三层证据：
 * 1. wire 契约 —— POST /workspaces 带 roots[]（与 hostPath 互斥），响应按 OpenAPI Workspace
 *    schema 携带有序 roots 投影（Root[0].id == workspace.id 主根不变式）；
 * 2. 根 CRUD —— POST /roots 增根（201 + id/alias/position），DELETE /roots/{rootId} 删根（204）；
 * 3. UI —— 注册 → 登录表单 → 打开工作区 → 文件树渲染 → 动作（打开文件）后截图；
 *    分组根渲染的验收断言 = 第二根文件在树中可见（设计 §5 候选①「分组根」的最小可判定形态）。
 *
 * 截图产物（相对 packages/ui）：test-results/plan0639-multi-root-*.png
 */
async function registerUser(
    request: APIRequestContext,
    tag: string,
): Promise<{ email: string; token: string }> {
    const email = `plan0639-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.com`,
        r = await request.post(`${CP_URL}/api/v1/auth/register`, {
            data: { email, password: SHARED_PASSWORD, name: "Plan0639" },
        });
    expect(r.status(), `register failed: ${r.status} ${await r.text()}`).toBe(201);
    const body = (await r.json()) as { accessToken?: string };
    expect(body.accessToken, "register must return an access token").toBeTruthy();
    return { email, token: body.accessToken! };
}

/** Windows 路径比较必须先归一化（转正斜杠 + 小写）再比（workspace 硬规则）。 */
function normalizeWinPath(value: string): string {
    return value.replace(/\\/g, "/").toLowerCase();
}

/**
 * 两个隔离临时根目录（主/次），各放一个指纹文件，供树渲染与分组断言使用。
 * 注意：isolatedWorkspaceHostPath() 以 Date.now() 命名，同一毫秒内两次调用会拿到
 * 同一路径 —— rootB 必须另加随机后缀，否则「增根」会变成重复路径（DB 唯一键拒绝）。
 */
function seedRootPair(): { rootA: string; rootB: string } {
    const rootA = isolatedWorkspaceHostPath(),
        rootB = path.join(
            path.dirname(rootA),
            `${path.basename(rootA)}-b${Math.floor(Math.random() * 1e6)}`,
        );
    mkdirSync(rootB, { recursive: true });
    writeFileSync(path.join(rootA, ALPHA_FILE), "# Alpha Root A\n\nSeeded by plan0639 spec.\n");
    writeFileSync(path.join(rootB, BETA_FILE), "# Beta Root B\n\nSeeded by plan0639 spec.\n");
    return { rootA, rootB };
}

async function createSingleRootWorkspace(
    request: APIRequestContext,
    token: string,
    rootA: string,
): Promise<WorkspaceView> {
    const created = await request.post(`${CP_URL}/api/v1/workspaces`, {
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "Idempotency-Key": globalThis.crypto.randomUUID(),
        },
        data: {
            name: `plan0639-multi-root-${Date.now()}`,
            storageMode: "direct_attach",
            roots: [{ path: rootA, alias: "alpha" }],
            executionMode: "windows-host",
        },
    });
    const text = await created.text();
    expect(
        created.status(),
        `create workspace with roots[] failed: ${created.status()} ${text}`,
    ).toBe(201);
    return JSON.parse(text) as WorkspaceView;
}

async function addRoot(
    request: APIRequestContext,
    token: string,
    input: { wsId: string; rootPath: string; alias: string },
): Promise<{ status: number; body: WorkspaceRootView & { raw: string } }> {
    const r = await request.post(`${CP_URL}/api/v1/workspaces/${input.wsId}/roots`, {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        data: { path: input.rootPath, alias: input.alias },
    });
    const raw = await r.text();
    let body: WorkspaceRootView = {};
    try {
        body = JSON.parse(raw) as WorkspaceRootView;
    } catch {
        // 非 JSON 错误体：保留 raw，交由断言失败信息呈现
    }
    return { status: r.status(), body: { ...body, raw } };
}

async function getWorkspace(
    request: APIRequestContext,
    token: string,
    wsId: string,
): Promise<WorkspaceView> {
    const r = await request.get(`${CP_URL}/api/v1/workspaces/${wsId}`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    expect(r.status(), `GET workspace failed: ${r.status} ${await r.text()}`).toBe(200);
    return (await r.json()) as WorkspaceView;
}

/** 真实登录表单（localMode 栈上已证可行，见 goldpath G2-a）。 */
async function loginViaForm(page: Page, email: string): Promise<void> {
    await page.goto("/login", { waitUntil: "load" });
    // 当前 LoginView 的账号输入框 name="identifier"（PLAN-0565 ruling #7：email 或 username）。
    await page.fill('input[name="identifier"]', email);
    await page.fill('input[type="password"]', SHARED_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/workspace/, { timeout: 15000 });
}

test.describe("@host PLAN-0639 M1 — multi-root workspace (roots[] wire)", () => {
    let token = "";

    test.beforeAll(async ({ request }) => {
        const user = await registerUser(request, "suite");
        token = user.token;
    });

    test("create direct_attach workspace with roots[] carries ordered roots projection", async ({
        request,
    }) => {
        const { rootA } = seedRootPair(),
            ws = await createSingleRootWorkspace(request, token, rootA);

        expect(ws.id, "workspace id must be present").toMatch(/^[0-9a-f-]{36}$/i);
        expect(ws.storageMode).toBe("direct_attach");
        expect(ws.executionMode).toBe("windows-host");
        expect(
            normalizeWinPath(ws.hostPath ?? ""),
            "owner must see the primary root host path (CP 回显 canonical 小写路径，按归一化比较)",
        ).toBe(normalizeWinPath(rootA));

        // OpenAPI Workspace schema (PLAN-0639 M1): roots = ordered [{id, alias, position}],
        // Root[0].id == workspace.id (primary root invariant).
        expect(
            Array.isArray(ws.roots),
            `Workspace response must carry the ordered roots projection (OpenAPI Workspace.roots); actual keys: ${Object.keys(ws).join(",")}`,
        ).toBe(true);
        expect(ws.roots).toHaveLength(1);
        expect(ws.roots![0]!.id).toBe(ws.id);
        expect(ws.roots![0]!.alias).toBe("alpha");
        expect(ws.roots![0]!.position).toBe(0);
    });

    test("POST /roots adds a second root and returns 201 with id/alias/position", async ({
        request,
    }) => {
        const { rootA, rootB } = seedRootPair(),
            ws = await createSingleRootWorkspace(request, token, rootA),
            added = await addRoot(request, token, { wsId: ws.id!, rootPath: rootB, alias: "beta" });

        expect(added.status, `add root failed: ${added.status} ${added.body.raw}`).toBe(201);
        expect(added.body.id, "added root must return an id").toMatch(/^[0-9a-f-]{36}$/i);
        expect(added.body.id).not.toBe(ws.id);
        expect(added.body.alias).toBe("beta");
        expect(added.body.position).toBe(1);
    });

    test("DELETE /roots/{rootId} removes the second root with 204", async ({ request }) => {
        const { rootA, rootB } = seedRootPair(),
            ws = await createSingleRootWorkspace(request, token, rootA),
            added = await addRoot(request, token, { wsId: ws.id!, rootPath: rootB, alias: "beta" });
        expect(added.status, `add root precondition failed: ${added.body.raw}`).toBe(201);

        const del = await request.delete(
            `${CP_URL}/api/v1/workspaces/${ws.id}/roots/${added.body.id}`,
            { headers: { Authorization: `Bearer ${token}` } },
        );
        expect(del.status(), `delete root failed: ${del.status} ${await del.text()}`).toBe(204);
    });

    test("workspace view exposes the ordered two-root projection after add-root", async ({
        request,
    }) => {
        const { rootA, rootB } = seedRootPair(),
            ws = await createSingleRootWorkspace(request, token, rootA),
            added = await addRoot(request, token, { wsId: ws.id!, rootPath: rootB, alias: "beta" });
        expect(added.status, `add root precondition failed: ${added.body.raw}`).toBe(201);

        const view = await getWorkspace(request, token, ws.id!);
        expect(
            Array.isArray(view.roots),
            `workspace view must carry roots[] after add-root; actual: ${JSON.stringify(view).slice(0, 400)}`,
        ).toBe(true);
        expect(view.roots).toHaveLength(2);
        expect(view.roots!.map((r) => r.position)).toEqual([0, 1]);
        expect(view.roots!.map((r) => r.alias)).toEqual(["alpha", "beta"]);
        expect(view.roots![0]!.id).toBe(ws.id);
        expect(view.roots![1]!.id).toBe(added.body.id);
    });

    test("UI: login → open multi-root workspace → tree renders roots; action screenshots", async ({
        page,
        request,
    }) => {
        // 独立用户：登录回写 tab 上下文时工作区唯一，避免 WORKSPACE_CONTEXT_CONFLICT 干扰树验收。
        const user = await registerUser(request, "ui"),
            { rootA, rootB } = seedRootPair(),
            ws = await createSingleRootWorkspace(request, user.token, rootA),
            added = await addRoot(request, user.token, {
                wsId: ws.id!,
                rootPath: rootB,
                alias: "beta",
            });
        expect(added.status, `add root precondition failed: ${added.body.raw}`).toBe(201);

        await loginViaForm(page, user.email);
        await page.goto(`/workspace/${ws.id}`, { waitUntil: "load" });

        // 实测（trace 证据）：表单登录后直达 /workspace/:id 时，FileTreePanel 的 onMounted
        // loadTree 可能早于 auth.selectWorkspace 完成 → 静默空树（无 list_directory 请求、
        // 无错误态）。用户可点的「刷新文件树」是合法的真实动作，点击后树即加载 —— 这既让
        // 截图建立在真实加载链上，也把上述时序缺口留在证据里（见最终报告）。
        const refreshTree = page.getByTestId("workspace-file-refresh");
        await expect(refreshTree).toBeVisible({ timeout: 15000 });
        await refreshTree.click();

        // 主根文件必须先可见 —— 这是树的基线渲染能力（也是截图的合格前提）。
        const alphaEntry = page.getByRole("button", { name: ALPHA_FILE, exact: true });
        await expect(alphaEntry).toBeVisible({ timeout: 20000 });
        await page.screenshot({ path: "test-results/plan0639-multi-root-tree.png" });

        // 动作后截图复核：打开主根文件，编辑器呈现内容。
        await alphaEntry.click();
        await expect(page.locator("text=Alpha Root A").first()).toBeVisible({ timeout: 15000 });
        await page.screenshot({ path: "test-results/plan0639-multi-root-file-open.png" });

        // 分组根验收（design §5 候选①）：第二根的文件必须在树中可到达/可见。
        // M1 若未实现树分组渲染，此断言红 = 产品缺口如实呈现。
        const betaEntry = page.getByRole("button", { name: BETA_FILE, exact: true });
        await expect(
            betaEntry,
            `second-root file ${BETA_FILE} must be reachable in the grouped file tree ` +
                `(design.md §5 candidate ① 分组根); primary root file ${ALPHA_FILE} rendered fine`,
        ).toBeVisible({ timeout: 15000 });
    });
});
