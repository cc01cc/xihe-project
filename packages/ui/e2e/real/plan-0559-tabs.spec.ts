import { test, expect, type APIRequestContext, type Page, type Request } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { generateE2EPassword } from "./helpers/password";

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`;
const PG_CONTAINER = process.env.XIHE_E2E_PG_CONTAINER || "a03-xihe-postgres-1";

async function register(request: APIRequestContext, label: string) {
    const email = `plan0559-${label}-${Date.now()}@test.com`;
    const password = generateE2EPassword();
    const response = await request.post(`${CP_URL}/api/v1/auth/register`, {
        headers: {
            "X-Forwarded-For": `10.${Date.now() % 250}.${Math.floor(Math.random() * 250)}.1`,
        },
        data: { email, password, name: `PLAN0559 ${label}` },
    });
    if (!response.ok()) {
        throw new Error(`register failed: ${response.status()} ${await response.text()}`);
    }
    expect(response.ok()).toBeTruthy();
    return { email, password, body: await response.json() };
}

async function login(page: Page, email: string, password: string) {
    await page.goto("/login");
    await page.fill('input[name="email"]', email);
    await page.fill('input[type="password"]', password);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/workspace/, { timeout: 15000 });
}

function workspaceHeaders(page: Page): string[] {
    const headers: string[] = [];
    page.on("request", (request: Request) => {
        const url = request.url();
        if (!url.includes("/api/v1/")) return;
        const header = request.headers()["x-workspace-id"];
        if (header) headers.push(header);
    });
    return headers;
}

function eventHeaders(page: Page): string[] {
    const headers: string[] = [];
    page.on("request", (request: Request) => {
        if (!request.url().includes("/events")) return;
        const header = request.headers()["x-workspace-id"];
        if (header) headers.push(header);
    });
    return headers;
}

test.describe("PLAN-0559 workspace tabs", () => {
    test("two tabs keep independent workspaces across refresh and share logout", async ({
        page,
        request,
    }) => {
        const owner = await register(request, "owner");
        const other = await register(request, "other");
        const workspaceA = owner.body.workspaceId as string;

        const created = await request.post(`${CP_URL}/api/v1/workspaces`, {
            headers: {
                Authorization: `Bearer ${owner.body.accessToken}`,
                "X-Workspace-Id": workspaceA,
                "Content-Type": "application/json",
            },
            data: { name: "PLAN-0559 B" },
        });
        expect(created.ok()).toBeTruthy();
        const workspaceB = (await created.json()).id as string;
        expect(workspaceB).not.toBe(workspaceA);

        // Non-member cannot enter A through the header.
        const forbidden = await request.get(`${CP_URL}/api/v1/sessions`, {
            headers: {
                Authorization: `Bearer ${other.body.accessToken}`,
                "X-Workspace-Id": workspaceA,
            },
        });
        expect(forbidden.status()).toBe(403);
        expect((await forbidden.json()).code).toBe("WORKSPACE_FORBIDDEN");

        await login(page, owner.email, owner.password);
        const pageB = await page.context().newPage();
        const headersA = workspaceHeaders(page);
        const headersB = workspaceHeaders(pageB);
        const eventsA = eventHeaders(page);
        const eventsB = eventHeaders(pageB);

        await page.goto(`/workspace/${workspaceA}`);
        await page.waitForTimeout(1500);
        await pageB.goto(`/workspace/${workspaceB}`);
        await pageB.waitForTimeout(1500);

        expect(new Set(headersA)).toContain(workspaceA);
        expect(new Set(headersB)).toContain(workspaceB);
        expect(new Set(eventsA)).toEqual(new Set([workspaceA]));
        expect(new Set(eventsB)).toEqual(new Set([workspaceB]));
        expect(await page.evaluate(() => sessionStorage.getItem("xihe-workspace"))).toContain(
            workspaceA,
        );
        expect(await pageB.evaluate(() => sessionStorage.getItem("xihe-workspace"))).toContain(
            workspaceB,
        );
        expect(await page.evaluate(() => localStorage.getItem("xihe-workspace"))).toBeNull();

        // Refreshing tab B must not fall back to the shared/default workspace.
        await pageB.reload();
        await pageB.waitForTimeout(1500);
        expect(pageB.url()).toContain(workspaceB);
        const afterReload = headersB.slice(-5);
        expect(afterReload).toContain(workspaceB);
        expect(afterReload).not.toContain(workspaceA);

        const refreshed = await pageB.evaluate(async (tabWorkspaceId) => {
            const refreshToken = localStorage.getItem("xihe-refresh-token");
            const response = await fetch("/api/v1/auth/refresh", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-Workspace-Id": tabWorkspaceId,
                },
                body: JSON.stringify({ refreshToken }),
            });
            const body = await response.json();
            const payload = JSON.parse(
                atob(body.accessToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
            );
            localStorage.setItem("xihe-token", body.accessToken);
            const sessions = await fetch("/api/v1/sessions", {
                headers: {
                    Authorization: `Bearer ${body.accessToken}`,
                    "X-Workspace-Id": tabWorkspaceId,
                },
            });
            return {
                workspaceId: body.workspaceId as string,
                claim: (payload.workspace_id as string | undefined) ?? null,
                sessionsStatus: sessions.status,
            };
        }, workspaceB);
        expect(refreshed.workspaceId).toBe(workspaceB);
        expect(refreshed.claim).toBeNull();
        expect(refreshed.sessionsStatus).toBe(200);
        expect(await pageB.evaluate(() => sessionStorage.getItem("xihe-workspace"))).toContain(
            workspaceB,
        );

        await page.screenshot({ path: "test-results/plan-0559-tab-a.png", fullPage: true });
        await pageB.screenshot({ path: "test-results/plan-0559-tab-b.png", fullPage: true });

        // Logout in one tab terminates the other tab through BroadcastChannel.
        await page.getByRole("button", { name: /退出登录|Log out/ }).click();
        await expect(pageB).toHaveURL(/\/login/, { timeout: 5000 });
        await pageB.close();
    });

    test("VIEWER is read-only and EDITOR can write in the real browser", async ({
        browser,
        request,
    }) => {
        const owner = await register(request, "owner-role");
        const viewer = await register(request, "viewer");
        const editor = await register(request, "editor");
        const workspaceId = owner.body.workspaceId as string;

        const grant = (userId: string, role: "VIEWER" | "EDITOR") => {
            execFileSync(
                "docker",
                [
                    "exec",
                    PG_CONTAINER,
                    "psql",
                    "-U",
                    "xihe",
                    "-d",
                    "xihe_1",
                    "-c",
                    `INSERT INTO workspace_users (workspace_id, user_id, role, created_at)
                     VALUES ('${workspaceId}', '${userId}', '${role}', now())
                     ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = '${role}'`,
                ],
                { stdio: "pipe" },
            );
        };
        grant(viewer.body.user.id, "VIEWER");
        grant(editor.body.user.id, "EDITOR");

        const viewerPage = await browser.newPage();
        await login(viewerPage, viewer.email, viewer.password);
        await viewerPage.goto(`/workspace/${workspaceId}`);
        await viewerPage.waitForTimeout(1200);
        await expect(viewerPage.getByTestId("workspace-viewer-badge")).toBeVisible();

        const viewerWrite = await viewerPage.evaluate(async (wsId) => {
            const token = localStorage.getItem("xihe-token");
            const response = await fetch("/api/v1/workspaces/" + wsId + "/imports", {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${token}`,
                    "X-Workspace-Id": wsId,
                    "Content-Type": "application/json",
                },
                body: "{}",
            });
            return { status: response.status, body: await response.json() };
        }, workspaceId);
        expect(viewerWrite.status).toBe(403);
        expect(viewerWrite.body.code).toBe("WORKSPACE_READ_ONLY");

        const editorPage = await browser.newPage();
        await login(editorPage, editor.email, editor.password);
        await editorPage.goto(`/workspace/${workspaceId}`);
        await editorPage.waitForTimeout(800);
        const editorWrite = await editorPage.evaluate(async (wsId) => {
            const token = localStorage.getItem("xihe-token");
            const response = await fetch("/api/v1/workspaces/" + wsId + "/imports", {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${token}`,
                    "X-Workspace-Id": wsId,
                    "Content-Type": "application/json",
                },
                body: "{}",
            });
            return { status: response.status, body: await response.json() };
        }, workspaceId);
        expect(editorWrite.status).not.toBe(403);

        const editorManage = await request.patch(`${CP_URL}/api/v1/workspaces/${workspaceId}`, {
            headers: {
                Authorization: `Bearer ${editor.body.accessToken}`,
                "X-Workspace-Id": workspaceId,
                "Content-Type": "application/json",
            },
            data: { name: "Editor Rename" },
        });
        expect(editorManage.status()).toBe(403);

        const ownerManage = await request.patch(`${CP_URL}/api/v1/workspaces/${workspaceId}`, {
            headers: {
                Authorization: `Bearer ${owner.body.accessToken}`,
                "X-Workspace-Id": workspaceId,
                "Content-Type": "application/json",
            },
            data: { name: "Owner Rename" },
        });
        expect(ownerManage.ok()).toBeTruthy();

        await viewerPage.screenshot({
            path: "test-results/plan-0559-viewer.png",
            fullPage: true,
        });
        await viewerPage.close();
        await editorPage.close();
    });
});
