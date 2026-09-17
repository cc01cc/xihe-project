import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    ApiError,
    api,
    normalizeCheckpointCleanupResult,
    normalizeCheckpointPreview,
    normalizeCheckpointResult,
    normalizeCheckpointRetention,
    normalizeWorkspaceCheckpointEvent,
    normalizeWorkspaceCheckpoints,
} from "../api";

const WORKSPACE_ID = "66666666-6666-4666-8666-666666666666";
const SLICE_REF = "refs/xihe/workspace/slice-1";
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const SESSION_ID = "55555555-5555-4555-8555-555555555555";
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    localStorage.clear();
    fetchSpy = vi.spyOn(globalThis, "fetch");
});
afterEach(() => fetchSpy.mockRestore());

function jsonResponse(payload: unknown, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(payload),
        headers: new Headers(),
    } as unknown as Response;
}

function textResponse(body: string): Response {
    return {
        ok: true,
        status: 200,
        text: () => Promise.resolve(body),
        headers: new Headers(),
    } as unknown as Response;
}

function checkpoint(overrides: Record<string, unknown> = {}) {
    return {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        sliceRef: SLICE_REF,
        capturedAt: "2026-09-15T10:00:00Z",
        sourceRunId: RUN_ID,
        sourceSessionId: SESSION_ID,
        predecessorRef: null,
        state: "captured",
        changedCount: 2,
        changedFiles: [
            { status: "M", path: "src/app.ts" },
            { status: "A", path: "src/new.ts" },
        ],
        opaqueNestedRepos: ["vendor/lib"],
        unrollableReason: null,
        truncated: false,
        revert: null,
        ...overrides,
    };
}

describe("workspace checkpoint normalizers", () => {
    it("normalizes timeline fields and excludes expired rows", () => {
        const list = normalizeWorkspaceCheckpoints([
            checkpoint(),
            checkpoint({ id: "expired", state: "expired" }),
        ]);
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({
            sliceRef: SLICE_REF,
            capturedAt: "2026-09-15T10:00:00Z",
            sourceRunId: RUN_ID,
            opaqueNestedRepos: ["vendor/lib"],
        });
    });

    it("keeps degraded rows and rejects unknown states or malformed refs", () => {
        expect(
            normalizeWorkspaceCheckpoints([checkpoint({ state: "degraded", sliceRef: null })])[0]
                .state,
        ).toBe("degraded");
        expect(normalizeWorkspaceCheckpoints([checkpoint({ state: "legacy-state" })])).toEqual([]);
        expect(normalizeWorkspaceCheckpoints([checkpoint({ sliceRef: 12 })])).toEqual([]);
    });

    it("normalizes lifecycle events without inventing a state", () => {
        expect(
            normalizeWorkspaceCheckpointEvent(
                { runId: RUN_ID, state: "captured", changedCount: 4 },
                SESSION_ID,
            ),
        ).toEqual({ runId: RUN_ID, sessionId: SESSION_ID, state: "captured", changedCount: 4 });
        expect(
            normalizeWorkspaceCheckpointEvent({ runId: RUN_ID, state: "legacy-state" }, SESSION_ID),
        ).toBeNull();
        expect(
            normalizeWorkspaceCheckpointEvent(
                { runId: RUN_ID, sessionId: "other", state: "captured" },
                SESSION_ID,
            ),
        ).toBeNull();
    });
});

describe("checkpoint preview and result normalizers", () => {
    it("normalizes restore/delete/typeConflict preview entries", () => {
        const preview = normalizeCheckpointPreview({
            sliceRef: SLICE_REF,
            counts: { restore: 2, delete: 1, typeConflict: 1 },
            entries: [
                { path: "src/a.ts", action: "restore", state: "execute" },
                {
                    path: "src/b.ts",
                    action: "delete",
                    state: "type_conflict",
                    reason: "TYPE_CHANGED",
                },
                { path: "src/c.ts", action: "restore", state: "noop" },
            ],
            truncated: true,
            opaqueNestedRepos: ["vendor/lib"],
        });
        expect(preview).toMatchObject({
            sliceRef: SLICE_REF,
            counts: { restore: 2, delete: 1, typeConflict: 1 },
            truncated: true,
            opaqueNestedRepos: ["vendor/lib"],
        });
        expect(preview?.entries[1].state).toBe("type_conflict");
        expect(
            normalizeCheckpointPreview({
                sliceRef: SLICE_REF,
                counts: { restore: 1, delete: 0, typeConflict: "x" },
                entries: [],
            }),
        ).toBeNull();
    });

    it("normalizes result outcomes and suspects only", () => {
        const result = normalizeCheckpointResult({
            sliceRef: SLICE_REF,
            counts: { restored: 1, deleted: 1, failed: 1 },
            entries: [
                { path: "a.ts", outcome: "restored" },
                { path: "b.ts", outcome: "suspect", reason: "CONCURRENT_WRITE" },
                { path: "c.ts", outcome: "failed" },
                { path: "d.ts", outcome: "legacy-outcome" },
            ],
            durationMs: 42,
            suspects: ["b.ts"],
        });
        expect(result?.counts).toEqual({ restored: 1, deleted: 1, failed: 1 });
        expect(result?.entries).toEqual([
            { path: "a.ts", outcome: "restored" },
            { path: "b.ts", outcome: "suspect", reason: "CONCURRENT_WRITE" },
            { path: "c.ts", outcome: "failed" },
        ]);
        expect(result?.suspects).toEqual(["b.ts"]);
        expect(
            normalizeCheckpointResult({
                sliceRef: SLICE_REF,
                counts: { restored: 1 },
                entries: [],
            }),
        ).toBeNull();
    });

    it("normalizes explicit cleanup and retained retention responses", () => {
        expect(normalizeCheckpointCleanupResult({ removed: true })).toEqual({ removed: true });
        expect(normalizeCheckpointCleanupResult({ removed: "yes" })).toBeNull();
        expect(
            normalizeCheckpointRetention({
                maxRuns: 50,
                ttlDays: 30,
                unsealedNeverDeleted: true,
                currentRuns: 7,
                currentRefs: 13,
            }),
        ).toMatchObject({ maxRuns: 50, ttlDays: 30 });
    });
});

