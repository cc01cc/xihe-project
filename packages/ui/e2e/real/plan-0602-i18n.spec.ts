import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { generateE2EPassword } from "./helpers/password";
import { expectPlatformScreenshot } from "../helpers/visual";

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
    ZH_HEADING = "配置管理",
    EN_HEADING = "Config",
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
        workspaceId: body.workspaceId,
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
        await page.goto("/settings/config", { waitUntil: "load" });
        await expect(page.getByTestId("settings-language-switcher")).toBeVisible({
            timeout: 20_000,
        });

        // Item 1: no persisted value → zh-CN on <html lang>, Chinese copy, nothing in storage.
        expect(await htmlLang(page)).toBe("zh-CN");
        await expect(page.getByTestId("settings-config-heading")).toHaveText(ZH_HEADING);
        expect([null, "zh-CN"]).toContain(await persistedLanguage(page));
        await page.screenshot({
            path: "test-results/plan-0602/01-fresh-boot-zh.png",
            fullPage: true,
        });
        expectPlatformScreenshot(page, "plan-0602-fresh-boot-zh.png");

        // Item 5: English → back to Chinese restores all three sinks.
        await page.getByTestId("settings-language-en-US").click();
        await expect(page.getByTestId("settings-config-heading")).toHaveText(EN_HEADING, {
            timeout: 10_000,
        });
        await page.getByTestId("settings-language-zh-CN").click();
        await expect(page.getByTestId("settings-config-heading")).toHaveText(ZH_HEADING, {
            timeout: 10_000,
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
        await page.goto("/settings/config", { waitUntil: "load" });
        await expect(page.getByTestId("settings-language-switcher")).toBeVisible({
            timeout: 20_000,
        });

        await page.getByTestId("settings-language-en-US").click();

        await expect(page.getByTestId("settings-config-heading")).toHaveText(EN_HEADING, {
            timeout: 10_000,
        });
        await expect(page.getByTestId("settings-language-en-US")).toHaveAttribute(
            "aria-pressed",
            "true",
        );
        expect(await htmlLang(page)).toBe("en-US");
        const stored = await persistedLanguage(page);
        expect(stored, "persisted value must be the raw locale, not JSON-quoted").toBe("en-US");
        expect(stored).not.toBe('"en-US"');
        // The settings nav label comes from the same locale map, proving vue-i18n switched globally.
        await expect(page.getByTestId("settings-nav-settings-config")).toHaveText("Config");
        await page.screenshot({
            path: "test-results/plan-0602/03-switched-en.png",
            fullPage: true,
        });
        expectPlatformScreenshot(page, "plan-0602-switched-en.png");
    });

    test("reload boots straight into English without a zh-CN flash", async ({ page }) => {
        await seedContext(page, user);
        await page.goto("/settings/config", { waitUntil: "load" });
        await page.getByTestId("settings-language-en-US").click();
        await expect(page.getByTestId("settings-config-heading")).toHaveText(EN_HEADING, {
            timeout: 10_000,
        });

        // Record every <html lang> value the document takes during the reload: the inline boot script
        // must set en-US before the app mounts, so zh-CN must never appear.
        await page.addInitScript(() => {
            const seen: string[] = [],
                record = () => seen.push(document.documentElement.lang);
            (window as unknown as { __langTrace: string[] }).__langTrace = seen;
            record();
            new MutationObserver(record).observe(document.documentElement, {
                attributes: true,
                attributeFilter: ["lang"],
            });
        });
        await page.reload({ waitUntil: "load" });
        await expect(page.getByTestId("settings-config-heading")).toHaveText(EN_HEADING, {
            timeout: 20_000,
        });
        const trace = await page.evaluate(
            () => (window as unknown as { __langTrace: string[] }).__langTrace,
        );
        expect(trace.length, "the lang trace must be recorded").toBeGreaterThan(0);
        expect(trace, `lang flapped through zh-CN: ${trace.join(" -> ")}`).not.toContain("zh-CN");
        expect(trace[trace.length - 1]).toBe("en-US");
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
        await page.goto("/settings/config", { waitUntil: "load" });
        await page.getByTestId("settings-language-en-US").click();
        await expect(page.getByTestId("settings-config-heading")).toHaveText(EN_HEADING, {
            timeout: 10_000,
        });

        const secondTab = await context.newPage();
        await secondTab.goto(
            `${await page.evaluate(() => window.location.origin)}/settings/config`,
            {
                waitUntil: "load",
            },
        );
        await expect(secondTab.getByTestId("settings-config-heading")).toHaveText(EN_HEADING, {
            timeout: 20_000,
        });
        expect(await htmlLang(secondTab)).toBe("en-US");
        await secondTab.close();
    });

    test("a hand-written fr-FR value falls back to zh-CN and is cleaned in storage", async ({
        page,
    }) => {
        await seedContext(page, user);
        await page.goto("/settings/config", { waitUntil: "load" });
        // Someone hand-edits the persisted key (or an older build wrote an unsupported locale).
        await page.evaluate((key) => localStorage.setItem(key, "fr-FR"), LANGUAGE_KEY);
        await page.reload({ waitUntil: "load" });

        await expect(page.getByTestId("settings-config-heading")).toHaveText(ZH_HEADING, {
            timeout: 20_000,
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
        await page.goto("/settings/config", { waitUntil: "load" });

        const switcher = page.getByTestId("settings-language-switcher"),
            overflow = await page.evaluate(() => {
                const doc = document.documentElement;
                return doc.scrollWidth > doc.clientWidth + 1;
            });
        await expect(switcher).toBeVisible({ timeout: 20_000 });
        expect(overflow, "no horizontal overflow at 390px").toBe(false);

        await page.getByTestId("settings-language-en-US").click();
        await expect(page.getByTestId("settings-config-heading")).toHaveText(EN_HEADING, {
            timeout: 10_000,
        });
        expect(await htmlLang(page)).toBe("en-US");
        await page.screenshot({
            path: "test-results/plan-0602/06-mobile-en.png",
            fullPage: true,
        });
        expectPlatformScreenshot(page, "plan-0602-mobile-en.png");
    });
});
