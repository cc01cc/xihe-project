import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { createPinia, setActivePinia } from "pinia";

/**
 * task-555：**独立会话分支**的附件入口。
 *
 * 为什么单开一个 spec、不改 `InputArea.spec.ts`：那个文件用「无 router」的挂载
 * （`isWorkspaceLessRoute(null) = false` ⇒ 默认走 workspace 模式），要测本分支必须在**文件级**
 * mock `vue-router`，那会连带改掉同文件其余用例的判定 —— 等于把「补一条测试」变成「重写测试前提」。
 *
 * 判据（两条正向 + 一条负向对照，防止为了绿把分支写死）：
 *  1 独立会话：图片 / 附件 / 截取屏幕三个入口 **不渲染**；提示条渲染
 *  2 工作区会话：同样三个入口 **存在**（负向对照）
 */

/** 被测组件从 `inject(routeLocationKey)` 取路由（不是 `useRoute()`）⇒ 直接注入即可，不需要 mock 整个 vue-router。 */
import { routeLocationKey } from "vue-router";

type FakeRoute = { path: string; params: Record<string, string>; query: Record<string, string> };
function standaloneRoute(): FakeRoute {
    return { path: "/chat/session-1", params: {}, query: {} };
}
function workspaceRoute(): FakeRoute {
    return {
        path: "/workspace/11111111-1111-4111-8111-111111111111/chat/session-1",
        params: { workspaceId: "11111111-1111-4111-8111-111111111111" },
        query: {},
    };
}

vi.mock("../../../../services/attachmentService", () => ({
    uploadAttachments: vi.fn<() => Promise<{ success: unknown[]; failed: unknown[] }>>(
        async () => ({
            success: [],
            failed: [],
        }),
    ),
    validateAttachment: () => ({ valid: true }),
}));

vi.mock("vue-sonner", () => ({
    toast: { error: vi.fn<(m: string) => void>(), success: vi.fn<(m: string) => void>() },
}));

const messages = {
    "zh-CN": {
        chat: {
            placeholder: "输入消息...",
            send: "发送",
            stop: "停止",
            image: "图片",
            attachFile: "附件",
            voice: "语音输入",
            input: { workspaceLessNoTargets: "独立会话不支持定向发送、代发与附件（仅纯对话）" },
            delegation: { button: "委派", reasonUnknown: "未知原因" },
        },
        multimodal: { image: "图片", screenshot: "截取屏幕", voice: "语音输入" },
        common: { cancel: "取消" },
    },
};

function createI18nInstance() {
    return createI18n({ legacy: false, locale: "zh-CN", fallbackLocale: "zh-CN", messages });
}

/** 三个被测入口给可辨识标记（真组件的外部表现不在本卡判据里，入口是否被渲染才是）。 */
const stubs = {
    ImageUpload: { template: '<button aria-label="入口-图片" />' },
    FileUpload: { template: '<button aria-label="入口-附件" />' },
    ScreenshotCapture: { template: '<button aria-label="入口-截屏" />' },
    VoiceInput: { template: '<button aria-label="入口-语音" />' },
    LoaderCircle: { template: "<span />" },
    Image: { template: "<span />" },
    Camera: { template: "<span />" },
    Mic: { template: "<span />" },
    Send: { template: "<span />" },
};

import InputArea from "../components/InputArea.vue";

function mountComposer(route: FakeRoute) {
    return mount(InputArea, {
        props: { sessionId: "session-1" },
        global: {
            plugins: [createI18nInstance()],
            stubs,
            provide: { [routeLocationKey as symbol]: route },
        },
    });
}

const ATTACHMENT_ENTRIES = ["入口-图片", "入口-附件", "入口-截屏"];

function renderedEntries(wrapper: ReturnType<typeof mountComposer>) {
    return ATTACHMENT_ENTRIES.filter((label) => wrapper.find(`[aria-label="${label}"]`).exists());
}

beforeEach(() => {
    setActivePinia(createPinia());
});

describe("task-555 独立会话的附件入口", () => {
    it("独立会话：三个附件入口都不渲染，且给出可见原因", () => {
        const wrapper = mountComposer(standaloneRoute());
        expect(renderedEntries(wrapper), "独立会话下不该有附件入口").toEqual([]);
        const hint = wrapper.find('[data-testid="composer-workspace-less-hint"]');
        expect(hint.exists(), "必须给出可见原因，不能只是少几个按钮").toBe(true);
        expect(hint.text()).toContain("独立会话不支持");
    });

    it("工作区会话（负向对照）：三个附件入口必须都在", () => {
        const wrapper = mountComposer(workspaceRoute());
        expect(renderedEntries(wrapper), "工作区会话被砍掉附件就是功能回归").toEqual(
            ATTACHMENT_ENTRIES,
        );
        expect(wrapper.find('[data-testid="composer-workspace-less-hint"]').exists()).toBe(false);
    });
});
