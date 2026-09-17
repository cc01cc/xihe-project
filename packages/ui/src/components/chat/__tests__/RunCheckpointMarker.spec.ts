import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import { createI18n } from "vue-i18n";
import RunCheckpointMarker from "../RunCheckpointMarker.vue";
import { api } from "../../../composables/api";
import { useCheckpointStore } from "../../../stores/checkpoint";

const WORKSPACE_ID = "workspace-a";
const RUN_ID = "run-a";
const SESSION_ID = "session-a";
const SLICE_REF = "refs/xihe/workspace/slice-a";
vi.mock("../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../composables/api")>();
    return { ...actual, api: { ...actual.api, listWorkspaceCheckpoints: vi.fn() } };
});
const mockedApi = vi.mocked(api);
const i18n = createI18n({
    legacy: false,
    locale: "en",
    messages: {
        en: {
            chat: {
                checkpointMarkerChangedPrefix: "This slice changed",
                checkpointMarkerChangedUnit: "file(s)",
                checkpointMarkerRollbackable: "restore available",
                checkpointMarkerRevertEntry: "Restore",
                checkpointMarkerReverted: "Restored",
                checkpointCountRestored: "restored",
                checkpointCountDeleted: "deleted",
                checkpointCountFailed: "failed",
                checkpointReasonUnavailable: "Unavailable",
                checkpointReasonGitUnavailable: "Git unavailable",
                checkpointReasonGitTooOld: "Git too old",
                checkpointReasonGitFailed: "Git failed",
                checkpointReasonWorkspaceUnknown: "Workspace unknown",
                checkpointReasonExpired: "Expired",
                checkpointMarkerUnrollable: "Unavailable",
                checkpointMarkerNoSnapshot: "No slice",
            },
        },
    },
});

function mountMarker() {
    return mount(RunCheckpointMarker, {
        props: { runId: RUN_ID, sessionId: SESSION_ID },
        global: {
            plugins: [i18n],
            stubs: { ArchiveRestore: true, CircleAlert: true, Clock: true, RotateCcw: true },
        },
    });
}
function checkpoint(overrides: Record<string, unknown> = {}) {
    return {
        id: "checkpoint-a",
        sliceRef: SLICE_REF,
        capturedAt: "2026-09-15T10:00:00Z",
        sourceRunId: RUN_ID,
        sourceSessionId: SESSION_ID,
        predecessorRef: null,
        state: "captured",
        changedCount: 3,
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
    mockedApi.listWorkspaceCheckpoints.mockResolvedValue([]);
    localStorage.setItem("xihe-user", JSON.stringify({ id: "user-a", workspaceId: WORKSPACE_ID }));
    localStorage.setItem(
        "xihe-workspace",
        JSON.stringify({ id: WORKSPACE_ID, name: "Workspace A" }),
    );
});

describe("RunCheckpointMarker", () => {
    it("renders a captured slice marker with restore entry", () => {
        useCheckpointStore().mergeEvent({
            runId: RUN_ID,
            sessionId: SESSION_ID,
            state: "captured",
            changedCount: 3,
            sliceRef: SLICE_REF,
        });
        const wrapper = mountMarker();
        expect(
            wrapper
                .find('[data-testid="run-checkpoint-marker"]')
                .attributes("data-checkpoint-kind"),
        ).toBe("captured");
        expect(wrapper.find('[data-testid="run-checkpoint-revert-entry"]').exists()).toBe(true);
    });

    it("emits the opaque sliceRef", async () => {
        useCheckpointStore().mergeEvent({
            runId: RUN_ID,
            sessionId: SESSION_ID,
            state: "captured",
            changedCount: 1,
            sliceRef: SLICE_REF,
        });
        const wrapper = mountMarker();
        await wrapper.find('[data-testid="run-checkpoint-revert-entry"]').trigger("click");
        expect(wrapper.emitted("revert")).toEqual([[SLICE_REF]]);
    });

    it("renders degraded state without restore", () => {
        useCheckpointStore().mergeEvent({
            runId: RUN_ID,
            sessionId: SESSION_ID,
            state: "degraded",
            changedCount: 0,
            unrollableReason: "GIT_UNAVAILABLE",
        });
        const wrapper = mountMarker();
        expect(
            wrapper
                .find('[data-testid="run-checkpoint-marker"]')
                .attributes("data-checkpoint-kind"),
        ).toBe("degraded");
        expect(wrapper.find('[data-testid="run-checkpoint-revert-entry"]').exists()).toBe(false);
    });

    it("loads the workspace list when context is known", async () => {
        mockedApi.listWorkspaceCheckpoints.mockResolvedValueOnce([checkpoint()]);
        const wrapper = mountMarker();
        await wrapper.vm.$nextTick();
        await Promise.resolve();
        await wrapper.vm.$nextTick();
        expect(mockedApi.listWorkspaceCheckpoints).toHaveBeenCalledWith(WORKSPACE_ID);
        expect(wrapper.find('[data-testid="run-checkpoint-marker"]').exists()).toBe(true);
    });
});
