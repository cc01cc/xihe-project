import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateE2EPassword } from "./helpers/password";
import { ensureWorkspace } from "./helpers/workspace";
import { dockerFrozenIncluded, dockerFrozenReason } from "./helpers/docker-frozen";

const RUNTIME_URL = `http://localhost:${process.env.XIHE_RUNTIME_PORT || "12633"}`;
const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`,
    SERVICE_TOKEN = process.env.XIHE_CP_API_TOKEN;
if (!SERVICE_TOKEN) throw new Error("XIHE_CP_API_TOKEN must be set for real E2E");
const TEST_PASSWORD = generateE2EPassword();

test.describe("@host Runtime M1 — dev:host E2E via Playwright CLI", () => {
    test("targeted file operation materializes one coding Sandbox, then delete preserves the contract", async ({
        request,
    }) => {
        test.skip(
            !dockerFrozenIncluded,
            dockerFrozenReason(
                "a docker-backed coding Sandbox is materialized for a targeted file operation, and delete preserves the WorkspaceStorage contract",
            ),
        );
        const register = await request.post(`${CP_URL}/api/v1/auth/register`, {
            data: {
                email: `runtime-m1-${Date.now()}@test.com`,
                password: TEST_PASSWORD,
                name: "Runtime M1",
            },
        });
        expect(register.ok()).toBeTruthy();
        const auth = await register.json(),
            wsId = await ensureWorkspace(request, auth.accessToken);

        // Session/auth creation only creates logical Workspace state.
        const before = await request.get(
            `${RUNTIME_URL}/internal/v1/runtime/workspaces/${wsId}/status`,
            {
                headers: { Authorization: `Bearer ${SERVICE_TOKEN}` },
            },
        );
        expect(before.status()).toBe(404);

        // The first targeted file operation performs materialization.
        const filePath = "hello-m1.txt",
            fileContent = `hello-m1-${wsId}`;
        const writeRes = await request.post(
            `${RUNTIME_URL}/internal/v1/runtime/workspaces/${wsId}/files/write/${encodeURIComponent(filePath)}`,
            {
                headers: { Authorization: `Bearer ${SERVICE_TOKEN}` },
                data: Buffer.from(fileContent, "utf-8"),
            },
        );
        expect(writeRes.ok()).toBeTruthy();

        const readRes = await request.post(
            `${RUNTIME_URL}/internal/v1/runtime/workspaces/${wsId}/files/read`,
            {
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${SERVICE_TOKEN}`,
                },
                data: { path: filePath },
            },
        );
        expect(readRes.ok()).toBeTruthy();
        const readBody = await readRes.json();
        // read returns {content, truncated} or similar
        const content = readBody.content ?? readBody.data ?? "";
        expect(content).toContain(fileContent);

        // Delete goes through the CP so the logical Workspace is marked deleted;
        // the Runtime only releases ephemeral Sandbox state and keeps files.
        const delRes = await request.delete(`${CP_URL}/api/v1/workspaces/${wsId}`, {
            headers: { Authorization: `Bearer ${auth.accessToken}` },
        });
        expect(delRes.status()).toBe(204);
        await new Promise((resolve) => setTimeout(resolve, 500));

        // The materialized runtime entry is gone after delete.
        const afterDel = await request.post(
            `${RUNTIME_URL}/internal/v1/runtime/workspaces/${wsId}/files/read`,
            {
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${SERVICE_TOKEN}`,
                },
                data: { path: filePath },
            },
        );
        expect(afterDel.status()).toBe(404);
    });

    test("direct Runtime create registers a direct_attach Workspace without materializing it", async ({
        request,
    }) => {
        const wsId = randomUUID();
        const workspaceDir = await mkdtemp(join(tmpdir(), "xihe-runtime-m1-"));
        try {
            const createRes = await request.post(`${RUNTIME_URL}/internal/v1/runtime/workspaces`, {
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${SERVICE_TOKEN}`,
                },
                data: {
                    workspaceId: wsId,
                    workspacePath: workspaceDir,
                    executionMode: "windows-host",
                    roots: [{ rootId: wsId, hostPath: workspaceDir }],
                },
            });
            expect(createRes.status()).toBe(200);
            expect(await createRes.json()).toEqual({ status: "ok", workspaceId: wsId });

            const statusRes = await request.get(
                `${RUNTIME_URL}/internal/v1/runtime/workspaces/${wsId}/status`,
                {
                    headers: { Authorization: `Bearer ${SERVICE_TOKEN}` },
                },
            );
            expect(statusRes.status()).toBe(200);
            const statusBody = await statusRes.json();
            expect(statusBody.workspaceId).toBe(wsId);
            expect(statusBody.state).toBe("ready");
            // A direct_attach registration carries no ExecutionSpec generation,
            // which proves it was registered without being materialized.
            expect(statusBody.generation ?? null).toBeNull();

            const deleteRes = await request.post(
                `${RUNTIME_URL}/internal/v1/runtime/workspaces/delete`,
                {
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${SERVICE_TOKEN}`,
                    },
                    data: { workspaceId: wsId },
                },
            );
            expect(deleteRes.status()).toBe(200);
            const deleteBody = await deleteRes.json();
            expect(deleteBody.status).toBe("ok");
            expect(deleteBody.workspaceId).toBe(wsId);
        } finally {
            await rm(workspaceDir, { recursive: true, force: true });
        }
    });

    test("direct Runtime create rejects storageRef mixed into a direct_attach registration", async ({
        request,
    }) => {
        const wsId = randomUUID();
        const workspaceDir = await mkdtemp(join(tmpdir(), "xihe-runtime-m1-mixed-"));
        try {
            const createRes = await request.post(`${RUNTIME_URL}/internal/v1/runtime/workspaces`, {
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${SERVICE_TOKEN}`,
                },
                data: {
                    workspaceId: wsId,
                    workspacePath: workspaceDir,
                    storageRef: wsId,
                    executionMode: "windows-host",
                    roots: [{ rootId: wsId, hostPath: workspaceDir }],
                },
            });
            expect(createRes.status()).toBe(400);
            const body = await createRes.json();
            expect(body.code).toBe("INVALID_REQUEST");
            expect(body.detail).toContain("mutually exclusive");

            const statusRes = await request.get(
                `${RUNTIME_URL}/internal/v1/runtime/workspaces/${wsId}/status`,
                {
                    headers: { Authorization: `Bearer ${SERVICE_TOKEN}` },
                },
            );
            expect(statusRes.status()).toBe(404);
        } finally {
            await rm(workspaceDir, { recursive: true, force: true });
        }
    });
});
