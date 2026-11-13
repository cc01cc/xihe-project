/**
 * task-63：**字段在 wire 上有 ≠ 行为对** —— 两条真链路用例，各带判别力对照。
 *
 * 来源：task-49 矩阵里「丢字段有副作用」的唯二两处，此前**都没有实测**。
 *
 * ## 为什么不能用单测代替
 *
 * 现有单测走的都是**直塞**（`SessionPolicyControls.spec.ts:140` 用 `$patch` 把 `canWrite` 塞进 store）。
 * 直塞绕过了 `normalizeWorkspace` ⇒「CP 说不可写」这条线整条是盲区。本文件从 `page.route` 的 wire 响应出发，
 * 经 `api.getWorkspace` → `normalizeWorkspace` → store → 组件，断言落在**用户能看见的控件**与
 * **真正发出去的字节**上。
 *
 * ## 三条防假绿
 *
 * 1. **线路必须真被走到**：页签上下文收窄成 `{ id }`（`bootFreshTab`），否则 `hydrateWorkspace`
 *    （`stores/auth.ts:461`）短路返回内存对象、`GET /workspaces/{id}` 连发都不发;那时 wire 写什么都到不了 UI。
 *    相关用例都断言 `detailHits`，把「wire 被读过」变成读数。
 * 2. **每条主用例都有同形对照**：description 有值 / 无值；canWrite `false` / `true` / 省略。
 *    没有对照的负断言分不清「判据活着」与「判据恒真」。
 * 3. **断言落在后果上**：description 断言 **PATCH 请求体**（覆盖发生在那一刻），canWrite 断言**控件的
 *    enabled/disabled 与按钮在不在**。
 *
 * ## 本文件的实测结论（2026-11-13，mock 车道）
 *
 * - **映射层是好的**：wire 的 `description` / `canWrite` 都完整进了 store 与页签上下文（第 1、4–6 条）。
 * - **但设置页的编辑态初始化与加载是脱钩的**：`WorkspaceSettingsView.vue:270-273` 的
 *   `onMounted(() => { startEdit(); void loadWorkspace(); })` 先跑 `startEdit()`、再**不等**它地拉工作区;
 *   `startEdit()`（`:206-210`）把 `editDescription` 初值取自 `auth.workspace?.description ?? ""`，
 *   之后**没有任何 watch 重新初始化**。于是在「挂载时 store 里的 workspace 还不带 description」的态下，
 *   输入框停在空串，而 `handleSave()`（`:218-221`）**无条件**发送 `description: editDescription.value.trim()`
 *   ⇒ 点保存即把既有描述覆盖成空串。第 2 条用例就是这一格的复现（标 `fixme`，属**产品缺陷**，本卡不解）。
 * - **入口缺口**：`/resources/**`、`/settings/**` 挂的是 `ResourcesLayout` / `SettingsLayout`（都不是
 *   `AppLayout`），而 `hydrateWorkspace()` 只在 `AppLayout.vue:307` 等页面内触发 ⇒ **直接从资源区落地时
 *   工作区投影一次都不取**，`canWriteWorkspace` 只能落到角色回落。第 7 条用例钉住这个现状。
 *
 * 已知边界：只覆盖 mock 车道（证不了「CP 真的会那么回」）；`GET` 的时序/竞态不在本文件范围。
 */
import { expect, test } from "./helpers/mock-test";
import type { Page } from "@playwright/test";
import { setupMockAuth } from "./helpers/auth";

const WORKSPACE_ID = "workspace-1",
    DESCRIPTION = "多根工作区（这条描述必须活下来）",
    MCP_CONFIG = { mcpServers: { "task63-demo": { command: "node", args: ["server.js"] } } };

/** wire 上我们关心的三个字段。省略 = 该字段**不出现在响应里**（正是要对照的那一态）。 */
interface WireShape {
    description?: string | null;
    workspaceRole?: "OWNER" | "EDITOR" | "VIEWER";
    canWrite?: boolean;
}

