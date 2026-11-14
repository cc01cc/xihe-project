import type { Page, Request } from "@playwright/test";
import { expect, test } from "./helpers/mock-test";
import { ACTION_TIMEOUT_MS, EXPECT_TIMEOUT_MS } from "../timeouts";
import { i18n } from "../../src/i18n";
import { API_REQUEST_TEMPLATE_FIXTURE } from "../../src/preview/mock/data/apiRequestTemplates";

/**
 * task-459 / D-1306 的**浏览器判据**：编辑连接时切换 API Type 的整条流，跑在 **preview 链路**
 * （`XIHE_E2E_EXPECT_CHAIN=preview` ⇒ vite 挂 mock 中间件、把 `/settings/**` 入口改写成
 * `preview-real.html`）。
 *
 * <p>**为什么这条链要整条一卡**：`ProviderHub.previewTypeChange()` 要两样东西才算能用 ——
 * ① `GET /provider-connections/{id}/api-type-change-impact`（`ProviderHub.vue:742`，不实现就抛错并
 * 弹 error toast，且 try 中断 ⇒ ②`listVisibleTemplates()` 不执行）；② `GET /config/api-request-templates`
 * 的 `entries.templates`（没有夹具 ⇒ `parseTemplates(undefined)` 回 [] ⇒ 模板选项恒空）。
 * 缺②时保存门（`:855-869` 的 `chat && !defaultTemplate`）仍然挡住 ⇒ **半修会把「弹错+选项空」
 * 换成「不弹错但仍保存不了」**，与 task-454 消灭假成功同主题，所以这里两条都断言。</p>
 *
 * <p>**不调 `setupMockAuth`**：它的 `**\/api\/v1\/**` 通配兜底会把 mock 中间件的真写面盖掉 ⇒
 * 测的是 spec 自己的桩（假绿）。只借 `mock-test` 的失败门禁（0 pageerror / 0 console error /
 * 0 非预期 ≥400）：impact 面缺失会以 404 让本 spec 红，这正是要的仪器。</p>
 *
 * <p>跑法（单 spec = L0）：`XIHE_E2E_PROFILE=mock XIHE_UI_PORT=12736 XIHE_E2E_BROWSER_CHANNEL=chrome-beta
 * XIHE_E2E_EXPECT_CHAIN=preview pnpm exec playwright test --config e2e/playwright.config.ts
 * e2e/mock/task459-provider-type-change.spec.ts --workers=1`</p>
 */
const INSTANCE_URL = "/settings/instance/llm-provider";

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

const MANAGE = copy("settings.providerHub.manage");
const TEMPLATE_LABEL = copy("settings.providerHub.newDefaultTemplate");
const CONFIRM = copy("settings.providerHub.confirmTypeChange");
const TOAST_REQUIRED = copy("settings.providerHub.toastTypePreviewRequired");
const ROWS = 'article[data-testid^="provider-connection-"]';

const PUBLISHED = API_REQUEST_TEMPLATE_FIXTURE.filter((item) => item.status === "published");
const DRAFT = API_REQUEST_TEMPLATE_FIXTURE.filter((item) => item.status === "draft");

async function openHub(page: Page) {
    await page.goto(INSTANCE_URL);
    await expect(page.getByTestId("provider-hub")).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
}

/**
 * 在 API Type 选择器里挑一条**与当前不同**的类型。
 * 不按文案硬编码：选项文案是 `formatApiType` 的口语短名（`apiTypeLabels.ts:25`，如「OpenAI 对话补全@1」），
 * 依赖它等于把 i18n 文案焊进判据 ⇒ 这里读当前选中值，挑第一条不同的选项（数据驱动）。
 */
async function switchToAnotherApiType(page: Page) {
    const trigger = page.getByTestId("provider-connection-api-type");
    const current = (await trigger.textContent())?.trim() ?? "";
    await trigger.click({ timeout: ACTION_TIMEOUT_MS });
    const options = page.getByRole("option");
    await expect(options.first()).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
    const texts = await options.allTextContents();
    const index = texts.findIndex((text) => text.trim() !== current);
    if (index < 0)
        throw new Error(`没有可切换的 API Type（当前 ${current}，选项 ${texts.join(" | ")}）`);
    await options.nth(index).click({ timeout: ACTION_TIMEOUT_MS });
    return texts[index].trim();
}

