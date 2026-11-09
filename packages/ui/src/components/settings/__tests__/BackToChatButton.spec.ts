import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { i18n } from "../../../i18n";

/**
 * task-36 ②：「返回聊天」的两条路径。
 *
 * 判据来自卡片：从聊天进设置再点返回，**不能**每次都 push 一条新历史（否则浏览器后退键要按很多下）；
 * 但按钮文案承诺的是「返回聊天」，所以上一条历史不是聊天/工作区时（直链进入、或刚在设置区里横跳），
 * 必须直接 push 到聊天，而不是退回上一个设置页。
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

import BackToChatButton from "../BackToChatButton.vue";

const CHAT_PATH = "/workspace/ws-1/chat/s-1";

function mountButton() {
    return mount(BackToChatButton, { global: { plugins: [i18n] } });
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
        routerState.back = "/workspace/ws-1/chat/s-1";
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

        expect(pushSpy).toHaveBeenCalledWith("/workspace/ws-1");
    });
});
