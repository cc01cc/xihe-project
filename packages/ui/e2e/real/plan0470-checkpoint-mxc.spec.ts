import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expect, test, type APIRequestContext } from "@playwright/test";
import {
    createSessionWithPrincipal,
    provisionWorkspaceAgentPrincipal,
} from "./helpers/agent-principal";
import { ensureAgentWorkspaceBinding, waitForControlPlaneAgentReady } from "./helpers/journey";
import { generateE2EPassword } from "./helpers/password";

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`;
const HOST_ROOT = path.resolve(
    process.cwd(),
    "../../.tmp/e2e-host",
    process.env.XIHE_E2E_RUN_ID ?? "unknown-run",
);
const BASELINE_FILE = ".plan0470-checkpoint-baseline.txt";

interface Checkpoint {
    state: string;
    sourceRunId: string | null;
    changedCount: number;
    changedFiles: Array<{ path: string; status: string }>;
    sliceRef: string | null;
    revert: { state: string; counts: { restored: number; deleted: number } } | null;
}

async function getCheckpoints(
    request: APIRequestContext,
    headers: Record<string, string>,
    workspaceId: string,
): Promise<Checkpoint[]> {
    const response = await request.get(`${CP_URL}/api/v1/workspaces/${workspaceId}/checkpoints`, {
        headers,
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    return (await response.json()) as Checkpoint[];
}

async function findRunId(
    request: APIRequestContext,
    headers: Record<string, string>,
    workspaceId: string,
): Promise<string> {
    let runId = "";
    await expect
        .poll(
            async () => {
                const response = await request.get(
                    `${CP_URL}/api/v1/audit/entries?type=chat_run&workspaceId=${workspaceId}&size=5`,
                    { headers },
                );
                if (!response.ok()) return "pending";
                const body = (await response.json()) as {
                    entries?: Array<{ id?: string; runId?: string }>;
                };
                const entry = body.entries?.find((item) => item.runId || item.id);
                runId = entry?.runId ?? entry?.id ?? "";
                return runId ? "found" : "pending";
            },
            { timeout: 60000, intervals: [500, 1000, 2000] },
        )
        .toBe("found");
    return runId;
}

test.describe("@host PLAN-0470 checkpoint direct-attach MXC consumer", () => {
    test.setTimeout(240000);

    test("captures a ChatRun and previews/reverts files through the browser", async ({
        page,
        request,
    }) => {
        const password = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword();
        const registration = await request.post(`${CP_URL}/api/v1/auth/register`, {
            data: {
                email: `plan0470-checkpoint-${Date.now()}@test.com`,
                password,
                name: "PLAN0470 Checkpoint MXC",
            },
        });
        expect([200, 201], await registration.text()).toContain(registration.status());
        const registered = (await registration.json()) as {
            accessToken: string;
            refreshToken: string;
            workspaceId: string;
        };

        const deleteDefault = await request.delete(
            `${CP_URL}/api/v1/workspaces/${registered.workspaceId}`,
            { headers: { Authorization: `Bearer ${registered.accessToken}` } },
        );
        expect(deleteDefault.ok()).toBeTruthy();

        const hostPath = path.join(HOST_ROOT, `plan0470-checkpoint-${Date.now()}`);
        mkdirSync(hostPath, { recursive: true });
        const created = await request.post(`${CP_URL}/api/v1/workspaces`, {
            headers: {
                Authorization: `Bearer ${registered.accessToken}`,
                "Content-Type": "application/json",
                "Idempotency-Key": `plan0470-checkpoint-${Date.now()}`,
            },
            data: {
                name: "PLAN-0470 Checkpoint MXC",
                storageMode: "direct_attach",
                hostPath,
                executionMode: "windows-mxc",
            },
        });
        expect(created.status(), await created.text()).toBe(201);
        const workspace = (await created.json()) as { id: string };
        const refreshed = await request.post(`${CP_URL}/api/v1/auth/refresh`, {
            data: { refreshToken: registered.refreshToken },
        });
        expect(refreshed.ok(), await refreshed.text()).toBeTruthy();
        const auth = (await refreshed.json()) as { accessToken: string; workspaceId: string };
        expect(auth.workspaceId).toBe(workspace.id);
        const headers = {
            Authorization: `Bearer ${auth.accessToken}`,
            "Content-Type": "application/json",
        };

        const principalId = await provisionWorkspaceAgentPrincipal(
            request,
            { accessToken: auth.accessToken, workspaceId: workspace.id },
            { name: "PLAN-0470 Checkpoint Writer", actions: ["read", "write"] },
        );
        const sessionId = await createSessionWithPrincipal(
            request,
            {
                accessToken: auth.accessToken,
                workspaceId: workspace.id,
            },
            { principalId, title: "PLAN-0470 checkpoint consumer" },
        );
        await ensureAgentWorkspaceBinding(workspace.id);
        await waitForControlPlaneAgentReady(request, headers);

        const baselinePath = path.join(hostPath, BASELINE_FILE);
        writeFileSync(baselinePath, "baseline\n", "utf8");
        const materialize = await request.post(
            `${CP_URL}/api/v1/workspaces/${workspace.id}/materialize`,
            { headers },
        );
        expect([200, 202]).toContain(materialize.status());
        const shadowGitDir = path.join(HOST_ROOT, ".xihe-shadow", `${workspace.id}.git`);
        await expect
            .poll(
                () => {
                    const result = spawnSync(
                        "git",
                        [
                            "--git-dir",
                            shadowGitDir,
                            "for-each-ref",
                            "--format=%(refname)",
                            "refs/xihe/slices",
                        ],
                        { encoding: "utf8" },
                    );
                    return result.status === 0
                        ? result.stdout.trim().split(/\r?\n/).filter(Boolean).length
                        : 0;
                },
                { timeout: 120000, intervals: [1000, 2000] },
            )
            .toBeGreaterThan(0);

        await page.addInitScript(
            (token) => localStorage.setItem("xihe-token", token),
            auth.accessToken,
        );
        await page.addInitScript(
            (raw) => localStorage.setItem("xihe-user", raw),
            JSON.stringify({ workspaceId: workspace.id }),
        );
        await page.addInitScript(
            (workspaceId) =>
                localStorage.setItem(
                    "xihe-workspace",
                    JSON.stringify({ id: workspaceId, name: "PLAN-0470 Checkpoint MXC" }),
                ),
            workspace.id,
        );
        await page.goto(`/chat/${sessionId}`, { waitUntil: "load" });
        const input = page.locator('[data-testid="chat-input"]');
        const send = page.locator('[data-testid="chat-send-button"]');
        await expect(input).toBeVisible({ timeout: 30000 });

        const nonce = Date.now();
        const fileName = `plan0470-note-${nonce}.md`;
        const content = `PLAN0470-CHECKPOINT-${nonce}`;
        await input.fill(`XIHE-E2E-WRITE ${fileName} ${content}`);
        await expect(send).toBeEnabled();
        const chatResponsePromise = page.waitForResponse(
            (response) =>
                response.url().endsWith("/api/v1/chat") && response.request().method() === "POST",
            { timeout: 30000 },
        );
        await send.click();
        const chatResponse = await chatResponsePromise;
        expect(chatResponse.ok(), `chat request returned ${chatResponse.status()}`).toBeTruthy();

        const approval = page.locator('[data-testid="modal-content"]');
        await expect(approval).toBeVisible({ timeout: 120000 });
        const runId = await findRunId(request, headers, workspace.id);
        await approval.locator('[data-testid="approval-approve"]').click();
        await expect(approval).toBeHidden({ timeout: 30000 });

        const hostFile = path.join(hostPath, fileName);
        await expect
            .poll(() => (existsSync(hostFile) ? readFileSync(hostFile, "utf8") : ""), {
                timeout: 60000,
            })
            .toContain(content);
        await expect
            .poll(
                async () => {
                    const response = await request.get(`${CP_URL}/api/v1/chat/runs/${runId}`, {
                        headers,
                    });
                    if (!response.ok()) return "unknown";
                    return String(
                        ((await response.json()) as { status?: string }).status ?? "unknown",
                    );
                },
                { timeout: 180000, intervals: [1000, 2000] },
            )
            .toBe("succeeded");
        await expect
            .poll(
                async () => {
                    const checkpoint = (await getCheckpoints(request, headers, workspace.id)).find(
                        (item) => item.sourceRunId === runId,
                    );
                    return checkpoint?.state ?? "missing";
                },
                { timeout: 120000, intervals: [1000, 2000] },
            )
            .toBe("captured");

        const checkpoint = (await getCheckpoints(request, headers, workspace.id)).find(
            (item) => item.sourceRunId === runId,
        );
        expect(checkpoint).toBeTruthy();
        expect(checkpoint?.changedCount).toBe(1);
        expect(checkpoint?.changedFiles).toContainEqual({ path: fileName, status: "A" });
        const marker = page.locator('[data-testid="run-checkpoint-marker"]').last();
        await expect(marker).toHaveAttribute("data-checkpoint-kind", "captured", {
            timeout: 30000,
        });

        const extraName = `plan0470-extra-${nonce}.txt`;
        const extraPath = path.join(hostPath, extraName);
        writeFileSync(extraPath, "revert removes this post-run file\n", "utf8");
        await marker.getByTestId("run-checkpoint-revert-entry").click();
        const dialog = page.getByTestId("checkpoint-dialog");
        await expect(dialog).toBeVisible();
        await expect(page.getByTestId("revert-preview-delete-count")).toHaveText("1");
        await expect(page.getByTestId("revert-preview-paths")).toContainText(extraName);
        await page.getByTestId("revert-preview-confirm").click();
        await expect(page.getByTestId("revert-result-counts")).toBeVisible({ timeout: 60000 });
        await expect.poll(() => existsSync(extraPath), { timeout: 30000 }).toBe(false);
        expect(readFileSync(hostFile, "utf8")).toContain(content);

        const reverted = (await getCheckpoints(request, headers, workspace.id)).find(
            (item) => item.sourceRunId === runId,
        );
        expect(reverted?.revert?.state).toBe("rolled_back");
        await expect(page.getByTestId("run-checkpoint-reverted").last()).toContainText(
            "已恢复到该切片",
        );
        const screenshotPath = path.resolve(
            process.cwd(),
            "../../.local/evidence/plan0470-checkpoint-mxc.png",
        );
        mkdirSync(path.dirname(screenshotPath), { recursive: true });
        await page.screenshot({ path: screenshotPath });
    });
});
