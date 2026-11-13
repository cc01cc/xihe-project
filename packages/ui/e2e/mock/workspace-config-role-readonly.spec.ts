/**
 * 工作区设置页「配置」tab 的角色只读回归网（`task-361`，裁定 = `D-1218` 选项 **B**）。
 *
 * ## 为什么有这个文件
 *
 * `PLAN-0773 M4-1`（`task-190`，`d0864b59e`）把工作区配置 tab 按 per-workspace 层接了回来，
 * 但 `task-360` 的检索证明：**VIEWER / EDITOR 从未进过这个面板**——配置 tab 在所有自动化里
 * 只以 mock 默认的 OWNER 身份跑过（`e2e/mock/helpers/auth.ts:213`）。
 * 单测只量「`readonly` 属性 ⇒ 不渲染可写控件」（`ConfigDomainPanel.readonly.spec.ts`），
 * **没有一条把 `workspaceRole` 接到 `WorkspaceConfigPanel.readonly` 上**——
 * 属性测试全绿而接线可能是反的。
 *
 * ## 裁定口径（`D-1218`，读这段再改断言）
 *
 * 配置面板**刻意 OWNER-only**：同一个工作区设置页里，常规 tab 的编辑/删除/保存都用
 * `canManageWorkspace`（= `workspaceRole === "OWNER"`，`stores/auth.ts:206`）。
 * 若只把配置 tab 放开给 EDITOR，配置会成为该页**唯一可被非 owner 改的东西** ⇒ 页内不一致。
 * 所以：**VIEWER 与 EDITOR 都必须只读**，EDITOR 用例的价值是**阳性对照**（页面真渲染了、读请求真发了），
 * 不是「可写」的期待。
 *
 * ## ⚠ 这条门只挡 UI，挡不住 API（`D-1218` 第三条，别把这条读成权限保证）
 *
 * `readonly` 只是**不渲染按钮**。CP 侧的写门是 `WorkspaceWriteGuard`：
 * `PUT /api/v1/config/workspace/<domain>` 命中 `isWorkspaceWrite` ⇒ `Requirement.WRITE`
 * ⇒ `WorkspaceRole.canWrite(role)` = OWNER / **EDITOR** / ADMIN / MEMBER（`WorkspaceRole.java:24-26`）。
 * ⇒ **EDITOR 直发 API 是能写成的**，而本文件断的是「UI 不给 EDITOR 按钮」。
 * 两件事都对，但混着读就会把「UI 只读」当成「权限只读」——**本文件不断言 API 403**（那要真栈，见卡面）。
 *
 * ## 三条防假绿（判据顺序不许调，`D-1199` 同族）
 *
 * 1. **先证被测路径真的跑了**：面板在 DOM（`ws-settings-config`）→ 域卡渲染出来 →
 *    **至少一次** `GET /api/v1/config/<domain>?layer=workspace` 被发出。
 * 2. **再断它没产出坏东西**：只读态下可写动作 count 0。顺序反过来就是「页面没渲染」也能通过的假绿。
 * 3. **扫描器自证**（OWNER 用例）：同一个扫描函数在可写身份下**必须**扫出写控件，
 *    否则第 2 条永远绿而毫无意义（`D-1034`：没红 ≠ 断言了正确行为）。
 *
 * 本文件**只断 testid 与请求**，不用整页快照（卡面硬要求③）。
 */
import { expect, test } from "./helpers/mock-test";
import type { Page } from "@playwright/test";
import { setupMockAuth } from "./helpers/auth";
import { LAYER_DOMAINS } from "../../src/stores/config";

const WORKSPACE_ID = "workspace-1",
    PANEL = '[data-testid="ws-settings-config"]';

type Role = "OWNER" | "EDITOR" | "VIEWER";

/** 本页只该读**这一层**：per-workspace。别的层出现就是串层（也是回归）。 */
const EXPECTED_LAYER = "workspace",
    WORKSPACE_DOMAINS = LAYER_DOMAINS.workspace;

interface ConfigCall {
    method: string;
    url: string;
    layer: string | null;
    domain: string;
}

/**
 * 装好本页需要的最小面：登录态 + 页签工作区角色 + 配置读面桩，并**记录**每一次 config 调用。
 *
 * 返回的 `calls` 是断言 ② 的唯一证据来源 —— 用 `page.on("request")` 会漏掉「route 已 fulfill 但
 * 组件根本没发」的反面，所以直接在 route 处理器里记（处理器只在请求真的到达时才跑）。
 */
