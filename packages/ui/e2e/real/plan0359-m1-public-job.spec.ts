import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { generateE2EPassword } from "./helpers/password";
import { test, expect } from "@playwright/test";

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`;
const RUNTIME_URL = `http://localhost:${process.env.XIHE_RUNTIME_PORT || "12633"}`;
const EVIDENCE_DIR = path.resolve(process.cwd(), "../../.local/evidence/plan0359-m1-public-job");
const M3_EVIDENCE_DIR = path.resolve(process.cwd(), "../../.local/evidence/plan0470-job-deletion");

test.describe("@host PLAN-0359 M1 public Workspace Job", () => {
    test.describe.configure({ mode: "serial" });
    test.setTimeout(240000);

    async function register(request: import("@playwright/test").APIRequestContext, tag: string) {
        const password = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword();
        const response = await request.post(`${CP_URL}/api/v1/auth/register`, {
            data: {
                email: `plan0359-m1-${tag}-${Date.now()}@test.com`,
                password,
                name: `PLAN0359 ${tag}`,
            },
        });
        expect(
            [200, 201],
            `register failed: ${response.status()} ${await response.text()}`,
        ).toContain(response.status());
        const body = await response.json();
        return {
            accessToken: String(body.accessToken),
            refreshToken: String(body.refreshToken),
            defaultWorkspaceId: String(body.workspaceId),
        };
    }

    async function createBoundWorkspace(
        request: import("@playwright/test").APIRequestContext,
        tag: string,
        executionMode: "windows-host" | "windows-mxc",
        allowUnavailable = false,
    ): Promise<{ token: string; workspaceId: string; hostPath: string } | null> {
        const auth = await register(request, tag);
        const headers = {
            Authorization: `Bearer ${auth.accessToken}`,
            "Content-Type": "application/json",
        };
        await request.delete(`${CP_URL}/api/v1/workspaces/${auth.defaultWorkspaceId}`, {
            headers: { Authorization: `Bearer ${auth.accessToken}` },
        });

        const hostPath = path.join(
            process.env.XIHE_WORKSPACE_HOST_ROOT || os.tmpdir(),
            `xihe-e2e-0359-m1-${tag}-${Date.now()}`,
        );
        mkdirSync(hostPath, { recursive: true });
        const created = await request.post(`${CP_URL}/api/v1/workspaces`, {
            headers: { ...headers, "Idempotency-Key": `plan0359-m1-${tag}-${Date.now()}` },
            data: {
                name: `PLAN0359 M1 ${tag}`,
                storageMode: "direct_attach",
                hostPath,
                executionMode,
            },
        });
        if (!created.ok()) {
            const failure = await created.text();
            if (!allowUnavailable) {
                expect(
                    created.ok(),
                    `workspace create failed: ${created.status()} ${failure}`,
                ).toBeTruthy();
            }
            expect(created.status(), failure).toBe(503);
            expect(failure).toContain("DIRECT_ATTACH_UNAVAILABLE");
            expect(failure).toContain("SANDBOX_PROBE_FAILED");
            test.info().annotations.push({
                type: "host-capability",
                description: `${executionMode} unavailable; workspace creation failed closed; no host fallback used`,
            });
            return null;
        }
        const workspace = await created.json();
        const workspaceId = String(workspace.id);

        const refreshed = await request.post(`${CP_URL}/api/v1/auth/refresh`, {
            data: { refreshToken: auth.refreshToken },
        });
        expect(
            refreshed.ok(),
            `refresh failed: ${refreshed.status()} ${await refreshed.text()}`,
        ).toBeTruthy();
        const refreshedBody = await refreshed.json();
        expect(String(refreshedBody.workspaceId)).toBe(workspaceId);

        return { token: String(refreshedBody.accessToken), workspaceId, hostPath };
    }

    async function startJob(
        request: import("@playwright/test").APIRequestContext,
        token: string,
        workspaceId: string,
        body: Record<string, unknown>,
        key: string,
    ) {
        return request.post(`${CP_URL}/api/v1/workspaces/${workspaceId}/jobs`, {
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
                "Idempotency-Key": key,
            },
            data: body,
        });
    }

    async function listJobs(
        request: import("@playwright/test").APIRequestContext,
        token: string,
        workspaceId: string,
    ) {
        const response = await request.get(`${CP_URL}/api/v1/workspaces/${workspaceId}/jobs`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        expect(
            response.ok(),
            `list jobs failed: ${response.status()} ${await response.text()}`,
        ).toBeTruthy();
        return (await response.json()) as Array<Record<string, unknown>>;
    }

    async function runtimeJobStatus(
        request: import("@playwright/test").APIRequestContext,
        workspaceId: string,
        jobId: string,
    ): Promise<Record<string, unknown>> {
        const serviceToken = process.env.XIHE_CP_API_TOKEN;
        if (!serviceToken) throw new Error("Runtime service token is unavailable in host E2E");
        const response = await request.post(
            `${RUNTIME_URL}/internal/v1/runtime/workspaces/${workspaceId}/jobs/status`,
            {
                headers: { Authorization: `Bearer ${serviceToken}` },
                data: { jobId },
            },
        );
        expect(
            response.ok(),
            `Runtime job status failed: ${response.status()} ${await response.text()}`,
        ).toBeTruthy();
        return (await response.json()) as Record<string, unknown>;
    }

    async function runtimeJobOutput(
        request: import("@playwright/test").APIRequestContext,
        workspaceId: string,
        jobId: string,
        stream: "stdout" | "stderr",
    ): Promise<string> {
        const serviceToken = process.env.XIHE_CP_API_TOKEN;
        if (!serviceToken) throw new Error("Runtime service token is unavailable in host E2E");
        const response = await request.post(
            `${RUNTIME_URL}/internal/v1/runtime/workspaces/${workspaceId}/jobs/output`,
            {
                headers: { Authorization: `Bearer ${serviceToken}` },
                data: { jobId, stream, offset: 0, limit: 4096 },
            },
        );
        expect(
            response.ok(),
            `Runtime job output failed: ${response.status()} ${await response.text()}`,
        ).toBeTruthy();
        const output = (await response.json()) as { data?: string };
        return String(output.data ?? "");
    }

    function queryIsolatedPostgres(sql: string): string {
        const container = process.env.XIHE_E2E_PG_CONTAINER;
        const database = process.env.XIHE_E2E_PG_DATABASE;
        const user = process.env.XIHE_E2E_PG_USER;
        if (!container || !database || !user) {
            throw new Error(
                "isolated Postgres metadata is unavailable; run through scripts/e2e-host.mjs",
            );
        }
        return execFileSync(
            process.platform === "win32" ? "docker.exe" : "docker",
            ["exec", container, "psql", "-X", "-A", "-t", "-U", user, "-d", database, "-c", sql],
            { encoding: "utf8", timeout: 15_000, windowsHide: true },
        ).trim();
    }

    function seedPage(
        page: import("@playwright/test").Page,
        token: string,
        workspaceId: string,
        name: string,
    ) {
        page.addInitScript((value) => localStorage.setItem("xihe-token", value), token);
        page.addInitScript(
            (value) => localStorage.setItem("xihe-user", value),
            JSON.stringify({ workspaceId }),
        );
        page.addInitScript(
            (value) => localStorage.setItem("xihe-workspace", value),
            JSON.stringify({ id: workspaceId, name }),
        );
        page.addInitScript(
            (value) => localStorage.setItem("xihe-workspace-id", value),
            workspaceId,
        );
    }

    test.beforeAll(async () => {
        mkdirSync(EVIDENCE_DIR, { recursive: true });
    });

    test("windows-host public Job start, output, cancel, and UI projection", async ({
        request,
        page,
    }) => {
        const workspace = await createBoundWorkspace(request, "host", "windows-host");
        if (!workspace)
            throw new Error("windows-host capability was expected for this local host test");
        const running = await startJob(
            request,
            workspace.token,
            workspace.workspaceId,
            {
                command: "cmd.exe",
                args: ["/c", "ping", "127.0.0.1", "-n", "15"],
                timeoutSecs: 30,
                scope: "workspace",
                source: "ui",
                env: {},
            },
            `plan0359-host-job-${Date.now()}`,
        );
        expect(
            [200, 202],
            `job start failed: ${running.status()} ${await running.text()}`,
        ).toContain(running.status());
        const projection = await running.json();
        const jobId = String(projection.jobId ?? "");
        expect(jobId).toBeTruthy();

        await expect
            .poll(
                async () => {
                    const jobs = await listJobs(request, workspace.token, workspace.workspaceId);
                    return jobs.find((job) => String(job.jobId) === jobId)?.status;
                },
                { timeout: 30000 },
            )
            .toMatch(/running|pending/);

        const cancel = await request.post(
            `${CP_URL}/api/v1/workspaces/${workspace.workspaceId}/jobs/${jobId}/cancel`,
            {
                headers: { Authorization: `Bearer ${workspace.token}` },
            },
        );
        expect(
            cancel.ok(),
            `cancel failed: ${cancel.status()} ${await cancel.text()}`,
        ).toBeTruthy();
        const cancelBody = await cancel.json();
        expect(cancelBody.status).toMatch(/cancelled|cancelling/);

        await expect
            .poll(
                async () => {
                    const jobs = await listJobs(request, workspace.token, workspace.workspaceId);
                    return jobs.find((job) => String(job.jobId) === jobId)?.status;
                },
                { timeout: 30000 },
            )
            .toBe("cancelled");

        seedPage(page, workspace.token, workspace.workspaceId, "PLAN0359 Host");
        await page.goto(`/workspace/${workspace.workspaceId}/environment`);
        await expect(page.locator('[data-testid="workspace-job-status"]').first()).toContainText(
            /取消|cancel/i,
            { timeout: 20000 },
        );
        await page.screenshot({
            path: path.join(EVIDENCE_DIR, "host-job-cancelled.png"),
            fullPage: true,
        });
    });

    test("windows-mxc public Job starts when available or fails closed at workspace creation", async ({
        request,
    }) => {
        const workspace = await createBoundWorkspace(request, "mxc", "windows-mxc", true);
        if (!workspace) return;
        const started = await startJob(
            request,
            workspace.token,
            workspace.workspaceId,
            {
                command: "cmd.exe",
                args: ["/c", "echo", "PLAN0359_MXC"],
                timeoutSecs: 15,
                scope: "workspace",
                source: "ui",
                env: {},
            },
            `plan0359-mxc-job-${Date.now()}`,
        );

        if (started.status() === 202 || started.status() === 200) {
            const projection = await started.json();
            const jobId = String(projection.jobId ?? "");
            let mxcStatus = "";
            await expect
                .poll(
                    async () => {
                        const jobs = await listJobs(
                            request,
                            workspace.token,
                            workspace.workspaceId,
                        );
                        mxcStatus = String(
                            jobs.find((job) => String(job.jobId) === jobId)?.status ?? "",
                        );
                        return mxcStatus;
                    },
                    { timeout: 30000 },
                )
                .toMatch(/running|completed|failed|interrupted/);

            if (mxcStatus === "running") {
                const cancel = await request.post(
                    `${CP_URL}/api/v1/workspaces/${workspace.workspaceId}/jobs/${jobId}/cancel`,
                    {
                        headers: { Authorization: `Bearer ${workspace.token}` },
                    },
                );
                if (cancel.status() === 502) {
                    const body = await cancel.json();
                    expect(body.code).toBe("JOB_CANCEL_UNCONFIRMED");
                } else {
                    expect(
                        cancel.ok(),
                        `MXC cancel failed: ${cancel.status()} ${await cancel.text()}`,
                    ).toBeTruthy();
                    await expect
                        .poll(
                            async () => {
                                const jobs = await listJobs(
                                    request,
                                    workspace.token,
                                    workspace.workspaceId,
                                );
                                return jobs.find((job) => String(job.jobId) === jobId)?.status;
                            },
                            { timeout: 30000 },
                        )
                        .toBe("cancelled");
                }
            } else {
                const output = await request.get(
                    `${CP_URL}/api/v1/workspaces/${workspace.workspaceId}/jobs/${jobId}/output?offset=0&limit=65536`,
                    {
                        headers: { Authorization: `Bearer ${workspace.token}` },
                    },
                );
                expect(
                    output.ok(),
                    `output failed: ${output.status()} ${await output.text()}`,
                ).toBeTruthy();
                expect(await output.text()).toContain("PLAN0359_MXC");
            }
        } else {
            expect([400, 409, 501, 502, 503]).toContain(started.status());
            const body = (await started.json().catch(() => ({}))) as Record<string, unknown>;
            expect(String(body.code ?? "")).toMatch(
                /JOB_BACKEND_LAUNCH_PENDING|CAPABILITY|RUNTIME|UNMAPPED|PROCESS/i,
            );
        }
    });

    test("PLAN-0470 windows-mxc cancellation and Workspace deletion preserve Job history/storage", async ({
        request,
        page,
    }) => {
        const workspace = await createBoundWorkspace(request, "m3-job-deletion", "windows-mxc");
        if (!workspace)
            throw new Error("windows-mxc is required for the PLAN-0470 host process gate");
        mkdirSync(M3_EVIDENCE_DIR, { recursive: true });
        const retainedFile = path.join(workspace.hostPath, "plan0470-storage-retained.txt");
        writeFileSync(retainedFile, "WorkspaceStorage survives workspace deletion\n", "utf8");

        const startRuntimeJob = async (marker: string, idempotencyKey: string) => {
            const response = await startJob(
                request,
                workspace.token,
                workspace.workspaceId,
                {
                    command: "cmd.exe",
                    args: ["/c", `echo ${marker} & timeout /t 60 /nobreak > nul`],
                    timeoutSecs: 90,
                    scope: "workspace",
                    source: "ui",
                    env: {},
                },
                idempotencyKey,
            );
            expect(
                [200, 202],
                `job start failed: ${response.status()} ${await response.text()}`,
            ).toContain(response.status());
            const body = (await response.json()) as { jobId?: string };
            const jobId = String(body.jobId ?? "");
            expect(jobId).toMatch(/^[0-9a-f-]{36}$/i);
            await expect
                .poll(
                    async () => {
                        const jobs = await listJobs(
                            request,
                            workspace.token,
                            workspace.workspaceId,
                        );
                        return jobs.find((job) => String(job.jobId) === jobId)?.status;
                    },
                    { timeout: 20000, intervals: [250, 500, 1000] },
                )
                .toBe("running");
            return jobId;
        };

        const cancelJobId = await startRuntimeJob(
            "PLAN0470_CANCEL_TARGET",
            `plan0470-cancel-${Date.now()}`,
        );
        const runtimeBeforeCancel = await runtimeJobStatus(
            request,
            workspace.workspaceId,
            cancelJobId,
        );
        if (runtimeBeforeCancel.status !== "running") {
            const [stdout, stderr] = await Promise.all([
                runtimeJobOutput(request, workspace.workspaceId, cancelJobId, "stdout"),
                runtimeJobOutput(request, workspace.workspaceId, cancelJobId, "stderr"),
            ]);
            throw new Error(
                `Runtime job was not running before cancel: status=${String(runtimeBeforeCancel.status)} ` +
                    `exitCode=${String(runtimeBeforeCancel.exitCode)} stdout=${JSON.stringify(stdout)} ` +
                    `stderr=${JSON.stringify(stderr)}`,
            );
        }

        const cancelResponse = await request.post(
            `${CP_URL}/api/v1/workspaces/${workspace.workspaceId}/jobs/${cancelJobId}/cancel`,
            { headers: { Authorization: `Bearer ${workspace.token}` } },
        );
        if (cancelResponse.status() !== 200) {
            const runtimeAfterCancel = await runtimeJobStatus(
                request,
                workspace.workspaceId,
                cancelJobId,
            );
            throw new Error(
                `CP cancel failed: ${cancelResponse.status()} ${await cancelResponse.text()}; ` +
                    `Runtime status before=${String(runtimeBeforeCancel.status)} ` +
                    `after=${String(runtimeAfterCancel.status)} exitCode=${String(runtimeAfterCancel.exitCode)}`,
            );
        }
        const cancelBody = (await cancelResponse.json()) as {
            jobId: string;
            status: string;
            changed: boolean;
        };
        expect(cancelBody).toEqual({ jobId: cancelJobId, status: "cancelled", changed: true });
        await expect
            .poll(
                async () => {
                    const jobs = await listJobs(request, workspace.token, workspace.workspaceId);
                    return jobs.find((job) => String(job.jobId) === cancelJobId)?.status;
                },
                { timeout: 30000, intervals: [250, 500, 1000] },
            )
            .toBe("cancelled");

        seedPage(page, workspace.token, workspace.workspaceId, "PLAN-0470 Job deletion");
        await page.goto(`/workspace/${workspace.workspaceId}/environment`, { waitUntil: "load" });
        await expect(page.locator('[data-testid="workspace-job-status"]').first()).toContainText(
            /取消|cancel/i,
            { timeout: 30000 },
        );
        await page.screenshot({
            path: path.join(M3_EVIDENCE_DIR, "mxc-job-cancelled.png"),
            fullPage: false,
        });

        const deleteJobId = await startRuntimeJob(
            "PLAN0470_DELETE_ORPHAN",
            `plan0470-delete-${Date.now()}`,
        );
        const deleteResponse = await request.delete(
            `${CP_URL}/api/v1/workspaces/${workspace.workspaceId}`,
            { headers: { Authorization: `Bearer ${workspace.token}` } },
        );
        if (deleteResponse.status() !== 204) {
            throw new Error(
                `Workspace delete failed: ${deleteResponse.status()} ${await deleteResponse.text()}`,
            );
        }

        const workspaceRow = queryIsolatedPostgres(
            `SELECT CASE WHEN deleted_at IS NULL THEN 'active' ELSE 'deleted' END || '|' || CASE WHEN storage_ref IS NULL THEN 'missing' ELSE 'present' END FROM workspaces WHERE id='${workspace.workspaceId}'::uuid`,
        );
        expect(workspaceRow).toBe("deleted|present");
        expect(existsSync(retainedFile)).toBe(true);

        const cancelHistory = queryIsolatedPostgres(
            `SELECT event_type || '|' || COALESCE(from_status, '-') || '|' || COALESCE(to_status, '-') || '|' || COALESCE(cancel_reason, '-') FROM workspace_job_history WHERE job_id='${cancelJobId}'::uuid ORDER BY sequence`,
        ).split(/\r?\n/);
        expect(cancelHistory).toContain("cancel|running|cancelled|user_cancel");
        expect(cancelHistory.filter((row) => row.startsWith("cancel|")).length).toBe(1);

        const orphanHistory = queryIsolatedPostgres(
            `SELECT event_type || '|' || COALESCE(from_status, '-') || '|' || COALESCE(to_status, '-') || '|' || COALESCE(cancel_reason, '-') FROM workspace_job_history WHERE job_id='${deleteJobId}'::uuid ORDER BY sequence`,
        ).split(/\r?\n/);
        expect(orphanHistory.some((row) => row.includes("|orphaned|destroy_orphan"))).toBe(true);
    });

    test("windows-mxc public Job rejects an outside write when capability is available", async ({
        request,
    }) => {
        const workspace = await createBoundWorkspace(request, "mxc-boundary", "windows-mxc", true);
        if (!workspace) {
            test.skip(
                true,
                "outside-write behavior requires an MXC-capable host; creation fail-closed behavior is tested separately",
            );
            return;
        }
        const outside = path.join(
            path.dirname(workspace.hostPath),
            `xihe-e2e-0359-outside-${Date.now()}.txt`,
        );
        const node = execFileSync("where.exe", ["node"], { encoding: "utf8" })
            .split(/\r?\n/)[0]
            .trim();
        const script = `require('fs').writeFileSync(${JSON.stringify(outside)}, 'outside')`;
        const started = await startJob(
            request,
            workspace.token,
            workspace.workspaceId,
            {
                command: node,
                args: ["-e", script],
                timeoutSecs: 15,
                scope: "workspace",
                source: "ui",
                env: {},
            },
            `plan0359-mxc-boundary-${Date.now()}`,
        );
        expect(
            [200, 202],
            `boundary start failed: ${started.status()} ${await started.text()}`,
        ).toContain(started.status());
        const projection = await started.json();
        const jobId = String(projection.jobId ?? "");
        expect(jobId).toBeTruthy();

        let finalStatus = "";
        await expect
            .poll(
                async () => {
                    const jobs = await listJobs(request, workspace.token, workspace.workspaceId);
                    finalStatus = String(
                        jobs.find((job) => String(job.jobId) === jobId)?.status ?? "",
                    );
                    return finalStatus;
                },
                { timeout: 30000 },
            )
            .toMatch(/running|failed|interrupted|cancelled|orphaned/);
        if (finalStatus === "running") {
            const cancel = await request.post(
                `${CP_URL}/api/v1/workspaces/${workspace.workspaceId}/jobs/${jobId}/cancel`,
                {
                    headers: { Authorization: `Bearer ${workspace.token}` },
                },
            );
            if (cancel.status() === 502) {
                const body = await cancel.json();
                expect(body.code).toBe("JOB_CANCEL_UNCONFIRMED");
            } else {
                expect(
                    cancel.ok(),
                    `boundary cancel failed: ${cancel.status()} ${await cancel.text()}`,
                ).toBeTruthy();
            }
        }
        expect(finalStatus).not.toBe("succeeded");
        expect(existsSync(outside)).toBe(false);
    });
});
