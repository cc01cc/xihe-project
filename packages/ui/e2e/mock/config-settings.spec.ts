// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
import { DEFAULT_MOCK_ALLOW, expect, test } from "./helpers/mock-test";
import { expectPlatformScreenshot } from "../helpers/visual";
import type { Page } from "@playwright/test";
import { ACTION_TIMEOUT_MS, LONG_TIMEOUT_MS } from "../timeouts";
import { expectTriggerLabel, selectByTestId } from "../helpers/select";
// task-204：域集合唯一来源是 SSOT（`stores/config.ts#LAYER_DOMAINS`），spec 里不另抄一份清单。
import { LAYER_DOMAINS } from "../../src/stores/config";

/**
 * 断言前置：确保域卡处于**展开**态 —— 只在「字段还不在 DOM 里」时点标题按钮。
 *
 * 为什么不能照旧「点一次标题按钮就是展开」：`ConfigDomainPanel` 的 `expanded` 自 task-225
 * （`9e63df3d2`，用户 2026-11-13「默认都是合拢的，用户还得多次点击」）起默认 **true**，
 * 那一次点击于是反过来变成**收起**，断言前 `config-field-<domain>-*` 一个都取不到
 * （实测：失败时卡片是 `▸` +「N 项 展开查看全部设置」）。
 *
 * 判据用「字段是否已在 DOM 里」，不依赖 `aria-expanded` —— 展开与否的**结果**才是断言要用的东西。
 * 与 BL-621（`6c5e9640f`）单测侧的 `ensureDomainExpanded` 同一判据，这里是 e2e 侧的同形修法。
 * 断言本身一行未放宽。
 */
async function ensureDomainExpanded(page: Page, domain: string): Promise<void> {
    if ((await page.locator(`[data-testid^="config-field-${domain}-"]`).count()) > 0) return;
    await page.getByTestId(`config-domain-toggle-${domain}`).click();
}

// BL-318：`shows an error banner when layer config cannot be loaded` 用
// `route.abort("connectionrefused")` **故意**制造网络失败（验"保存失败"横幅），逐条放行该信号。
test.use({ mockAllow: [...DEFAULT_MOCK_ALLOW, String.raw`net::ERR_CONNECTION_REFUSED`] });

const CONFIG_DOMAINS: Record<string, Record<string, string>> = {
    "llm-provider": {
        profile: JSON.stringify({
            providerId: "deepseek",
            connectionKey: "default",
            model: "deepseek-chat",
        }),
        temperature: "0.7",
    },
    "context-policy": { defaults: '{"softThresholdPct":0.8}' },
    embedding: { model: "text-embedding-3-small", dimensions: "1536" },
    rag: { chunkSize: "1000", topK: "5" },
    "agent-runtime": { useRegistry: "true" },
    "agent-profile": { userName: "zero" },
    "user-preference": { theme: "dark" },
    logging: { logLevel: "INFO", levelCp: "DEBUG" },
    "approval-policy": { mode: "manual" },
};

