import type { Page } from "@playwright/test";

import { expect, test } from "./helpers/mock-test";
import { setupMockAuth } from "./helpers/auth";
import { EXPECT_TIMEOUT_MS } from "../timeouts";

/**
 * `task-187` 探针（**只读分诊用，不是验收用例**）。
 *
 * 目的：把 `task-76` 剩的三条红（`workspace-members:259` · `policy-management:378` ·
 * `resources-ia:160`）的**判类读数**一次打出来。判类规则已由 Lead 固化，读数一到直接归类：
 *
 * - `members:259`：`selfPermissionsStatus=ready` ∧ `workspaceProjection` 匹配当前 workspace ∧
 *   `workspaceAtoms` 含来源原子 ∧ **仍红** ⇒ **(b)**；三量缺一 ⇒ **(a)**。
 *   **注意**：该用例断的是「列表在 + 表单 hidden」= `canViewMembers` **与** `canManageWorkspace`
 *   **两条判据**，不是同一条 ⇒ 若落 (b) 先查 `panelReadonly`/`canManageWorkspace` 侧。
 * - `policy-management:378`：`config-domain-*` 节点 0 而断言期望非 0 ⇒ **(c)**；节点真存在 ⇒ **(b)**。
 *   只数节点数分不出「真渲染」与「残留在 403 子树里但不可见」，所以**必须记 `closest` 宿主**。
 * - `resources-ia:160`：`active === INSTANCE` 却期望 disabled ⇒ **(c)**（当前层永不禁用是有意设计）；
 *   否则 ⇒ **(b)**。`active` 不读组件内部，用 `[role="tab"][aria-selected="true"]` 反推。
 */

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "probe-task187";

interface AuthProbe {
    status: string | null;
    workspaceId: string | null;
    projectionWorkspaceId: string | null;
    atoms: string[];
    canViewMembers: boolean | null;
    canManageWorkspace: boolean | null;
    canWriteWorkspace: boolean | null;
    projectionExported: boolean;
    atomsExported: boolean;
    permissionsShape: string[] | null;
    permissionsWorkspaceRows: number | null;
    permissionsRequested: number;
}

function log(tag: string, payload: Record<string, unknown>): void {
    console.log("[task187-probe] " + tag + " " + JSON.stringify(payload));
}

/** 从 Vue app 上取 Pinia 的 auth store（setup store 的 refs/computed 都在实例上，硬读数）。 */
async function readAuth(page: Page, permissionsRequested: number): Promise<AuthProbe> {
    const raw = await page.evaluate(() => {
        interface StoreShape {
            selfPermissionsStatus?: string;
            workspace?: { id?: string };
            workspaceProjection?: { workspaceId?: string } | null;
            workspaceAtoms?: Set<string> | null;
            canViewMembers?: boolean;
            canManageWorkspace?: boolean;
            canWriteWorkspace?: boolean;
            selfPermissions?: Record<string, unknown> | null;
            selfPermissionsRaw?: Record<string, unknown> | null;
        }
        interface PiniaShape {
            _s?: Map<string, StoreShape>;
        }
        interface AppShape {
            config?: { globalProperties?: { $pinia?: PiniaShape } };
        }
        const host = document.querySelector("#app") as
            | (Element & { __vue_app__?: AppShape })
            | null;
        const store = host?.__vue_app__?.config?.globalProperties?.$pinia?._s?.get("auth");
        if (!store) return null;
        return {
            status: store.selfPermissionsStatus ?? null,
            workspaceId: store.workspace?.id ?? null,
            projectionWorkspaceId: store.workspaceProjection?.workspaceId ?? null,
            atoms: store.workspaceAtoms ? Array.from(store.workspaceAtoms) : [],
            canViewMembers: store.canViewMembers ?? null,
            canManageWorkspace: store.canManageWorkspace ?? null,
            canWriteWorkspace: store.canWriteWorkspace ?? null,
            projectionExported: store.workspaceProjection !== undefined,
            atomsExported: store.workspaceAtoms !== undefined,
            canWriteExported: store.canWriteWorkspace !== undefined,
            permissionsShape: store.selfPermissions
                ? Object.keys(store.selfPermissions as Record<string, unknown>)
                : null,
            permissionsWorkspaceRows: Array.isArray(
                (store.selfPermissions as { workspaces?: unknown[] } | null)?.workspaces,
            )
                ? ((store.selfPermissions as { workspaces: unknown[] }).workspaces.length as number)
                : null,
        };
    });

    return {
        status: raw?.status ?? null,
        workspaceId: raw?.workspaceId ?? null,
        projectionWorkspaceId: raw?.projectionWorkspaceId ?? null,
        atoms: raw?.atoms ?? [],
        canViewMembers: raw?.canViewMembers ?? null,
        canManageWorkspace: raw?.canManageWorkspace ?? null,
        canWriteWorkspace: raw?.canWriteWorkspace ?? null,
        projectionExported: raw?.projectionExported ?? false,
        atomsExported: raw?.atomsExported ?? false,
        permissionsShape: raw?.permissionsShape ?? null,
        permissionsWorkspaceRows: raw?.permissionsWorkspaceRows ?? null,
        permissionsRequested,
    };
}

