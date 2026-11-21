// timeout-exempt: single-page keyboard assertions; no long-running journey
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { generateE2EPassword } from "./helpers/password";
import { ensureWorkspace } from "./helpers/workspace";
import { ACTION_TIMEOUT_MS, LONG_TIMEOUT_MS, TEST_TIMEOUT_MS } from "../timeouts";

/**
 * task-28（原 task-222）：锁住 SearchableCombobox 弹层打开态下的 Tab 落点。
 *
 * 背景（task-215；见 src/components/ui/combobox/ComboboxViewport.vue:16-29 注释与
 * internal/A03-xihe/evidence/2026-11-21-combobox-a11y/）：
 * Chrome 130 起「没有可聚焦子项的可滚动容器」默认进入顺序焦点导航，本 viewport 是 overflow-y-auto
 * 且 24 个选项全是 tabindex=-1（无可聚焦子项）⇒ 不加拦截时第一次 Tab 停在 role=presentation 的
 * viewport div 上、面板不关（用户体感 = 多一跳）。ComboboxViewport.vue:32 的显式 tabindex="-1"
 * 就是这一跳的解药（Chrome 规则对带负 tabindex 的元素失效）。
 *
 * 三个用例：
 * 1) 正例：Tab 一次 ⇒ 面板关闭 + activeElement 是触发器 button[data-testid=settings-audit-status]。
 * 2) 第二跳：面板保持关闭、焦点不再停在 viewport 上。
 * 3) 反向自证（**不写盘**，只在运行期摘掉 DOM 属性）：把 viewport 的 tabindex 移除 ⇒ 旧行为必须复现
 *    （面板仍打开 + 焦点停在 viewport）。若有一天 Chrome 不再把此类容器纳入 Tab 序列，本用例会红，
 *    提醒重新评估 tabindex="-1" 是否还需要——这是「前提变了」的警报，不是产品回归。
 * 另：把环境变量 XIHE_E2E_TABINDEX_STRIP=1 传给 playwright 时，用例 1 会在按 Tab 前摘掉该属性，
 * 于是它必须在**行为断言** expect(listbox).toBeHidden() 上红（这就是手工 J2 反向验证，零文件改动）。
 */
