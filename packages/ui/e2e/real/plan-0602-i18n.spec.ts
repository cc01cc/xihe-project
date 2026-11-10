// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { generateE2EPassword } from "./helpers/password";
import { expectPlatformScreenshot } from "../helpers/visual";
import { ensureWorkspace } from "./helpers/workspace";
import { ACTION_TIMEOUT_MS, LONG_TIMEOUT_MS } from "../timeouts";

/**
 * PLAN-0602 runtime language switch — the 7-item checklist from
 * `plans/PLAN-0602-XH-i18n-runtime-switch/evidence/m1-language-switch.md` §4, made executable.
 *
 * External-stack mode (no port or account is hardcoded here):
 *   XIHE_E2E_EXTERNAL_SERVER=1        reuse the running UI (playwright.config webServer gate)
 *   XIHE_UI_PORT                      UI port — the ONLY source of the Playwright baseURL
 *   XIHE_CP_BASE_URL | XIHE_CP_PORT   CP origin, used only to register the throw-away fixture user
 *   XIHE_E2E_PASSWORD                 optional shared password for that fixture user
 *
 * The suite needs no ADMIN credentials: it registers a fresh USER through the public API and seeds the
 * UI auth context, so a shared stack can run it without handing out an admin ticket. When the CP
 * contract is absent every test skips with an actionable message.
 *
 * Item → test mapping:
 *   1 fresh boot stays zh-CN · 5 switch back to zh      → freshBootIsChineseAndSwitchingBackRestoresIt
 *   2 switch to English syncs three sinks               → switchingToEnglishSyncsI18nHtmlLangAndStorage
 *   3 reload keeps English (no zh flash)                → reloadBootsStraightIntoEnglish
 *   4 reopening in another tab keeps English            → secondTabInheritsPersistedEnglish
 *   6 hand-written fr-FR falls back and is cleaned       → invalidPersistedLocaleFallsBackAndIsCleaned
 *   7 390px viewport keeps the switcher usable           → switcherStaysUsableAtMobileWidth
 */

const CP_ORIGIN = resolveCpOrigin(),
    PASSWORD = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword(),
    // PLAN-0752：设置面按「层×域」拆页，i18n 文案锚点从旧页标题换成用户层 llm-provider 域标题。
    ZH_HEADING = "LLM 提供商",
    EN_HEADING = "LLM Provider",
    DOMAIN_PAGE = "/settings/user/llm-provider",
    LANGUAGE_KEY = "xihe-language";

function resolveCpOrigin(): string {
    const explicit = process.env.XIHE_CP_BASE_URL,
        port = process.env.XIHE_CP_PORT;
    if (explicit) return explicit.replace(/\/$/, "");
    return port ? `http://localhost:${port}` : "";
}

function missingContract(): string {
    if (!process.env.XIHE_UI_PORT) return "Set XIHE_UI_PORT to the shared stack UI port";
    if (!CP_ORIGIN) return "Set XIHE_CP_BASE_URL (or XIHE_CP_PORT) to the shared stack CP origin";
    return "";
}

interface FixtureUser {
    token: string;
    workspaceId: string;
    identity: { id: string; email: string; name: string; role: string };
}

async function registerFixtureUser(request: APIRequestContext): Promise<FixtureUser> {
    const email = `plan0602-${Date.now()}-${Math.floor(Math.random() * 10_000)}@test.local`,
        response = await request.post(`${CP_ORIGIN}/api/v1/auth/register`, {
            data: { email, password: PASSWORD, name: "i18n fixture" },
        }),
        body = (await response.json()) as {
            accessToken: string;
            workspaceId: string;
            user: { id: string; email?: string; name?: string; role?: string };
        };
    expect(response.status(), `register -> ${JSON.stringify(body)}`).toBe(201);
    return {
        token: body.accessToken,
        workspaceId: await ensureWorkspace(request, body.accessToken),
        identity: {
            id: body.user.id,
            email: body.user.email ?? email,
            name: body.user.name ?? "i18n fixture",
            role: body.user.role ?? "USER",
        },
    };
}

/** Seeds the UI auth/workspace context (same storage shape as the app writes on login). */
async function seedContext(page: Page, user: FixtureUser): Promise<void> {
    await page.addInitScript(
        ({ token, ws, identity }) => {
            localStorage.setItem("xihe-token", token);
            localStorage.setItem("xihe-user", JSON.stringify(identity));
            localStorage.setItem(
                "xihe-workspace",
                JSON.stringify({ id: ws, name: "Default Workspace" }),
            );
            sessionStorage.setItem(
                "xihe-workspace",
                JSON.stringify({
                    id: ws,
                    name: "Default Workspace",
                    workspaceRole: "OWNER",
                    ownerId: "x",
                }),
            );
        },
        { token: user.token, ws: user.workspaceId, identity: user.identity },
    );
}

/** PLAN-0752：语言切换器只挂在 AppLayout 左栏（设置页已无切换器），切换动作在工作区页完成。 */
function appPage(user: FixtureUser): string {
    return `/workspace/${user.workspaceId}`;
}

