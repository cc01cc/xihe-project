import { describe, it, expect, beforeEach, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import { createI18n } from "vue-i18n";
import WorkspaceChangesPanel from "../workspace/WorkspaceChangesPanel.vue";
import { ApiError, api } from "../../composables/api";
import type { WorkspaceCheckpoint, WorkspaceGitStatus } from "../../types";

const WORKSPACE_ID = "workspace-a";
const SLICE_REF = "refs/xihe/workspace/slice-a";
vi.mock("../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../composables/api")>();
    return {
        ...actual,
        api: {
            ...actual.api,
            listWorkspaceCheckpoints: vi.fn(),
            getWorkspaceGitStatus: vi.fn(),
            previewWorkspaceCheckpointRevert: vi.fn(),
            executeWorkspaceCheckpointRevert: vi.fn(),
        },
    };
});
const mockedApi = vi.mocked(api, true);
const i18n = createI18n({
    legacy: false,
    locale: "en",
    messages: {
        en: {
            common: { cancel: "Cancel", close: "Close" },
            workspace: {
                diffTabTimeline: "Slice timeline",
                diffTabPending: "Pending commit",
                diffDifferenceNote: "The lists are never merged.",
                diffPendingLoading: "Reading git status…",
                diffPendingLoadFailed: "Failed to load pending status",
                diffPendingRetry: "Retry",
                diffPendingNoRepo: "No pending-commit view",
                diffPendingEmpty: "Nothing pending",
                diffPendingCountUnit: "file(s)",
                diffRefresh: "Refresh",
                closePanel: "Close",
                checkpointTimelineLoading: "Loading timeline",
                checkpointTimelineEmpty: "No slices",
                checkpointTimeUnknown: "Time unknown",
                checkpointSourceUnknown: "Unknown source",
                checkpointOpaqueRepos: "Nested repositories",
                checkpointTruncated: "Truncated",
                checkpointFilesTruncated: "File list incomplete",
                checkpointRestore: "Restore to slice",
                checkpointState: {
                    captured: "Captured",
                    "abnormal-captured": "Abnormal capture",
                    degraded: "Degraded",
                    expired: "Expired",
                },
                diffRunChangedUnit: "file(s)",
            },
        },
    },
});
function checkpoint(overrides: Partial<WorkspaceCheckpoint> = {}): WorkspaceCheckpoint {
    return {
        id: "checkpoint-a",
        sliceRef: SLICE_REF,
        capturedAt: "2026-09-15T10:00:00Z",
        sourceRunId: "run-a",
        sourceSessionId: "session-a",
        predecessorRef: null,
        state: "captured",
        changedCount: 2,
        changedFiles: [
            { status: "M", path: "src/parser.ts" },
            { status: "A", path: "src/index.ts" },
        ],
        opaqueNestedRepos: ["vendor/lib"],
        unrollableReason: null,
        truncated: false,
        revert: null,
        ...overrides,
    };
}
function mountPanel() {
    return mount(WorkspaceChangesPanel, {
        props: { workspaceId: WORKSPACE_ID },
        global: { plugins: [i18n] },
    });
}
async function settle() {
    await flushPromises();
    await flushPromises();
}
beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    mockedApi.listWorkspaceCheckpoints.mockResolvedValue([checkpoint()]);
    mockedApi.getWorkspaceGitStatus.mockResolvedValue({
        isRepository: true,
        entries: [{ status: "M", path: "README.md" }],
    } satisfies WorkspaceGitStatus);
});

describe("WorkspaceChangesPanel slice timeline", () => {
    it("renders a timeline separately from pending status", async () => {
        const wrapper = mountPanel();
        await settle();
        await wrapper
            .find('[data-testid="workspace-checkpoint-select-checkpoint-a"]')
            .trigger("click");
        expect(mockedApi.listWorkspaceCheckpoints).toHaveBeenCalledWith(WORKSPACE_ID);
        expect(wrapper.find('[data-testid="workspace-diff-tab-timeline"]').text()).toBe(
            "Slice timeline",
        );
        expect(wrapper.find('[data-testid="workspace-checkpoint-timeline"]').text()).toContain(
            "src/parser.ts",
        );
        expect(wrapper.find('[data-testid="workspace-diff-pending-list"]').exists()).toBe(false);
    });

    it("shows source metadata, nested repositories and truncation", async () => {
        mockedApi.listWorkspaceCheckpoints.mockResolvedValueOnce([checkpoint({ truncated: true })]);
        const wrapper = mountPanel();
        await settle();
        await wrapper
            .find('[data-testid="workspace-checkpoint-select-checkpoint-a"]')
            .trigger("click");
        expect(wrapper.find('[data-testid="workspace-checkpoint-slice-details"]').text()).toContain(
            "vendor/lib",
        );
        expect(wrapper.find('[data-checkpoint-state="captured"]').exists()).toBe(true);
    });

    it("opens the workspace+sliceRef restore flow", async () => {
        mockedApi.previewWorkspaceCheckpointRevert.mockResolvedValue({
            sliceRef: SLICE_REF,
            counts: { restore: 1, delete: 0, typeConflict: 0 },
            entries: [],
            truncated: false,
        });
        const wrapper = mountPanel();
        await settle();
        await wrapper
            .find('[data-testid="workspace-checkpoint-select-checkpoint-a"]')
            .trigger("click");
        await wrapper.find('[data-testid="workspace-checkpoint-restore"]').trigger("click");
        await settle();
        expect(mockedApi.previewWorkspaceCheckpointRevert).toHaveBeenCalledWith(
            WORKSPACE_ID,
            SLICE_REF,
        );
    });

    it("renders degraded cards without restore actions", async () => {
        mockedApi.listWorkspaceCheckpoints.mockResolvedValueOnce([
            checkpoint({
                state: "degraded",
                sliceRef: null,
                changedCount: 0,
                changedFiles: [],
                unrollableReason: "GIT_UNAVAILABLE",
            }),
        ]);
        const wrapper = mountPanel();
        await settle();
        await wrapper
            .find('[data-testid="workspace-checkpoint-select-checkpoint-a"]')
            .trigger("click");
        expect(wrapper.find('[data-testid="workspace-checkpoint-restore"]').exists()).toBe(false);
        expect(wrapper.text()).toContain("GIT_UNAVAILABLE");
    });

    it("keeps pending entries on the second tab", async () => {
        mockedApi.getWorkspaceGitStatus.mockResolvedValueOnce({
            isRepository: true,
            entries: [{ status: "??", path: "notes/draft.md" }],
        });
        const wrapper = mountPanel();
        await settle();
        await wrapper.find('[data-testid="workspace-diff-tab-pending"]').trigger("click");
        expect(wrapper.find('[data-testid="workspace-diff-pending-list"]').text()).toContain(
            "notes/draft.md",
        );
        expect(wrapper.find('[data-testid="workspace-diff-pending-list"]').text()).not.toContain(
            "src/index.ts",
        );
    });

    it("shows timeline failure and can close", async () => {
        mockedApi.listWorkspaceCheckpoints.mockRejectedValueOnce(
            new ApiError({ status: 503, code: "CHECKPOINT_UNAVAILABLE", requestId: "req-1" }),
        );
        const wrapper = mountPanel();
        await settle();
        expect(
            wrapper.find('[data-testid="workspace-checkpoint-timeline-error"]').text(),
        ).toContain("CHECKPOINT_UNAVAILABLE");
        await wrapper.find('[data-testid="workspace-changes-close"]').trigger("click");
        expect(wrapper.emitted("close")).toHaveLength(1);
    });
});
