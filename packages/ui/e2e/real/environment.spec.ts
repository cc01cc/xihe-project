// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
import { expect, test } from "@playwright/test";
import { ensureWorkspace } from "./helpers/workspace";
import { LONG_TIMEOUT_MS } from "../timeouts";

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
        auth.workspaceId = await ensureWorkspace(request, auth.accessToken);
        expect(auth.workspaceId).toBeTruthy();

        await page.addInitScript(
            ({ token, workspaceId }) => {
                localStorage.setItem("xihe-token", token);
                localStorage.setItem("xihe-user", JSON.stringify({ workspaceId }));
                // PLAN-0608 C′：/workspace 在**无 tab 工作区上下文**时渲染显式选择面，
                // 只有上下文已存在守卫才跳 /workspace/{id}。并存键由守卫的
                // migrateLegacyWorkspace() 搬进 sessionStorage；audit/approval 等
                // 58 处 real spec 同样种这个键，本 spec 之前漏了 → 停在选择面、
                // GET .../environment 从未发出、30 s 超时（task-140/142）。
                localStorage.setItem(
                    "xihe-workspace",
                    JSON.stringify({ id: workspaceId, name: "Default Workspace" }),
                );
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
            timeout: LONG_TIMEOUT_MS,
        });
        await page.getByTestId("workspace-toolbar-environment").click();
        await page.waitForURL(
            (url) => url.pathname === `/workspace/${auth.workspaceId}/environment`,
            { timeout: LONG_TIMEOUT_MS },
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
                    await page.getByTestId("workspace-environment-refresh").click();
                    await response;
                    return (
                        (
                            await page.getByTestId("workspace-environment-status").textContent()
                        )?.trim() ?? ""
                    );
                },
                { timeout: LONG_TIMEOUT_MS, intervals: [1000] },
            )
            .toMatch(/ready|blocked/);
        await expect(page.getByTestId("workspace-environment-status")).toContainText("ready");
        await page.screenshot({
            scale: "css",
            path: testInfo.outputPath("environment-desktop.png"),
        });

        await page.reload({ waitUntil: "load" });
        await expect(page.getByTestId("workspace-environment-heading")).toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });
        await expect(page.getByTestId("workspace-environment-status")).toContainText("ready", {
            timeout: LONG_TIMEOUT_MS,
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
        await page.screenshot({
            scale: "css",
            path: testInfo.outputPath("environment-mobile.png"),
        });
        const runtimeHeading = page.getByRole("heading", { name: "运行时", exact: true });
        await runtimeHeading.scrollIntoViewIfNeeded();
        await expect(runtimeHeading).toBeInViewport();
        await page.screenshot({
            scale: "css",
            path: testInfo.outputPath("environment-mobile-runtime.png"),
        });

        expect(pageErrors.map((error) => error.message)).toEqual([]);
    });
});
