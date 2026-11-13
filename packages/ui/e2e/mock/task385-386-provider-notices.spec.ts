import { expect, test } from "./helpers/mock-test";
import type { Page } from "@playwright/test";
import { ACTION_TIMEOUT_MS } from "../timeouts";

/**
 * task-385（D-1233）+ task-386（D-1232）的浏览器判据。两条都是**纯 UI**（D-1203：不加 HTTP
 * warning 字段、不改服务端行为），所以 mock lane 就能钉住；真栈复跑归 L2 窗口。
 *
 * 385：实例层保存 profile 时连接未就绪 ⇒ inline 警示**且保存真的发生**（不阻断）、可关闭。
 * 386：消费层（用户层）展示实例模型时，只有「自己有同 key 对的 USER ∧ enabled ∧ READY 连接」
 *      才标注「此模型将使用你自己的凭据」；只有 INSTANCE 行 / 未就绪 ⇒ 不标注。
 *
 * 承重负例：385 把 refreshProfileWarning() 去掉 ⇒ 第一条红；把警示改成阻断 ⇒ PUT 计数断言红。
 * 386 漏掉 scope 过滤 ⇒ 第四条（只有 INSTANCE 行）红；漏掉 READY ⇒ 第五条红。
 */
const PROVIDER = {
    id: "example",
    displayName: "Example",
    adapter: "openai-compatible",
    defaultBaseUrl: "https://example.test/v1",
    modelDiscovery: "remote-models",
    credential: { type: "api-key", required: true },
    supports: { customBaseUrl: true, streaming: true },
    supportedApiTypes: [{ apiTypeId: "openai-chat", version: 1 }],
    defaultApiType: { apiTypeId: "openai-chat", version: 1 },
};

function connection(overrides: Record<string, unknown> = {}) {
    return {
        id: "conn-1",
        providerId: PROVIDER.id,
        connectionKey: "primary",
        apiTypeId: "openai-chat",
        apiTypeVersion: 1,
        operation: "chat",
        label: "Mock connection",
        scope: "INSTANCE",
        baseUrl: "https://example.test/v1",
        modelDiscovery: "manual",
        manualModels: ["model-a"],
        hasKey: true,
        enabled: true,
        status: "READY",
        revision: 1,
        ...overrides,
    };
}

const PROFILE = JSON.stringify({
    providerId: PROVIDER.id,
    connectionKey: "primary",
    model: "model-a",
});

const WARNING = '[data-testid="provider-profile-warning"]';
const NOTE = '[data-testid="config-source-own-credential-llm-provider"]';
const SUMMARY = '[data-testid="config-source-summary-llm-provider"]';

async function login(page: Page, admin: boolean): Promise<void> {
    await page.addInitScript((isAdmin: boolean) => {
        localStorage.setItem("xihe-token", "mock-token");
        localStorage.setItem(
            "xihe-user",
            JSON.stringify({
                id: "u1",
                email: isAdmin ? "admin@xihe.local" : "user@xihe.local",
                capabilities: {
                    isInstanceAdmin: isAdmin,
                    isInstanceSuper: isAdmin,
                    workspaceAdminOf: [],
                },
            }),
        );
    }, admin);
}

interface Fixture {
    connections: Array<Record<string, unknown>>;
    /** 用户层 meta：profile 行的 source（instance ⇒ 真的在消费实例模型）。 */
    userProfileSource?: string;
    /** 合并读面（GET /config/llm-provider，无 layer）里的生效 profile。 */
    mergedProfile?: string;
}

/** 路由桩：catch-all 先注册（Playwright LIFO，具体路由后注册者胜）。 */
async function mockApis(page: Page, fixture: Fixture) {
    const state = { puts: [] as string[], instanceEntries: {} as Record<string, string> };
    const json = (body: unknown) => ({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
    });
    await page.route("**/api/v1/**", (route) => route.fulfill(json({})));
    await page.route("**/api/v1/provider-catalog", (route) =>
        route.fulfill(json({ catalogRevision: "1", providers: [PROVIDER] })),
    );
    await page.route("**/api/v1/provider-connections", (route) =>
        route.fulfill(json({ connections: fixture.connections })),
    );
    await page.route("**/api/v1/api-input-types", (route) => route.fulfill(json({ types: [] })));
    await page.route("**/api/v1/config/**", async (route) => {
        const request = route.request(),
            url = new URL(request.url()),
            layer = url.searchParams.get("layer");
        if (request.method() === "PUT") {
            const body = request.postData() ?? "{}";
            state.puts.push(body);
            state.instanceEntries = JSON.parse(body) as Record<string, string>;
            await route.fulfill(json({ status: "ok", keys: 1 }));
            return;
        }
        if (url.pathname.endsWith("/meta")) {
            const keys =
                layer === "user" && fixture.userProfileSource
                    ? [
                          {
                              key: "profile",
                              source: fixture.userProfileSource,
                              locked: false,
                              writable: true,
                              reason: null,
                              instanceEligible: true,
                              defaultPresent: true,
                              overridable: true,
                          },
                      ]
                    : [];
            await route.fulfill(json({ keys }));
            return;
        }
        const domain = url.pathname.split("/").pop() ?? "";
        if (!layer) {
            // 合并读面直接返回 entries map（stores/config.ts:292 fetchDomain）。
            await route.fulfill(
                json(fixture.mergedProfile ? { profile: fixture.mergedProfile } : {}),
            );
            return;
        }
        await route.fulfill(
            json({
                domain,
                entries: layer === "instance" ? state.instanceEntries : {},
                envOverridden: {},
            }),
        );
    });
    return state;
}