describe("workspace checkpoint API methods", () => {
    it("lists the workspace timeline", async () => {
        fetchSpy.mockResolvedValueOnce(jsonResponse([checkpoint()]));
        const list = await api.listWorkspaceCheckpoints(WORKSPACE_ID);
        expect(list[0].sliceRef).toBe(SLICE_REF);
        expect(fetchSpy).toHaveBeenCalledWith(
            `/api/v1/workspaces/${WORKSPACE_ID}/checkpoints`,
            expect.objectContaining({ headers: expect.any(Object) }),
        );
    });

    it("posts sliceRef for preview and restore", async () => {
        fetchSpy.mockResolvedValueOnce(
            jsonResponse({
                sliceRef: SLICE_REF,
                counts: { restore: 1, delete: 0, typeConflict: 0 },
                entries: [],
                truncated: false,
                opaqueNestedRepos: [],
            }),
        );
        await api.previewWorkspaceCheckpointRevert(WORKSPACE_ID, SLICE_REF);
        expect(fetchSpy).toHaveBeenLastCalledWith(
            `/api/v1/workspaces/${WORKSPACE_ID}/checkpoints/revert/preview`,
            expect.objectContaining({
                method: "POST",
                body: JSON.stringify({ sliceRef: SLICE_REF }),
            }),
        );
        fetchSpy.mockResolvedValueOnce(
            jsonResponse({
                sliceRef: SLICE_REF,
                counts: { restored: 1, deleted: 0, failed: 0 },
                entries: [],
                durationMs: 10,
                suspects: [],
            }),
        );
        await api.executeWorkspaceCheckpointRevert(WORKSPACE_ID, SLICE_REF, ["src/type-change.ts"]);
        expect(fetchSpy).toHaveBeenLastCalledWith(
            `/api/v1/workspaces/${WORKSPACE_ID}/checkpoints/revert`,
            expect.objectContaining({
                method: "POST",
                body: JSON.stringify({
                    sliceRef: SLICE_REF,
                    acknowledgeTypeChanges: ["src/type-change.ts"],
                }),
            }),
        );
    });

    it("reads a slice blob and performs explicit cleanup", async () => {
        fetchSpy.mockResolvedValueOnce(textResponse("line one\nline two"));
        await expect(
            api.getWorkspaceCheckpointBlob(WORKSPACE_ID, SLICE_REF, "src/a b.ts"),
        ).resolves.toBe("line one\nline two");
        expect(fetchSpy).toHaveBeenLastCalledWith(
            `/api/v1/workspaces/${WORKSPACE_ID}/checkpoints/blob?sliceRef=${encodeURIComponent(SLICE_REF)}&path=src%2Fa+b.ts`,
            expect.any(Object),
        );
        fetchSpy.mockResolvedValueOnce(jsonResponse({ removed: true }));
        await expect(api.cleanupWorkspaceCheckpoints(WORKSPACE_ID)).resolves.toEqual({
            removed: true,
        });
        expect(fetchSpy).toHaveBeenLastCalledWith(
            `/api/v1/workspaces/${WORKSPACE_ID}/checkpoints/cleanup`,
            expect.objectContaining({
                method: "POST",
                body: JSON.stringify({ acknowledge: true }),
            }),
        );
    });

    it("surfaces restore conflicts as ApiError", async () => {
        fetchSpy.mockResolvedValueOnce(
            jsonResponse(
                { status: 409, code: "CHECKPOINT_TYPE_CONFLICT", requestId: "req-1" },
                409,
            ),
        );
        await expect(
            api.executeWorkspaceCheckpointRevert(WORKSPACE_ID, SLICE_REF),
        ).rejects.toBeInstanceOf(ApiError);
    });
});