test.describe("task-187 探针（只读分诊）", () => {
    /** 探针 1 的共用体：种 EDITOR tab 上下文 + 挂投影 + 打三量与 DOM。 */
    async function probeMembers(
        page: Page,
        preset: "owner" | "editor" | null,
    ): Promise<{ auth: AuthProbe; dom: Record<string, unknown>; permissionsUrls: string[] }> {
        const permissionsUrls: string[] = [];
        page.on("request", (req) => {
            if (req.url().includes("/me/permissions")) permissionsUrls.push(req.url());
        });
        // **不要用 `capabilities: {...}` 覆盖**：`setupMockAuth` 是整体替换，缺 `workspaceAdminOf` 会让
        // `capabilities.workspaceAdminOf.includes(...)` 抛 `Cannot read properties of undefined`（冒烟实测）。
        // 用预设表达「本工作区属主、但无实例级能力」。
        await setupMockAuth(page, preset ? { capabilitiesPreset: preset } : {});
        await page.addInitScript(() => {
            sessionStorage.setItem(
                "xihe-workspace",
                JSON.stringify({
                    id: "11111111-1111-4111-8111-111111111111",
                    name: "Mock Workspace",
                    workspaceRole: "EDITOR",
                    ownerId: "owner-1",
                }),
            );
        });
        // 原用例的投影口径（task-470 / b87fd4f7b）；`*` 后缀容忍 query，避免 glob 漏匹配。
        await page.route("**/api/v1/me/permissions*", (route) =>
            route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    userId: "user-1",
                    instanceCapabilities: [],
                    instancePermissions: [],
                    workspaces: [
                        {
                            workspaceId: WORKSPACE_ID,
                            workspaceRole: "EDITOR",
                            workspaceAdmin: false,
                            permissions: [
                                { actionClass: "WRITE_WORKSPACE_CONTENT", resource: "*" },
                            ],
                        },
                    ],
                }),
            }),
        );
        await page.goto("/workspace/" + WORKSPACE_ID + "/members");
        await page.locator('[data-testid="workspace-members-page"]').waitFor({
            state: "visible",
            timeout: EXPECT_TIMEOUT_MS,
        });
        await page.waitForTimeout(300);
        const auth = await readAuth(page, permissionsUrls.length);
        const dom = await page.evaluate(() => {
            const panel = document.querySelector('[data-testid="ws-members-panel"]');
            const add = document.querySelector('[data-testid="ws-members-add"]');
            return {
                panelPresent: !!panel,
                addPresent: !!add,
                addHidden: add instanceof HTMLElement ? add.offsetParent === null : null,
                rows: document.querySelectorAll('[data-testid="ws-members-row"]').length,
                panelTextHead: (panel as HTMLElement | null)?.innerText?.slice(0, 60) ?? null,
            };
        });
        return { auth, dom, permissionsUrls };
    }

    test("探针 1a：members:259 EDITOR + **默认能力**（= 原用例的夹具状态）", async ({ page }) => {
        const read = await probeMembers(page, null);
        log("members259-defaultCaps", read);
        expect(read.auth.workspaceId, "前提：工作区已加载").toBe(WORKSPACE_ID);
    });

    test("探针 1b：members:259 EDITOR + **非实例管理员**（只差能力这一个变量）", async ({
        page,
    }) => {
        const read = await probeMembers(page, "owner");
        log("members259-noInstanceAdmin", read);
        expect(read.auth.workspaceId, "前提：工作区已加载").toBe(WORKSPACE_ID);
    });

    test("探针 1c：members:259 EDITOR + **editor 预设**（本工作区非 admin）", async ({ page }) => {
        const read = await probeMembers(page, "editor");
        log("members259-editorPreset", read);
        expect(read.auth.workspaceId, "前提：工作区已加载").toBe(WORKSPACE_ID);
    });

    test("探针 2：policy-management:378 —— 域面板节点 + closest 宿主", async ({ page }) => {
        await setupMockAuth(page, { capabilities: { isInstanceAdmin: false } });
        await page.goto("/settings/policy");
        await page.locator('[data-testid="settings-forbidden"]').waitFor({
            state: "visible",
            timeout: EXPECT_TIMEOUT_MS,
        });

        const dom = await page.evaluate(() => {
            const node = document.querySelector('[data-testid="config-domain-llm-provider"]');
            return {
                url: location.pathname,
                forbiddenVisible: !!document.querySelector('[data-testid="settings-forbidden"]'),
                domainViewPresent: !!document.querySelector('[data-testid="settings-domain-view"]'),
                domainPanelCount: document.querySelectorAll(
                    '[data-testid="config-domain-llm-provider"]',
                ).length,
                domainPanelHost:
                    node?.closest("[data-testid]")?.getAttribute("data-testid") ?? null,
                domainPanelVisible:
                    node instanceof HTMLElement ? node.offsetParent !== null : false,
                navGroupPrimary: document.querySelectorAll(
                    '[data-testid="settings-nav-group-primary"]',
                ).length,
            };
        });
        log("policy378", dom);
        expect(dom.forbiddenVisible, "前提：403 卡片渲染").toBe(true);
    });

    test("探针 3：resources-ia:160 —— active 反推 + 每层禁用态", async ({ page }) => {
        await setupMockAuth(page, { capabilitiesPreset: "owner" });
        await page.goto("/resources/credentials");
        await page.locator('[data-testid="resource-layer-tabs"]').waitFor({
            state: "visible",
            timeout: EXPECT_TIMEOUT_MS,
        });

        const tabs = await page.evaluate(() => {
            const rows = Array.from(
                document.querySelectorAll<HTMLElement>('[data-testid^="resource-layer-tab-"]'),
            );
            const selected = rows.find((row) => row.getAttribute("aria-selected") === "true");
            return {
                active: selected?.getAttribute("data-testid") ?? null,
                tabs: rows.map((row) => ({
                    id: row.getAttribute("data-testid"),
                    selected: row.getAttribute("aria-selected"),
                    disabled: row instanceof HTMLButtonElement ? row.disabled : null,
                    title: row.getAttribute("title"),
                })),
                disabledReasons:
                    document
                        .querySelector('[data-testid="resource-layer-disabled-reasons"]')
                        ?.textContent?.trim() ?? null,
            };
        });
        log("resources160", { tabs, session: SESSION_ID });
        expect(tabs.tabs.length, "前提：层签渲染了").toBeGreaterThan(0);
    });
});
