import type { Page } from "@playwright/test";
import { expect, test } from "./helpers/mock-test";
import { EXPECT_TIMEOUT_MS } from "../timeouts";
import { i18n } from "../../src/i18n";

/**
 * task-94：**零连接时漂移线索必须仍在**（ProviderHub 空态短路修复的浏览器证据）。
 *
 * <p>缺陷形态：`ProviderHub.vue:1339-1345` 原来是 `v-if="connections.length === 0"` 空态 + `<div v-else>`，
 * 漂移条目（PLAN-0523 T3.2 的「已失效 · 保留中」）住在 v-else 枝里 ⇒ **一条连接都没有时整枝被跳过**，
 * 用户看不到「我的默认连接已经不可见」这条唯一线索。修法：v-else 换成
 * `v-if="connections.length > 0 || driftedProfile"`，并把「无匹配」提示挪到漂移条目之后、加 `connections.length > 0` 条件。</p>
 *
 * <p>本文件只测**渲染可见性**（不碰漂移判定 `:150 driftedProfile`、不碰保存期 inline 警示 `:317/:322 profileWarning`）。
 * 三态各一条，全部走 index 链路的 page.route 桩（不依赖 vite mock 中间件 ⇒ 无链路守卫、不 skip）：
 * ① 零连接 + 有漂移 ② 零连接 + 无漂移 ③ 有连接 + 有漂移。</p>
 *
 * <p>跑法（单 spec = L0）：`cd packages/ui && XIHE_E2E_PROFILE=mock XIHE_UI_PORT=12750 pnpm test:e2e
 * e2e/mock/provider-hub-drift-empty.spec.ts --workers=1`</p>
 */
const zh = i18n.global.getLocaleMessage("zh-CN") as Record<string, unknown>;

function copy(path: string): string {
    const value = path.split(".").reduce<unknown>((node, key) => {
        return node && typeof node === "object"
            ? (node as Record<string, unknown>)[key]
            : undefined;
    }, zh);
    if (typeof value !== "string") throw new Error("zh-CN 文案缺失：" + path);
    return value;
}

const EMPTY_COPY = copy("settings.providerHub.empty"),
    DRIFT_BADGE = copy("settings.providerHub.driftBadge"),
    NO_MATCH_COPY = copy("settings.providerHub.noMatch"),
    HUB_URL = "/settings/user/llm-provider",
    /** 漂移条目的 testid：profile 指向的连接已不可见时才有。 */
    DRIFT = "provider-default-drift",
    /** 只命中连接列表行（默认连接卡是 provider-default-connection，详情是 section）。 */
    ROWS = 'article[data-testid^="provider-connection-"]',
    /** profile 指向的连接（刻意不出现在连接列表里 ⇒ 必然漂移）。 */
    GHOST_PROFILE = {
        providerId: "custom-openai-compatible",
        connectionKey: "ghost-default",
        model: "ghost-model",
    };

const CATALOG = { catalogRevision: "rev-mock-task94", providers: [] };

interface Connection {
    id: string;
    providerId: string;
    connectionKey: string;
    apiTypeId: string;
    apiTypeVersion: number;
    operation: string;
    label: string;
    scope: string;
    baseUrl: string | null;
    modelDiscovery: string;
    manualModels: string[];
    hasKey: boolean;
    enabled: boolean;
    status: string;
    revision: number;
}

function connection(key: string, label: string): Connection {
    return {
        id: key,
        providerId: "custom-openai-compatible",
        connectionKey: key,
        apiTypeId: "openai-chat-completions",
        apiTypeVersion: 1,
        operation: "chat",
        label,
        scope: "USER",
        baseUrl: null,
        modelDiscovery: "manual",
        manualModels: ["kept-model"],
        hasKey: true,
        enabled: true,
        status: "READY",
        revision: 1,
    };
}

const KEPT_CONNECTION = connection("kept-line", "保留的连接");

interface StubOptions {
    /** 是否让 user 层 llm-provider 的 profile 指向一条不可见连接（= 制造漂移）。 */
    driftProfile: boolean;
    /** 连接列表返回的行（零连接态传 []）。 */
    connections: Connection[];
}