const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`;
const STRIP_TABINDEX = process.env.XIHE_E2E_TABINDEX_STRIP === "1";

type Auth = { accessToken: string; workspaceId: string };

async function register(request: APIRequestContext): Promise<Auth> {
    const password = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword();
    const response = await request.post(`${CP_URL}/api/v1/auth/register`, {
        data: {
            email: `combobox-tab-228-${Date.now()}@test.local`,
            password,
            name: "Combobox Tab 228",
        },
    });
    expect(response.status(), await response.text()).toBe(201);
    const body = await response.json();
    return {
        accessToken: body.accessToken,
        workspaceId: await ensureWorkspace(request, body.accessToken),
    };
}

async function installAuth(page: Page, auth: Auth) {
    await page.addInitScript(
        ({ token, workspaceId }) => {
            localStorage.setItem("xihe-token", token);
            localStorage.setItem("xihe-user", JSON.stringify({ workspaceId }));
            localStorage.setItem(
                "xihe-workspace",
                JSON.stringify({ id: workspaceId, name: "Default Workspace" }),
            );
        },
        { token: auth.accessToken, workspaceId: auth.workspaceId },
    );
}

/** 开层；同时断言「本载体确实满足 Chrome 规则的前提」，否则下面的断言会失去意义。 */
async function openStatusCombobox(page: Page) {
    const trigger = page.getByTestId("settings-audit-status");
    await expect(trigger).toBeVisible({ timeout: LONG_TIMEOUT_MS });
    await trigger.click();

    await expect(page.getByTestId("searchable-combobox-input")).toBeVisible({
        timeout: ACTION_TIMEOUT_MS,
    });
    const listbox = page.getByRole("listbox");
    await expect(listbox).toBeVisible({ timeout: ACTION_TIMEOUT_MS });

    const premise = await page.evaluate(() => {
        const viewport = document.querySelector(
            '[data-slot="combobox-viewport"]',
        ) as HTMLElement | null;
        const options = document.querySelectorAll('[role="option"]');
        return {
            overflowY: viewport ? getComputedStyle(viewport).overflowY : null,
            scrollable: viewport ? viewport.scrollHeight > viewport.clientHeight + 1 : false,
            tabindex: viewport?.getAttribute("tabindex") ?? null,
            optionCount: options.length,
            focusableOptionCount: Array.from(options).filter(
                (node) => (node as HTMLElement).tabIndex >= 0,
            ).length,
        };
    });
    expect(premise.overflowY, "viewport 必须是可滚动容器").toBe("auto");
    expect(premise.scrollable, "viewport 必须真的可滚动（scrollHeight > clientHeight）").toBe(true);
    expect(premise.focusableOptionCount, "选项必须全部 tabindex=-1（无可聚焦子项）").toBe(0);
    if (!STRIP_TABINDEX) {
        expect(premise.tabindex, "ComboboxViewport.vue:32 的显式 tabindex=-1 必须在").toBe("-1");
    }
    return { trigger, listbox };
}

/** 运行期摘掉 viewport 的 tabindex（只改 DOM，不写盘）。返回摘掉前后 agent 读到的值。 */
async function stripViewportTabindex(page: Page) {
    return page.evaluate(() => {
        const viewport = document.querySelector('[data-slot="combobox-viewport"]');
        if (!viewport) throw new Error("combobox-viewport 不存在");
        const before = viewport.getAttribute("tabindex");
        viewport.removeAttribute("tabindex");
        return { before, after: viewport.getAttribute("tabindex") };
    });
}

async function activeElement(page: Page) {
    return page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return {
            tag: el?.tagName.toLowerCase() ?? null,
            testid: el?.dataset.testid ?? null,
            slot: el?.getAttribute("data-slot") ?? null,
            role: el?.getAttribute("role") ?? null,
        };
    });
}

async function panelIsOpen(page: Page) {
    return page.evaluate(() => document.querySelector('[role="listbox"]') !== null);
}

test.describe.configure({ retries: 0 });

test("@host task-28 combobox: Tab closes the panel and lands on the trigger (not the viewport)", async ({
    page,
    request,
}) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    const auth = await register(request);
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await installAuth(page, auth);

    await page.goto("/settings/audit", { waitUntil: "load" });
    const { listbox } = await openStatusCombobox(page);
    expect(await activeElement(page)).toMatchObject({ tag: "input", role: "combobox" });

    // 手工 J2 反向验证开关：仅当显式传 XIHE_E2E_TABINDEX_STRIP=1 时走到这里（正常跑不会摘）。
    if (STRIP_TABINDEX) {
        const stripped = await stripViewportTabindex(page);
        expect(stripped.after, "tabindex 已被摘掉（反向验证的前提）").toBeNull();
    }

    await page.keyboard.press("Tab");

    await expect(listbox, "Tab 后弹层必须关闭").toBeHidden({ timeout: ACTION_TIMEOUT_MS });
    expect(await activeElement(page)).toMatchObject({
        tag: "button",
        testid: "settings-audit-status",
    });
    expect(pageErrors).toEqual([]);
});

test("@host task-28 combobox: a second Tab keeps moving (panel stays closed, focus never parks on the viewport)", async ({
    page,
    request,
}) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    const auth = await register(request);
    await installAuth(page, auth);
    await page.goto("/settings/audit", { waitUntil: "load" });
    const { listbox } = await openStatusCombobox(page);

    await page.keyboard.press("Tab");
    await expect(listbox).toBeHidden({ timeout: ACTION_TIMEOUT_MS });
    await page.keyboard.press("Tab");

    await expect(listbox).toBeHidden({ timeout: ACTION_TIMEOUT_MS });
    const active = await activeElement(page);
    expect(active.slot, "焦点不得停在 presentation 的 viewport 上").not.toBe("combobox-viewport");
});

test("@host task-28 combobox: counterfactual — without tabindex the viewport swallows the Tab", async ({
    page,
    request,
}) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    const auth = await register(request);
    await installAuth(page, auth);
    await page.goto("/settings/audit", { waitUntil: "load" });
    await openStatusCombobox(page);

    const stripped = await stripViewportTabindex(page);
    expect(stripped.before, "摘之前必须是 tabindex=-1").toBe("-1");
    expect(stripped.after, "摘之后必须没有 tabindex").toBeNull();

    await page.keyboard.press("Tab");
    await page.waitForTimeout(200);

    // 反向自证（不写盘）：没有 tabindex 时 Chrome 把可滚动容器纳入 Tab 序列 ⇒ 旧行为复现。
    expect(
        await panelIsOpen(page),
        "摘掉 tabindex 后弹层必须**仍打开**（证明 tabindex 是关层的因）",
    ).toBe(true);
    expect(await activeElement(page)).toMatchObject({ tag: "div", slot: "combobox-viewport" });
});
