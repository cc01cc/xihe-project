import { describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia } from "pinia";
import { defineComponent } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import type * as apiModule from "../../../composables/api";
import { api } from "../../../composables/api";
import { i18n } from "../../../i18n";
import MobileChatSheet from "../components/MobileChatSheet.vue";
import SessionContextPanel from "../components/SessionContextPanel.vue";

/**
 * task-124 · **同屏计数**判据（D-979 第五种假绿的正面补法）。
 *
 * ## 为什么需要这支 spec（task-116 那支不够）
 * `sessionSettingsExpandedHosts.spec.ts`（task-116）断言的是**组件状态**：它把 `ChatPanel` mock 成
 * 空 `div`，于是被断言的 DOM 里根本没有 `session-settings-expanded` —— 它证明的是"收口逻辑被调用"，
 * 不是"重复消失"。本支补的正是缺的那一块：
 *
 * - **同一个 `mount`** 里同时存在两个宿主：
 *   ① 移动替身 `MobileChatSheet`（真组件）；
 *   ② 桌面 dock 宿主 —— `SessionContextPanel`（`WorkspaceWorkbench.vue:806-808` 的 `#context` 槽
 *      挂的就是它）。
 * - **不 mock 被测正文**：`ChatPanel` / `SessionSettingsPanel` / `SessionContextPanel` 全真挂
 *   （移动替身的正文链是 `MobileChatSheet → ChatPanel(isMobile) → SessionSettingsPanel →
 *   SessionContextPanel`，见 `SessionSettingsPanel.vue:318-327`）。
 * - 先断言**两个宿主都真的渲染**（否则"只剩 1 个"可以靠"根本没挂"骗过），再数节点。
 *
 * ## 判据
 * `session-settings-expanded` 在同一棵 DOM 里 **≤ 1**；跨断点后仍成立。
 * 反向验证（撤回 task-124 的 `v-if="open && isMobileNow"`）⇒ 该断言必须红，读数 `expected 2 to be
 * less than or equal to 1`。
 */

const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

vi.mock("vue-sonner", () => ({
    toast: { success: vi.fn<(m: string) => void>(), error: vi.fn<(m: string) => void>() },
}));

/**
 * 只替**网络**，不替组件：真实正文链需要这些 api 返回形状合法的空数据。
 * （替掉 `ChatPanel` 就等于把被测物换成空 div —— 那正是 task-116 那支的局限，见 D-979。）
 */
vi.mock("../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof apiModule>();
    return {
        ...actual,
        api: {
            ...actual.api,
            getMessages: vi.fn<typeof actual.api.getMessages>().mockResolvedValue({
                items: [],
                hasMore: false,
                branchId: null,
            } as never),
            getPendingApprovals: vi
                .fn<typeof actual.api.getPendingApprovals>()
                .mockResolvedValue([] as never),
            getSessionBranches: vi
                .fn<typeof actual.api.getSessionBranches>()
                .mockResolvedValue({ rootBranchId: null, branches: [] } as never),
            createSessionBranch: vi
                .fn<typeof actual.api.createSessionBranch>()
                .mockResolvedValue({} as never),
            getFollowUpQueue: vi.fn<typeof actual.api.getFollowUpQueue>().mockResolvedValue({
                sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                queueState: "empty",
                outstandingCount: 0,
                capacityLimit: 5,
                pauseReason: null,
                items: [],
            } as never),
            enqueueFollowUp: vi
                .fn<typeof actual.api.enqueueFollowUp>()
                .mockResolvedValue({} as never),
            withdrawFollowUp: vi
                .fn<typeof actual.api.withdrawFollowUp>()
                .mockResolvedValue({} as never),
            continueFollowUpQueue: vi
                .fn<typeof actual.api.continueFollowUpQueue>()
                .mockResolvedValue({} as never),
            getSessionDerivedState: vi
                .fn<typeof actual.api.getSessionDerivedState>()
                .mockResolvedValue({} as never),
            listSessionRuns: vi
                .fn<typeof actual.api.listSessionRuns>()
                .mockResolvedValue({ items: [] } as never),
            bindSessionDefaults: vi
                .fn<typeof actual.api.bindSessionDefaults>()
                .mockResolvedValue({} as never),
            getSessionContext: vi.fn<typeof api.getSessionContext>().mockResolvedValue({} as never),
        },
    };
});

function testRouter() {
    return createRouter({
        history: createMemoryHistory(),
        routes: [{ path: "/:pathMatch(.*)*", component: { template: "<div />" } }],
    });
}

/** 统计某个 testid 在当前 wrapper 里的节点数（**绑挂载根**，不看 `document`）。 */
function count(wrapper: VueWrapper, testId: string): number {
    return wrapper.findAll(`[data-testid="${testId}"]`).length;
}