test.describe("task-385 实例层 profile 未就绪警示（不阻断）", () => {
    test.use({ viewport: { width: 1600, height: 1000 } });

    test("UNVERIFIED 连接设为默认 ⇒ 警示出现 + PUT 真的发了 + 可关闭", async ({ page }) => {
        await login(page, true);
        const state = await mockApis(page, {
            connections: [connection({ status: "UNVERIFIED" })],
        });
        await page.goto("/settings/instance/llm-provider");
        const hub = page.locator('[data-testid="provider-hub"]');
        await expect(hub).toBeVisible({ timeout: ACTION_TIMEOUT_MS });
        await expect(page.locator(WARNING)).toHaveCount(0);

        await page
            .locator('[data-testid="provider-connection-default-conn-1"]')
            .click({ timeout: ACTION_TIMEOUT_MS });

        const warning = page.locator(WARNING);
        await expect(warning).toBeVisible({ timeout: ACTION_TIMEOUT_MS });
        await expect(warning).toContainText("409");
        // 不阻断的承重断言：警示出现的同时，保存请求真的发出去了（不是「拦下来只给提示」）。
        expect(state.puts.length).toBe(1);
        expect(JSON.parse(state.puts[0] ?? "{}")).toMatchObject({
            profile: expect.stringContaining('"connectionKey":"primary"'),
        });

        await page
            .locator('[data-testid="provider-profile-warning-dismiss"]')
            .click({ timeout: ACTION_TIMEOUT_MS });
        await expect(warning).toHaveCount(0);
    });

    test("READY 连接设为默认 ⇒ 保存成功且无警示", async ({ page }) => {
        await login(page, true);
        const state = await mockApis(page, { connections: [connection({ status: "READY" })] });
        await page.goto("/settings/instance/llm-provider");
        await expect(page.locator('[data-testid="provider-hub"]')).toBeVisible({
            timeout: ACTION_TIMEOUT_MS,
        });
        await page
            .locator('[data-testid="provider-connection-default-conn-1"]')
            .click({ timeout: ACTION_TIMEOUT_MS });
        await expect.poll(() => state.puts.length, { timeout: ACTION_TIMEOUT_MS }).toBe(1);
        await expect(page.locator(WARNING)).toHaveCount(0);
    });
});

test.describe("task-386 消费层实例模型的凭据归属标注", () => {
    test.use({ viewport: { width: 1600, height: 1000 } });

    test("自己有同 key 的 USER ∧ READY 连接 ⇒ 标注可见（文案说凭据）", async ({ page }) => {
        await login(page, false);
        await mockApis(page, {
            connections: [connection({ scope: "USER", status: "READY" })],
            userProfileSource: "instance",
            mergedProfile: PROFILE,
        });
        await page.goto("/settings/user/llm-provider");
        await expect(page.locator(SUMMARY)).toBeVisible({ timeout: ACTION_TIMEOUT_MS });
        const note = page.locator(NOTE);
        await expect(note).toBeVisible({ timeout: ACTION_TIMEOUT_MS });
        await expect(note).toHaveText("此模型将使用你自己的凭据");
    });

    test("只有 INSTANCE 行（管理员视角常见）⇒ 不标注（scope 过滤承重）", async ({ page }) => {
        await login(page, false);
        await mockApis(page, {
            connections: [connection({ scope: "INSTANCE", status: "READY" })],
            userProfileSource: "instance",
            mergedProfile: PROFILE,
        });
        await page.goto("/settings/user/llm-provider");
        await expect(page.locator(SUMMARY)).toBeVisible({ timeout: ACTION_TIMEOUT_MS });
        await expect(page.locator(NOTE)).toHaveCount(0);
    });

    test("USER 行但 UNVERIFIED ⇒ 不标注（运行时会回落 INSTANCE，标注会是假的）", async ({
        page,
    }) => {
        await login(page, false);
        await mockApis(page, {
            connections: [connection({ scope: "USER", status: "UNVERIFIED" })],
            userProfileSource: "instance",
            mergedProfile: PROFILE,
        });
        await page.goto("/settings/user/llm-provider");
        await expect(page.locator(SUMMARY)).toBeVisible({ timeout: ACTION_TIMEOUT_MS });
        await expect(page.locator(NOTE)).toHaveCount(0);
    });

    test("profile 不是来自实例层（source=user）⇒ 不标注", async ({ page }) => {
        await login(page, false);
        await mockApis(page, {
            connections: [connection({ scope: "USER", status: "READY" })],
            userProfileSource: "user",
            mergedProfile: PROFILE,
        });
        await page.goto("/settings/user/llm-provider");
        await expect(page.locator(SUMMARY)).toBeVisible({ timeout: ACTION_TIMEOUT_MS });
        await expect(page.locator(NOTE)).toHaveCount(0);
    });
});
