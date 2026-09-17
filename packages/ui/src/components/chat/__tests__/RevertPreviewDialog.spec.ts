import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import RevertPreviewDialog from "../RevertPreviewDialog.vue";
import { ApiError, api } from "../../../composables/api";
import type { CheckpointPreview } from "../../../types";

const WORKSPACE_ID = "workspace-a";
const SLICE_REF = "refs/xihe/workspace/slice-a";
vi.mock("../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../composables/api")>();
    return { ...actual, api: { ...actual.api, previewWorkspaceCheckpointRevert: vi.fn() } };
});
const mockedApi = vi.mocked(api);
const i18n = createI18n({
    legacy: false,
    locale: "en-US",
    messages: {
        "en-US": {
            common: { cancel: "Cancel", close: "Close" },
            chat: {
                checkpointPreviewTitle: "Restore to this slice",
                checkpointPreviewDescription: "Preview",
                checkpointPreviewLoading: "Loading",
                checkpointPreviewFailed: "Preview failed",
                checkpointPreviewRetry: "Retry",
                checkpointPreviewRestore: "Will restore",
                checkpointPreviewDelete: "Will delete",
                checkpointPreviewTypeConflict: "Type changes",
                checkpointPreviewTypeConflictIncomplete: "Incomplete",
                checkpointPreviewPathsTitle: "Paths",
                checkpointPreviewExpand: "Show all",
                checkpointPreviewCollapse: "Collapse",
                checkpointPreviewTruncated: "Truncated",
                checkpointPreviewNoEntries: "No paths",
                checkpointPreviewConfirm: "Execute restore",
                checkpointEntryRestore: "Restore",
                checkpointEntryDelete: "Delete",
                checkpointEntryNoop: "No action",
                checkpointEntryTypeConflict: "Type conflict",
                checkpointTypeConflictAck: "Confirm type changes",
            },
        },
    },
});

function preview(overrides: Partial<CheckpointPreview> = {}): CheckpointPreview {
    return {
        sliceRef: SLICE_REF,
        counts: { restore: 2, delete: 1, typeConflict: 0 },
        entries: [
            { path: "src/a.ts", action: "restore", state: "execute" },
            { path: "src/gone.ts", action: "delete", state: "execute" },
        ],
        truncated: false,
        ...overrides,
    };
}
function mountDialog(props: { show?: boolean; busy?: boolean; error?: string | null } = {}) {
    return mount(RevertPreviewDialog, {
        props: { show: true, workspaceId: WORKSPACE_ID, sliceRef: SLICE_REF, ...props },
        global: { plugins: [i18n] },
    });
}
async function settle() {
    await Promise.resolve();
    await Promise.resolve();
}
beforeEach(() => vi.clearAllMocks());

describe("RevertPreviewDialog", () => {
    it("loads a workspace slice preview and renders all counts", async () => {
        mockedApi.previewWorkspaceCheckpointRevert.mockResolvedValueOnce(preview());
        const wrapper = mountDialog();
        await settle();
        expect(mockedApi.previewWorkspaceCheckpointRevert).toHaveBeenCalledWith(
            WORKSPACE_ID,
            SLICE_REF,
        );
        expect(wrapper.find('[data-testid="revert-preview-restore-count"]').text()).toBe("2");
        expect(wrapper.find('[data-testid="revert-preview-delete-count"]').text()).toBe("1");
        expect(wrapper.find('[data-testid="revert-preview-type-conflict-count"]').text()).toBe("0");
    });

    it("requires and emits only type-change path confirmations", async () => {
        mockedApi.previewWorkspaceCheckpointRevert.mockResolvedValueOnce(
            preview({
                counts: { restore: 1, delete: 0, typeConflict: 1 },
                entries: [
                    {
                        path: "src/type.ts",
                        action: "restore",
                        state: "type_conflict",
                        reason: "TYPE_CHANGED",
                    },
                ],
            }),
        );
        const wrapper = mountDialog();
        await settle();
        const confirm = wrapper.find('[data-testid="revert-preview-confirm"]');
        expect((confirm.element as HTMLButtonElement).disabled).toBe(true);
        await wrapper.find('[data-testid="revert-preview-type-conflict-ack"]').setValue(true);
        await confirm.trigger("click");
        expect(wrapper.emitted("confirm")).toEqual([[["src/type.ts"]]]);
    });

    it("shows entry state and supports a deterministic retry", async () => {
        mockedApi.previewWorkspaceCheckpointRevert.mockRejectedValueOnce(
            new ApiError({ status: 503, code: "CHECKPOINT_UNAVAILABLE", requestId: "req-1" }),
        );
        const wrapper = mountDialog();
        await settle();
        expect(wrapper.find('[data-testid="revert-preview-error"]').text()).toContain(
            "CHECKPOINT_UNAVAILABLE",
        );
        mockedApi.previewWorkspaceCheckpointRevert.mockResolvedValueOnce(
            preview({ entries: [{ path: "a.ts", action: "restore", state: "noop" }] }),
        );
        await wrapper.find('[data-testid="revert-preview-retry"]').trigger("click");
        await settle();
        expect(wrapper.find('[data-testid="revert-preview-entry-state"]').text()).toContain(
            "No action",
        );
    });
});