async function stubApi(page: Page, options: StubOptions) {
    await page.addInitScript(() => {
        localStorage.setItem("xihe-token", "mock-token");
        localStorage.setItem(
            "xihe-user",
            JSON.stringify({ id: "u1", email: "admin@xihe.local", role: "ADMIN" }),
        );
        localStorage.setItem(
            "xihe-workspace",
            JSON.stringify({ id: "ws-1", name: "Mock Workspace" }),
        );
    });
    // 兜底：设置页外壳会顺带拉 /auth/me、/me/permissions、/sessions 等；本 spec 只关心
    // llm-provider 的漂移渲染，其余一律给空的 200（未桩 = 打到 vite 代理 = 502，公共失败门禁会红）。
    await page.route("**/api/v1/**", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
    );
    await page.route("**/api/v1/workspaces/ws-1", (route) =>
        route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ id: "ws-1", name: "Mock Workspace" }),
        }),
    );
    // 配置面：只有 user 层 llm-provider 的 profile 可能被预置；其余域一律空条目（形状与 CP 一致）。
    await page.route("**/api/v1/config/**", (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith("/meta")) {
            return route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ keys: [] }),
            });
        }
        const domain = url.pathname.split("/").pop() ?? "";
        const layer = url.searchParams.get("layer") ?? "user";
        const entries =
            options.driftProfile && domain === "llm-provider" && layer === "user"
                ? { profile: JSON.stringify(GHOST_PROFILE) }
                : {};
        return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ domain, entries }),
        });
    });
    await page.route("**/api/v1/provider-connections", (route) =>
        route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ connections: options.connections }),
        }),
    );
    await page.route("**/api/v1/provider-catalog", (route) =>
        route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(CATALOG),
        }),
    );
    await page.route("**/api/v1/api-input-types", (route) =>
        route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ types: [] }),
        }),
    );
    await page.route("**/api/v1/models", (route) =>
        route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ models: {}, providers: {} }),
        }),
    );
    await page.route("**/api/v1/events**", (route) =>
        route.fulfill({
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
            body: "retry: 5000\n\n",
        }),
    );
}

async function openHub(page: Page) {
    await page.goto(HUB_URL, { waitUntil: "load" });
    await expect(page.getByTestId("provider-hub")).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
    // 页面数据是挂载后异步拉的：等主从区出现，避免用「还没加载完」当结论（假绿）。
    // 不用「漂移 or 空态」当哨兵：零连接 + 有漂移时两者**同时**在场，`.or()` 会撞 strict mode
    // （实测 resolved to 2 elements）—— 那正是本卡要的状态，不该被当成加载判据。
    await expect(page.getByTestId("provider-master-detail")).toBeVisible({
        timeout: EXPECT_TIMEOUT_MS,
    });
}

test.describe("ProviderHub 零连接时漂移线索（task-94）", () => {
    test("① 零连接 + profile 指向失效连接 ⇒ 漂移条目可见且写明「已失效 · 保留中」", async ({
        page,
    }) => {
        await stubApi(page, { driftProfile: true, connections: [] });
        await openHub(page);

        const drift = page.getByTestId(DRIFT);
        await expect(drift, "零连接时也必须渲染漂移条目（修前 v-else 短路会把它藏掉）").toBeVisible(
            {
                timeout: EXPECT_TIMEOUT_MS,
            },
        );
        await expect(drift).toContainText(GHOST_PROFILE.connectionKey);
        await expect(drift.getByText(DRIFT_BADGE, { exact: true })).toBeVisible();
        // 空态与漂移同屏是**预期**：前者说「你没有可见连接」，后者说「你的默认连接是其中一个」。
        await expect(page.getByText(EMPTY_COPY, { exact: true })).toBeVisible();
        // 零连接时不该冒出「无匹配」筛选提示（那是「有连接但被筛选藏掉」的语义）。
        await expect(page.getByText(NO_MATCH_COPY, { exact: true })).toHaveCount(0);
        await expect(page.locator(ROWS)).toHaveCount(0);
    });

    test("② 零连接 + 无 profile ⇒ 空态照旧，且不渲染空漂移壳", async ({ page }) => {
        await stubApi(page, { driftProfile: false, connections: [] });
        await page.goto(HUB_URL, { waitUntil: "load" });
        await expect(page.getByTestId("provider-hub")).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        await expect(page.getByText(EMPTY_COPY, { exact: true })).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        await expect(page.getByTestId(DRIFT)).toHaveCount(0);
        await expect(page.getByText(NO_MATCH_COPY, { exact: true })).toHaveCount(0);
        await expect(page.locator(ROWS)).toHaveCount(0);
    });

    test("③ 有连接 + profile 指向失效连接 ⇒ 漂移条目与连接行同屏可见", async ({ page }) => {
        await stubApi(page, { driftProfile: true, connections: [KEPT_CONNECTION] });
        await page.goto(HUB_URL, { waitUntil: "load" });
        const drift = page.getByTestId(DRIFT);
        await expect(drift, "有连接时漂移行为必须不变").toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        await expect(drift.getByText(DRIFT_BADGE, { exact: true })).toBeVisible();
        await expect(page.locator(ROWS)).toHaveCount(1);
        await expect(page.locator(ROWS + '[data-connection-key="kept-line"]')).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        await expect(page.getByText(EMPTY_COPY, { exact: true })).toHaveCount(0);
        await expect(page.getByText(NO_MATCH_COPY, { exact: true })).toHaveCount(0);
    });
});
