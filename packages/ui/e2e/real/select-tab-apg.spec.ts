// timeout-exempt: single-page keyboard assertions; no long-running journey
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { generateE2EPassword } from "./helpers/password";
import { ensureWorkspace } from "./helpers/workspace";
import { ACTION_TIMEOUT_MS, LONG_TIMEOUT_MS, TEST_TIMEOUT_MS } from "../timeouts";

/**
 * task-227 J3：Select 弹层里的 Tab 行为（正例）。
 *
 * 被测对象 = 本仓 `patches/reka-ui@2.11.0.patch` 对 `dist/Select/SelectContentImpl` 的改写：
 * 上游 2.11.0 在 `handleKeyDown` 里把 Tab 无条件 `preventDefault()`（焦点被吞、层不关），
 * patch 把它换成「关层 + 焦点移到触发器之后的下一个 tabbable，不提交高亮项」（上游 v3 / PR #3168 口径）。
 *
 * 载体：/settings/audit 的 `settings-audit-type`（reka Select 触发器）→ 之后的下一个 tabbable
 * 是状态筛选 combobox 触发器 `settings-audit-status`。
 *
 * 反例不写在这里：把 dist 换回 pristine 再跑本 spec，断言会红在「listbox 仍可见 / 焦点仍停在 option」。
 */
const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`;

type Auth = { accessToken: string; workspaceId: string };

async function register(request: APIRequestContext): Promise<Auth> {
    const password = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword();
    const response = await request.post(`${CP_URL}/api/v1/auth/register`, {
        data: {
            email: `select-tab-227-${Date.now()}@test.local`,
            password,
            name: "Select Tab 227",
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

async function openTypeSelect(page: Page) {
    const trigger = page.getByTestId("settings-audit-type");
    await expect(trigger).toBeVisible({ timeout: LONG_TIMEOUT_MS });
    await trigger.focus();
    await page.keyboard.press("Enter");
    const listbox = page.getByRole("listbox");
    await expect(listbox).toBeVisible({ timeout: ACTION_TIMEOUT_MS });
    return { trigger, listbox };
}

async function activeTestId(page: Page): Promise<string | null> {
    return page.evaluate(
        () => (document.activeElement as HTMLElement | null)?.dataset.testid ?? null,
    );
}

test.describe.configure({ retries: 0 });

test("@host task-227 Select: Tab closes the layer and moves focus past the trigger", async ({
    page,
    request,
}) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    const auth = await register(request);
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await installAuth(page, auth);

    await page.goto("/settings/audit", { waitUntil: "load" });
    const { trigger, listbox } = await openTypeSelect(page);
    const triggerTextBefore = (await trigger.innerText()).trim();

    await page.keyboard.press("Tab");

    await expect(listbox).toBeHidden({ timeout: ACTION_TIMEOUT_MS });
    expect(await activeTestId(page)).toBe("settings-audit-status");
    // (i) 语义：Tab 不提交高亮项 ⇒ 触发器文本不变
    expect((await trigger.innerText()).trim()).toBe(triggerTextBefore);
    expect(pageErrors).toEqual([]);
});

test("@host task-227 Select: Shift+Tab closes the layer and returns focus to the trigger", async ({
    page,
    request,
}) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    const auth = await register(request);
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await installAuth(page, auth);

    await page.goto("/settings/audit", { waitUntil: "load" });
    const { listbox } = await openTypeSelect(page);

    await page.keyboard.press("Shift+Tab");

    await expect(listbox).toBeHidden({ timeout: ACTION_TIMEOUT_MS });
    expect(await activeTestId(page)).toBe("settings-audit-type");
    expect(pageErrors).toEqual([]);
});