/**
 * 走产品 UI 建一条 INSTANCE 连接，并把它设成 **embedding** 类型。
 *
 * <p>为什么不是 chat：mock catalog（`api-server.ts:1104-1200`，CP 5 型的子集）里**只有
 * `dashscope-qwen` 支持两种类型**（openai-chat-completions + dashscope-multimodal-embedding），**没有**
 * 任何 provider 同时支持两种 **chat** 类型 ⇒ 「chat 切 chat」在当前夹具里不可达。而保存门只在
 * `formOperation === "chat"` 时要模板 ⇒ **embedding → chat** 这一方向能真实走到那半条门，
 * 且不需要给 catalog 发明任何能力（不夸大 provider 支持面）。</p>
 */
async function createEmbeddingConnection(page: Page, key: string, label: string) {
    await page.getByTestId("provider-hub-connect").click({ timeout: ACTION_TIMEOUT_MS });
    await expect(page.getByTestId("provider-picker-modal")).toBeVisible({
        timeout: EXPECT_TIMEOUT_MS,
    });
    await page.getByTestId("provider-picker-dashscope-qwen").click({
        timeout: ACTION_TIMEOUT_MS,
    });
    const modal = page.getByTestId("provider-connection-modal");
    await expect(modal).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
    await modal.getByTestId("provider-connection-form-label").fill(label);
    await modal.getByTestId("provider-connection-form-key").fill(key);
    await modal.locator('input[type="password"]').fill("mock-key-for-e2e");
    // 新建时切成 embedding：此时还没有 existing 连接 ⇒ changedType=false ⇒ 保存门不要求模板。
    await switchToAnotherApiType(page);
    await modal.getByTestId("provider-connection-field-discovery").click({
        timeout: ACTION_TIMEOUT_MS,
    });
    await page
        .getByTestId("provider-connection-discovery-option-manual")
        .click({ timeout: ACTION_TIMEOUT_MS });
    const models = modal.locator("textarea");
    if (await models.count()) await models.fill("task459-model-a\ntask459-model-b");
    await modal.locator('button[type="submit"]').click({ timeout: ACTION_TIMEOUT_MS });
    await expect(page.locator(`${ROWS}[data-connection-key="${key}"]`)).toBeVisible({
        timeout: EXPECT_TIMEOUT_MS,
    });
}

function rowOf(page: Page, key: string) {
    return page.locator(`${ROWS}[data-connection-key="${key}"]`);
}

async function openManage(page: Page, key: string) {
    await rowOf(page, key)
        .getByRole("button", { name: MANAGE })
        .click({ timeout: ACTION_TIMEOUT_MS });
    const modal = page.getByTestId("provider-connection-modal");
    await expect(modal).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
    return modal;
}

/** 记录真正发出去的 PATCH 体（观测，不改变行为；不做通配桩）。 */
function patchSpy(page: Page, connectionKey: string) {
    const seen: Array<Record<string, unknown>> = [];
    page.on("request", (request: Request) => {
        if (request.method() !== "PATCH") return;
        if (!request.url().includes("/api/v1/provider-connections/")) return;
        if (request.url().endsWith("/provider-connections")) return;
        seen.push(request.postDataJSON() as Record<string, unknown>);
    });
    void connectionKey;
    return seen;
}

