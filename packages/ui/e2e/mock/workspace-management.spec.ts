// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
import { expect, test } from "./helpers/mock-test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { LONG_TIMEOUT_MS } from "../timeouts";

let createPayload: Record<string, unknown> | null = null;

/**
 * 创建桩返回的工作区 id **必须是 UUID**：`router/index.ts:610` 的守卫先验形状（task-537：
 * 非 UUID 的 `/workspace/<id>` 会被清上下文并重定向到 `/workspace?invalidWorkspace=1`）。
 * 历史上这里用人类可读的 `ws-new` ⇒「创建成功后跳转」这条断言永远过不了（2026-11-15 实测
 * 导航序列：`/workspace` → `/workspace?invalidWorkspace=1` → `/workspace`）。
 */
const WS_NEW_ID = "33333333-3333-4333-8333-333333333333";

test.describe("Workspace management dialogs (PLAN-262 M2)", () => {
    test.beforeEach(async ({ page }) => {
        createPayload = null;
        await setupMockAuth(page);
        await setupMockSessions(page, {
            sessions: [{ id: "session-1", title: "Session 1" }],
            messages: { "session-1": [] },
        });
        // Mock workspace CRUD contract (CP canonical shape per openapi.yaml)
        await page.route("**/api/v1/workspaces", async (route) => {
            if (route.request().method() === "POST") {
                const body = route.request().postDataJSON() as Record<string, unknown>;
                createPayload = body;
                await route.fulfill({
                    status: 201,
                    contentType: "application/json",
                    body: JSON.stringify({
                        id: WS_NEW_ID,
                        name: body.name ?? "Untitled",
                        description: body.description ?? null,
                        ownerId: "user-1",
                        storageBackend: "host_directory",
                        storageRef: WS_NEW_ID,
                        generation: 1,
                    }),
                });
                return;
            }
            await route.fallback();
        });
        await page.route("**/api/v1/workspaces/*", async (route) => {
            const method = route.request().method(),
                url = new URL(route.request().url());
            const wsId =
                url.pathname.split("/").filter(Boolean).at(-1) ??
                "11111111-1111-4111-8111-111111111111";
            if (method === "PATCH") {
                const body = route.request().postDataJSON() as Record<string, unknown>;
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({
                        id: wsId,
                        name: body.name ?? "Mock Workspace",
                        description: body.description ?? null,
                        ownerId: "user-1",
                        storageBackend: "host_directory",
                        storageRef: wsId,
                        generation: 1,
                    }),
                });
                return;
            }
            if (method === "DELETE") {
                await route.fulfill({ status: 204, body: "" });
                return;
            }
            await route.fallback();
        });
    });

    test("empty picker offers creation; direct-attach create posts the host binding and execution mode", async ({
        page,
    }) => {
        // PLAN-0608 C′: `/workspace` with no tab context renders `WorkspacePicker` (not the old
        // 「暂无工作区」panel), and its empty branch is the current creation entry (PLAN-0614 T2.1).
        // setupMockAuth seeds the per-tab context too (PLAN-0560), so clear both storages.
        await page.addInitScript(() => {
            localStorage.removeItem("xihe-workspace");
            sessionStorage.removeItem("xihe-workspace");
        });

        // 「空 picker」的前提：`setupMockAuth` 的默认桩对 `GET /api/v1/workspaces`（列表）回
        // **单工作区**（`e2e/mock/helpers/auth.ts:111`，task-140「与 seed 同源」）⇒ WorkspacePicker
        // 走列表分支，空态 `workspace-picker-empty`（`src/components/WorkspacePicker.vue:204`）
        // 永不渲染。这里显式回 `[]`（后注册优先，只影响本用例）。
        // 列表桩必须**有状态**：① 创建前空列表是「空 picker」的前提；② 创建后刷新时若仍回
        // `[]`，选择面拿不到新工作区 ⇒ 不跳转，断言停在「URL 没变」（2026-11-15 实测：只做
        // ① 会把红点从「找不到空态」搬到「URL 没变」，两处都修才算通）。
        // 另外同路径的 POST（创建）必须 fallback 到 beforeEach 的 201 桩，全路径拦截会把它吃掉。
        let workspaceCreated = false;
        page.on("request", (request) => {
            if (
                request.method() === "POST" &&
                new URL(request.url()).pathname === "/api/v1/workspaces"
            ) {
                workspaceCreated = true;
            }
        });
        await page.route(
            (url) => url.pathname === "/api/v1/workspaces",
            (route) => {
                if (route.request().method() !== "GET") return route.fallback();
                const body = workspaceCreated
                    ? JSON.stringify([
                          {
                              id: WS_NEW_ID,
                              name: "E2E Workspace",
                              ownerId: "user-1",
                              storageMode: "direct_attach",
                              workspaceRole: "OWNER",
                          },
                      ])
                    : "[]";
                return route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body,
                });
            },
        );

        // 创建成功后会跳 `/workspace/ws-new`，该页要读 `GET /api/v1/workspaces/ws-new`。
        // 详情没桩时落到默认夹具的「静默 404」（`e2e/mock/helpers/workspace-fixture.ts:24`）⇒
        // WorkspaceView 判 404 后回到选择面，URL 停在 /workspace（2026-11-15 实测：修掉空态后
        // 红点才漂到这里 —— 这条用例原本有**两处**断点，前一处遮住了后一处）。
        await page.route(`**/api/v1/workspaces/${WS_NEW_ID}`, (route) =>
            route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    id: WS_NEW_ID,
                    name: WS_NEW_ID,
                    description: null,
                    ownerId: "user-1",
                    storageMode: "direct_attach",
                    storageBackend: "host_directory",
                    storageRef: "ws-new",
                    generation: 1,
                }),
            }),
        );

        // Current creation flow is direct-attach only: Runtime-visible source browser, then a real
        // capability preflight for both Windows execution modes (PLAN-0384 T1.1/T1.3).
        await page.route("**/api/v1/workspaces/import-sources**", (route) =>
            route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    path: "H:/src/demo",
                    entries: [{ name: "demo", kind: "directory", readable: true, size: 0 }],
                }),
            }),
        );
        await page.route("**/api/v1/workspaces/capabilities/preflight", async (route) => {
            const body = route.request().postDataJSON() as { executionMode?: string };
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    storageMode: "direct_attach",
                    executionMode: body.executionMode ?? "windows-mxc",
                    available: true,
                    maturity: "stable",
                    reason: null,
                }),
            });
        });

        await page.goto("/workspace");
        await expect(page.getByTestId("workspace-picker")).toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });
        await expect(page.getByTestId("workspace-picker-empty")).toContainText("你还没有工作区");
        await page.getByTestId("workspace-picker-create").click();

        const dialog = page.getByTestId("workspace-create-dialog");
        await expect(dialog).toBeVisible();
        // `managed_import` is frozen (PLAN-0618 complete freeze): the card is gone and only the
        // explanatory frozen note remains, so `direct_attach` is the one selectable storage mode.
        await expect(dialog.getByTestId("workspace-storage-managed")).toHaveCount(0);
        await expect(dialog.getByTestId("workspace-storage-managed-frozen")).toContainText(
            "执行后端已冻结",
        );
        await dialog.getByTestId("workspace-storage-direct").click();

        await dialog.getByTestId("workspace-source-path").fill("H:/src/demo");
        await dialog.getByTestId("workspace-source-read").click();
        await expect(dialog.getByTestId("workspace-source-browser")).toContainText("demo");
        await dialog.getByTestId("workspace-source-use").click();

        // Preflight reports both modes available; MXC stays the recommended default.
        await expect(dialog.getByTestId("workspace-execution-mxc-status")).toContainText("可用");
        await dialog.getByTestId("workspace-execution-next").click();

        await dialog.getByTestId("workspace-create-name").fill("E2E Workspace");
        await dialog.getByTestId("workspace-create-submit").click();

        await expect(page).toHaveURL(new RegExp(`/workspace/${WS_NEW_ID}`));
        // The direct-attach request must carry the root binding and the execution mode; the
        // retired `profile` field and the frozen `managed_import` mode must not appear.
        // PLAN-0639 M1: root binding is roots=[{path}] (root[0] = primary).
        expect(createPayload).toMatchObject({
            name: "E2E Workspace",
            storageMode: "direct_attach",
            executionMode: "windows-mxc",
            roots: [{ path: "H:/src/demo" }],
        });
        expect(createPayload?.profile).toBeUndefined();
    });

    test("workspace settings page saves rename and enforces exact-name delete guard", async ({
        page,
    }) => {
        await page.goto("/workspace/11111111-1111-4111-8111-111111111111");
        // PLAN-0560: workspace settings entry routes to the workspace settings page.
        // C3: the entry now lives in the secondary nav (tab bar is session-only).
        await page.getByTestId("workspace-nav-settings").click();
        await expect(page).toHaveURL(/\/workspace\/11111111-1111-4111-8111-111111111111\/settings/);
        await expect(page.getByTestId("workspace-settings-page")).toBeVisible();

        await page.getByTestId("ws-settings-name-input").fill("Renamed Workspace");
        await page.getByTestId("ws-settings-save").click();
        await expect(page.getByText("工作区已更新")).toBeVisible();

        // Delete flow: wrong name first, then exact name
        await page.getByTestId("ws-settings-delete").click();
        const confirm = page.getByTestId("workspace-delete-confirm");
        await expect(confirm).toBeVisible();
        await confirm.locator("#ws-delete-confirm-input").fill("Wrong Name");
        await confirm.getByTestId("ws-delete-confirm-btn").click();
        await expect(confirm.getByText("请输入完整的工作区名称以确认")).toBeVisible();

        await confirm.locator("#ws-delete-confirm-input").fill("Renamed Workspace");
        await confirm.getByTestId("ws-delete-confirm-btn").click();
        await expect(page).toHaveURL(/\/workspace$/);
    });
});

