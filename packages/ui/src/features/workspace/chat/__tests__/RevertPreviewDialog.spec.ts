import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import RevertPreviewDialog from "../components/RevertPreviewDialog.vue";
import { ApiError, api } from "../../../../composables/api";
import type * as apiModule from "../../../../composables/api";
import type { CheckpointPreview } from "../../../../types";

const WORKSPACE_ID = "workspace-a",
    SLICE_REF = "refs/xihe/workspace/slice-a";
vi.mock("../../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof apiModule>();
    return {
        ...actual,
        api: {
            ...actual.api,
            previewWorkspaceCheckpointRevert: vi.fn<typeof api.previewWorkspaceCheckpointRevert>(),
        },
    };
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
                checkpointPreviewConcurrentWriteRisk: "Concurrent writes may be marked",
                checkpointPreviewOpaqueNestedRepos: "Opaque nested repositories",
                checkpointPreviewConfirm: "Execute restore",
                checkpointEntryRestore: "Restore",
                checkpointEntryDelete: "Delete",
                checkpointEntryNoop: "No action",
                checkpointEntryTypeConflict: "Type conflict",
                checkpointTypeConflictAck: "Confirm type changes",
                checkpointNestedRepoImpactTitle: "Nested impact",
                checkpointNestedRepoDirty: "Uncommitted changes",
                checkpointNestedRepoHeadMoved: "HEAD drifted",
                checkpointNestedRepoForceAck: "Force over their changes",
                checkpointNestedRepoDriftAck: "Acknowledge HEAD drift",
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
        opaqueNestedRepos: [],
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

    it("shows concurrent-write risk and opaque nested repositories", async () => {
        mockedApi.previewWorkspaceCheckpointRevert.mockResolvedValueOnce(
            preview({ opaqueNestedRepos: ["vendor/lib"] }),
        );
        const wrapper = mountDialog();
        await settle();
        expect(wrapper.find('[data-testid="revert-preview-concurrent-write-risk"]').exists()).toBe(
            true,
        );
        expect(wrapper.find('[data-testid="revert-preview-opaque-nested-repos"]').text()).toContain(
            "vendor/lib",
        );
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
        expect(wrapper.emitted("confirm")).toEqual([[["src/type.ts"], [], false]]);
    });

    it("gates a forced restore behind the dirty nested-repo confirmation", async () => {
        mockedApi.previewWorkspaceCheckpointRevert.mockResolvedValueOnce(
            preview({
                nestedRepoAffected: [
                    { repoPath: "vendor/lib", kind: "git", dirty: true, headMoved: false },
                ],
            }),
        );
        const wrapper = mountDialog();
        await settle();
        const block = wrapper.find('[data-testid="revert-preview-nested-repos"]');
        expect(block.exists()).toBe(true);
        expect(block.text()).toContain("vendor/lib");
        expect(wrapper.find('[data-testid="revert-preview-nested-repo-row"]').text()).toContain(
            "Uncommitted changes",
        );
        const confirm = wrapper.find('[data-testid="revert-preview-confirm"]');
        expect((confirm.element as HTMLButtonElement).disabled).toBe(true);
        await wrapper.find('[data-testid="revert-preview-nested-force-ack"]').setValue(true);
        await confirm.trigger("click");
        // dirty (not drifted) repos: force=true and no acknowledgement list
        expect(wrapper.emitted("confirm")).toEqual([[[], [], true]]);
    });

    it("requires acknowledging every head-drifted nested repo and sends the full list", async () => {
        mockedApi.previewWorkspaceCheckpointRevert.mockResolvedValueOnce(
            preview({
                nestedRepoAffected: [
                    { repoPath: "vendor/lib", kind: "git", dirty: false, headMoved: true },
                    { repoPath: "vendor/lib2", kind: "git", dirty: false, headMoved: true },
                ],
            }),
        );
        const wrapper = mountDialog();
        await settle();
        const confirm = wrapper.find('[data-testid="revert-preview-confirm"]');
        expect((confirm.element as HTMLButtonElement).disabled).toBe(true);
        await wrapper.find('[data-testid="revert-preview-nested-drift-ack"]').setValue(true);
        await confirm.trigger("click");
        // ruling (a): the acknowledgement covers every drifted repo, force stays false
        expect(wrapper.emitted("confirm")).toEqual([[[], ["vendor/lib", "vendor/lib2"], false]]);
    });

    it("hides the nested block when the preview reports no affected repositories", async () => {
        mockedApi.previewWorkspaceCheckpointRevert.mockResolvedValueOnce(preview());
        const wrapper = mountDialog();
        await settle();
        expect(wrapper.find('[data-testid="revert-preview-nested-repos"]').exists()).toBe(false);
        await wrapper.find('[data-testid="revert-preview-confirm"]').trigger("click");
        expect(wrapper.emitted("confirm")).toEqual([[[], [], false]]);
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