test.describe("preview mock 编辑连接切 API Type 整条流（task-459 / D-1306）", () => {
    test("切类型→impact 可见+无 error toast→模板选项非空→选模板+确认⇒PATCH 真带三要素", async ({
        page,
    }) => {
        await openHub(page);
        await createEmbeddingConnection(page, "e2e-type-change-a", "E2E 切类型连接 A");
        const patches = patchSpy(page, "e2e-type-change-a");
        const modal = await openManage(page, "e2e-type-change-a");

        const switched = await switchToAnotherApiType(page);

        // ① impact 面：区块出现（缺端点时它不渲染，且会先弹 error toast）。
        const impact = modal.getByTestId("connection-type-impact");
        await expect(impact).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        // ② 模板选项非空：**这条是 half-fix 的判别器** —— 只补 impact 时它是空的。
        const templateSelect = impact.getByRole("combobox", { name: TEMPLATE_LABEL });
        await templateSelect.click({ timeout: ACTION_TIMEOUT_MS });
        const optionTexts = await page.getByRole("option").allTextContents();
        expect(optionTexts.length).toBeGreaterThan(0);
        // 夹具里已发布的两条至少一条能进选项；草稿那条**不许**出现（published 过滤承重）。
        const publishedNames = PUBLISHED.map((item) => item.name);
        expect(optionTexts.some((text) => publishedNames.some((name) => text.includes(name)))).toBe(
            true,
        );
        for (const item of DRAFT) {
            expect(optionTexts.join(" | ")).not.toContain(item.name);
        }
        const chosen = optionTexts.find((text) =>
            publishedNames.some((name) => text.includes(name)),
        );
        if (!chosen) throw new Error("选项里没有已发布模板：" + optionTexts.join(" | "));
        await page.getByRole("option", { name: chosen, exact: true }).click({
            timeout: ACTION_TIMEOUT_MS,
        });

        await impact.getByRole("checkbox").check({ timeout: ACTION_TIMEOUT_MS });
        await modal.getByTestId("provider-connection-submit").click({ timeout: ACTION_TIMEOUT_MS });

        // ③ PATCH 真的发了，且三要素齐（确认位 + 模板引用 + CAS 用的 revision）。
        await expect(modal).toBeHidden({ timeout: EXPECT_TIMEOUT_MS });
        expect(patches.length).toBe(1);
        const body = patches[0];
        expect(body.confirmedTypeChange).toBe(true);
        expect(typeof body.expectedRevision).toBe("number");
        const ref = body.connectionDefaultTemplateRef as Record<string, unknown>;
        expect(ref).toBeTruthy();
        expect(ref.layer).toBe("instance");
        expect(ref.version).toBe(1);
        expect(PUBLISHED.map((item) => item.id)).toContain(ref.templateId);
        // 类型真的换了（不是把原值再发一遍）。
        // 从 embedding 切到 chat ⇒ 目标类型确定，可断言具体值（不是「有个值就行」）。
        expect(body.apiTypeId).toBe("openai-chat-completions");
        expect(body.apiTypeVersion).toBe(1);
        void switched;
    });

    test("负例：chat 连接不选模板就保存 ⇒ 不发 PATCH + 出「需先预览/选择」提示", async ({
        page,
    }) => {
        await openHub(page);
        await createEmbeddingConnection(page, "e2e-type-change-b", "E2E 切类型连接 B");
        const patches = patchSpy(page, "e2e-type-change-b");
        const modal = await openManage(page, "e2e-type-change-b");
        await switchToAnotherApiType(page);
        const impact = modal.getByTestId("connection-type-impact");
        await expect(impact).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        await impact.getByRole("checkbox").check({ timeout: ACTION_TIMEOUT_MS });
        await modal.getByTestId("provider-connection-submit").click({ timeout: ACTION_TIMEOUT_MS });
        await expect(page.getByText(TOAST_REQUIRED)).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        expect(patches.length).toBe(0);
    });

    test("负例：不勾确认就保存 ⇒ 不发 PATCH", async ({ page }) => {
        await openHub(page);
        await createEmbeddingConnection(page, "e2e-type-change-c", "E2E 切类型连接 C");
        const patches = patchSpy(page, "e2e-type-change-c");
        const modal = await openManage(page, "e2e-type-change-c");
        await switchToAnotherApiType(page);
        const impact = modal.getByTestId("connection-type-impact");
        await expect(impact).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        await modal.getByTestId("provider-connection-submit").click({ timeout: ACTION_TIMEOUT_MS });
        await expect(page.getByText(TOAST_REQUIRED)).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        expect(patches.length).toBe(0);
        // 顺带钉住确认框的文案来自 i18n（不是硬编码中文）。
        await expect(impact.getByText(CONFIRM)).toBeVisible();
    });
});