/** The persisted value is a RAW string (VueUse string serializer), never JSON-quoted. */
async function persistedLanguage(page: Page): Promise<string | null> {
    return page.evaluate((key) => localStorage.getItem(key), LANGUAGE_KEY);
}

async function htmlLang(page: Page): Promise<string> {
    return page.evaluate(() => document.documentElement.lang);
}

test.describe("@host PLAN-0602 runtime language switch", () => {
    let user: FixtureUser;

    test.beforeAll(async ({ request }) => {
        if (missingContract()) return;
        user = await registerFixtureUser(request);
    });

    test.beforeEach(() => {
        const missing = missingContract();
        test.skip(Boolean(missing), missing);
    });

    test("fresh boot stays zh-CN and switching back from English restores it", async ({ page }) => {
        await seedContext(page, user);
        await page.goto(appPage(user), { waitUntil: "load" });
        await expect(page.getByTestId("app-language-switcher")).toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });

        // Item 1: no persisted value → zh-CN on <html lang>, Chinese copy, nothing in storage.
        expect(await htmlLang(page)).toBe("zh-CN");
        await page.goto(DOMAIN_PAGE, { waitUntil: "load" });
        await expect(page.getByTestId("settings-domain-title")).toHaveText(ZH_HEADING);
        expect([null, "zh-CN"]).toContain(await persistedLanguage(page));
        await page.screenshot({
            path: "test-results/plan-0602/01-fresh-boot-zh.png",
            fullPage: true,
        });
        expectPlatformScreenshot(page, "plan-0602-fresh-boot-zh.png");

        // Item 5: English → back to Chinese restores all three sinks.
        await page.goto(appPage(user), { waitUntil: "load" });
        await page.getByTestId("app-language-en-US").click();
        await page.goto(DOMAIN_PAGE, { waitUntil: "load" });
        await expect(page.getByTestId("settings-domain-title")).toHaveText(EN_HEADING, {
            timeout: ACTION_TIMEOUT_MS,
        });
        await page.goto(appPage(user), { waitUntil: "load" });
        await page.getByTestId("app-language-zh-CN").click();
        await page.goto(DOMAIN_PAGE, { waitUntil: "load" });
        await expect(page.getByTestId("settings-domain-title")).toHaveText(ZH_HEADING, {
            timeout: ACTION_TIMEOUT_MS,
        });
        expect(await htmlLang(page)).toBe("zh-CN");
        expect(await persistedLanguage(page)).toBe("zh-CN");
        await page.screenshot({
            path: "test-results/plan-0602/02-back-to-zh.png",
            fullPage: true,
        });
        expectPlatformScreenshot(page, "plan-0602-back-to-zh.png");
    });

    test("switching to English syncs i18n, <html lang> and the raw localStorage value", async ({
        page,
    }) => {
        await seedContext(page, user);
        await page.goto(appPage(user), { waitUntil: "load" });
        await expect(page.getByTestId("app-language-switcher")).toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });

        await page.getByTestId("app-language-en-US").click();
        await expect(page.getByTestId("app-language-en-US")).toHaveAttribute(
            "aria-pressed",
            "true",
        );
        expect(await htmlLang(page)).toBe("en-US");
        const stored = await persistedLanguage(page);
        expect(stored, "persisted value must be the raw locale, not JSON-quoted").toBe("en-US");
        expect(stored).not.toBe('"en-US"');
        // 域页标题与左栏域链接同源 locale，证明 vue-i18n 已全局切换。
        await page.goto(DOMAIN_PAGE, { waitUntil: "load" });
        await expect(page.getByTestId("settings-domain-title")).toHaveText(EN_HEADING, {
            timeout: ACTION_TIMEOUT_MS,
        });
        await expect(page.locator('a[href="/settings/user/llm-provider"]').first()).toHaveText(
            "LLM Provider",
        );
        await page.screenshot({
            path: "test-results/plan-0602/03-switched-en.png",
            fullPage: true,
        });
        expectPlatformScreenshot(page, "plan-0602-switched-en.png");
    });

    test("reload boots straight into English without a zh-CN flash", async ({ page }) => {
        await seedContext(page, user);
        await page.goto(appPage(user), { waitUntil: "load" });
        await page.getByTestId("app-language-en-US").click();
        // 停在域页再 reload：反闪证明与具体页面无关，这里顺带断言域标题已是英文。
        await page.goto(DOMAIN_PAGE, { waitUntil: "load" });
        await expect(page.getByTestId("settings-domain-title")).toHaveText(EN_HEADING, {
            timeout: ACTION_TIMEOUT_MS,
        });

        // Anti-flash proof: the static attribute is zh-CN, so the parser sets it for an instant; what
        // matters is that the inline boot script switches to en-US BEFORE Vue mounts, i.e. no Chinese
        // UI is ever painted. The trace records, per <html lang> change, how many #app children exist.
        await page.addInitScript(() => {
            const seen: Array<{ lang: string; appChildren: number }> = [],
                record = () => {
                    const root = document.documentElement;
                    if (!root) return;
                    seen.push({
                        lang: root.lang,
                        appChildren: document.getElementById("app")?.childElementCount ?? -1,
                    });
                };
            (
                window as unknown as { __langTrace: Array<{ lang: string; appChildren: number }> }
            ).__langTrace = seen;
            record();
            // Observe `document` (not documentElement): the init script can run before the parser has
            // created <html>, so the static attribute and the boot-script overwrite both have to be
            // caught by a subtree observer.
            new MutationObserver(record).observe(document, {
                subtree: true,
                childList: true,
                attributes: true,
                attributeFilter: ["lang"],
            });
            document.addEventListener("DOMContentLoaded", record, { once: true });
        });
        await page.reload({ waitUntil: "load" });
        await expect(page.getByTestId("settings-domain-title")).toHaveText(EN_HEADING, {
            timeout: LONG_TIMEOUT_MS,
        });
        const trace = await page.evaluate(
                () =>
                    (
                        window as unknown as {
                            __langTrace: Array<{ lang: string; appChildren: number }>;
                        }
                    ).__langTrace,
            ),
            firstEnglish = trace.findIndex((entry) => entry.lang === "en-US");
        expect(trace.length, "the lang trace must be recorded").toBeGreaterThan(0);
        expect(
            firstEnglish,
            `en-US never applied: ${JSON.stringify(trace)}`,
        ).toBeGreaterThanOrEqual(0);
        expect(
            trace[firstEnglish].appChildren,
            "en-US must be applied before Vue mounts (-1 = #app not parsed yet, 0 = empty)",
        ).toBeLessThanOrEqual(0);
        expect(trace[trace.length - 1].lang).toBe("en-US");
        expect(
            trace.filter((entry) => entry.appChildren > 0 && entry.lang !== "en-US"),
            `lang regressed after mount: ${JSON.stringify(trace)}`,
        ).toEqual([]);
        expect(await htmlLang(page)).toBe("en-US");
        expect(await persistedLanguage(page)).toBe("en-US");
        await page.screenshot({
            path: "test-results/plan-0602/04-reload-en.png",
            fullPage: true,
        });
        expectPlatformScreenshot(page, "plan-0602-reload-en.png");
    });

    test("a second tab in the same browser inherits the persisted English", async ({
        page,
        context,
    }) => {
        await seedContext(page, user);
        await page.goto(appPage(user), { waitUntil: "load" });
        await page.getByTestId("app-language-en-US").click();
        expect(await htmlLang(page)).toBe("en-US");

        const secondTab = await context.newPage();
        await secondTab.goto(`${await page.evaluate(() => window.location.origin)}${DOMAIN_PAGE}`, {
            waitUntil: "load",
        });
        await expect(secondTab.getByTestId("settings-domain-title")).toHaveText(EN_HEADING, {
            timeout: LONG_TIMEOUT_MS,
        });
        expect(await htmlLang(secondTab)).toBe("en-US");
        await secondTab.close();
    });

    test("a hand-written fr-FR value falls back to zh-CN and is cleaned in storage", async ({
        page,
    }) => {
        await seedContext(page, user);
        await page.goto(appPage(user), { waitUntil: "load" });
        // Someone hand-edits the persisted key (or an older build wrote an unsupported locale).
        await page.evaluate((key) => localStorage.setItem(key, "fr-FR"), LANGUAGE_KEY);
        await page.reload({ waitUntil: "load" });
        await page.goto(DOMAIN_PAGE, { waitUntil: "load" });

        await expect(page.getByTestId("settings-domain-title")).toHaveText(ZH_HEADING, {
            timeout: LONG_TIMEOUT_MS,
        });
        expect(await htmlLang(page)).toBe("zh-CN");
        expect(await persistedLanguage(page), "invalid value must be rewritten to zh-CN").toBe(
            "zh-CN",
        );
        await page.screenshot({
            path: "test-results/plan-0602/05-fallback-fr.png",
            fullPage: true,
        });
        expectPlatformScreenshot(page, "plan-0602-fallback-fr.png");
    });

    test("the switcher stays usable at 390px", async ({ page }) => {
        await seedContext(page, user);
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(appPage(user), { waitUntil: "load" });
        // 390px 下左栏是抽屉：先打开抽屉，切换器才进入视口。
        await page.getByTestId("mobile-sidebar-toggle").click();

        const switcher = page.getByTestId("app-language-switcher"),
            overflow = await page.evaluate(() => {
                const doc = document.documentElement;
                return doc.scrollWidth > doc.clientWidth + 1;
            });
        await expect(switcher).toBeVisible({ timeout: LONG_TIMEOUT_MS });
        expect(overflow, "no horizontal overflow at 390px").toBe(false);

        await page.getByTestId("app-language-en-US").click();
        expect(await htmlLang(page)).toBe("en-US");
        await page.goto(DOMAIN_PAGE, { waitUntil: "load" });
        await expect(page.getByTestId("settings-domain-title")).toHaveText(EN_HEADING, {
            timeout: ACTION_TIMEOUT_MS,
        });
        await page.screenshot({
            path: "test-results/plan-0602/06-mobile-en.png",
            fullPage: true,
        });
        expectPlatformScreenshot(page, "plan-0602-mobile-en.png");
    });
});