interface Probes {
    /** `GET /workspaces/{id}` 被产品代码真读了几次（防「wire 根本没被读」的假绿）。 */
    detailHits: { count: number };
    /** 保存时真正发出去的 PATCH 请求体（覆盖就发生在这些字节里）。 */
    patches: Record<string, unknown>[];
}

/**
 * 起一个**新鲜页签**（页签上下文只知道 id）并把 wire 桩好。
 *
 * 为什么收窄 seed：夹具默认 seed 是 `{ id, name, ownerId }`（`helpers/auth.ts:201-215`），
 * `hydrateWorkspace` 看到 id 命中且有 `ownerId` 就直接返回内存对象 —— 测试会变成「断言 seed 里的值」，
 * 而 seed 是我们自己写进去的（假链路）。收窄后 store 必须发 `GET /workspaces/{id}`。
 *
 * 这个形状不是凭空造的：`workspaceContext.migrateLegacyWorkspace()`（`lib/workspaceContext.ts:59-75`）
 * 把旧 localStorage 迁进页签时**只写 `{ id, name }`**，角色与 `canWrite` 都丢掉 —— 那是真实可达的态。
 */
async function bootFreshTab(page: Page, wire: WireShape): Promise<Probes> {
    await setupMockAuth(page);

    await page.addInitScript(() => {
        sessionStorage.setItem("xihe-workspace", JSON.stringify({ id: "workspace-1" }));
        localStorage.removeItem("xihe-workspace");
    });

    const probes: Probes = { detailHits: { count: 0 }, patches: [] };

    // 兜底先注册（Playwright：后注册者优先），保证下面的具名桩覆盖它。
    await page.route("**/api/v1/**", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
    );

    // 工作区外壳会拉会话列表；兜底的 `{}` 会让它报 "missing sessions" 并整页加载失败。
    await page.route(/\/api\/v1\/(?:workspaces\/[^/]+\/)?sessions(?:\?.*)?$/, (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ sessions: [] }),
        });
    });

    // 工作区详情 + 保存：**这一对是本文件的主角**。
    await page.route(`**/api/v1/workspaces/${WORKSPACE_ID}`, async (route) => {
        const request = route.request();
        if (request.method() === "PATCH") {
            const body = request.postDataJSON() as Record<string, unknown>;
            probes.patches.push(body);
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    id: WORKSPACE_ID,
                    name: typeof body.name === "string" ? body.name : "Mock Workspace",
                    description: body.description ?? null,
                    ownerId: "user-1",
                    workspaceRole: wire.workspaceRole ?? "OWNER",
                    ...(wire.canWrite === undefined ? {} : { canWrite: wire.canWrite }),
                }),
            });
            return;
        }
        probes.detailHits.count += 1;
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                id: WORKSPACE_ID,
                name: "Mock Workspace",
                ownerId: "user-1",
                storageBackend: "host_directory",
                storageRef: "/mock/workspace-1",
                storageMode: "direct_attach",
                executionMode: "windows-host",
                workspaceRole: wire.workspaceRole ?? "OWNER",
                ...(wire.description === undefined ? {} : { description: wire.description }),
                ...(wire.canWrite === undefined ? {} : { canWrite: wire.canWrite }),
            }),
        });
    });

    // MCP 配置读面：给**真实形状**，否则禁用的 textarea 里没有可读内容（「禁用」与「空壳」分不开）。
    await page.route(`**/api/v1/workspaces/${WORKSPACE_ID}/mcp-config`, (route) =>
        route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(MCP_CONFIG),
        }),
    );

    return probes;
}

const SETTINGS_URL = `/workspace/${WORKSPACE_ID}/settings`,
    MCP_DIRECT_URL = "/resources/mcp?layer=WORKSPACE";

/** 页签上下文里现在是什么（`hydrateWorkspace` 的 `writeTabWorkspace(current)` 写的就是**规范化后**的对象）。 */
async function tabWorkspace(page: Page): Promise<Record<string, unknown>> {
    const raw = await page.evaluate(() => sessionStorage.getItem("xihe-workspace"));
    return JSON.parse(raw ?? "{}") as Record<string, unknown>;
}

