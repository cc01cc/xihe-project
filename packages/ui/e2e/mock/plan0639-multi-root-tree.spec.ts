import { test, expect } from "@playwright/test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";

/**
 * PLAN-0639 M2 (design §5 candidate ①): the file tree renders one group per declared
 * root of a multi-root workspace. Group header = alias; selecting a root group
 * expands it and reveals its files. Single-root workspaces keep the flat rendering.
 *
 * The trees are seeded through the mock-only localStorage hooks
 * (`xihe-mock-filetree` / `xihe-mock-filetree-roots`) — no live CP+MCP chain, per the
 * mock profile's contract (host E2E covers the real chain).
 */

const ALPHA_FILE = "alpha-root-a.md",
    BETA_FILE = "beta-root-b.md",
    PRIMARY_ROOT_ID = "workspace-1",
    SECONDARY_ROOT_ID = "00000000-0000-4000-8000-0000000000b2",
    SECONDARY_ROOT_ALIAS = "beta";

function seedRootTrees(page: import("@playwright/test").Page) {
    return page.addInitScript(
        ({ alpha, beta, secondaryRootId }) => {
            localStorage.setItem(
                "xihe-mock-filetree",
                JSON.stringify([{ name: alpha, path: alpha, type: "file", size: 5 }]),
            );
            localStorage.setItem(
                "xihe-mock-filetree-roots",
                JSON.stringify({
                    [secondaryRootId]: [{ name: beta, path: beta, type: "file", size: 5 }],
                }),
            );
        },
        { alpha: ALPHA_FILE, beta: BETA_FILE, secondaryRootId: SECONDARY_ROOT_ID },
    );
}

test.describe("PLAN-0639 M2 multi-root file tree groups (mock)", () => {
    test.beforeEach(async ({ page }) => {
        await setupMockSessions(page, {
            sessions: [{ id: "session-1", title: "Session 1" }],
            messages: { "session-1": [] },
        });
    });

    test("single-root workspace renders flat, without group headers", async ({ page }) => {
        await setupMockAuth(page);
        await seedRootTrees(page);
        await page.goto("/workspace/workspace-1");

        await expect(page.getByRole("button", { name: ALPHA_FILE, exact: true })).toBeVisible({
            timeout: 15000,
        });
        // No grouping chrome for the legacy single-root shape…
        await expect(page.getByTestId("workspace-tree-root-header")).toHaveCount(0);
        await expect(page.getByTestId("workspace-tree-grouped")).toHaveCount(0);
        // …and the seeded secondary tree stays unreachable (nothing selects it).
        await expect(page.getByRole("button", { name: BETA_FILE, exact: true })).toHaveCount(0);
    });

    test("multi-root: group headers render; a root's files appear only after selection", async ({
        page,
    }) => {
        await setupMockAuth(page, {
            workspace: {
                hostPath: "H:/mock/alpha",
                roots: [
                    { id: PRIMARY_ROOT_ID, alias: "alpha", position: 0 },
                    { id: SECONDARY_ROOT_ID, alias: SECONDARY_ROOT_ALIAS, position: 1 },
                ],
            },
        });
        await seedRootTrees(page);
        await page.goto("/workspace/workspace-1");

        const headers = page.getByTestId("workspace-tree-root-header");
        await expect(headers).toHaveCount(2);
        await expect(headers.nth(0)).toContainText("alpha");
        await expect(headers.nth(1)).toContainText(SECONDARY_ROOT_ALIAS);

        // The primary root group auto-expands (its tree loads with the panel head),
        // so the primary file is visible without any selection…
        await expect(page.getByRole("button", { name: ALPHA_FILE, exact: true })).toBeVisible({
            timeout: 15000,
        });
        // …while the unselected secondary root keeps its files hidden.
        await expect(headers.nth(1)).toHaveAttribute("aria-expanded", "false");
        await expect(page.getByRole("button", { name: BETA_FILE, exact: true })).toHaveCount(0);

        // Selection expands the group and lazily reveals its files.
        await headers.nth(1).click();
        await expect(headers.nth(1)).toHaveAttribute("aria-expanded", "true");
        await expect(page.getByRole("button", { name: BETA_FILE, exact: true })).toBeVisible({
            timeout: 15000,
        });

        // Collapsing the group hides them again.
        await headers.nth(1).click();
        await expect(headers.nth(1)).toHaveAttribute("aria-expanded", "false");
        await expect(page.getByRole("button", { name: BETA_FILE, exact: true })).toHaveCount(0);
    });

    test("multi-root: alias-less secondary root falls back to the ordinal label", async ({
        page,
    }) => {
        await setupMockAuth(page, {
            workspace: {
                roots: [
                    { id: PRIMARY_ROOT_ID, alias: null, position: 0 },
                    { id: SECONDARY_ROOT_ID, alias: null, position: 1 },
                ],
            },
        });
        await seedRootTrees(page);
        await page.goto("/workspace/workspace-1");

        const headers = page.getByTestId("workspace-tree-root-header");
        await expect(headers).toHaveCount(2);
        // Primary alias-less root falls back to the hostPath last segment — the mock
        // fixture has no hostPath, so both headers fall back to the ordinal label.
        await expect(headers.nth(0)).toContainText("1");
        await expect(headers.nth(1)).toContainText("2");
    });
});
