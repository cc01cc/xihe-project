import { describe, it, expect, beforeEach, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import { createI18n } from "vue-i18n";
import WorkspaceChangesPanel from "../components/WorkspaceChangesPanel.vue";
import { ApiError, api } from "../../../composables/api";
import type * as apiModule from "../../../composables/api";
import type { WorkspaceCheckpoint, WorkspaceGitStatus } from "../../../types";

const WORKSPACE_ID = "workspace-a",
    SLICE_REF = "refs/xihe/workspace/slice-a";
vi.mock("../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof apiModule>();
    return {
        ...actual,
        api: {
            ...actual.api,
            listWorkspaceCheckpoints: vi.fn<typeof apiModule.api.listWorkspaceCheckpoints>(),
            getWorkspaceGitStatus: vi.fn<typeof apiModule.api.getWorkspaceGitStatus>(),
            previewWorkspaceCheckpointRevert:
                vi.fn<typeof apiModule.api.previewWorkspaceCheckpointRevert>(),
            executeWorkspaceCheckpointRevert:
                vi.fn<typeof apiModule.api.executeWorkspaceCheckpointRevert>(),
        },
    };
});
const mockedApi = vi.mocked(api, true),
    i18n = createI18n({
        legacy: false,
        locale: "en",
        messages: {
            en: {
                common: { cancel: "Cancel", close: "Close" },
                chat: {
                    checkpointReasonUnavailable: "Unavailable",
                    checkpointReasonGitUnavailable: "Git unavailable",
                    checkpointReasonGitTooOld: "Git too old",
                    checkpointReasonGitFailed: "Git failed",
                    checkpointReasonWorkspaceUnknown: "Workspace unknown",
                    checkpointReasonNestedRepoLimit: "Nested repo limit",
                    checkpointReasonInvalidRequest: "Invalid request",
                    checkpointReasonExpired: "Expired",
                },
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
                errors: {
                    errorCodeLabel: "Error code",
                    technicalDetail: "Technical details",
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
        const reason = wrapper.find('[data-testid="workspace-checkpoint-reason"]');
        expect(reason.text()).toBe("Git unavailable");
        expect(reason.attributes("title")).toBeUndefined();
    });

    it("uses a generic label and keeps an unknown reason in title", async () => {
        mockedApi.listWorkspaceCheckpoints.mockResolvedValueOnce([
            checkpoint({
                state: "degraded",
                sliceRef: null,
                changedCount: 0,
                changedFiles: [],
                unrollableReason: "FUTURE_REASON",
            }),
        ]);
        const wrapper = mountPanel();
        await settle();
        await wrapper
            .find('[data-testid="workspace-checkpoint-select-checkpoint-a"]')
            .trigger("click");
        const reason = wrapper.find('[data-testid="workspace-checkpoint-reason"]');
        expect(reason.text()).toBe("Unavailable");
        expect(reason.text()).not.toContain("FUTURE_REASON");
        expect(reason.attributes("title")).toBe("FUTURE_REASON");
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
        // task-175 D：诊断面三件事齐判（task-45/task-78 判据）——
        // ① 可读文案在；② copy 不含错误码、不含 API error N（禁止把码拼进文案）；
        // ③ 码在专用可选中 code 元素里（诊断面给码，task-78 同款）。裁 ②（总账 §十四 `fc327a318`）：码进折叠区 ⇒ 折叠态不渲染码节点，展开后出现且可复制（机器判据同 task-61）。
        const error = wrapper.find('[data-testid="workspace-checkpoint-timeline-error"]');
        expect(error.exists()).toBe(true);
        const copy = wrapper.find('[data-testid="workspace-checkpoint-timeline-error-copy"]');
        expect(copy.text()).not.toBe("");
        expect(copy.text()).not.toContain("CHECKPOINT_UNAVAILABLE");
        expect(copy.text()).not.toMatch(/API error \d+/);
        expect(
            wrapper.find('[data-testid="workspace-checkpoint-timeline-error-code-value"]').exists(),
        ).toBe(false);
        wrapper
            .get('[data-testid="workspace-checkpoint-timeline-error-detail-toggle"]')
            .trigger("click");
        await settle();
        const codeValue = wrapper.find(
            '[data-testid="workspace-checkpoint-timeline-error-code-value"]',
        );
        expect(codeValue.text()).toBe("CHECKPOINT_UNAVAILABLE");
        expect(codeValue.classes()).toContain("select-all");
        await wrapper.find('[data-testid="workspace-changes-close"]').trigger("click");
        expect(wrapper.emitted("close")).toHaveLength(1);
    });

    /**
     * task-69 A：pending 这块原先**整块没有码元素**（v-if 只看 technicalDetail），而它的 copy 会落到
     * `errors.unknownCode` ⇒ 裁 ② 的文案「展开技术详情，把其中的错误码报给管理员」在这条面上落空。
     * 判据照 task-61 那一套（Lead 裁 ② 指定的机器判据，不另造）：折叠态码节点未渲染 → click + flush
     * → 码出现、是 <code>、带 select-all；正文仍不含码、不含客户端兜底 detail。
     */
    it("pending 错误面在折叠区里给出可复制的码（折叠态取不到，展开后取得到）", async () => {
        mockedApi.getWorkspaceGitStatus.mockRejectedValueOnce(
            new ApiError({
                status: 500,
                code: "GIT_PENDING_UNAVAILABLE",
                detail: "API error 500",
                requestId: "req-pending-1",
            }),
        );
        const wrapper = mountPanel();
        await settle();
        await wrapper.find('[data-testid="workspace-diff-tab-pending"]').trigger("click");

        expect(wrapper.find('[data-testid="workspace-diff-pending-error"]').exists()).toBe(true);
        const copy = wrapper.find('[data-testid="workspace-diff-pending-error-copy"]');
        expect(copy.text()).not.toBe("");
        expect(copy.text()).not.toContain("GIT_PENDING_UNAVAILABLE");
        expect(copy.text()).not.toMatch(/API error \d+/);

        // 折叠态：码与 detail 都不挂载（v-if，不是 display:none）。
        expect(
            wrapper.find('[data-testid="workspace-diff-pending-error-code-value"]').exists(),
        ).toBe(false);
        expect(
            wrapper.find('[data-testid="workspace-diff-pending-error-detail-body"]').exists(),
        ).toBe(false);

        await wrapper
            .get('[data-testid="workspace-diff-pending-error-detail-toggle"]')
            .trigger("click");
        await settle();
        const codeValue = wrapper.get('[data-testid="workspace-diff-pending-error-code-value"]');
        expect(codeValue.text()).toBe("GIT_PENDING_UNAVAILABLE");
        expect(codeValue.element.tagName).toBe("CODE");
        expect(codeValue.classes()).toContain("select-all");
        expect(wrapper.get('[data-testid="workspace-diff-pending-error-code"]').text()).toContain(
            i18n.global.t("errors.errorCodeLabel"),
        );
        expect(wrapper.get('[data-testid="workspace-diff-pending-error-detail-body"]').text()).toBe(
            "API error 500",
        );
        // 诊断面第三件：下一步动作必须在（重试入口），否则文案只是把人引到一个死路上。
        expect(wrapper.find('[data-testid="workspace-diff-pending-retry"]').exists()).toBe(true);
    });

    /**
     * 两格判据之一：**只有码**时折叠区必须渲染 —— 码进折叠区后，触发器就是码唯一的落脚处。
     * detail 为空 ⇒ 区内不出现 detail 节点（不为空壳渲染隐藏节点）。
     */
    it("pending 面只有码、没有 detail 时仍渲染诊断区", async () => {
        mockedApi.getWorkspaceGitStatus.mockRejectedValueOnce(
            new ApiError({
                status: 500,
                code: "GIT_PENDING_UNAVAILABLE",
                detail: "",
                requestId: "r",
            }),
        );
        const wrapper = mountPanel();
        await settle();
        await wrapper.find('[data-testid="workspace-diff-tab-pending"]').trigger("click");

        expect(
            wrapper.find('[data-testid="workspace-diff-pending-error-detail-toggle"]').exists(),
        ).toBe(true);
        expect(
            wrapper.find('[data-testid="workspace-diff-pending-error-code-value"]').exists(),
        ).toBe(false);
        await wrapper
            .get('[data-testid="workspace-diff-pending-error-detail-toggle"]')
            .trigger("click");
        await settle();
        expect(wrapper.get('[data-testid="workspace-diff-pending-error-code-value"]').text()).toBe(
            "GIT_PENDING_UNAVAILABLE",
        );
        expect(
            wrapper.find('[data-testid="workspace-diff-pending-error-detail-body"]').exists(),
        ).toBe(false);
    });

    /**
     * 两格判据之二：**码与 detail 都取不到 ⇒ 不渲染空折叠区**（否则就是一个点开什么都没有的触发器）。
     * 可达路径 = 非 ApiError 的 cause：presentError 走 fallback 且 code/technicalDetail 双 null
     * （src/lib/errorMessages.ts:224-230）。
     */
    it("pending 面码与 detail 双无时不渲染空折叠区", async () => {
        mockedApi.getWorkspaceGitStatus.mockRejectedValueOnce(new Error("network down"));
        const wrapper = mountPanel();
        await settle();
        await wrapper.find('[data-testid="workspace-diff-tab-pending"]').trigger("click");

        const copy = wrapper.find('[data-testid="workspace-diff-pending-error-copy"]');
        expect(copy.text()).toBe(i18n.global.t("workspace.diffPendingLoadFailed"));
        expect(
            wrapper.find('[data-testid="workspace-diff-pending-error-detail-toggle"]').exists(),
        ).toBe(false);
    });
});