/**
 * task-365 B（`D-1220` ②）：「新建工作区 / 导入源」的入口从页内工具栏搬到左栏「工作区」区头。
 * 每条都钉两件事：**新入口可达** + **旧入口不再存在**（`toHaveCount(0)`）——
 * 只钉前者会让「两处并存」这种半成品一路绿；只钉后者会让「搬没了」一路绿。
 */
test.describe("Workspace chrome entries live in the rail section header (task-365 B)", () => {
    // 独立 describe **不继承**上面那个 describe 的 beforeEach —— 少了这一步整块跑在登录页上
    // （实测：`sidebar-import-source` not found，快照里是「登录」标题）。
    test.beforeEach(async ({ page }) => {
        await setupMockAuth(page);
        await setupMockSessions(page, {
            sessions: [{ id: "session-1", title: "Session 1" }],
            messages: { "session-1": [] },
        });
    });

    test("add-workspace: rail header opens the dialog; the page toolbar entry is gone", async ({
        page,
    }) => {
        await page.goto("/workspace/11111111-1111-4111-8111-111111111111");
        await expect(page.getByTestId("sidebar-add-workspace")).toBeVisible();
        await expect(page.getByTestId("workspace-toolbar-add")).toHaveCount(0);
        await expect(page.getByTestId("workspace-toolbar-more-add-workspace")).toHaveCount(0);

        await page.getByTestId("sidebar-add-workspace").click();
        await expect(page.getByTestId("workspace-create-dialog")).toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });
        // 消费后抹掉参数：深链不留状态，刷新不会又弹一次。
        await expect(page).not.toHaveURL(/create=1/);
    });

    test("import-source: rail header opens the dialog; the page toolbar entry is gone", async ({
        page,
    }) => {
        await page.goto("/workspace/11111111-1111-4111-8111-111111111111");
        await expect(page.getByTestId("sidebar-import-source")).toBeVisible();
        await expect(page.getByTestId("workspace-toolbar-import-source")).toHaveCount(0);

        await page.getByTestId("sidebar-import-source").click();
        await expect(page.getByTestId("workspace-import-dialog")).toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });
        await expect(page).not.toHaveURL(/importSource=1/);
    });
});
