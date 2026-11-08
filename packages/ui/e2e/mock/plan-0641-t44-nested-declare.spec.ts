// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
import { expect, test } from "./helpers/mock-test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { LONG_TIMEOUT_MS } from "../timeouts";

/**
 * PLAN-0641 T4.4 (design §6.3 row 4, B6=(a), contract F4): only a real nested repo or a
 * linked worktree is declarable as an independent root. A submodule is the user's own
 * nesting declaration (never offered), a symlink is classification-only (never enters the
 * declare flow) and a bare repo is warn-only in v1 — all three stay listed with a type
 * label but must not render the declare entry (a dead action would only earn a 400 later).
 *
 * Discovery is stubbed through the mock lane's route interception; the live CP → Runtime
 * probe chain is covered by the package tests and host E2E.
 */

const REPOS = [
    { path: "vendor/lib", type: "nested", declared: false },
    { path: "linked-wt", type: "gitdir", declared: false },
    { path: "deep/tools/helper", type: "submodule", declared: false },
    { path: "linked", type: "symlink", declared: false },
    { path: "mirror.git", type: "bare", declared: false },
];

test.describe("PLAN-0641 T4.4 nested-repo declare entry (mock)", () => {
    test("only nested/gitdir get the declare entry; the other three stay label-only", async ({
        page,
    }, testInfo) => {
        await setupMockSessions(page, {
            sessions: [{ id: "session-1", title: "Session 1" }],
            messages: { "session-1": [] },
        });
        await setupMockAuth(page);
        await page.addInitScript(() => {
            // Locale-stable assertions: the default locale is zh-CN.
            localStorage.setItem("xihe-language", "en-US");
            localStorage.setItem(
                "xihe-mock-filetree",
                JSON.stringify([{ name: "readme.md", path: "readme.md", type: "file", size: 5 }]),
            );
        });

        // Registered after `setupMockAuth`, whose `**/api/v1/**` catch-all answers `{}`
        // for unmatched routes; later routes take precedence in Playwright.
        let discoveryCalls = 0;
        await page.route("**/api/v1/workspaces/*/nested-repos", async (route) => {
            discoveryCalls += 1;
            // The post-declaration refetch reports nothing left to offer (CP evicted its
            // 30s cache on the declaration), which hides the section again.
            const items = discoveryCalls === 1 ? REPOS : [{ ...REPOS[0], declared: true }];
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    workspaceId: "workspace-1",
                    cachedAt: new Date().toISOString(),
                    items,
                }),
            });
        });
        let declareBody: { path?: string } | null = null;
        await page.route("**/api/v1/workspaces/workspace-1/roots", async (route) => {
            declareBody = route.request().postDataJSON() as { path?: string } | null;
            await route.fulfill({
                status: 201,
                contentType: "application/json",
                body: JSON.stringify({ id: "root-1", alias: null, position: 1 }),
            });
        });

        await page.goto("/workspace/workspace-1");

        const panel = page.getByTestId("nested-repos-panel");
        await expect(panel).toBeVisible({ timeout: LONG_TIMEOUT_MS });
        await expect(panel).toContainText("Undeclared nested git repositories");

        const rows = page.getByTestId("nested-repo-row");
        await expect(rows).toHaveCount(REPOS.length);

        // The two declarable kinds carry the entry (and it is enabled for an OWNER).
        for (const index of [0, 1]) {
            const entry = rows.nth(index).getByTestId("nested-repo-declare");
            await expect(entry).toBeVisible();
            await expect(entry).toBeEnabled();
            await expect(entry).toHaveText("Declare as root");
        }
        await expect(rows.nth(0).getByTestId("nested-repo-path")).toHaveText("vendor/lib");
        await expect(rows.nth(0).getByTestId("nested-repo-type")).toHaveText("Nested repo");
        await expect(rows.nth(1).getByTestId("nested-repo-type")).toHaveText("Linked worktree");

        // The three non-declarable kinds stay listed with their label but offer no entry.
        const nonDeclarable = [
            { index: 2, label: "Submodule" },
            { index: 3, label: "Symlink" },
            { index: 4, label: "Bare repo" },
        ];
        for (const { index, label } of nonDeclarable) {
            await expect(rows.nth(index).getByTestId("nested-repo-type")).toHaveText(label);
            await expect(rows.nth(index).getByTestId("nested-repo-declare")).toHaveCount(0);
        }

        await panel.screenshot({ path: testInfo.outputPath("t44-nested-declare-panel.png") });

        // Clicking a declarable entry opens the two-step confirm; the POST happens only
        // on confirm (B1) and carries the whole workspace-relative path (B12).
        await rows.nth(0).getByTestId("nested-repo-declare").click();
        await expect(rows.nth(0).getByTestId("nested-repo-confirm")).toBeVisible();
        expect(declareBody).toBeNull();

        await rows.nth(0).getByTestId("nested-repo-declare-confirm").click();
        await expect(page.getByText("Declared as an independent root")).toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });
        expect(declareBody).toEqual({ path: "vendor/lib" });
        // Success refetches discovery and the declared repo drops out of the section.
        await expect(panel).toHaveCount(0, { timeout: LONG_TIMEOUT_MS });
    });
});
