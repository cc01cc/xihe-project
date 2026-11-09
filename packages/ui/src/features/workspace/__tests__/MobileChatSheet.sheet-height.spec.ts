import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { reactive } from "vue";
import { createPinia } from "pinia";

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
vi.mock("vue-i18n", () => ({
    useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock("../chat/components/ChatPanel.vue", () => ({
    default: { template: "<div />" },
}));
vi.mock("../components/MobileMembersSheet.vue", () => ({
    default: { template: "<div />" },
}));
vi.mock("@lucide/vue", () => ({
    MessageCircle: { template: "<i />" },
    // SheetContent 的关闭按钮要用它；这里保留真实 Sheet 依赖链，所以必须补齐。
    XIcon: { template: "<i />" },
}));

import MobileChatSheet from "../components/MobileChatSheet.vue";

/**
 * BL-405（PLAN-0631 W9 · 390px 移动视口）：底部 sheet 高度必须锁在视口内。
 *
 * 背景：`SheetContent.vue` 的基础类串里有 `data-[side=bottom]:h-auto`，arbitrary variant
 * 带来的 `[data-side="bottom"]` 属性选择器让它比裸高度类多一层特异性（0,2,0 > 0,1,0）
 * ⇒ 高度一直被 auto 覆盖，内容把 sheet 撑到 1.61× 视口（round-2 实测 1360.56px / 844px）。
 * **PLAN-0702（safe-area/键盘适配）** 起高度改为 `min(75dvh, calc(100dvh - 2rem))`（给安全区
 * 与软键盘留位），断言随之同步到新类；实质判据（h-auto 被顶掉）不变。
 *
 * jsdom 不加载 Tailwind CSS，`getComputedStyle` 取不到实际高度，所以这里断言**真实渲染出的
 * class 链**，三条互证（缺一条都不成立）：
 *   ① 覆盖类 `data-[side=bottom]:h-auto` 必须已被 tailwind-merge 顶掉（这才是修复的实质）；
 *   ② 同 variant 的 `data-[side=bottom]:h-[min(75dvh,calc(100dvh-2rem))]` 与无对抗类的
 *      `max-h-[min(75dvh,calc(100dvh-2rem))]` 必须存在；
 *   ③ 元素确实带 `data-side="bottom"`，证明被断言的那个 variant 真的会命中。
 * 只断言「类名字符串存在」是不够的 —— 那在 `h-auto` 仍生效时也会通过。
 */
describe("MobileChatSheet sheet height (BL-405)", () => {
    async function mountOpen() {
        const wrapper = mount(MobileChatSheet, {
            props: { sessionId: "session-1" },
            // sheet 走 Portal 渲染到 body，必须 attach 才能用 document 查询。
            attachTo: document.body,
            global: { plugins: [createPinia()] },
        });
        (wrapper.vm as unknown as { toggle: () => void }).toggle();
        await flushPromises();
        return wrapper;
    }

    it("locks the bottom sheet to min(75dvh, 100dvh - 2rem) instead of letting h-auto win", async () => {
        const wrapper = await mountOpen();
        const el = document.body.querySelector<HTMLElement>('[data-testid="mobile-chat-sheet"]');

        expect(el, "sheet content 应已 Portal 渲染到 body").not.toBeNull();
        const className = el!.className;

        // ③ 前提：被断言的 variant 确实命中这个元素。
        expect(el!.getAttribute("data-side"), "side=bottom 才会命中 data-[side=bottom]:*").toBe(
            "bottom",
        );
        // ① 实质判据：基础串的 h-auto 已被顶掉。
        expect(className, "data-[side=bottom]:h-auto 必须已被 tailwind-merge 移除").not.toMatch(
            /(^|\s)data-\[side=bottom\]:h-auto(\s|$)/,
        );
        // ② 替代约束必须在（0702 起为 min(75dvh, calc(100dvh - 2rem))），且含无对抗类的 max-h 兜底。
        const classes = className.split(/\s+/);
        expect(classes).toContain("data-[side=bottom]:h-[min(75dvh,calc(100dvh-2rem))]");
        expect(classes).toContain("max-h-[min(75dvh,calc(100dvh-2rem))]");

        wrapper.unmount();
    });
});
