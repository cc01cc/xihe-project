import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent } from "vue";
import { i18n } from "../../../i18n";
import BackToChatButton from "../BackToChatButton.vue";

/**
 * task-36 ②：「返回聊天」的两条路径。
 *
 * 判据来自卡片：从聊天进设置再点返回，**不能**每次都 push 一条新历史（否则浏览器后退键要按很多下）；
 * 但控件文案承诺的是「返回聊天」，所以上一条历史不是聊天/工作区时（直链进入、或刚在设置区里横跳），
 * 必须直接 push 到聊天，而不是退回上一个设置页。
 *
 * <p><b>task-40（H-07）加钉两条</b>：①这个控件是**导航**，渲染结果必须是真实 `<a href>`
 * （中键/右键/⌘-click 才能开新标签）——只断言"点了会跳"测不出这件事，因为原生 button 也能跳；
 * ②带修饰键或非主键的点击**不许**被我们拦（拦了就等于把刚恢复的原生能力又收回去）。</p>
 */
const { routerState, pushSpy, backSpy } = vi.hoisted(() => ({
    routerState: { back: null as string | null },
    pushSpy: vi.fn<(to: unknown) => Promise<void>>(),
    backSpy: vi.fn<() => void>(),
}));

vi.mock("vue-router", () => ({
    useRouter: () => ({
        push: pushSpy,
        back: backSpy,
        options: { history: { state: routerState } },
    }),
}));

const sessionState = vi.hoisted(() => ({
    currentSessionId: "s-1" as string | null,
    workspaceId: "ws-1" as string | null,
}));

vi.mock("../../../stores/session", () => ({
    useSessionStore: () => ({
        get currentSessionId() {
            return sessionState.currentSessionId;
        },
        get currentSession() {
            return sessionState.currentSessionId ? { workspaceId: sessionState.workspaceId } : null;
        },
    }),
}));

vi.mock("../../../stores/auth", () => ({
    useAuthStore: () => ({ currentWorkspaceId: sessionState.workspaceId }),
}));

const CHAT_PATH = "/workspace/ws-1/session/s-1";
const WORKSPACE_PATH = "/workspace/ws-1";

/**
 * `router-link` 替身：渲染真实 `<a href>` 并把 `$attrs`（含 `data-testid` 与我们的 click 监听）
 * 透传下去 —— 这样断言的是"点击处理器挂在 <a> 上"这件事本身，而不是替身的形状。
 * （与 `components/resources/__tests__/ResourceWorkspaceRequired.spec.ts:14-17` 同形。）
 */
const RouterLinkStub = defineComponent({
    props: ["to"],
    template: '<a :href="to" v-bind="$attrs"><slot /></a>',
});

function mountButton() {
    return mount(BackToChatButton, {
        global: { plugins: [i18n], stubs: { "router-link": RouterLinkStub } },
    });
}

beforeEach(() => {
    routerState.back = null;
    pushSpy.mockClear();
    backSpy.mockClear();
    sessionState.currentSessionId = "s-1";
    sessionState.workspaceId = "ws-1";
});

describe("BackToChatButton history handling (task-36 ②)", () => {
    it("uses router.back() when the previous entry is the chat page (no history pile-up)", async () => {
        routerState.back = "/workspace/ws-1/session/s-1";
        const wrapper = mountButton();

        await wrapper.get('[data-testid="settings-back-to-chat"]').trigger("click");

        expect(backSpy).toHaveBeenCalledTimes(1);
        expect(pushSpy).not.toHaveBeenCalled();
    });

    it("pushes the chat path when the previous entry is another settings page", async () => {
        routerState.back = "/settings/config";
        const wrapper = mountButton();

        await wrapper.get('[data-testid="settings-back-to-chat"]').trigger("click");

        // 退回上一个设置页不算「返回聊天」——按钮文案承诺的是聊天，所以直接 push 目标页。
        expect(backSpy).not.toHaveBeenCalled();
        expect(pushSpy).toHaveBeenCalledWith(CHAT_PATH);
    });

    it("pushes the chat path on a direct link (empty history stack)", async () => {
        routerState.back = null;
        const wrapper = mountButton();

        await wrapper.get('[data-testid="settings-back-to-chat"]').trigger("click");

        expect(backSpy).not.toHaveBeenCalled();
        expect(pushSpy).toHaveBeenCalledWith(CHAT_PATH);
    });

    it("falls back to the workspace when no session is active", async () => {
        routerState.back = null;
        sessionState.currentSessionId = null;
        const wrapper = mountButton();

        await wrapper.get('[data-testid="settings-back-to-chat"]').trigger("click");

        expect(pushSpy).toHaveBeenCalledWith(WORKSPACE_PATH);
    });
});

describe("BackToChatButton 是链接不是按钮（task-40 / H-07）", () => {
    it("渲染真实 <a href>（中键 / 右键 / ⌘-click 开新标签的前提）", () => {
        const wrapper = mountButton();
        const link = wrapper.get('[data-testid="settings-back-to-chat"]');

        expect(link.element.tagName).toBe("A");
        // href 就是「返回聊天」的目标页 —— 新标签里打开的是同一个地方，不是设置页。
        expect(link.attributes("href")).toBe(CHAT_PATH);
    });

    it("没有会话时 href 落到工作区（兜底同样是链接）", () => {
        sessionState.currentSessionId = null;
        const wrapper = mountButton();

        expect(wrapper.get('[data-testid="settings-back-to-chat"]').attributes("href")).toBe(
            WORKSPACE_PATH,
        );
    });

    it("带修饰键 / 非主键的点击不被拦（原生新标签能力原样交还浏览器）", async () => {
        const wrapper = mountButton();
        const link = wrapper.get('[data-testid="settings-back-to-chat"]');

        // 中键（button=1）：cartwheel 是"在后台新标签打开"的常用手势。
        const middle = new MouseEvent("click", { button: 1, bubbles: true, cancelable: true });
        link.element.dispatchEvent(middle);
        // ⌘/Ctrl-click：mac/windows 的"新标签打开"标准手势。
        const modified = new MouseEvent("click", {
            button: 0,
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
        });
        link.element.dispatchEvent(modified);

        expect(middle.defaultPrevented).toBe(false);
        expect(modified.defaultPrevented).toBe(false);
        expect(pushSpy).not.toHaveBeenCalled();
        expect(backSpy).not.toHaveBeenCalled();
    });

    it("普通左键仍走 SPA 历史语义（preventDefault + 既有 task-36 ② 判定不变）", async () => {
        routerState.back = "/workspace/ws-1";
        const wrapper = mountButton();

        const plain = new MouseEvent("click", { button: 0, bubbles: true, cancelable: true });
        wrapper.get('[data-testid="settings-back-to-chat"]').element.dispatchEvent(plain);

        expect(plain.defaultPrevented).toBe(true);
        expect(backSpy).toHaveBeenCalledTimes(1);
    });
});