test.describe("Config Settings (three layers)", () => {
    test.beforeEach(async ({ page }) => {
        await page.addInitScript(() => {
            localStorage.setItem("xihe-token", "mock-token");
            localStorage.setItem(
                "xihe-user",
                JSON.stringify({
                    id: "u1",
                    email: "admin@xihe.local",
                    // PLAN-0610 W3-2b decision #22: `authStore.isAdmin` reads the capability
                    // projection (`user.capabilities.isInstanceAdmin`), not the retired `role`
                    // string. Without it the page renders as a plain user — no instance tab, no
                    // import/export block — which is what every assertion below depends on.
                    capabilities: {
                        isInstanceAdmin: true,
                        isInstanceSuper: true,
                        workspaceAdminOf: ["ws-1"],
                    },
                }),
            );
            localStorage.setItem(
                "xihe-workspace",
                JSON.stringify({ id: "ws-1", name: "Mock Workspace" }),
            );
        });
    });

    async function mockConfigAPIs(page: any, options: { delayMs?: number } = {}) {
        // Catch-all first: Playwright routes are LIFO, specific routes below win.
        await page.route("**/api/v1/**", async (route: any) => {
            if (options.delayMs)
                await new Promise((resolve) => setTimeout(resolve, options.delayMs));
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({}),
            });
        });
        // task-461（D-1311）：上面的兜底把页面**合法调用**的会话列表也答成 `{}`，而
        // `api.ts:3107-3114 normalizeSessionListPayload` 要求 `sessions` 数组 ⇒ throw ⇒ logger[ERROR]
        // ⇒ `helpers/page-failures.ts:44` 的共享 console 门「no unexpected console errors」红。
        // 这不是产品缺陷，是**桩给了非法形状**：`WorkspaceSessionGroups` 首屏要读独立会话与
        // 工作区会话，两条都被兜底吞掉。修法照**仓内既有先例** `plan-0560-settings.spec.ts:33-43`
        // （BL-318 同因同修）：注册在兜底**之后**（Playwright LIFO ⇒ 后注册优先），只给集合面
        // 一个合法信封，非 GET 仍 `route.fallback()` 交回上层桩。
        //
        // **为什么不 passthrough 给 mock server**：本 spec 跑 index 链路，`helpers/chain.ts:79
        // mockApiEnvFor("index") = "0"` ⇒ `vite.config.ts:136/155` 不挂 mock 中间件 ⇒ `route.continue()`
        // 会落到 vite 的 SPA 回落（200 HTML），JSON 解析炸得更响。index 链路只能按契约给形状。
        //
        // **读数机制（runtime-1 核实，更正 4cb22713 body 的措辞）**：含视觉基线的用例修前**不是「没走到 skip」**——
        // `e2e/helpers/visual.ts:28 test.skip(true)` 在非 linux 平台执行了，红来自**之后的 auto fixture teardown**
        // （`helpers/mock-test.ts:79 expectNoPageFailures`，`{auto:true}`）⇒ skip 已触发 + 门红 = failed；门绿 = skipped。
        // ⇒ **这套套件里 skipped 不是免检区**（teardown 门仍能把 skip 的用例判红），且这些用例在 Windows 上
        // **视觉断言零执行**（仪器覆盖边界，别读成「它在保护视觉回归」）。两种说法排查方向不同：前者查渲染/取数，
        // 后者查桩形状。
        //        // **边界（runtime-1 复核意见，别照抄到别处）**：`{sessions: []}` 是**合法空集**，在这里成立
        // 只因为本 spec 不断言会话内容。要验会话内容的 spec 必须给真行 —— 空集会让断言变成空断言
        // （D-1281 同族）。**不放宽 console 门、不给 sessions 错误加白名单**（那是把判据改绿，D-1303）。
        await page.route(/\/api\/v1\/(?:workspaces\/[^/]+\/)?sessions(?:\?.*)?$/, (route: any) => {
            if (route.request().method() !== "GET") return route.fallback();
            return route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ sessions: [] }),
            });
        });
        // PLAN-0560: workspace settings page resolves the workspace context first.
        await page.route("**/api/v1/workspaces/ws-1", (route: any) =>
            route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ id: "ws-1", name: "Mock Workspace" }),
            }),
        );
        await page.route("**/api/v1/config/**", async (route: any) => {
            const url = new URL(route.request().url()),
                domain = url.pathname.split("/").pop() ?? "";
            if (options.delayMs)
                await new Promise((resolve) => setTimeout(resolve, options.delayMs));
            if (route.request().method() === "PUT") {
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({ status: "ok", keys: 1 }),
                });
                return;
            }
            const entries = CONFIG_DOMAINS[domain] ?? {};
            // Layer views get the includeMeta envelope; resolved reads stay flat.
            const body = url.searchParams.has("layer")
                ? {
                      domain,
                      entries,
                      envOverridden: domain === "embedding" ? { model: "env-embedding-model" } : {},
                  }
                : entries;
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify(body),
            });
        });
        await page.route("**/api/v1/config/*/meta**", async (route: any) => {
            const url = new URL(route.request().url()),
                domain = url.pathname.split("/")[4] ?? "",
                layer = url.searchParams.get("layer") ?? "instance",
                entries = CONFIG_DOMAINS[domain] ?? {};
            const keys = Object.keys(entries).map((key) => {
                const locked = domain === "embedding" && key === "model";
                return {
                    key,
                    source: locked ? "env" : layer,
                    locked,
                    writable: !locked,
                    reason: locked ? "ENV_LOCKED" : null,
                    instanceEligible: true,
                    defaultPresent: false,
                    overridable: true,
                };
            });
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ domain, layer, keys }),
            });
        });
        await page.route("**/api/v1/events**", (route: any) =>
            route.fulfill({
                status: 200,
                headers: { "Content-Type": "text/event-stream" },
                body: "retry: 5000\n\n",
            }),
        );
    }

    // PLAN-0752 M1 换掉了「层 = 页内页签」的交互：层现在是左栏的两个分组，域是二级链接
    // （`SettingsSidebar`）。所以本用例证明的同一件事换了承载物：
    //   旧 config-tab-instance / config-tab-user    → settings-nav-group-primary 的两段（实例配置 / 用户配置）
    //   旧 config-tab-workspace 不存在              → 所有域链接都是 /settings/(instance|user)/<domain>，无 workspace 段
    //   旧 config-domain-logging / -agent-runtime   → 域页 `/settings/instance/<domain>` 里的同名面板
    // 旧用例里的「admin 才看得到导入导出入口」移到导出用例（数据页）继续断言，不在这里重复。
    test("settings sidebar exposes both layers to admins, domain pages render their panels", async ({
        page,
    }) => {
        await mockConfigAPIs(page);
        await page.goto("/settings/instance/logging", { waitUntil: "load" });

        // 侧栏层分组要等能力投影落定（cap:instance:admin）；给足 lane 预算而不是 5 s 默认值。
        await expect(page.getByTestId("settings-nav-group-primary")).toHaveCount(2, {
            timeout: LONG_TIMEOUT_MS,
        });
        await expect(page.getByTestId("settings-domain-title")).toHaveText("日志设置");
        await expect(page.getByTestId("config-domain-logging")).toBeVisible();

        // 同层另一个域：一页一域，所以换页验第二块面板仍在。
        await page.goto("/settings/instance/agent-runtime", { waitUntil: "load" });
        await expect(page.getByTestId("config-domain-agent-runtime")).toBeVisible();

        // PLAN-0560：工作区层不在全局设置区（只在 /workspace/:id/settings）——层进 URL 里没有 workspace 段。
        // task-172：域链接 id 变成层限定 per-domain（`settings-nav-domain-<layer>-<domain>`），
        // 「全部域链接」语义用前缀选择器取。
        const hrefs = await page
            .locator('[data-testid^="settings-nav-domain-"]')
            .evaluateAll((els) => els.map((el) => el.getAttribute("href") ?? ""));
        expect(hrefs.length).toBeGreaterThan(0);
        expect(hrefs.every((href) => /^\/settings\/(instance|user)\/[\w-]+$/.test(href))).toBe(
            true,
        );
        await expectPlatformScreenshot(page, "config-instance-tab.png");
    });

    test("instance layer keeps the instance-only instructions field", async ({ page }) => {
        await mockConfigAPIs(page);
        // 旧：/settings/config 的 instance 层签里展开 agent-runtime；新：instance 层的 agent-runtime 域页（一页一域）。
        await page.goto("/settings/instance/agent-runtime", { waitUntil: "load" });
        await expect(page.getByTestId("config-domain-agent-runtime")).toBeVisible();

        await ensureDomainExpanded(page, "agent-runtime");
        await expect(page.getByTestId("config-field-agent-runtime-instructions")).toBeVisible();
    });

    // task-112 原用例是「工作区设置页的『配置』标签里按域铺面板」；task-253（用户 2026-11-10 裁定，
    // 提交 51c1d2a40）移除了该标签与域段，本条因此被翻成**正面守卫**（断言「配置 tab 不存在 +
    // 没有任何域面板」）。
    //
    // **task-204（Lead 2026-11-13）：契约又翻回来了** —— PLAN-0773 M4-1（`d0864b59e`）有意把
    // per-workspace 层加回来（`ConfigLayer` 加 `workspace`、`LAYER_DOMAINS.workspace` = 同一张矩阵、
    // 工作区设置页长出「配置」tab + 域面板）⇒ 原断言会红，而它红得**对**：契约变了，判据必须跟。
    // D-1122 49A / PLAN-0766 T2.4（2026-11-13）：那张矩阵已从 8 域缩到 **4 域**（模型 4 域退出
    // 工作区层）—— 本条不写死数（`expectedDomains` 从 SSOT 取），所以自动跟着变。
    //
    // 翻面**不删**：删断言只能证明「这一刻没写」，将来有人再把 tab 拿掉时不会有任何东西变红。
    // 反过来写之后，被持续验证的契约是「恰好两个 tab（general/config）+ 域面板集合等于 SSOT」。
    // task-236（M4-3）：成员提升为一级页 /workspace/:id/members —— 成员 tab 已撤（下方正面守卫）。
    test("workspace settings page: 三 tab + 配置域面板集合由 SSOT 派生（task-204 翻面）", async ({
        page,
    }) => {
        await mockConfigAPIs(page);
        // ?tab=config 现在是 tab 白名单成员 ⇒ 落在 config 本身（不再兜底回落 general）。
        await page.goto("/workspace/ws-1/settings?tab=config", { waitUntil: "load" });

        await expect(page.getByTestId("workspace-settings-page")).toBeVisible();
        await expect(page.getByTestId("ws-settings-tab-general")).toBeVisible();
        await expect(page.getByTestId("ws-settings-tab-config")).toBeVisible();
        // 计数**写死 2**（不是 ≥2）：tab 增删都必须在这里显式改判据，不能静默长出新 tab。
        await expect(page.locator('[data-testid^="ws-settings-tab-"]')).toHaveCount(2);
        // task-236（M4-3）正面守卫：成员 tab 已提升为一级页，不得复活成设置页 tab。
        await expect(page.getByTestId("ws-settings-tab-members")).toHaveCount(0);
        // task-209 / D-1019：mcp / credentials / knowledge 三个资源 tab 仍不在（已撤到资源区，非双入口）。
        await expect(page.getByTestId("ws-settings-tab-mcp")).toHaveCount(0);
        await expect(page.getByTestId("ws-settings-tab-credentials")).toHaveCount(0);
        await expect(page.getByTestId("ws-settings-tab-knowledge")).toHaveCount(0);

        // 生效 tab：tab 按钮没有 `aria-selected`，高亮实现是 `border-primary`（WorkspaceSettingsView.vue）。
        await expect(page.getByTestId("ws-settings-tab-config")).toHaveClass(/border-primary/);

        // 域落点**从 DOM 取**、期望集合**从 SSOT 取**（`LAYER_DOMAINS.workspace`），再对撞：
        // spec 里不另抄一份域名清单（抄的那份一定会漂，且漂了没人知道）。
        // 注意 4 个域是**专用分区**而不是通用面板（`ConfigLayerPanels.vue`）：llm-provider 走
        // `provider-partition`，agent-templates / api-request-templates / embedding 走专用面板 +
        // `config-source-summary-<domain>`；其余 5 个域走 `config-domain-toggle-<domain>`。
        // 只认通用 toggle 会漏 3 个域 —— 这正是本条第一版判据红掉的原因（把「渲染方式」当成了「域」）。
        const expectedDomains = [...LAYER_DOMAINS.workspace];
        expect(expectedDomains.length).toBeGreaterThan(0);
        // 判据：**每个 SSOT 域都要在 DOM 里留下带该域名的 testid 落点**（通用面板、专用分区、
        // source-summary 都算，因为「用什么组件渲染」不是本条的判据 —— 那 4 个专用域本来就没有
        // 通用 toggle；第一版按通用 toggle 判，红了 3 个域，红得对但判据选错了层次）。
        const missingDomains = await page.evaluate((domains: string[]) => {
            const testIds = Array.from(document.querySelectorAll("[data-testid]")).map(
                (el) => el.getAttribute("data-testid") ?? "",
            );
            return domains.filter((domain) => !testIds.some((id) => id.includes(domain)));
        }, expectedDomains);
        expect(missingDomains).toEqual([]);

        // 反向：**渲染出来的通用域必须是 SSOT 的成员**（防止页面自己发明域/拼错域名）。
        const renderedGenericDomains = await page
            .locator('[data-testid^="config-domain-toggle-"]')
            .evaluateAll((els) =>
                els.map((el) =>
                    (el.getAttribute("data-testid") ?? "").replace("config-domain-toggle-", ""),
                ),
            );
        expect(renderedGenericDomains.length).toBeGreaterThan(0);
        expect(
            renderedGenericDomains.filter(
                (domain: string) => !expectedDomains.includes(domain as never),
            ),
        ).toEqual([]);

        // MCP 仍在「自己独立的界面」上 —— 只是从工作区设置的 tab 换成了资源区的工作区层
        // （`/resources/mcp?layer=WORKSPACE`）。**行为断言不变**：进得去、文本框在。
        await page.goto("/resources/mcp?layer=WORKSPACE", { waitUntil: "load" });
        await expect(page.getByTestId("resources-header")).toBeVisible();
        await expect(page.getByTestId("mcp-config-textarea")).toBeVisible();
    });

    // task-174：原用例是「断言…→截图→goto MCP→断言…→截图」，截图夹在中间 ⇒ 非 linux 的 skip
    // 会把后半段一起截断。两张基线各归一条视觉用例，**断言全留在行为用例**；本条只留
    // 「页面挂载了」这一条读就绪断言（它在截图之前执行，Windows 上照样跑）。
    // 每条视觉用例**只拍一张**：`expectPlatformScreenshot` 在非 linux 会 skip，
    // 一张用例里拍两张就必然有一张后面还跟着语句（第二条就永远到不了）。
    test("renders the workspace settings baseline", async ({ page }) => {
        await mockConfigAPIs(page);
        await page.goto("/workspace/ws-1/settings?tab=config", { waitUntil: "load" });
        await expect(page.getByTestId("workspace-settings-page")).toBeVisible();
        await expectPlatformScreenshot(page, "config-workspace-tab.png");
    });

    test("renders the MCP resource baseline", async ({ page }) => {
        await mockConfigAPIs(page);
        await page.goto("/resources/mcp?layer=WORKSPACE", { waitUntil: "load" });
        await expect(page.getByTestId("resources-header")).toBeVisible();
        await expectPlatformScreenshot(page, "config-workspace-mcp-tab.png");
    });

    test("approval-policy is instance-writable, per-workspace visible and user-hidden", async ({
        page,
    }) => {
        await mockConfigAPIs(page);
        // 旧：/settings/config 的 instance 层签；新：instance 层的 approval-policy 域页。
        await page.goto("/settings/instance/approval-policy", { waitUntil: "load" });

        // PLAN-0364 决策 #9（supersede PLAN-0337 选项①）：instance 层可写默认。
        const instanceDomain = page.getByTestId("config-domain-approval-policy");
        await expect(instanceDomain).toBeVisible();
        await ensureDomainExpanded(page, "approval-policy");
        await expectTriggerLabel(page, "config-select-approval-policy-mode", "manual");

        // task-468（D-1330 改向）：**原断言「工作区页不得出现 approval-policy」是过期判据**。
        // 它引的是 task-253（用户 2026-11-10 裁定，51c1d2a40）退役**全局**工作区配置层；而
        // `d0864b59e`（PLAN-0773 M4-1 / task-190，**Lead 2026-11-13 裁定形态 B2**）把配置 tab 按
        // **按工作区**的层接回了同一 URL 树（`?tab=config`），同批 `lib/settingsIa.ts` 收窄为
        // `Exclude<ConfigLayer, "workspace">` ⇒ **全局设置仍三层，退役事实在全局面继续成立**。
        // M4-1 后有两笔规格跟随（`76bc895a3` / `99355bc4e`）**漏了本处**；它长期被上面那条
        // trigger 断言的红遮住，task-464 修好草稿同步后才露出来。同文件「三 tab + 域集由 SSOT
        // 派生」那条与本处曾**互相矛盾**（同一 URL 一边断言域集等于 SSOT、一边断言该域 count=0），
        // 套件自身绿灯即反证本处过期 ⇒ **翻面而不是删断言**（删了将来有人把 tab 拿掉也不会红，task-112）。
        await page.goto("/workspace/ws-1/settings?tab=config", { waitUntil: "load" });
        await expect(page.getByTestId("workspace-settings-page")).toBeVisible();
        await expect(page.getByTestId("ws-settings-tab-config")).toBeVisible();
        // **判据判别力（Lead 补充要求 / runtime-1 复核点）**：不是把 count=0 翻成「存在」就完事 ——
        // 期望集**从 SSOT 取**、落点**从 DOM 取**，两侧对撞（与「三 tab + 域集由 SSOT 派生」那条同源，
        // spec 不另抄域名清单）；再加**反向层守卫**：实例独占域不得出现在工作区面。
        // 两者合起来才能区分「per-workspace 面按本层矩阵渲染」与「随便渲染了一堆卡」（D-1281 空断言）。
        const expectedDomains = [...LAYER_DOMAINS.workspace];
        expect(expectedDomains.length).toBeGreaterThan(0);
        expect(expectedDomains).toContain("approval-policy");
        // **取样范围收进本层配置面板容器**（runtime-1 加固建议二，task-468 后续）：原先在全 document
        // 取 testid ⇒ 页面别处（如导航）出现含域名的 testid 就能满足正向断言，而反向仍 0，理论上可同绿。
        // 收进容器后两侧同口径。**不收敛到 `config-domain-` 前缀**：工作区 3 域里
        // `approval-policy` / `job-policy` 走专用分区 + `config-source-summary-<domain>`
        // （见「三 tab」那条注释），只认通用前缀会**假红**。task-485 把 `agent-templates` 撤下工作区层
        // 后，本条注释点名的特例跟着换人（域集仍从 SSOT 取，断言本身不写域名）。
        const configPanel = page.getByTestId("ws-settings-config");
        await expect(configPanel).toBeVisible();
        const renderedTestIds = await configPanel.evaluate((panel) =>
            Array.from(panel.querySelectorAll("[data-testid]")).map(
                (el) => el.getAttribute("data-testid") ?? "",
            ),
        );
        // 每个 SSOT 域都要在**本层面板内**留下带该域名的 testid 落点（通用面板 / 专用分区 /
        // source-summary 都算，「用什么组件渲染」不是判据 —— 同「三 tab」那条的教训）。
        const missingDomains = expectedDomains.filter(
            (domain) => !renderedTestIds.some((id) => id.includes(domain)),
        );
        expect(missingDomains).toEqual([]);
        // 反向：从 SSOT 派生**全部**实例独占域（在 instance 矩阵、不在 workspace 矩阵），逐个断言不在。
        // runtime-1 加固建议一：原 `.find` 只守第一个（他实算 1/8），改 `.filter` ⇒ **同成本守 8/8**。
        // 不写死域名 ⇒ 矩阵变了自动跟着变；**显式挡空集**（空集会让这条退化成空断言）。
        const instanceOnlyDomains = LAYER_DOMAINS.instance.filter(
            (domain) => !LAYER_DOMAINS.workspace.includes(domain),
        );
        expect(instanceOnlyDomains.length).toBeGreaterThan(0);
        for (const domain of instanceOnlyDomains) {
            await expect(page.getByTestId(`config-domain-${domain}`)).toHaveCount(0);
        }
        await expect(page.getByTestId("config-domain-approval-policy")).toBeVisible();
        // **写面（原标题里的 workspace-overridable）本轮不钉**：`PUT /api/v1/config/workspace/{domain}`
        // 在契约里仍 `deprecated: true`（`openapi.yaml:3276`），UI 已消费但契约收口在 **BL-571** 另卡
        // ⇒ 现在钉成判据等于用测试锁死一条待收口的路径（Lead 裁定：本轮只翻读面）。标题已随之改名，
        // 不留「名字承诺了覆盖、实际没断言」的缺口。

        // user 层仍不可写（显式例外）：层×域矩阵里 user 层没有 approval-policy，
        // 直链落「该组合不存在」的 404 视图（V3/V25），而不是渲染一块点不动的面板。
        await page.goto("/settings/user/approval-policy", { waitUntil: "load" });
        await expect(page.getByTestId("settings-not-found")).toBeVisible();
        await expect(page.getByTestId("config-domain-approval-policy")).toHaveCount(0);
    });

    // 已删除：「saving the approval mode goes through the workspace endpoint」（task-112）。
    // 当时理由：task-253 退役工作区配置层后，产品侧没有入口能触发
    // `PUT /api/v1/config/workspace/approval-policy`，保留它等于要求产品把废弃路径加回来
    // （拿测试反向绑架产品）。
    // **task-468 更新（D-1330）**：该前提已被 M4-1 / B2 取代 —— per-workspace 配置面接回后
    // 这条写路径**又有入口了**（`WorkspaceConfigPanel` → `ConfigLayerPanels layer="workspace"`）。
    // 但契约仍标 deprecated（`openapi.yaml:3276`，BL-571 收口另卡）⇒ **写面判据等 BL-571 收口后
    // 再钉**，本轮不恢复；「工作区层不再发任何 /config/workspace 请求」这条旧撤销事实**已不成立**，
    // 不再由任何断言承重（别把它当现状引用）。同层端点仍在服务的部分由实例层/用户层保存用例覆盖：
    //   · 「saving a value goes through the layer endpoint」（本文件，instance/logging）
    //   · approval-policy 的层语义由上面那条（instance 可写 / per-workspace 可见 / user 层 404）覆盖

    test("user layer drops instance-only domains and the instructions field", async ({ page }) => {
        await mockConfigAPIs(page);

        // 用户层的域各占一页；旧用例在同一个「用户层签」里一次看全，现在按域逐个验同一批事实。
        //
        // task-485 / task-226 D4（用户 2026-11-14 ④「智能体个人属于成员管理，并不是在设置域里面」）：
        // `agent-profile` 已撤出设置区 ⇒ 旧 URL **302 到成员管理**，不渲染域页、也不进 404。
        await page.goto("/settings/user/agent-profile", { waitUntil: "load" });
        await expect(page).toHaveURL(/\/members$/);
        await expect(page.getByTestId("config-domain-agent-profile")).toHaveCount(0);
        await page.goto("/settings/user/user-preference", { waitUntil: "load" });
        await expect(page.getByTestId("config-domain-user-preference")).toBeVisible();

        // logging 是实例独占域：用户层矩阵里没有它 ⇒ 直链 404 视图（旧断言是「用户层签里不出现该面板」）。
        await page.goto("/settings/user/logging", { waitUntil: "load" });
        await expect(page.getByTestId("settings-not-found")).toBeVisible();
        await expect(page.getByTestId("config-domain-logging")).toHaveCount(0);

        // 实例专属字段：「用户层看不到」这条旧口径被 PLAN-0752 T3.2 / design §5.1 取代 ——
        // 不再静默隐藏（隐藏会让人以为没这项），而是渲染成只读行 + 「仅实例层」徽标。
        await page.goto("/settings/user/agent-runtime", { waitUntil: "load" });
        await expect(page.getByTestId("config-domain-agent-runtime")).toBeVisible();
        await ensureDomainExpanded(page, "agent-runtime");
        const instructions = page.getByTestId("config-field-agent-runtime-instructions");
        await expect(instructions).toBeVisible();
        await expect(
            page.getByTestId("config-key-layer-badge-agent-runtime-instructions"),
        ).toHaveText("仅实例层");
        await expect(instructions.locator("input, textarea").first()).toBeDisabled();
    });

    test("env-locked embedding model shows the env source and stays read-only", async ({
        page,
    }) => {
        await mockConfigAPIs(page);
        // task-112：EmbeddingSettingsPanel 只在**非实例层**的 embedding 域页挂载
        // （ConfigLayerPanels.vue：domain === "embedding" && layer !== "instance"），
        // 原来的宿主是已废弃的工作区「配置」标签（task-253 / 51c1d2a40）⇒ 改到用户层域页。
        await page.goto("/settings/user/embedding", { waitUntil: "load" });

        await expect(page.getByTestId("embedding-settings")).toBeVisible();
        const source = page.getByTestId("config-source-summary-embedding");
        await expect(source).toBeVisible();
        // task-170/F-07：审计明细（`domain.key` 技术标识 + 来源）默认收起，展开后才可见。
        await expect(source).not.toContainText("embedding.model");
        const toggle = page.getByTestId("config-source-summary-toggle-embedding");
        await expect(toggle).toHaveAttribute("aria-expanded", "false");
        await toggle.click();
        await expect(toggle).toHaveAttribute("aria-expanded", "true");
        await expect(source).toContainText("embedding.model");
        await expect(source).toContainText("环境变量锁定");
    });

    test("saving a value goes through the layer endpoint", async ({ page }) => {
        await mockConfigAPIs(page);
        // 旧：/settings/config 的 instance 层签；新：instance 层的 logging 域页，保存仍走层端点。
        await page.goto("/settings/instance/logging", { waitUntil: "load" });

        // 域面板要等层配置 GET 落定才挂载；4 worker 满载时 5 s 默认值不够（2026-11-10 全量实测 flaky），
        // 这里给 lane 预算（文件头已有 timeout-exempt 说明），只放宽等待、不放宽断言。
        await expect(page.getByTestId("config-domain-logging")).toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });
        await ensureDomainExpanded(page, "logging");
        await selectByTestId(page, "config-select-logging-levelCp", "ERROR");

        const [request] = await Promise.all([
            page.waitForRequest(
                (req) =>
                    req.method() === "PUT" && req.url().includes("/api/v1/config/instance/logging"),
            ),
            page.getByTestId("config-domain-logging").getByRole("button", { name: "保存" }).click(),
        ]);
        expect(JSON.parse(request.postData() ?? "{}").levelCp).toBe("ERROR");
    });

    // PLAN-0752 M1 把配置页换成域页后，旧的「配置导入/导出」区块随死页一起没了入口；
    // 现存的导出/导入入口在「数据」页（/settings/data，T4.4：数据面是有 atom 的页）。
    // 旧断言还验过 URL 上的 layer=instance 与 includeSecrets=true —— 这两个值自 0752 起不再由 UI 传参，
    // 而是 CP 的默认值（ConfigController.java:492-505：layer 服务端写死 instance、includeSecrets 默认 true）；
    // 该不变量由 CP 侧测试守（task-111/dev-1 补），UI 侧只证明「导出按钮确实打到实例导出端点」。
    test("export triggers the instance export request", async ({ page }) => {
        await mockConfigAPIs(page);
        await page.goto("/settings/data", { waitUntil: "load" });

        const [request] = await Promise.all([
            page.waitForRequest((req) => req.url().includes("/api/v1/config/export")),
            page.locator('button:has-text("导出设置")').click(),
        ]);
        expect(request.url()).toContain("/api/v1/config/export");
    });

    // 旧：/settings/config 死页 ConfigSettings 上传后渲染 config-import-warnings。
    // 新：导入/导出入口在「数据」页（T4.4）；M1 换页时把 warnings 面丢了（只显示
    // Imported/Skipped），task-111 补回 —— warnings[] 由 CP 返回后**逐条渲染**。
    // 这条断言要分辨两件事：①CP 给 N 条 ⇒ 列表恰 N 条且内容是 CP 原文（不是空容器、不是
    // [object Object]）②CP 没给 ⇒ **容器不渲染**（空容器与不渲染必须能区分）。
    test("import posts the file and renders skip warnings", async ({ page }) => {
        await mockConfigAPIs(page);
        let warnings: string[] = [
            "provider-connections: 1 credential(s) skipped - rebuild them via the provider connections API/UI",
        ];
        const postedBodies: string[] = [];
        await page.route("**/api/v1/config/import**", async (route: any) => {
            postedBodies.push(route.request().postData() ?? "");
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ status: "ok", imported: 2, skipped: 1, warnings }),
            });
        });
        await page.goto("/settings/data", { waitUntil: "load" });

        // 数据页的导入是两步：选文件 → 预览弹窗确认（预览要求 JSON 里真有 chats 数组）。
        const importOnce = async (): Promise<void> => {
            await page.getByRole("button", { name: "导入", exact: true }).click();
            await page.locator('input[type="file"]').setInputFiles({
                name: "xihe-chats.json",
                mimeType: "application/json",
                buffer: Buffer.from(
                    JSON.stringify({
                        chats: [{ id: "chat-1", messages: [{ role: "user", content: "hi" }] }],
                    }),
                ),
            });
            const modal = page.getByTestId("modal-content");
            await expect(modal).toBeVisible();
            await modal.getByRole("button", { name: "确认", exact: true }).click();
            await expect(modal).toBeHidden();
        };

        await importOnce();
        // ① 文件确实 POST 到导入端点（旧断言靠「上传后渲染出 warnings」间接证明，这里直接读请求体）
        await expect.poll(() => postedBodies.length).toBe(1);
        expect(postedBodies[0]).toContain("chat-1");
        // ② CP 给了 1 条 ⇒ 列表恰 1 条，且内容就是 CP 原文
        const warningList = page.getByTestId("config-import-warnings");
        await expect(warningList).toBeVisible();
        await expect(warningList.locator("li")).toHaveCount(1);
        await expect(warningList).toContainText("credential(s) skipped");

        // ③ CP 没给 warnings ⇒ 不渲染空容器
        warnings = [];
        await importOnce();
        await expect(page.getByTestId("config-import-warnings")).toHaveCount(0);
    });

    // 旧：死页 ConfigSettings 的整页 `showInitialLoading` →「加载中…」。
    // 新（task-112 + task-121）：域页在数据回来前渲染 `common.loading`
    // （`data-testid="settings-domain-loading"`），且**不渲染**「本域 N 项配置」；
    // 面板树用 `v-show` **常挂但不可见**（task-121：`v-if` 卸载窗口会和任何回写
    // `layerLoading` 的子组件组成「挂载→取数→卸载→重挂」自持循环，实测 63 轮/秒）。
    // 断言四件事：①pending 面出现 ②「0 项配置」不出现（不能把「还没回来」画成「没有配置」）
    // ③面板**不可见**（判据是「没假装已加载」，不是「DOM 里没有」—— 常挂是 task-121 的设计）
    // ④取数落定后三者反转（证明上面是**状态**，不是永远不渲染）。
    test("shows a pending state instead of an empty domain while layer config loads", async ({
        page,
    }) => {
        await mockConfigAPIs(page, { delayMs: 3000 });
        await page.goto("/settings/instance/logging", { waitUntil: "load" });

        // ① pending 面（用 testid，不依赖「加载中…」的省略号字形）
        await expect(page.getByTestId("settings-domain-loading")).toBeVisible();
        // ② 不得把 unknown 折成结论：此时不能出现「本域 N 项配置」
        await expect(page.getByTestId("settings-domain-summary")).toHaveCount(0);
        // ③ 面板不可见（task-121：v-show 常挂，所以判据从「DOM 里没有」改为「不可见」）
        await expect(page.getByTestId("config-domain-logging")).toBeHidden();

        // ④ 取数落定后三者反转
        await expect(page.getByTestId("settings-domain-loading")).toHaveCount(0, {
            timeout: LONG_TIMEOUT_MS,
        });
        await expect(page.getByTestId("settings-domain-summary")).toBeVisible();
        await expect(page.getByTestId("config-domain-logging")).toBeVisible();
    });

    // task-121 / VW-31：pending 期间面板容器是 `v-show` 隐藏 + `inert` + `aria-busy`。
    // dev-1 的诚实边界：jsdom 里 `display:none` 的元素仍可被脚本 `focus()`，**真实 Tab 顺序只能 e2e 验**。
    // 选 llm-provider 用户层域页：它是唯一在面板树里挂 ProviderHub 的页，也是 task-121 的循环现场。
    //
    // 这条断言的**判别力边界**（四组 A/B 实测，别当它对 inert 本身有判别力）：
    //  - 面板隐藏 + 无 inert ⇒ **绿**（`display:none` 已把子树移出 tab 序，inert 在此无增量）；
    //  - 面板可见 + 有 inert ⇒ **绿**（inert 生效，Tab 跳过面板）；
    //  - 面板可见 + 无 inert ⇒ **红**（Tab #35/41 落进面板）⇒ 断言有判别力，且 inert 在
    //    「pending 期间面板可见」这种形态下是**承重**的。
    //  ⇒ 现行实现下它守的是「pending 期间面板不进 tab 序」（今天由 v-show 提供，inert 是第二层）；
    //    若将来加载态改成「可见但禁用」，这条仍会替我们把 inert 的缺失抓出来。
    // Tab 预算必须按可聚焦元素数现算：固定 12 次会停在侧栏里，A/B 里正是这样一度变成空断言。
    test("pending keeps Tab focus out of the panel subtree", async ({ page }) => {
        // 快路由：provider 端点立即可用（让面板里的控件真的渲染出来）
        await mockConfigAPIs(page);
        // 慢路由：只把「层配置」拖住，制造 pending 窗口（LIFO：后注册者优先）
        await page.route("**/api/v1/config/**", async (route: any) => {
            await new Promise((resolve) => setTimeout(resolve, 3000));
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ domain: "", entries: {}, envOverridden: {} }),
            });
        });
        await page.goto("/settings/user/llm-provider", { waitUntil: "load" });

        await expect(page.getByTestId("settings-domain-loading")).toBeVisible();
        // 面板常挂但不可见；容器带 aria-busy/inert（本断言的机制前置）。
        // 注：llm-provider 域在这一层没有 `config-domain-*` 包裹（见 ConfigLayerPanels 的
        // `v-if="domain === 'llm-provider'"` 分支），面板内容就是 ProviderHub 本体。
        const panel = page.getByTestId("provider-hub");
        await expect(panel).toBeAttached();
        await expect(panel).toBeHidden();
        await expect(page.locator('div[aria-busy="true"][inert]')).toHaveCount(1);
        // 非空判据：面板里确实有可聚焦控件（否则「焦点没进去」是空断言）
        await expect(page.getByTestId("provider-connection-search")).toBeAttached();

        // Tab 预算按「当前可聚焦元素数 + 余量」现算 —— 固定次数（如 12）会停在侧栏里，
        // 断言就变成空断言（A/B 实测：面板故意可见时 12 次仍绿）。
        const focusableCount = await page.evaluate(
            () =>
                document.querySelectorAll(
                    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
                ).length,
        );
        for (let index = 0; index < focusableCount + 5; index += 1) {
            await page.keyboard.press("Tab");
            const focusedInsidePanels = await page.evaluate(() => {
                const active = document.activeElement,
                    hub = document.querySelector('[data-testid="provider-hub"]');
                return Boolean(active && hub && hub.contains(active));
            });
            expect(
                focusedInsidePanels,
                `Tab #${index + 1}/${focusableCount + 5} 后焦点落进面板子树`,
            ).toBe(false);
        }
    });

    // PLAN-0752 V12（移动端 375×812）：旧口径要证明的是「窄视口下设置区仍可用、不塌」，
    // 新壳里用三件事证明同样的事：
    //  ①左栏退化为抽屉（桌面 `aside` 在窄屏不渲染）且可开合；
    //  ②设置区**不出现横向滚动** —— 几何事实（`scrollWidth <= clientWidth`），不是截图观感；
    //  ③域页内容可见且标题非空（窄屏不是"只画了壳"）。
    test("mobile viewport: settings drawer opens and closes with no horizontal scroll", async ({
        page,
    }) => {
        await mockConfigAPIs(page);
        await page.setViewportSize({ width: 375, height: 812 });
        await page.goto("/settings/instance/logging", { waitUntil: "load" });

        // ③ 域页内容可见 + 标题非空（先等层配置落定，避免把 pending 壳当内容）
        await expect(page.getByTestId("settings-domain-loading")).toHaveCount(0, {
            timeout: LONG_TIMEOUT_MS,
        });
        const domainTitle = page.getByTestId("settings-domain-title");
        // 「非空」先查、且独立于可见性：空标题的 h2 高为 0，`toBeVisible` 也会红，
        // 若不先单独断言文字，这条就永远被可见性抢先 —— 文字判据就没有判别力了。
        await expect(domainTitle).toBeAttached();
        await expect(domainTitle, "域页标题必须非空").not.toHaveText(/^\s*$/, {
            timeout: ACTION_TIMEOUT_MS,
        });
        await expect(domainTitle).toBeVisible();
        await expect(page.getByTestId("config-domain-logging")).toBeVisible();

        // ① 抽屉：未开时不存在，打开后可见且含域条目，关闭后消失
        await expect(page.getByTestId("settings-drawer")).toHaveCount(0);
        const toggle = page.getByTestId("settings-drawer-toggle");
        await expect(toggle).toBeVisible();
        await expect(toggle).toHaveAttribute("aria-expanded", "false");
        await toggle.click();
        const drawer = page.getByTestId("settings-drawer");
        await expect(drawer).toBeVisible();
        await expect(toggle).toHaveAttribute("aria-expanded", "true");
        await expect(drawer.locator('[data-testid^="settings-nav-domain-"]').first()).toBeVisible();
        // task-510：抽屉是真 Sheet ⇒ 打开时焦点必须在抽屉内（修前是手搓 div，没有焦点陷阱，
        // Tab 会跑到背后正文，读屏用户没有出口）。这里只钉"焦点在里面"这一事实，不钉实现。
        const focusInsideDrawer = await page.evaluate(() => {
            const el = document.querySelector('[data-testid="settings-drawer"]');
            return Boolean(el && el.contains(document.activeElement));
        });
        expect(focusInsideDrawer, "抽屉打开后焦点必须在抽屉内（焦点陷阱）").toBe(true);
        await drawer.getByRole("button", { name: "关闭目录" }).click();
        await expect(page.getByTestId("settings-drawer")).toHaveCount(0);
        await expect(toggle).toHaveAttribute("aria-expanded", "false");

        // ② 无横向滚动 —— 关闭态与打开态都查（抽屉是 fixed 覆盖层，也不该把文档撑宽）
        const assertNoHorizontalScroll = async (state: string) => {
            const metrics = await page.evaluate(() => ({
                scrollWidth: document.documentElement.scrollWidth,
                clientWidth: document.documentElement.clientWidth,
            }));
            expect(
                metrics.scrollWidth,
                `${state}出现横向滚动：scrollWidth=${metrics.scrollWidth} > clientWidth=${metrics.clientWidth}`,
            ).toBeLessThanOrEqual(metrics.clientWidth);
        };
        await assertNoHorizontalScroll("抽屉关闭态");
        await toggle.click();
        await expect(drawer).toBeVisible();
        await assertNoHorizontalScroll("抽屉打开态");

        // ③ Esc 关抽屉（task-510）：修前 Esc 无反应，键盘用户只有"点遮罩"一条路。
        // 与上面「点关闭按钮」是两条独立路径，两条都钉。
        await page.keyboard.press("Escape");
        await expect(page.getByTestId("settings-drawer")).toHaveCount(0, {
            timeout: ACTION_TIMEOUT_MS,
        });
        await expect(toggle).toHaveAttribute("aria-expanded", "false");
    });

    test("shows an error banner when layer config cannot be loaded", async ({ page }) => {
        await page.route("**/api/v1/**", (route: any) =>
            route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({}),
            }),
        );
        // task-461（D-1311）：上面的兜底把页面**合法调用**的会话列表也答成 `{}`，而
        // `api.ts:3107-3114 normalizeSessionListPayload` 要求 `sessions` 数组 ⇒ throw ⇒ logger[ERROR]
        // ⇒ `helpers/page-failures.ts:44` 的共享 console 门「no unexpected console errors」红。
        // 这不是产品缺陷，是**桩给了非法形状**：`WorkspaceSessionGroups` 首屏要读独立会话与
        // 工作区会话，两条都被兜底吞掉。修法照**仓内既有先例** `plan-0560-settings.spec.ts:33-43`
        // （BL-318 同因同修）：注册在兜底**之后**（Playwright LIFO ⇒ 后注册优先），只给集合面
        // 一个合法信封，非 GET 仍 `route.fallback()` 交回上层桩。
        //
        // **为什么不 passthrough 给 mock server**：本 spec 跑 index 链路，`helpers/chain.ts:79
        // mockApiEnvFor("index") = "0"` ⇒ `vite.config.ts:136/155` 不挂 mock 中间件 ⇒ `route.continue()`
        // 会落到 vite 的 SPA 回落（200 HTML），JSON 解析炸得更响。index 链路只能按契约给形状。
        //
        // **读数机制（runtime-1 核实，更正 4cb22713 body 的措辞）**：含视觉基线的用例修前**不是「没走到 skip」**——
        // `e2e/helpers/visual.ts:28 test.skip(true)` 在非 linux 平台执行了，红来自**之后的 auto fixture teardown**
        // （`helpers/mock-test.ts:79 expectNoPageFailures`，`{auto:true}`）⇒ skip 已触发 + 门红 = failed；门绿 = skipped。
        // ⇒ **这套套件里 skipped 不是免检区**（teardown 门仍能把 skip 的用例判红），且这些用例在 Windows 上
        // **视觉断言零执行**（仪器覆盖边界，别读成「它在保护视觉回归」）。两种说法排查方向不同：前者查渲染/取数，
        // 后者查桩形状。
        //        // **边界（runtime-1 复核意见，别照抄到别处）**：`{sessions: []}` 是**合法空集**，在这里成立
        // 只因为本 spec 不断言会话内容。要验会话内容的 spec 必须给真行 —— 空集会让断言变成空断言
        // （D-1281 同族）。**不放宽 console 门、不给 sessions 错误加白名单**（那是把判据改绿，D-1303）。
        await page.route(/\/api\/v1\/(?:workspaces\/[^/]+\/)?sessions(?:\?.*)?$/, (route: any) => {
            if (route.request().method() !== "GET") return route.fallback();
            return route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ sessions: [] }),
            });
        });
        await page.route("**/api/v1/config/**", (route: any) => route.abort("connectionrefused"));
        await page.route("**/api/v1/events**", (route: any) =>
            route.fulfill({
                status: 200,
                headers: { "Content-Type": "text/event-stream" },
                body: "retry: 5000\n\n",
            }),
        );
        // 旧：/settings/config 里层的整块加载失败；新：域页拉层配置失败（SettingsDomainView 的 fetchError 分支）。
        await page.goto("/settings/instance/logging", { waitUntil: "load" });
        await expect(page.getByTestId("settings-domain-title")).toBeVisible();
        await expect(page.locator("text=保存失败")).toBeVisible();
    });
});
