import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { createPinia, setActivePinia } from "pinia";
import InputArea from "../components/InputArea.vue";

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
            input: {
                workspaceLessNoTargets: "独立会话不支持附件（仅纯对话）",
                workspaceLessDropped: "独立会话不支持附件，本条已去掉附件后发送",
                toLabel: "代发身份",
                toTargetsLabel: "发送",
                // task-102：与产品同文（两条都回答免打扰问题）。
                toHint: "相当于 {'@'}，会作为重要通知送达，不会被免打扰屏蔽（可多选）",
                ccHint: "普通抄送通知（不会被免打扰屏蔽）",
                toEmptyHint: "本条不会通知任何参与者",
                toEmptyHintDismiss: "知道了",
                ccLabel: "抄送",
                ccAdd: "添加…",
                ccRemove: "移除抄送",
                ccCollapse: "收起抄送",
                recipientPlaceholder: "输入名字…",
                recipientRemove: "移除",
                recipientHint: "↑↓ 选择 · Enter 确认 · Tab 补全 · Esc 关闭",
                recipientEmpty: "没有匹配的成员",
                recipientUnknown: "没有找到这个成员",
            },
            delegation: { button: "委派", reasonUnknown: "未知原因" },
        },
        workspace: { speakAsLabel: "以此身份发言", participantUnknownName: "未知用户" },
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
 * task-30 ② 建表 → **task-49 重排**：composer 能力的「会话类型 × 栏目」对照表。
 *
 * <p>task-30 建这张表的原因：文案与控件集合之间没有机器判据 —— `showSpeakAs` / `showToTargets`
 * 各自带 `!workspaceLess`，而 `showCcSection` 与 delegate 的 `visible` 却没有，却没有用例会因此变红。</p>
 *
 * <p>task-49（`task-48` 落库后）：CP 已允许独立会话发送给成员 / 抄送 / 代发 ⇒ 这三项从**负例翻成正例**；
 * 附件三件套（图片 / 附件 / 截屏）与委派**保持负例**。所以表从「一张负例表」改为「每格显式声明期望」的
 * 对照表 —— 否则「全表正例」会让它变成**恒真断言**（表还在，判别力没了）。</p>
 *
 * <p>当前 7 行 × 2 会话类型 = **14 格**，其中负例 **4 格**（图片 / 附件 / 截屏 / 委派 在独立会话下），
 * 正例 10 格；下面的自检用例把这个分布也钉住。</p>
 */
type CapabilityProbe = {
    /** 能力名（用户语言，与 hint 文案的措辞对齐）。 */
    capability: string;
    /** 该能力在 composer 里的唯一 DOM 锚点。 */
    probe: string;
    /** 工作区会话下的期望（对照侧）。 */
    workspace: "present" | "absent";
    /** 独立会话下的期望（本卡核心）。 */
    workspaceLess: "present" | "absent";
};

const CAPABILITY_PROBES: CapabilityProbe[] = [
    // —— task-49 放开的三个收件人面：两种会话都必须渲染 ——
    {
        capability: "代发身份（以某参与者身份发送）",
        probe: '[data-testid="speak-as-bar"]',
        workspace: "present",
        workspaceLess: "present",
    },
    {
        capability: "发送多选（TO）",
        probe: '[data-testid="to-targets-bar"]',
        workspace: "present",
        workspaceLess: "present",
    },
    {
        capability: "抄送（CC）",
        probe: '[data-testid="cc-expand"]',
        workspace: "present",
        workspaceLess: "present",
    },
    // —— 保持负例：委派（会让工具能力被间接使用）与附件三件套（CP 仍 400）——
    {
        capability: "委派",
        probe: '[data-testid="chat-delegate-button"]',
        workspace: "present",
        workspaceLess: "absent",
    },
    {
        capability: "图片",
        probe: '[aria-label="入口-图片"]',
        workspace: "present",
        workspaceLess: "absent",
    },
    {
        capability: "附件",
        probe: '[aria-label="入口-附件"]',
        workspace: "present",
        workspaceLess: "absent",
    },
    {
        capability: "截屏",
        probe: '[aria-label="入口-截屏"]',
        workspace: "present",
        workspaceLess: "absent",
    },
];

type SessionKind = "workspace" | "workspaceLess";

/** 一格 = 能力 × 会话类型；把「期望 vs 实际」摊平成可读的失败清单。 */
function surveyCapabilities(wrapper: ReturnType<typeof mountComposer>, kind: SessionKind) {
    return CAPABILITY_PROBES.map((row) => ({
        capability: row.capability,
        session: kind,
        expected: row[kind],
        actual: wrapper.find(row.probe).exists() ? "present" : "absent",
    }));
}

describe("task-49 表驱动守卫：每个能力 × 会话类型都有显式期望", () => {
    it("独立会话：三个收件人面在、附件三件套与委派不在", async () => {
        const wrapper = mountComposer(standaloneRoute());
        await flushPromises();

        const cells = surveyCapabilities(wrapper, "workspaceLess");
        const wrong = cells.filter((cell) => cell.expected !== cell.actual);
        expect(
            wrong,
            "独立会话下这些格与期望不符（task-49 放开 TO/CC/代发，附件与委派仍禁用）",
        ).toEqual([]);
        wrapper.unmount();
    });

    it("工作区会话（对照侧）：同一张表的正例格全部渲染", async () => {
        const wrapper = mountComposer(workspaceRoute());
        await flushPromises();

        const cells = surveyCapabilities(wrapper, "workspace");
        const wrong = cells.filter((cell) => cell.expected !== cell.actual);
        expect(wrong, "工作区会话缺这些入口 = 功能回归，或夹具喂空导致上一条假绿").toEqual([]);
        wrapper.unmount();
    });

    it("表本身有判别力：14 格里负例恰好 4 格（删光负例 ⇒ 本用例红）", () => {
        const cells = CAPABILITY_PROBES.flatMap((row) => [
            { session: "workspace" as const, expected: row.workspace },
            { session: "workspaceLess" as const, expected: row.workspaceLess },
        ]);
        const negatives = cells.filter((cell) => cell.expected === "absent");
        expect(cells).toHaveLength(14);
        expect(
            negatives,
            "负例格数变了：要么有人把「仍不支持」的能力放开，要么把表格改成了恒真断言",
        ).toHaveLength(4);
        // 恒真防护：负例只能出现在独立会话列 —— 若某天工作区会话也出负例，说明表的期望写反了。
        expect(new Set(negatives.map((cell) => cell.session))).toEqual(new Set(["workspaceLess"]));
    });
});
