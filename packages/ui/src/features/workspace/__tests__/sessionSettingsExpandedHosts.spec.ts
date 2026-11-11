import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import { reactive } from "vue";
import { i18n } from "../../../i18n";
import MobileChatSheet from "../components/MobileChatSheet.vue";

/**
 * task-116 · 重复 testid「第 2 组」：`session-settings-expanded`（workspace 面）。
 *
 * ## 定性：这是**第三种**「看着互斥其实不互斥」
 * 前两种已定过：① **两层壳**（task-90：移动壳与内嵌正文挂同名 testid）；② **CSS 断点双渲染**
 * （task-95/102：`hidden md:block` + `md:hidden` 两套 DOM 恒同挂）。
 * 本卡这一条是第三种，机制不同：
 *
 * - `MobileChatSheet` 是 dock 的**移动替身**，模板根 `div` 与浮动按钮都是 `md:hidden`
 *   ⇒ **CSS 只隐藏触发器，不收回"已经打开的内容"**；reka 的 `SheetContent` 在 `open` 为真时
 *   照常渲染并 teleport 到 body。
 * - 于是「移动端打开会话设置 → 视口拉宽到 ≥768」会同时留下两份 `SessionContextPanel`：
 *   ① 本 sheet 内 `ChatPanel(isMobile=true)` → `SessionSettingsPanel` → 正文；
 *   ② 桌面分支 `WorkspaceWorkbench` 的 dock `#context` 槽 → 另一份正文。
 *   两份正文都带 `data-testid="session-settings-expanded"`（`:61`）。
 * - 判据与 `WorkspaceView` 里 agent 管理弹窗那条同源（「once the viewport is wide enough for the
 *   dock, drop it so a resize can never leave two hosts eligible」），只是那条当时漏了本组件。
 *
 * ## 本 spec 判什么、不判什么
 * - **判**：替身是否在跨断点时自我撤销（宿主互斥）。这是本卡新增的收口。
 * - **不判**：替身内部有几个 `session-settings-expanded` 节点 —— 那由
 *   `chat/__tests__/sessionSettingsExpandedUnique.spec.ts`（task-90，挂**真实**两层组合）负责，
 *   判据是 `toHaveLength(1)` + 家族内无重名。两支 spec 合起来才等于"任意视口下同名节点 ≤1"：
 *   替身关掉 ⇒ 桌面只剩 dock 一份；替身开着 ⇒ 它内部只有一份。
 */

const agentState = reactive({
    status: "idle",
    currentToolCall: null,
    pendingApprovals: [] as Array<{ sessionId?: string; state?: string }>,
});

vi.mock("../../../stores/agent", () => ({
    useAgentStore: () => ({ agentState }),
}));
vi.mock("../../../stores/session", () => ({
    useSessionStore: () => ({ sessions: [] }),
}));
// 不 mock vue-i18n：本仓单测基座把"渲染出裸键"判失败（task-105），假翻译会让所有用例假红。
vi.mock("@lucide/vue", () => ({
    MessageCircle: { template: "<i />" },
}));
vi.mock("../chat/components/ChatPanel.vue", () => ({
    default: { template: "<div />" },
}));
vi.mock("../components/MobileMembersSheet.vue", () => ({
    default: { template: "<div />" },
}));

/**
 * Sheet 壳替身 **照 `open` 门控**，并把当前值写到 `data-sheet-open` 上。
 *
 * 为什么不做成"永远渲染 slot"（现有 `MobileChatSheet.spec.ts` 的写法）：那样 `open` 的真假在 DOM
 * 上不可观测，本卡的收口判据就没有分辨力。真实 reka `SheetContent` 只在 `open` 为真时挂载内容 ——
 * 这正是被测语义（jsdom 里真实 portal 挂不出来是环境限制，不是产品行为）。
 */
vi.mock("../../../components/ui/sheet/Sheet.vue", async () => {
    const { defineComponent, h } = await import("vue");
    return {
        default: defineComponent({
            props: { open: { type: Boolean, default: false } },
            setup:
                (props, { slots }) =>
                () =>
                    h(
                        "div",
                        { "data-testid": "stub-sheet-root", "data-sheet-open": String(props.open) },
                        props.open ? slots.default?.() : undefined,
                    ),
        }),
    };
});
vi.mock("../../../components/ui/sheet/SheetContent.vue", () => ({
    default: {
        name: "SheetContent",
        emits: ["pointerDownOutside"],
        template: "<div><slot /></div>",
    },
}));
vi.mock("../../../components/ui/sheet/SheetHeader.vue", () => ({
    default: { template: "<div><slot /></div>" },
}));
vi.mock("../../../components/ui/sheet/SheetTitle.vue", () => ({
    default: { template: "<div><slot /></div>" },
}));
vi.mock("../../../components/ui/sheet/SheetDescription.vue", () => ({
    default: { template: "<div><slot /></div>" },
}));

function mountSheet(isMobile = true) {
    return mount(MobileChatSheet, {
        props: { sessionId: "session-1", isMobile },
        global: { plugins: [createPinia(), i18n] },
    });
}

/** 替身当前是否开着 —— 直接读 Sheet 壳拿到的 `open` 值，不靠视觉/类名。 */
function sheetOpen(wrapper: ReturnType<typeof mountSheet>): boolean {
    const root = wrapper.get('[data-testid="stub-sheet-root"]');
    return root.attributes("data-sheet-open") === "true";
}

describe("MobileChatSheet 是 dock 的替身：跨断点必须自我撤销（task-116）", () => {
    beforeEach(() => {
        agentState.pendingApprovals = [];
    });

    it("移动端：打开后替身在渲染（判据有分辨力，不是恒 false）", async () => {
        const wrapper = mountSheet(true);
        await flushPromises();
        expect(sheetOpen(wrapper)).toBe(false);

        (wrapper.vm as unknown as { toggle: () => void }).toggle();
        await flushPromises();

        expect(sheetOpen(wrapper)).toBe(true);
        wrapper.unmount();
    });

    it("跨断点：视口宽到能放 dock 后替身立刻关闭 ⇒ 不会与 dock 同时挂正文", async () => {
        const wrapper = mountSheet(true);
        await flushPromises();
        (wrapper.vm as unknown as { toggle: () => void }).toggle();
        await flushPromises();
        expect(sheetOpen(wrapper)).toBe(true);

        // WorkspaceView 把 isMobileViewport 传进来；宽度跨到桌面时它变 false。
        await wrapper.setProps({ isMobile: false });
        await flushPromises();

        expect(sheetOpen(wrapper)).toBe(false);
        // 成员 sheet 也是同一台替身里的第二层宿主，必须一起收。
        expect(wrapper.findAll('[data-testid="members-entry-count"]').length).toBeLessThanOrEqual(
            0,
        );
        wrapper.unmount();
    });

    it("桌面直接挂载：不收口也不该被打开（触发器在 md:hidden 里，点了也不该留两份）", async () => {
        const wrapper = mountSheet(false);
        await flushPromises();

        // 桌面挂载时替身从一开始就是关的。
        expect(sheetOpen(wrapper)).toBe(false);
        wrapper.unmount();
    });
});