async function bootConfigTab(page: Page, role: Role): Promise<{ calls: ConfigCall[] }> {
    const calls: ConfigCall[] = [];

    await setupMockAuth(page, { workspace: { workspaceRole: role } });

    // 兜底：未桩的端点一律 200 `{}`（与 r17 同形；mock 车道没有真后端）。
    await page.route("**/api/v1/**", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
    );

    // 工作区外壳会拉会话列表；兜底的 `{}` 会让它整页加载失败。
    await page.route(/\/api\/v1\/(?:workspaces\/[^/]+\/)?sessions(?:\?.*)?$/, (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ sessions: [] }),
        });
    });

    await page.route(`**/api/v1/workspaces/${WORKSPACE_ID}`, (route) =>
        route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                id: WORKSPACE_ID,
                name: "Mock Workspace",
                ownerId: "user-1",
                workspaceRole: role,
            }),
        }),
    );

    // meta 必须先注册（Playwright 路由是 LIFO：后注册的优先，所以更具体的要**晚**注册）。
    await page.route("**/api/v1/config/*/meta**", (route) => {
        const url = new URL(route.request().url()),
            segments = url.pathname.split("/"),
            domain = segments[segments.length - 2] ?? "";
        calls.push({
            method: route.request().method(),
            url: url.pathname + url.search,
            layer: url.searchParams.get("layer"),
            domain,
        });
        return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ domain, layer: EXPECTED_LAYER, keys: [] }),
        });
    });

    await page.route("**/api/v1/config/**", (route) => {
        const url = new URL(route.request().url()),
            segments = url.pathname.split("/"),
            domain = segments[segments.length - 1] ?? "";
        calls.push({
            method: route.request().method(),
            url: url.pathname + url.search,
            layer: url.searchParams.get("layer"),
            domain,
        });
        return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ domain, entries: {}, envOverridden: {} }),
        });
    });

    return { calls };
}

/**
 * 面板内**可用**的写动作控件（testid 面）。
 *
 * 三个桶，缺一不可：
 * - `write-testid`：testid 命中写动词（新增写按钮必须带 testid，否则落进下一桶）；
 * - `editable-control`：`input` / `select` / `textarea` —— 只读态下字段渲染成 `span`
 *   （`ConfigDomainPanel.vue:813-838` 的 `v-else-if="!readonly"` / `v-else`），出现即说明不是只读；
 * - `untestid-control`：**面板内没有 testid 的可交互控件**。
 *   这一桶是为保存按钮专设的：`ConfigDomainPanel.vue:890` 的保存按钮**没有 testid**，
 *   只靠 `v-if="!readonly"` 存在 ⇒ 只断 testid 会漏掉它。只读态下本面板内其余控件
 *   （折叠 toggle / 来源跳转 / 用户覆盖 / 漂移清除 / 重置）**全部带 testid**，
 *   所以「出现一个无 testid 的控件」= 保存按钮回来了（或有人加了新的写面却没给 testid）。
 */
async function writeControls(page: Page): Promise<string[]> {
    return page.evaluate((selector) => {
        const scope = document.querySelector(selector);
        if (!scope) return ["PANEL_NOT_MOUNTED"];
        const nodes = [
            ...scope.querySelectorAll<HTMLElement>(
                'button, input, select, textarea, [role="switch"]',
            ),
        ];
        const out: string[] = [];
        for (const node of nodes) {
            const testid = node.getAttribute("data-testid") ?? "",
                disabled =
                    (node as HTMLButtonElement).disabled ||
                    (node as HTMLInputElement).readOnly === true ||
                    node.getAttribute("aria-disabled") === "true";
            if (disabled) continue;
            if (!testid) {
                // 只算**通用域卡内部**的无 testid 控件：那正是保存按钮的位置
                // （`ConfigDomainPanel.vue:890`，`v-if="!readonly"`，无 testid）；
                // 专用面板（如 `AgentTemplatesPanel`）里另有不带 testid 的按钮，不属本判据。
                if (node.closest('[data-testid^="config-domain-"]')) {
                    out.push("untestid-control:" + node.tagName.toLowerCase());
                }
                continue;
            }
            if (/save|create|delete|remove|apply|update|submit|write|reset|clear/i.test(testid)) {
                out.push("write-testid:" + testid);
                continue;
            }
            if (/^(INPUT|SELECT|TEXTAREA)$/.test(node.tagName)) {
                out.push("editable-control:" + testid);
            }
        }
        return out;
    }, PANEL);
}

