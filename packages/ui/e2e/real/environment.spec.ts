import { expect, test } from "@playwright/test";

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`;

test.describe("Workspace environment status", () => {
    test("@host navigates from workspace and shows assignment, storage and Runtime observation", async ({
        page,
        request,
    }, testInfo) => {
        const pageErrors: Error[] = [];
        page.on("pageerror", (error) => pageErrors.push(error));

        const suffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
        const registration = await request.post(`${CP_URL}/api/v1/auth/register`, {
            data: {
                email: `environment-${suffix}@test.local`,
                password: `A${suffix}environment!`,
                name: "Environment E2E",
            },
        });
        expect(registration.status()).toBe(201);
        const auth = await registration.json();
        expect(auth.workspaceId).toBeTruthy();

        await page.addInitScript(
            ({ token, workspaceId }) => {
                localStorage.setItem("xihe-token", token);
                localStorage.setItem("xihe-user", JSON.stringify({ workspaceId }));
            },
            { token: auth.accessToken, workspaceId: auth.workspaceId },
        );

        await page.setViewportSize({ width: 1920, height: 1080 });

        const environmentResponse = page.waitForResponse(
            (response) =>
                response
                    .url()
                    .includes(
                        `/api/v1/workspaces/${encodeURIComponent(auth.workspaceId)}/environment`,
                    ) && response.request().method() === "GET",
        );

        await page.goto("/workspace", { waitUntil: "load" });
        await expect(page.getByTestId("workspace-toolbar-environment")).toBeVisible({
            timeout: 15000,
        });
        await page.getByTestId("workspace-toolbar-environment").click();
        await page.waitForURL(
            (url) => url.pathname === `/workspace/${auth.workspaceId}/environment`,
            { timeout: 15000 },
        );
        expect((await environmentResponse).status()).toBe(200);

        await expect(page.getByTestId("workspace-environment-heading")).toBeVisible();
        await expect(page.getByTestId("workspace-environment-status")).toContainText(
            /materializing|ready/,
        );
        await expect(page.getByText(auth.workspaceId, { exact: true }).first()).toBeVisible();
        await expect(page.getByText("host_directory", { exact: true })).toBeVisible();
        await expect(page.locator("body")).not.toContainText("storagePath");

        // The workspace page already triggered auto-preparation; this page only
        // refetches on the visible Refresh action, so poll through real clicks.
        await expect
            .poll(
                async () => {
                    const response = page.waitForResponse(
                        (r) =>
                            r
                                .url()
                                .includes(
                                    `/api/v1/workspaces/${encodeURIComponent(auth.workspaceId)}/environment`,
                                ) && r.request().method() === "GET",
                    );
                    await page.getByTitle("Refresh").click();
                    await response;
                    return (
                        (
                            await page.getByTestId("workspace-environment-status").textContent()
                        )?.trim() ?? ""
                    );
                },
                { timeout: 60000, intervals: [1000] },
            )
            .toMatch(/ready|blocked/);
        await expect(page.getByTestId("workspace-environment-status")).toContainText("ready");
        await page.screenshot({ path: testInfo.outputPath("environment-desktop.png") });

        await page.reload({ waitUntil: "load" });
        await expect(page.getByTestId("workspace-environment-heading")).toBeVisible({
            timeout: 15000,
        });
        await expect(page.getByTestId("workspace-environment-status")).toContainText("ready", {
            timeout: 30000,
        });

        await page.setViewportSize({ width: 390, height: 844 });
        await expect(page.getByTestId("mobile-sidebar-toggle")).toBeVisible();
        const mobileSidebar = page.getByTestId("sidebar");
        await expect(mobileSidebar).toHaveAttribute("aria-hidden", "true");
        await expect
            .poll(
                async () => (await mobileSidebar.boundingBox())?.width ?? Number.POSITIVE_INFINITY,
            )
            .toBeLessThanOrEqual(1);
        await expect(page.getByTestId("workspace-environment-heading")).toBeVisible();
        const overflow = await page.evaluate(() => {
            const documentElement = document.scrollingElement;
            return documentElement ? documentElement.scrollWidth - documentElement.clientWidth : 0;
        });
        expect(overflow).toBeLessThanOrEqual(2);
        await page.screenshot({ path: testInfo.outputPath("environment-mobile.png") });
        const runtimeHeading = page.getByRole("heading", { name: "运行时", exact: true });
        await runtimeHeading.scrollIntoViewIfNeeded();
        await expect(runtimeHeading).toBeInViewport();
        await page.screenshot({ path: testInfo.outputPath("environment-mobile-runtime.png") });

        expect(pageErrors.map((error) => error.message)).toEqual([]);
    });
});