/**
 * 先在一个会 hydrate 的落点把工作区投影取回来，再**页内导航**到 MCP 资源页。
 *
 * 走的是产品自己的迁移链接（`WorkspaceSettingsView.vue:383-390` 的 `ws-settings-resource-moved-action`，
 * D-1023）：旧 `?tab=mcp` 深链 → 提示条 → 资源区。不用 `page.goto` 是因为那会整页重载、store 复位，
 * 而资源区**不会**再 hydrate（见文件头「入口缺口」）。
 */
async function hydrateThenOpenMcp(page: Page): Promise<void> {
    await page.goto(`${SETTINGS_URL}?tab=mcp`, { waitUntil: "load" });
    await expect(page.getByTestId("workspace-settings-page")).toBeVisible();
    await page.getByTestId("ws-settings-resource-moved-action").click();
    await expect(page).toHaveURL(/\/resources\/mcp\?layer=WORKSPACE/);
    await expect(page.getByTestId("resources-header")).toBeVisible();
}

test.describe("task-63 · wire 字段 → 行为（description / canWrite）", () => {
    test("description（映射层）：wire 的值经 normalize 后进了页签上下文", async ({ page }) => {
        const probes = await bootFreshTab(page, {
            description: DESCRIPTION,
            workspaceRole: "OWNER",
        });
        await page.goto(SETTINGS_URL, { waitUntil: "load" });
        await expect(page.getByTestId("workspace-settings-page")).toBeVisible();

        // ① 线路：wire 真被读过（否则下面读的是 seed）。
        await expect.poll(() => probes.detailHits.count).toBeGreaterThan(0);
        // ② 映射层没丢：`normalizeWorkspace` 的 `description` 分支（`api.ts:2126-2131`）把它带到了页签上下文。
        await expect.poll(() => tabWorkspace(page).then((ws) => ws.description)).toBe(DESCRIPTION);
    });

    test.fixme("description（验收流程 · 产品缺陷）：只改名字保存 —— 描述被覆盖成空串", async ({
        page,
    }) => {
        // 实测（2026-11-13，本文件）：`ws-settings-description-input` 的值是 **""**，
        // 而页签上下文里 `description` 明明有值（见上一条）。原因见文件头：
        // `startEdit()` 在 `onMounted` 里先于 `loadWorkspace()` 跑且此后不再初始化。
        // 卡面要求「测出真红 ⇒ 停手报 Lead，不自己修」⇒ 本条以 fixme 留在树里当判据，
        // 修好后把 `test.fixme` 换回 `test` 即可转红/转绿。
        const probes = await bootFreshTab(page, {
            description: DESCRIPTION,
            workspaceRole: "OWNER",
        });
        await page.goto(SETTINGS_URL, { waitUntil: "load" });
        await expect(page.getByTestId("workspace-settings-page")).toBeVisible();
        await expect.poll(() => probes.detailHits.count).toBeGreaterThan(0);

        const descriptionInput = page.getByTestId("ws-settings-description-input");
        await expect(descriptionInput).toBeVisible();
        await expect(descriptionInput).toHaveValue(DESCRIPTION);

        await page.getByTestId("ws-settings-name-input").fill("Renamed Mock Workspace");
        await page.getByTestId("ws-settings-save").click();
        await expect.poll(() => probes.patches.length).toBe(1);
        expect(probes.patches[0]).toMatchObject({
            name: "Renamed Mock Workspace",
            description: DESCRIPTION,
        });
    });

    test("description（判别力对照：wire 不带该字段）：同一路径确实会写成空串", async ({ page }) => {
        // 这一条**不是验收**，是判别力证明：`handleSave` 无条件发送 description，
        // 所以「字段没到 UI」的后果就是清空既有描述。上一条（fixme）红在同一处。
        const probes = await bootFreshTab(page, { workspaceRole: "OWNER" }),
            descriptionInput = page.getByTestId("ws-settings-description-input");
        await page.goto(SETTINGS_URL, { waitUntil: "load" });

        await expect(descriptionInput).toBeVisible();
        await expect(descriptionInput).toHaveValue("");

        await page.getByTestId("ws-settings-name-input").fill("Renamed Mock Workspace");
        await page.getByTestId("ws-settings-save").click();
        await expect.poll(() => probes.patches.length).toBe(1);
        expect(probes.patches[0]).toMatchObject({
            name: "Renamed Mock Workspace",
            description: "",
        });
    });

    test("canWrite（EDITOR + wire canWrite=false）：规范化后 MCP 写面只读", async ({ page }) => {
        const probes = await bootFreshTab(page, { workspaceRole: "EDITOR", canWrite: false }),
            textarea = page.getByTestId("mcp-config-textarea");
        await hydrateThenOpenMcp(page);

        // 线路自查：`canWrite` 只能来自 wire（seed 里没有它）。
        expect(probes.detailHits.count).toBeGreaterThan(0);

        // 写面在 DOM 且带读面内容 —— 只读 ≠ 空。
        await expect(textarea).toBeVisible();
        await expect(textarea).toHaveValue(/"task63-demo"/);
        // CP 说不可写 ⇒ 控件必须禁用；保存按钮按产品口径不渲染（`WorkspaceMcpPanel.vue:245`）。
        await expect(textarea).toBeDisabled();
        await expect(page.getByTestId("mcp-config-save")).toHaveCount(0);
    });

    test("canWrite（EDITOR + wire canWrite=true，阳性对照）：同一屏可写", async ({ page }) => {
        const textarea = page.getByTestId("mcp-config-textarea");
        await bootFreshTab(page, { workspaceRole: "EDITOR", canWrite: true });
        await hydrateThenOpenMcp(page);

        await expect(textarea).toBeVisible();
        await expect(textarea).toBeEnabled();
        await expect(page.getByTestId("mcp-config-save")).toBeVisible();
    });

    test("canWrite（EDITOR + wire 省略该字段，回落语义）：回落成可写", async ({ page }) => {
        // 钉住回落：`canWriteWorkspace = canWrite ?? workspaceRole !== "VIEWER"`（`stores/auth.ts:203-205`）
        // ⇒ 少了 wire 字段，CP 明确拒绝的 EDITOR 会显示为可写（按钮可点、CP 仍拒 = 假可用）。
        const textarea = page.getByTestId("mcp-config-textarea");
        await bootFreshTab(page, { workspaceRole: "EDITOR" });
        await hydrateThenOpenMcp(page);

        await expect(textarea).toBeVisible();
        await expect(textarea).toBeEnabled();
        await expect(page.getByTestId("mcp-config-save")).toBeVisible();
    });

    test("【入口缺口·现状】直接从资源区落地：工作区投影一次都不取，wire 说什么都不影响写面", async ({
        page,
    }) => {
        // wire 明确说「VIEWER 且 canWrite=false」—— 按契约这是最该只读的身份。
        const probes = await bootFreshTab(page, { workspaceRole: "VIEWER", canWrite: false });
        await page.goto(MCP_DIRECT_URL, { waitUntil: "load" });
        await expect(page.getByTestId("resources-header")).toBeVisible();

        // ① 这条读数才是缺口本身：整页生命周期内 `GET /workspaces/{id}` = 0 次。
        expect(probes.detailHits.count).toBe(0);
        // ② 于是 `canWriteWorkspace` 只能落到角色回落；页签上下文没有 role/ownerId ⇒
        //    `workspaceRole` 回落成 "EDITOR"（`stores/auth.ts:195-202`）⇒ 可写。
        await expect(page.getByTestId("mcp-config-textarea")).toBeEnabled();
        await expect(page.getByTestId("mcp-config-save")).toBeVisible();
        // 判据方向：**入口一旦补了 hydrate，本条会转红** —— 那时把上面两条改成
        // `toBeGreaterThan(0)` 与 `toBeDisabled`，本条即成为修好的回执。
    });
});
