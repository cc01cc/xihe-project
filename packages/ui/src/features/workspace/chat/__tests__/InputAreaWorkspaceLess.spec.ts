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
import type * as apiModule from "../../../../composables/api";

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
    const actual = await importOriginal<typeof apiModule>();
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
                // task-114：夹具跟产品走（三栏都有栏外说明）。
                toLabelHint: "本条以所选身份的账号发出，对方看到的是它，不是你",
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
                // task-38 C3（bc81fff811）：抄送空候选时的常驻说明。夹具与产品同文；
                // 缺这条键时整支 spec 会在挂载期被裸键护栏判红（task-70 实测）。
                ccEmptyHint: "暂无可抄送成员：把成员加进这个会话后就能抄送",
            },
            delegation: { button: "委派", reasonUnknown: "未知原因" },
        },
        workspace: { participantUnknownName: "未知用户" },
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

    /**
     * task-70 正向钉人话 + 反向钉入口：task-38 C3 把「抄送无可选成员」做成**常驻禁用入口 + 一句说明**
     * （产品侧 `cc-expand-empty` / sr-only `cc-empty-hint`）。两件事一起钉：
     *  正向 —— 用户看得到那句人话（不是只有 aria-disabled 的灰按钮）；
     *  反向 —— 入口不许回流成「静默消失」（C3 之前空候选就是把控件去掉），且必须仍可聚焦。
     */
    it("抄送无可选成员：常驻禁用入口 + 同一句人话说明（不静默消失）", () => {
        const wrapper = mountComposer(workspaceRoute());
        const entry = wrapper.find('[data-testid="cc-expand-empty"]');
        expect(entry.exists(), "空候选不许把入口整块去掉").toBe(true);
        expect(entry.attributes("aria-disabled")).toBe("true");
        const hint = wrapper.find('[data-testid="cc-empty-hint"]');
        expect(hint.exists(), "禁用入口必须带可读原因（sr-only 也算）").toBe(true);
        expect(hint.text()).toContain("暂无可抄送成员");
        wrapper.unmount();
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
    // —— task-49 放开的收件人面 × task-55 移除代发入口：三种格都有**显式期望**，不留空 ——
    {
        // task-55（D-1882③）：代发身份入口从 composer 移除，两种会话都是 absent。
        // 这一行**不许删** —— 删掉它就等于把「代发面回来了」判为通过（表驱动的价值恰在显式负格）。
        capability: "代发身份入口（task-55 已移除，只留 wire）",
        probe: '[data-testid="speak-as-bar"]',
        workspace: "absent",
        workspaceLess: "absent",
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
    it("独立会话：两个收件人面在（代发入口已移除）、附件三件套与委派不在", async () => {
        const wrapper = mountComposer(standaloneRoute());
        await flushPromises();

        const cells = surveyCapabilities(wrapper, "workspaceLess");
        const wrong = cells.filter((cell) => cell.expected !== cell.actual);
        expect(
            wrong,
            "独立会话下这些格与期望不符（task-49 放开 TO/CC；task-55 移除代发入口；附件与委派仍禁用）",
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

    it("表本身有判别力：14 格里负例恰好 6 格（删光负例 ⇒ 本用例红）", () => {
        const cells = CAPABILITY_PROBES.flatMap((row) => [
            { session: "workspace" as const, expected: row.workspace },
            { session: "workspaceLess" as const, expected: row.workspaceLess },
        ]);
        const negatives = cells.filter((cell) => cell.expected === "absent");
        expect(cells).toHaveLength(14);
        expect(
            negatives,
            "负例格数变了：要么有人把「仍不支持」的能力放开，要么把表格改成了恒真断言",
        ).toHaveLength(6);
        // 恒真防护升级（task-55 / D-1882③）：负例现在**跨两种会话**，原判据「负例只出现在独立会话列」
        // 会直接把这次合法翻转判红，而放宽成「数量对就行」又会退化成恒真断言。
        // 改法 = 按行归属点名：整行两格皆 absent 的**只许是**代发入口那一行。
        const bothAbsent = CAPABILITY_PROBES.filter(
            (row) => row.workspace === "absent" && row.workspaceLess === "absent",
        ).map((row) => row.capability);
        expect(bothAbsent).toEqual(["代发身份入口（task-55 已移除，只留 wire）"]);
        expect(negatives.filter((cell) => cell.session === "workspace")).toHaveLength(1);
        expect(negatives.filter((cell) => cell.session === "workspaceLess")).toHaveLength(5);
    });
});
