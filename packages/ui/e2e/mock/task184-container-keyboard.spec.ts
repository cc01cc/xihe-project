/**
 * task-184（`BL-561` 扩展 / `D-1600`）：容器页签行的键盘契约 —— **效果面**读数。
 *
 * 逻辑面（顺序、单行不吞键、移动被 blocked 的理由）在
 * `src/features/workspace/lib/__tests__/containerTabNav.spec.ts` 里用纯函数钉住；这里只证明
 * **真的动了 `document.activeElement`**、**真的没有吞键**、**真的说了话**。
 */
import { expect, test } from "./helpers/mock-test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { EXPECT_TIMEOUT_MS } from "../timeouts";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "task184-keyboard";

interface KeyRecord {
    combo: string;
    prevented: boolean;
}

test.describe("task-184 容器页签行键盘契约（BL-561 扩展）", () => {
    test("F6 在两行之间循环焦点（落点 = 目标行激活页签），且真的 preventDefault", async ({
        page,
    }) => {
        await setupMockAuth(page, {});
        await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: "kb" }] });
        await page.addInitScript(() => {
            const log: { combo: string; prevented: boolean }[] = [];
            Reflect.set(window, "__keys", log);
            const build = (event: KeyboardEvent) =>
                [
                    event.ctrlKey ? "Ctrl" : "",
                    event.altKey ? "Alt" : "",
                    event.shiftKey ? "Shift" : "",
                    event.key,
                ]
                    .filter((part) => part !== "")
                    .join("+");
            // 只在 **bubble** 阶段读数：产品挂在 nav 上的处理器已经跑完，
            // 于是 `defaultPrevented` 反映的是「产品到底吞没吞这个键」。
            window.addEventListener("keydown", (event) => {
                log.push({ combo: build(event), prevented: event.defaultPrevented });
            });
        });
        await page.goto(`/workspace/${WORKSPACE_ID}/chat/${SESSION_ID}`);
        const mainTab = page
            .locator('[data-testid="workspace-container-tabs"][data-container="main"] [role="tab"]')
            .first();
        await mainTab.waitFor({ state: "visible", timeout: EXPECT_TIMEOUT_MS });
        await mainTab.focus();

        const focusOf = () =>
            page.evaluate(() => {
                const el = document.activeElement as HTMLElement | null;
                const row = el?.closest('[data-testid="workspace-container-tabs"]');
                return {
                    testid: el?.getAttribute("data-testid") ?? null,
                    container: row?.getAttribute("data-container") ?? null,
                };
            });

        expect((await focusOf()).container, "起点应在中栏页签行").toBe("main");

        await page.keyboard.press("F6");
        const afterForward = await focusOf();
        // task-65 A 段（`D-1777`/`D-1778`）：容器值域 = {main, right}，文件树**不再是容器行**
        // （它是右栏的 `files` 面板）。所以 F6 的第二站是**右栏行**，落点 = 该行激活页签，
        // 而右栏行页签沿用既有 `dock-tab-*` 契约（66+ 消费点不得改名）。
        expect(afterForward.container, "F6 应把焦点移到右栏行").toBe("right");
        expect(afterForward.testid, "落点 = 目标行的入口页签（= 右栏激活页签 files）").toBe(
            "dock-tab-files",
        );

        await page.keyboard.press("Shift+F6");
        const afterBackward = await focusOf();
        expect(afterBackward.container, "Shift+F6 应回到中栏行").toBe("main");
        expect(afterBackward.testid).toBe("workspace-container-tab-main-session:" + SESSION_ID);

        const keys = (await page.evaluate(() => Reflect.get(window, "__keys"))) as KeyRecord[];
        const f6 = keys.filter((item) => item.combo === "F6" || item.combo === "Shift+F6");
        expect(f6, "两条 F6 事件都应被记录到").toHaveLength(2);
        for (const item of f6) {
            expect(item.prevented, item.combo + " 由产品接管 ⇒ 应 preventDefault").toBe(true);
        }
    });

    test("移动/建组键今天不可执行 ⇒ **不静默**：polite 播报理由，且不改焦点", async ({ page }) => {
        await setupMockAuth(page, {});
        await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: "kb" }] });
        await page.goto(`/workspace/${WORKSPACE_ID}/chat/${SESSION_ID}`);
        const mainTab = page
            .locator('[data-testid="workspace-container-tabs"][data-container="main"] [role="tab"]')
            .first();
        await mainTab.waitFor({ state: "visible", timeout: EXPECT_TIMEOUT_MS });
        await mainTab.focus();

        const status = page.getByTestId("workspace-container-nav-status");
        await expect(status, "初始应为空（没有播报就没有话）").toHaveText("");

        await page.keyboard.press("Control+Alt+ArrowRight");
        await expect(status).toHaveText(/当前布局不支持把面板移到其它容器/);

        const focusContainer = await page.evaluate(() => {
            const el = document.activeElement as HTMLElement | null;
            return (
                el
                    ?.closest('[data-testid="workspace-container-tabs"]')
                    ?.getAttribute("data-container") ?? null
            );
        });
        expect(focusContainer, "移动命令被拒时**不应**改变焦点").toBe("main");
    });

    test("焦点不在页签行里时按 F6：产品不接管（不 preventDefault）", async ({ page }) => {
        await setupMockAuth(page, {});
        await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: "kb" }] });
        await page.goto(`/workspace/${WORKSPACE_ID}/chat/${SESSION_ID}`);
        await page
            .locator('[data-testid="workspace-container-tabs"][data-container="main"] [role="tab"]')
            .first()
            .waitFor({ state: "visible", timeout: EXPECT_TIMEOUT_MS });
        const prevented = await page.evaluate(() => {
            let seen = false;
            const probe = (event: KeyboardEvent) => {
                seen = event.defaultPrevented;
            };
            window.addEventListener("keydown", probe);
            const target = document.activeElement as HTMLElement | null;
            (target ?? document.body).dispatchEvent(
                new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "F6" }),
            );
            window.removeEventListener("keydown", probe);
            return seen;
        });
        expect(prevented, "行外 F6 不属于本契约 ⇒ 不许 preventDefault（浏览器默认必须留着）").toBe(
            false,
        );
    });
});
