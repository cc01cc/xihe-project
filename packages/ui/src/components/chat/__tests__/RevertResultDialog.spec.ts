import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import RevertResultDialog from "../RevertResultDialog.vue";
import { api } from "../../../composables/api";
import type { CheckpointResult } from "../../../types";

const WORKSPACE_ID = "workspace-a";
const SLICE_REF = "refs/xihe/workspace/slice-a";
vi.mock("../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../composables/api")>();
    return {
        ...actual,
        api: { ...actual.api, getWorkspaceCheckpointBlob: vi.fn(), readFile: vi.fn() },
    };
});
const mockedApi = vi.mocked(api);
const i18n = createI18n({
    legacy: false,
    locale: "en-US",
    messages: {
        "en-US": {
            common: { close: "Close" },
            chat: {
                checkpointResultTitle: "Restore result",
                checkpointResultDescription: "Outcomes",
                checkpointResultRestored: "Restored",
                checkpointResultDeleted: "Deleted",
                checkpointResultFailed: "Failed",
                checkpointResultSuspect: "Suspect",
                checkpointResultPartial: "Partial restore",
                checkpointResultViewDiff: "View diff",
                checkpointResultDiffLoading: "Loading diff",
                checkpointResultDiffFailed: "Diff failed",
                checkpointResultDiffSlice: "slice content",
                checkpointResultDiffTruncated: "Truncated",
                checkpointResultSliceRef: "Slice ref",
                checkpointResultDuration: "Duration",
                checkpointResultRetry: "Retry",
                checkpointResultDismiss: "Dismiss",
            },
        },
    },
});

function result(overrides: Partial<CheckpointResult> = {}): CheckpointResult {
    return {
        sliceRef: SLICE_REF,
        counts: { restored: 1, deleted: 1, failed: 1 },
        entries: [
            { path: "src/a.ts", outcome: "restored" },
            { path: "src/gone.ts", outcome: "deleted" },
            { path: "src/broken.ts", outcome: "failed", reason: "WRITE_FAILED" },
            { path: "src/suspect.ts", outcome: "suspect", reason: "CONCURRENT_WRITE" },
        ],
        durationMs: 42,
        suspects: ["src/suspect.ts"],
        ...overrides,
    };
}

function mountDialog(overrides: { show?: boolean; result?: CheckpointResult | null } = {}) {
    return mount(RevertResultDialog, {
        props: { show: true, workspaceId: WORKSPACE_ID, result: result(), ...overrides },
        global: { plugins: [i18n] },
    });
}
async function settle() {
    await Promise.resolve();
    await Promise.resolve();
}
beforeEach(() => vi.clearAllMocks());

describe("RevertResultDialog", () => {
    it("groups all result outcomes and renders suspects", () => {
        const wrapper = mountDialog();
        expect(wrapper.find('[data-testid="revert-result-group-restored"]').text()).toContain(
            "src/a.ts",
        );
        expect(wrapper.find('[data-testid="revert-result-group-deleted"]').text()).toContain(
            "src/gone.ts",
        );
        expect(wrapper.find('[data-testid="revert-result-group-failed"]').text()).toContain(
            "src/broken.ts",
        );
        expect(wrapper.find('[data-testid="revert-result-group-suspect"]').text()).toContain(
            "src/suspect.ts",
        );
        expect(wrapper.find('[data-testid="revert-result-suspects"]').text()).toContain(
            "src/suspect.ts",
        );
        expect(wrapper.find('[data-testid="revert-result-ref"]').text()).toContain(SLICE_REF);
    });

    it("offers retry for failed outcomes", async () => {
        const wrapper = mountDialog();
        await wrapper.find('[data-testid="revert-result-retry"]').trigger("click");
        expect(wrapper.emitted("retry")).toEqual([[SLICE_REF]]);
    });

    it("loads slice blob and current content for inline diff", async () => {
        mockedApi.getWorkspaceCheckpointBlob.mockResolvedValueOnce("line one\nold line\n");
        mockedApi.readFile.mockResolvedValueOnce({ content: "line one\nnew line\n" });
        const wrapper = mountDialog();
        await wrapper.find('[data-testid="revert-result-diff-src/broken.ts"]').trigger("click");
        await settle();
        expect(mockedApi.getWorkspaceCheckpointBlob).toHaveBeenCalledWith(
            WORKSPACE_ID,
            SLICE_REF,
            "src/broken.ts",
        );
        expect(mockedApi.readFile).toHaveBeenCalledWith("src/broken.ts", WORKSPACE_ID);
        expect(wrapper.find('[data-testid="revert-result-diff-rows"]').text()).toContain(
            "new line",
        );
    });
});
