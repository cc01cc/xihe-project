import type { Page } from "@playwright/test";
import { expect, test } from "./helpers/mock-test";
import { ACTION_TIMEOUT_MS, EXPECT_TIMEOUT_MS } from "../timeouts";
import { i18n } from "../../src/i18n";

/**
 * task-284 判据②a 的**浏览器证据**（实例层 llm-provider 与用户层同构，B 形态），跑在 **preview 链路**：
 * `XIHE_E2E_EXPECT_CHAIN=preview` ⇒ vite 挂 mock 中间件并把 `/settings/**` 入口改写成 `preview-real.html`。
 *
 * <p>**不调 `setupMockAuth`**：它的 api/v1 通配兜底会把 task-454 的真写面整个盖掉 ⇒ 测的是 spec
 * 自己的桩（假绿）。这里只借 `mock-test` 的失败门禁（0 pageerror / 0 console error / 0 非预期 ≥400）：
 * 创建流要连打 POST → verify → 列表重载，任何一条面缺失都会以 404 或 pageerror 让本 spec 红。</p>
 *
 * <p><b>判据②a 与本 spec 的对应</b>：① 实例层能**建** ≥2 条 INSTANCE 连接（走产品 UI 表单，不是塞夹具）；
 * ② 每条带 ≥2 个模型（种子两条 chat 连接走目录，新建两条走手填模型）；③ 归属徽标显示 Instance 而不是 User
 * （task-454 前小写 scope 落 else 分支的回归）；④ 刷新后仍在（写面落 dev server 内存）。</p>
 *
 * <p><b>②b 真栈持久化仍未验（D-1155，不许用 mock 代替）</b>：本 spec 只证 mock 车道的 UI 结构与写面通路。
 * CP 真栈的「建连接 → 重启进程后仍在」需要真栈窗口，属 L2；dev server 重启回种子是 mock 的既定局限
 * （`data/providerConnections.ts` 注释已写），**不在这里断言成持久化**。</p>
 *
 * <p>跑法（单 spec = L0）：`XIHE_E2E_PROFILE=mock XIHE_UI_PORT=12736 XIHE_E2E_BROWSER_CHANNEL=chrome-beta
 * XIHE_E2E_EXPECT_CHAIN=preview pnpm exec playwright test --config e2e/playwright.config.ts
 * e2e/mock/task284-instance-provider.spec.ts --workers=1`</p>
 */
const INSTANCE_URL = "/settings/instance/llm-provider",
    USER_URL = "/settings/user/llm-provider",
    zh = i18n.global.getLocaleMessage("zh-CN") as Record<string, unknown>;

function copy(path: string): string {
    const value = path.split(".").reduce<unknown>((node, key) => {
        return node && typeof node === "object"
            ? (node as Record<string, unknown>)[key]
            : undefined;
    }, zh);
    if (typeof value !== "string") throw new Error("zh-CN 文案缺失：" + path);
    return value;
}

const SCOPE_INSTANCE = copy("settings.providerHub.scopeInstance"),
    SCOPE_USER = copy("settings.providerHub.scopeUser");

/**
 * 行的选择器必须只命中**列表行**。实测教训（本 spec 首跑 4 条全红，真因是选择器不是产品）：
 * `data-connection-key` 同时出现在三处 —— 默认连接卡（`ProviderHub.vue:1192`）、列表行 `<article>`（`:1273`）、
 * 右侧详情 `<section data-testid="provider-connection-detail">`（`:1351`）⇒ 裸属性选择器会 strict mode
 * violation（resolved to 2 elements）。这里用 `article[data-testid^="provider-connection-"]`：
 * 详情是 section 不算，默认连接卡的 testid 是 `provider-default-connection` 也不匹配该前缀。
 */
const ROWS = 'article[data-testid^="provider-connection-"]';

async function openHub(page: Page, url: string) {
    await page.goto(url);
    await expect(page.getByTestId("provider-hub")).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
}

interface NewConnection {
    key: string;
    label: string;
    models: string[];
}

/** 走产品 UI 建一条 INSTANCE 连接（手填两个模型）。 */
async function createConnection(page: Page, input: NewConnection) {
    await page.getByTestId("provider-hub-connect").click({ timeout: ACTION_TIMEOUT_MS });
    await expect(page.getByTestId("provider-picker-modal")).toBeVisible({
        timeout: EXPECT_TIMEOUT_MS,
    });
    await page.getByTestId("provider-picker-anthropic").click({ timeout: ACTION_TIMEOUT_MS });
    const modal = page.getByTestId("provider-connection-modal");
    await expect(modal).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
    await modal.getByTestId("provider-connection-form-label").fill(input.label);
    await modal.getByTestId("provider-connection-form-key").fill(input.key);
    // apiKey 输入框没有 testid（`:2215-2225`），按 type=password 定位。
    await modal.locator('input[type="password"]').fill("mock-key-for-e2e");
    await modal
        .getByTestId("provider-connection-field-discovery")
        .click({ timeout: ACTION_TIMEOUT_MS });
    // reka-ui Select 的内容在 portal 里 ⇒ 用 page 而不是 modal 定位选项。
    await page
        .getByTestId("provider-connection-discovery-option-manual")
        .click({ timeout: ACTION_TIMEOUT_MS });
    await modal.locator("textarea").fill(input.models.join("\n"));
    await modal.locator('button[type="submit"]').click({ timeout: ACTION_TIMEOUT_MS });
    // 创建成功的判据是**列表真的多出这一行**，不是 toast（toast 是旧假成功也有的东西）。
    await expect(
        page.locator(
            `article[data-testid^="provider-connection-"][data-connection-key="${input.key}"]`,
        ),
    ).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
}

