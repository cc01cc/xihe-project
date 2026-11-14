import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
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

/**
 * task-30 ②：表驱动守卫**必须**让候选集合非空，否则「独立会话下没有抄送」可以因为
 * 「根本没有参与者」而假绿 —— 那正是这次漏掉两个入口的同一类错误（空集把缺口藏起来，
 * 见 D-1281）。这里按真实响应形状喂两个 agent 参与者 + speakAs=true：
 * 工作区会话下四类控件都会渲染（负向对照证明表没有空转），独立会话下一个都不许有。
 */
vi.mock("../../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../../composables/api")>();
    const agent = (participantId: string, displayName: string) => ({
        participantId,
        principalKind: "AGENT" as const,
        principalId: participantId,
        displayName,
        role: "MEMBER" as const,
        orderIndex: 10,
        wakePolicy: "ALL_MESSAGES" as const,
        respondPolicy: "ALWAYS" as const,
        disabledAt: null,
        readCursor: null,
        selfOwned: true,
    });
    return {
        ...actual,
        api: {
            ...actual.api,
            getSessionParticipants: vi.fn<typeof actual.api.getSessionParticipants>(async () => ({
                participants: [agent("p-self", "agent-self"), agent("p-other", "agent-other")],
                capabilities: { view: true, manage: true, mention: true, speakAs: true },
            })),
        },
    };
});

const messages = {
    "zh-CN": {
        chat: {
            placeholder: "输入消息...",
            send: "发送",
            stop: "停止",
            image: "图片",
            attachFile: "附件",
            voice: "语音输入",
            input: { workspaceLessNoTargets: "独立会话不支持选择发送对象、代发与附件（仅纯对话）" },
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

/**
 * task-30 ②（用户报障：提示条写着「独立会话不支持…（仅纯对话）」，旁边还摆着「抄送」「委派」）。
 *
 * <p>根因不是"忘了两处 if"，而是**文案与控件集合之间没有机器判据**：`showSpeakAs` /
 * `showToTargets` 各自带着 `!workspaceLess`，`showCcSection` 与 delegate 的 `visible` 却没有，
 * 却没有任何用例会因为"漏了门"而红。这张表就是把两者钉在一起 —— 以后新增 composer 入口时，
 * 只要它属于 CP 对独立会话封禁的能力（as / to / cc / 附件），就必须先在这里登记，
 * 否则「独立会话不该有它」这件事永远不会被测到。</p>
 */
type CapabilityProbe = {
    /** 能力名（用户语言，与 hint 文案的措辞对齐）。 */
    capability: string;
    /** 该能力在 composer 里的唯一 DOM 锚点。 */
    probe: string;
};

const CAPABILITY_PROBES: CapabilityProbe[] = [
    { capability: "代发身份（以某参与者身份发送）", probe: '[data-testid="speak-as-bar"]' },
    { capability: "发送多选（TO）", probe: '[data-testid="to-targets-bar"]' },
    { capability: "抄送（CC）", probe: '[data-testid="cc-expand"]' },
    { capability: "委派", probe: '[data-testid="chat-delegate-button"]' },
    { capability: "图片", probe: '[aria-label="入口-图片"]' },
    { capability: "附件", probe: '[aria-label="入口-附件"]' },
    { capability: "截屏", probe: '[aria-label="入口-截屏"]' },
];

describe("task-30 表驱动守卫：hint 声称不支持的能力 → 一个控件都不许在", () => {
    it("独立会话：表里每一项都不渲染", async () => {
        const wrapper = mountComposer(standaloneRoute());
        await flushPromises();

        const leaked = CAPABILITY_PROBES.filter((row) => wrapper.find(row.probe).exists()).map(
            (row) => row.capability,
        );
        expect(leaked, "独立会话（仅纯对话）下这些能力的控件仍在渲染").toEqual([]);
        wrapper.unmount();
    });

    it("工作区会话（负向对照）：表里每一项都必须渲染 —— 否则这张表在空转", async () => {
        const wrapper = mountComposer(workspaceRoute());
        await flushPromises();

        const missing = CAPABILITY_PROBES.filter((row) => !wrapper.find(row.probe).exists()).map(
            (row) => row.capability,
        );
        expect(missing, "工作区会话缺这些入口 = 功能回归，或夹具喂空导致上一条假绿").toEqual([]);
        wrapper.unmount();
    });
});