/**
 * 双宿主 harness：**同一次 `mount`** 里既有移动替身，也有桌面 dock 宿主。
 *
 * 桌面宿主的在场条件按真实分支写（`v-if="!isMobile"`，对应 `WorkspaceWorkbench` 只在桌面分支
 * 渲染 dock），移动替身则像 `WorkspaceView.vue:586` 那样**常驻**（只按 `sessionId` gate）——
 * 这正是重复发生的条件：视口拉宽后桌面宿主起来了，而替身里**已经打开的内容**还在。
 */
function mountBothHosts(isMobile: boolean) {
    const Harness = defineComponent({
        components: { MobileChatSheet, SessionContextPanel },
        props: { isMobile: { type: Boolean, default: true } },
        setup: () => ({ SESSION_ID }),
        template: `
            <div>
                <MobileChatSheet :session-id="SESSION_ID" :is-mobile="isMobile" />
                <div v-if="!isMobile" data-testid="desktop-dock-host">
                    <SessionContextPanel :session-id="SESSION_ID" />
                </div>
            </div>
        `,
    });
    return mount(Harness, {
        props: { isMobile },
        attachTo: document.body,
        global: {
            plugins: [createPinia(), i18n, testRouter()],
            stubs: {
                // 孙组件（策略/模板/来源三块）不是被测正文，与 task-90 那支同样处理。
                SessionPolicyControls: { template: "<div />" },
                SessionContextTemplate: { template: "<div />" },
                ContextSourcesU1: { template: "<div />" },
                // `ChatPanel` 的**兄弟**子组件同样不是被测正文（正文链是 ChatPanel →
                // SessionSettingsPanel → SessionContextPanel，那三支都真挂）。真挂它们只会把
                // `navigator.mediaDevices`（ScreenshotCapture）之类浏览器能力拉进 jsdom。
                MessageList: { template: "<div />" },
                InputArea: { template: "<div />" },
                SSEStream: { template: "<div />" },
                ApprovalModal: { template: "<div />" },
                SessionDerivedStatePanel: { template: "<div />" },
                FollowUpQueuePanel: { template: "<div />" },
                GuidancePanel: { template: "<div />" },
                RevertPreviewDialog: { template: "<div />" },
                RevertResultDialog: { template: "<div />" },
                ProviderBindingGuideDialog: { template: "<div />" },
            },
        },
    });
}

async function settle() {
    await flushPromises();
    await flushPromises();
}

describe("同屏计数：session-settings-expanded 在任意视口 ≤ 1（task-124）", () => {
    it("移动端打开替身 ⇒ 恰好 1 个节点；跨断点后桌面宿主起来、替身正文消失 ⇒ 仍 1 个", async () => {
        const wrapper = mountBothHosts(true);
        await settle();

        // 打开移动替身（真组件：toggle 是它自己的入口）。
        (wrapper.findComponent(MobileChatSheet).vm as unknown as { toggle: () => void }).toggle();
        await settle();

        // ① 先证明"移动宿主真的渲染了正文"——否则后面的计数可以靠"什么都没挂"骗过。
        expect(count(wrapper, "mobile-chat-sheet")).toBe(1);
        expect(count(wrapper, "session-settings-expanded")).toBe(1);
        expect(count(wrapper, "session-context-panel")).toBe(1);

        // ② 跨断点：桌面 dock 宿主起来（真实分支条件），替身仍在挂载（只是收口）。
        await wrapper.setProps({ isMobile: false });
        await settle();

        // ③ 再证明"桌面宿主真的渲染了"——两个宿主都真在，这条计数才有意义。
        expect(count(wrapper, "desktop-dock-host")).toBe(1);
        expect(count(wrapper, "session-context-panel")).toBe(1);

        // ④ 判据本体：同一棵 DOM 里同名节点 ≤ 1。
        expect(count(wrapper, "session-settings-expanded")).toBeLessThanOrEqual(1);
        expect(count(wrapper, "session-context-panel")).toBeLessThanOrEqual(1);

        wrapper.unmount();
    });

    it("桌面直接挂载：替身从未渲染正文（结构性，不靠 watch 兜）", async () => {
        const wrapper = mountBothHosts(false);
        await settle();

        // 桌面视口下 `toggle()` 仍可被程序调用（状态层允许），但正文**结构上不存在**。
        (wrapper.findComponent(MobileChatSheet).vm as unknown as { toggle: () => void }).toggle();
        await settle();

        expect(count(wrapper, "desktop-dock-host")).toBe(1);
        expect(count(wrapper, "mobile-chat-sheet")).toBe(0);
        expect(count(wrapper, "session-settings-expanded")).toBeLessThanOrEqual(1);

        wrapper.unmount();
    });
});