test.describe("preview mock instance provider hub (task-284 判据②a)", () => {
    test("实例层两条 chat 连接各 ≥2 模型，归属徽标是 Instance 不是 User", async ({ page }) => {
        await openHub(page, INSTANCE_URL);
        for (const key of ["conn-claude-primary", "conn-claude-secondary"]) {
            const row = page.locator(
                `article[data-testid^="provider-connection-"][data-connection-key="${key}"]`,
            );
            await expect(row).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
            await expect(row).toContainText(SCOPE_INSTANCE, { timeout: EXPECT_TIMEOUT_MS });
            // 回归判据：小写 scope 时代这里渲染的是 User（task-454 前的实测缺陷）。
            await expect(row).not.toContainText(SCOPE_USER);
        }
        await page
            .locator(
                'article[data-testid^="provider-connection-"][data-connection-key="conn-claude-primary"]' +
                    " button",
            )
            .first()
            .click({
                timeout: ACTION_TIMEOUT_MS,
            });
        await expect(page.getByTestId("provider-model-claude-sonnet-4-5")).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        await expect(page.getByTestId("provider-model-claude-haiku-4-5")).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        await page
            .locator(
                'article[data-testid^="provider-connection-"][data-connection-key="conn-claude-secondary"]' +
                    " button",
            )
            .first()
            .click({
                timeout: ACTION_TIMEOUT_MS,
            });
        await expect(page.getByTestId("provider-model-claude-opus-4-1")).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
    });

    test("能建：走产品 UI 新建两条 INSTANCE 连接，行数真的 +2，各带 2 个手填模型", async ({
        page,
    }) => {
        await openHub(page, INSTANCE_URL);
        const before = await page.locator(ROWS).count();
        await createConnection(page, {
            key: "e2e-inst-a",
            label: "E2E 实例连接 A",
            models: ["e2e-model-a1", "e2e-model-a2"],
        });
        await createConnection(page, {
            key: "e2e-inst-b",
            label: "E2E 实例连接 B",
            models: ["e2e-model-b1", "e2e-model-b2"],
        });
        await expect(page.locator(ROWS)).toHaveCount(before + 2, { timeout: EXPECT_TIMEOUT_MS });
        for (const key of ["e2e-inst-a", "e2e-inst-b"]) {
            const row = page.locator(
                `article[data-testid^="provider-connection-"][data-connection-key="${key}"]`,
            );
            await expect(row).toContainText(SCOPE_INSTANCE, { timeout: EXPECT_TIMEOUT_MS });
        }
        await page
            .locator(
                'article[data-testid^="provider-connection-"][data-connection-key="e2e-inst-b"]' +
                    " button",
            )
            .first()
            .click({
                timeout: ACTION_TIMEOUT_MS,
            });
        await expect(page.getByTestId("provider-model-e2e-model-b1")).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        await expect(page.getByTestId("provider-model-e2e-model-b2")).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
    });

    test("刷新后仍在（写面落 dev server 内存，不是只改前端状态）", async ({ page }) => {
        await openHub(page, INSTANCE_URL);
        await createConnection(page, {
            key: "e2e-inst-reload",
            label: "E2E 刷新连接",
            models: ["e2e-reload-m1", "e2e-reload-m2"],
        });
        await page.reload();
        await expect(page.getByTestId("provider-hub")).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        await expect(
            page.locator(
                'article[data-testid^="provider-connection-"][data-connection-key="e2e-inst-reload"]',
            ),
        ).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
    });

    test("同构：用户层挂同一个 ProviderHub，结构与创建入口一致（判据①）", async ({ page }) => {
        await openHub(page, USER_URL);
        await expect(page.getByTestId("provider-hub-connect")).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        await expect(page.getByTestId("provider-master-detail")).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        // 夹具行都是 INSTANCE 归属 ⇒ 用户层也如实标 Instance，不因为页面是用户层就改标签。
        const row = page.locator(
            'article[data-testid^="provider-connection-"][data-connection-key="conn-claude-primary"]',
        );
        await expect(row).toContainText(SCOPE_INSTANCE, { timeout: EXPECT_TIMEOUT_MS });
    });
});