/**
 * 每个工作区层域在面板里的**读面标记**：通用域用 `ConfigDomainPanel` 的域卡，
 * `agent-templates` 走专用面板（`ConfigLayerPanels.vue:810-820` 的 v-else-if 分支 ⇒ `AgentTemplatesPanel`）。
 *
 * 为什么逐域断言而不是只断「面板在」：面板挂载了但一个域都没渲染，等于读面是空壳，
 * 那时下面的「可写动作 0」也是空转（没有控件可扫）。
 */
const DOMAIN_MARKER: Record<string, string> = {
    "agent-templates": "agent-templates-panel",
};

async function expectDomainsRendered(page: Page): Promise<void> {
    for (const domain of WORKSPACE_DOMAINS) {
        const marker = DOMAIN_MARKER[domain] ?? `config-domain-${domain}`;
        await expect(page.getByTestId(marker)).toHaveCount(1);
    }
}

/** 断言 ②：至少一次 per-workspace 层读，且**没有任何写请求**（只读面连试都不该试）。 */
function expectReadOnlyTraffic(calls: ConfigCall[]): void {
    const reads = calls.filter((call) => call.method === "GET");
    // ②-a 至少一次**显式 per-workspace 层**读：这是本页存在的理由（读本工作区自己的行）。
    expect(reads.filter((call) => call.layer === EXPECTED_LAYER).length).toBeGreaterThan(0);
    // ②-b 除它之外不得出现**别的显式层** —— 串到 instance / user 层就是把别人的数据当自己的。
    //
    // 允许 `layer === null`：那是**resolved 读**（`GET /config/<domain>` 不带 layer = 合并后的
    // 有效值），由专用面板（`agent-templates`）自己发，语义上不属于「本页在写哪一层」。
    // 实测本次请求集合 = ["workspace", null]（2026-11-13，本 spec 首跑）。
    expect([...new Set(reads.map((call) => call.layer))].filter((layer) => layer !== null)).toEqual(
        [EXPECTED_LAYER],
    );
    // ②-c 只读身份下不得出现任何写方法（PUT/PATCH/DELETE/POST）——连试都不该试。
    expect(calls.filter((call) => call.method !== "GET")).toEqual([]);
}

for (const role of ["VIEWER", "EDITOR"] as const) {
    test(`配置 tab（${role}）：面板挂载 + 工作区层读发生 + 可写动作 0（D-1218 B）`, async ({
        page,
    }) => {
        const { calls } = await bootConfigTab(page, role);
        await page.goto(`/workspace/${WORKSPACE_ID}/settings?tab=config`, { waitUntil: "load" });

        // ① 面没被按角色藏掉，而且不是错误态。
        await expect(page.getByTestId("ws-settings-config")).toHaveCount(1);
        await expect(page.getByTestId("ws-settings-config-error")).toHaveCount(0);

        // ② 读面真的发生：域卡渲染 + 至少一次 per-workspace 层 GET（顺序在 ③ 之前，不许调）。
        await expectDomainsRendered(page);
        expectReadOnlyTraffic(calls);

        // ③ 只读真的只读。
        expect(await writeControls(page)).toEqual([]);
    });
}

test("扫描器自证（OWNER 可写）：同一函数必须扫出写控件，否则上面两条 count 0 是空转", async ({
    page,
}) => {
    const { calls } = await bootConfigTab(page, "OWNER");
    await page.goto(`/workspace/${WORKSPACE_ID}/settings?tab=config`, { waitUntil: "load" });

    await expect(page.getByTestId("ws-settings-config")).toHaveCount(1);
    await expectDomainsRendered(page);
    expectReadOnlyTraffic(calls);

    // 阳性对照：可写身份下扫描器**必须**有输出，且里面必须有那个没有 testid 的保存按钮。
    const controls = await writeControls(page);
    expect(controls.length).toBeGreaterThan(0);
    expect(controls).toContain("untestid-control:button");
});
