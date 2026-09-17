import { describe, it, expect, beforeEach, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import { useCheckpointStore } from "../checkpoint";
import { ApiError, api } from "../../composables/api";
import type { WorkspaceCheckpoint } from "../../types";

const WORKSPACE_ID = "workspace-a";
const OTHER_WORKSPACE_ID = "workspace-b";
const RUN_ID = "run-a";
const SESSION_ID = "session-a";
const SLICE_REF = "refs/xihe/workspace/slice-a";

vi.mock("../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../composables/api")>();
    return { ...actual, api: { ...actual.api, listWorkspaceCheckpoints: vi.fn() } };
});
const mockedApi = vi.mocked(api);

function checkpoint(overrides: Partial<WorkspaceCheckpoint> = {}): WorkspaceCheckpoint {
    return {
        id: "checkpoint-a",
        sliceRef: SLICE_REF,
        capturedAt: "2026-09-15T10:00:00Z",
        sourceRunId: RUN_ID,
        sourceSessionId: SESSION_ID,
        predecessorRef: null,
        state: "captured",
        changedCount: 2,
        changedFiles: [{ status: "M", path: "src/a.ts" }],
        opaqueNestedRepos: [],
        unrollableReason: null,
        truncated: false,
        revert: null,
        ...overrides,
    };
}

beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
});

describe("workspace checkpoint events", () => {
    it("keeps lifecycle annotations by source run", () => {
        const store = useCheckpointStore();
        store.mergeEvent({
            runId: RUN_ID,
            sessionId: SESSION_ID,
            state: "captured",
            changedCount: 3,
            sliceRef: SLICE_REF,
        });
        expect(store.getEvent(RUN_ID)).toMatchObject({
            state: "captured",
            sliceRef: SLICE_REF,
            changedCount: 3,
        });
    });

    it("ignores a different session for an existing run event", () => {
        const store = useCheckpointStore();
        store.mergeEvent({
            runId: RUN_ID,
            sessionId: SESSION_ID,
            state: "captured",
            changedCount: 1,
        });
        store.mergeEvent({ runId: RUN_ID, sessionId: "other", state: "degraded", changedCount: 0 });
        expect(store.getEvent(RUN_ID)?.state).toBe("captured");
    });
});

describe("workspace checkpoint list fetch", () => {
    it("fetches and scopes the durable list by workspace", async () => {
        mockedApi.listWorkspaceCheckpoints.mockResolvedValueOnce([checkpoint()]);
        const store = useCheckpointStore();
        const records = await store.fetchWorkspaceCheckpoints(WORKSPACE_ID);
        expect(mockedApi.listWorkspaceCheckpoints).toHaveBeenCalledWith(WORKSPACE_ID);
        expect(records?.[0]).toMatchObject({ workspaceId: WORKSPACE_ID, sourceRunId: RUN_ID });
        expect(store.getForRun(WORKSPACE_ID, RUN_ID)?.sliceRef).toBe(SLICE_REF);
        expect(store.getForWorkspace(OTHER_WORKSPACE_ID)).toEqual([]);
    });

    it("caches and force refreshes a workspace list", async () => {
        mockedApi.listWorkspaceCheckpoints.mockResolvedValue([checkpoint()]);
        const store = useCheckpointStore();
        await store.fetchWorkspaceCheckpoints(WORKSPACE_ID);
        await store.fetchWorkspaceCheckpoints(WORKSPACE_ID);
        expect(mockedApi.listWorkspaceCheckpoints).toHaveBeenCalledTimes(1);
        await store.fetchWorkspaceCheckpoints(WORKSPACE_ID, { force: true });
        expect(mockedApi.listWorkspaceCheckpoints).toHaveBeenCalledTimes(2);
    });

    it("deduplicates concurrent list requests", async () => {
        let resolveList: ((value: WorkspaceCheckpoint[]) => void) | null = null;
        mockedApi.listWorkspaceCheckpoints.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveList = resolve;
                }),
        );
        const store = useCheckpointStore();
        const first = store.fetchWorkspaceCheckpoints(WORKSPACE_ID);
        const second = store.fetchWorkspaceCheckpoints(WORKSPACE_ID);
        await flushPromises();
        expect(mockedApi.listWorkspaceCheckpoints).toHaveBeenCalledTimes(1);
        resolveList?.([checkpoint()]);
        await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    });

    it("keeps a previous list annotated when refresh fails", async () => {
        mockedApi.listWorkspaceCheckpoints.mockResolvedValueOnce([checkpoint()]);
        const store = useCheckpointStore();
        await store.fetchWorkspaceCheckpoints(WORKSPACE_ID);
        mockedApi.listWorkspaceCheckpoints.mockRejectedValueOnce(
            new ApiError({ status: 503, code: "CHECKPOINT_UNAVAILABLE", requestId: "req-1" }),
        );
        const list = await store.fetchWorkspaceCheckpoints(WORKSPACE_ID, { force: true });
        expect(list?.[0].error).toContain("CHECKPOINT_UNAVAILABLE");
    });

    it("ignores a response that finishes after user switch", async () => {
        let resolveList: ((value: WorkspaceCheckpoint[]) => void) | null = null;
        mockedApi.listWorkspaceCheckpoints.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveList = resolve;
                }),
        );
        const store = useCheckpointStore();
        const pending = store.fetchWorkspaceCheckpoints(WORKSPACE_ID);
        await flushPromises();
        store.clearForUserSwitch();
        resolveList?.([checkpoint()]);
        await pending;
        expect(store.getForWorkspace(WORKSPACE_ID)).toEqual([]);
    });
});

describe("workspace checkpoint cleanup", () => {
    it("clears records and events on user switch", () => {
        const store = useCheckpointStore();
        store.mergeEvent({
            runId: RUN_ID,
            sessionId: SESSION_ID,
            state: "captured",
            changedCount: 1,
        });
        store.clearForUserSwitch();
        expect(store.getEvent(RUN_ID)).toBeUndefined();
        expect(store.records).toEqual({});
    });
});
