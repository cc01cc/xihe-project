import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { i18n } from "../../../../i18n";
import type * as apiModule from "../../../../composables/api";
import { ApiError, api } from "../../../../composables/api";
import WorkspaceChangesPanel from "../WorkspaceChangesPanel.vue";

/**
 * task-45：变更面板是**持久在屏的错误条**（不是 toast），所以它的形态是
 * 「可读文案 + 默认折叠的技术详情」。
 *
 * <p>这个组件此前零单测覆盖，而它正是本卡改动里最容易被回退的一处：
 * 只要有人把 `timelineError.copy` 改回 `timelineError`，界面就会重新出现
 * `AUDIT_ERROR: API error 500` 那种「英文码 + 英文兜底」（DEV-011 禁止）。</p>
 *
 * <p>三条判据刻意窄：①错误条渲染出来 ②主文案不含英文 detail 与码 ③展开折叠区能拿到原文。</p>
 */

vi.mock("../../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof apiModule>();
    return {
        ...actual,
        api: {
            ...actual.api,
            listWorkspaceCheckpoints: vi.fn<typeof apiModule.api.listWorkspaceCheckpoints>(),
            getWorkspaceGitStatus: vi.fn<typeof apiModule.api.getWorkspaceGitStatus>(),
        },
    };
});

const mockedApi = vi.mocked(api, true),
    WORKSPACE_ID = "77777777-7777-4777-8777-777777777777";

describe("WorkspaceChangesPanel 错误面（task-45）", () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        vi.clearAllMocks();
        mockedApi.getWorkspaceGitStatus.mockRejectedValue(new Error("pending tab offline"));
    });

    it("未知码 + 客户端兜底英文 detail 不直出，原文收进默认折叠的技术详情", async () => {
        // 与 batch-2 实拍同形：码是后端没有的码，detail 是 api.ts 的客户端兜底串。
        mockedApi.listWorkspaceCheckpoints.mockRejectedValue(
            new ApiError({
                status: 503,
                code: "CHECKPOINT_UNAVAILABLE",
                detail: "API error 503",
                requestId: "test",
            }),
        );
        const wrapper = mount(WorkspaceChangesPanel, {
            props: { workspaceId: WORKSPACE_ID },
            global: { plugins: [i18n] },
        });
        await flushPromises();

        const copy = wrapper.get('[data-testid="workspace-checkpoint-timeline-error-copy"]');
        expect(copy.text()).not.toMatch(/API error \d+/);
        expect(copy.text()).not.toContain("CHECKPOINT_UNAVAILABLE");
        expect(copy.text()).toBe(i18n.global.t("errors.unknownCode"));

        const toggle = wrapper.get(
            '[data-testid="workspace-checkpoint-timeline-error-detail-toggle"]',
        );
        expect(toggle.text()).toBe(i18n.global.t("errors.technicalDetail"));
        // 裁 ②（总账 §十四 `fc327a318`）：码进折叠区 ⇒ 折叠态不渲染码节点，展开后出现且可复制（机器判据同 task-61）。：折叠态码节点与 detail 节点都不渲染。
        expect(
            wrapper.find('[data-testid="workspace-checkpoint-timeline-error-code-value"]').exists(),
        ).toBe(false);
        expect(
            wrapper
                .find('[data-testid="workspace-checkpoint-timeline-error-detail-body"]')
                .exists(),
        ).toBe(false);

        await toggle.trigger("click");
        await flushPromises();
        expect(
            wrapper.get('[data-testid="workspace-checkpoint-timeline-error-detail-body"]').text(),
        ).toBe("API error 503");
        expect(
            wrapper.get('[data-testid="workspace-checkpoint-timeline-error-code-value"]').text(),
        ).toBe("CHECKPOINT_UNAVAILABLE");
    });

    /**
     * 裁 ② 后的「空壳」判据换了轴：折叠区的 `v-if` 是 `code || technicalDetail` ——
     * **只有码**时折叠区必须渲染（否则码就没有落脚处），**两者都无**时才不渲染空壳。
     * 两档分开钉，别只留旧的那半（旧断言是「没有 detail ⇒ 没有触发器」，裁 ② 后它就是错的）。
     */
    it("只有码、没有 detail 时仍渲染诊断区，但折叠态不渲染码节点", async () => {
        mockedApi.listWorkspaceCheckpoints.mockRejectedValue(
            new ApiError({ status: 503, code: "CHECKPOINT_UNAVAILABLE", requestId: "test" }),
        );
        const wrapper = mount(WorkspaceChangesPanel, {
            props: { workspaceId: WORKSPACE_ID },
            global: { plugins: [i18n] },
        });
        await flushPromises();

        expect(
            wrapper.find('[data-testid="workspace-checkpoint-timeline-error-copy"]').exists(),
        ).toBe(true);
        expect(
            wrapper
                .find('[data-testid="workspace-checkpoint-timeline-error-detail-toggle"]')
                .exists(),
        ).toBe(true);
        expect(
            wrapper.find('[data-testid="workspace-checkpoint-timeline-error-code-value"]').exists(),
        ).toBe(false);
        wrapper
            .get('[data-testid="workspace-checkpoint-timeline-error-detail-toggle"]')
            .trigger("click");
        await flushPromises();
        expect(
            wrapper.get('[data-testid="workspace-checkpoint-timeline-error-code-value"]').text(),
        ).toBe("CHECKPOINT_UNAVAILABLE");
        // detail 为空 ⇒ 区内不出现 detail 节点（不为空壳渲染隐藏节点）。
        expect(
            wrapper
                .find('[data-testid="workspace-checkpoint-timeline-error-detail-body"]')
                .exists(),
        ).toBe(false);
    });

    it("码与 detail 都取不到 ⇒ 不渲染空折叠区", async () => {
        // 非 ApiError（无 `problem.code`）⇒ `presentError` 返回 code/technicalDetail 双 null（errorMessages.ts:230）。
        mockedApi.listWorkspaceCheckpoints.mockRejectedValue(new Error("network down"));
        const wrapper = mount(WorkspaceChangesPanel, {
            props: { workspaceId: WORKSPACE_ID },
            global: { plugins: [i18n] },
        });
        await flushPromises();
        expect(
            wrapper.find('[data-testid="workspace-checkpoint-timeline-error-copy"]').exists(),
        ).toBe(true);
        expect(
            wrapper
                .find('[data-testid="workspace-checkpoint-timeline-error-detail-toggle"]')
                .exists(),
        ).toBe(false);
    });
});
