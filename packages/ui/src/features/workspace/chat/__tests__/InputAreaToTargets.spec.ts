import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { createPinia, setActivePinia } from "pinia";
import InputArea from "../components/InputArea.vue";
import RecipientField from "../components/RecipientField.vue";
import type { SessionParticipantView } from "../../../../types/participant";

/**
 * PLAN-0665 M2 T2.1：composer「定向发送」多选 chips（1..N 个 AGENT）。
 *
 * 与 0659 的「代发」栏分开：代发是**身份**（单选），定向发送是**响应者集合**（多选，
 * 每个目标各起一个 run）。这里只钉渲染与发送契约（第 5 个 emit 参数 `toParticipantIds`）。
 */
const storeState = vi.hoisted(() => ({
    canSpeakAs: false,
    speakAsCandidates: [] as SessionParticipantView[],
    participants: [] as SessionParticipantView[],
    ensureLoaded: vi.fn<(id: string | null) => Promise<void>>(),
}));

vi.mock("../../stores/sessionParticipants", () => ({
    useSessionParticipantsStore: () => storeState,
}));

vi.mock("../../../../services/attachmentService", () => ({
    uploadAttachments: vi.fn<() => Promise<{ success: never[]; failed: never[] }>>(),
    validateAttachment: () => ({ valid: true }),
}));

const messages = {
    "zh-CN": {
        chat: {
            placeholder: "输入消息...",
            send: "发送",
            stop: "停止",
            followUpEnqueue: "排队发送",
            followUpEnqueuing: "加入中…",
            followUpPlaceholder: "添加后续任务…",
            followUpComposerNotice: "当前任务之后执行",
            followUpPausedNotice: "追加到暂停队列末尾",
            followUpFullNotice: "队列已满，草稿保留",
            input: {
                toLabel: "发送",
                toTargetsLabel: "定向发送",
                toAgentsOnlyHint: "人类成员请用抄送；人类作答待后续版本",
                ccLabel: "抄送",
                ccAdd: "添加…",
                ccRemove: "移除抄送",
            },
        },
        workspace: {
            speakAsLabel: "以此身份发言",
            participantUnknownName: "未知用户",
        },
        multimodal: { image: "图片", screenshot: "截图", voice: "语音" },
        common: { cancel: "取消" },
    },
};

const stubs = {
    ImageUpload: { template: "<div />" },
    FileUpload: { template: "<div />" },
    ScreenshotCapture: { template: "<div />" },
    VoiceInput: { template: "<div />" },
    LoaderCircle: { template: "<span />" },
    Image: { template: "<span />" },
    Camera: { template: "<span />" },
    Mic: { template: "<span />" },
    Send: { template: "<span />" },
};

const PRIMARY_ID = "11111111-1111-4111-8111-111111111111";
const HELPER_ID = "33333333-3333-4333-8333-333333333333";

function participant(overrides: Partial<SessionParticipantView>): SessionParticipantView {
    return {
        participantId: "p",
        principalKind: "AGENT",
        principalId: "5a2b7c9d-2222-4222-8222-bbbbbbbbbbbb",
        displayName: "Agent",
        role: "MEMBER",
        orderIndex: 20,
        wakePolicy: "MENTION",
        respondPolicy: "WHEN_MENTIONED",
        disabledAt: null,
        readCursor: null,
        selfOwned: true,
        ...overrides,
    };
}

function roster(): SessionParticipantView[] {
    return [
        participant({
            participantId: PRIMARY_ID,
            displayName: "Alpha",
            role: "PRIMARY",
            orderIndex: 10,
        }),
        participant({ participantId: HELPER_ID, displayName: "Helper", orderIndex: 30 }),
    ];
}

function mountInputArea() {
    return mount(InputArea, {
        props: { sessionId: "session-1" },
        global: {
            plugins: [
                createI18n({ legacy: false, locale: "zh-CN", fallbackLocale: "zh-CN", messages }),
            ],
            stubs,
        },
    });
}

beforeEach(() => {
    setActivePinia(createPinia());
    storeState.canSpeakAs = false;
    storeState.speakAsCandidates = [];
    storeState.participants = [];
    storeState.ensureLoaded.mockReset();
    storeState.ensureLoaded.mockResolvedValue(undefined);
});

describe("InputArea 定向发送多选（PLAN-0665 M2 T2.1）", () => {
    it("renders only when the session has AGENT participants, with the agents-only hint", async () => {
        storeState.participants = [
            participant({ participantId: "human-1", principalKind: "HUMAN" }),
        ];
        const withoutAgents = mountInputArea();
        await flushPromises();
        expect(withoutAgents.find('[data-testid="to-targets-bar"]').exists()).toBe(false);

        storeState.participants = roster();
        const withAgents = mountInputArea();
        await flushPromises();
        expect(withAgents.find('[data-testid="to-targets-bar"]').exists()).toBe(true);
        expect(withAgents.find('[data-testid="to-agents-only-hint"]').text()).toContain(
            "人类成员请用抄送",
        );
    });

    it("does not preselect any target (empty set keeps the legacy single-responder path)", async () => {
        storeState.participants = roster();
        const wrapper = mountInputArea();
        await flushPromises();

        expect(wrapper.findAll('[data-testid="to-targets-chip"]')).toHaveLength(0);
    });

    it("collects multiple targets and emits them as the 5th send argument", async () => {
        storeState.participants = roster();
        const wrapper = mountInputArea();
        await flushPromises();

        await wrapper.get('[data-testid="to-targets-input"]').setValue("Alpha Helper");
        await wrapper.get('[data-testid="to-targets-input"]').trigger("keydown", { key: " " });
        await flushPromises();
        expect(
            wrapper
                .findAll('[data-testid="to-targets-chip"]')
                .map((chip) => chip.attributes("data-participant-id"))
                .sort(),
        ).toEqual([PRIMARY_ID, HELPER_ID].sort());

        await wrapper.get('[data-testid="chat-input"]').setValue("hello both");
        await wrapper.get('[data-testid="chat-send-button"]').trigger("click");
        await flushPromises();

        const emitted = wrapper.emitted("send");
        expect(emitted).toBeTruthy();
        expect(emitted![0][4]).toEqual([PRIMARY_ID, HELPER_ID]);
    });

    it("removes the last target chip ⇒ emits an EXPLICIT empty set (task-450 / F-12)", async () => {
        storeState.participants = roster();
        const wrapper = mountInputArea();
        await flushPromises();

        await wrapper.get('[data-testid="to-targets-input"]').setValue("Helper");
        await wrapper.get('[data-testid="to-targets-input"]').trigger("keydown", { key: " " });
        await flushPromises();
        await wrapper.get('[data-testid="to-targets-chip-remove"]').trigger("click");
        await flushPromises();

        expect(wrapper.findAll('[data-testid="to-targets-chip"]')).toHaveLength(0);
        await wrapper.get('[data-testid="chat-input"]').setValue("hello");
        await wrapper.get('[data-testid="chat-send-button"]').trigger("click");
        await flushPromises();
        // task-450（F-12 / D-1273）：旧断言是 toBeUndefined()，那正是被裁掉的旧行为 ——
        // 「用户显式清空收件人」在 wire 上被表达成「没提收件人」，CP 于是按默认路由 fanOut。
        // CP 只认**显式空数组**才抑制（ChatToTargets.isExplicitEmpty），所以这里必须是 []。
        expect(wrapper.emitted("send")![0][4]).toEqual([]);
    });
});

/**
 * task-450（F-12 / D-1273）：**省略**与**显式空集**是两种意图，不能混。
 * 真栈取证：清空全部 To chip 后 UI 请求体根本没有 toParticipantIds 键
 * （evidence/2026-11-14-instance-flow-audit/task450-empty-to-payload.json）⇒ CP 走默认路由，
 * 智能体照常回话，抑制分支没触发。这里钉住「触碰过 ⇒ 空集也要发」。
 */
describe("InputArea · task-450 省略 vs 显式空集", () => {
    it("从未触碰定向栏 ⇒ 第 5 个参数仍是 undefined（保留旧单响应者路径）", async () => {
        storeState.participants = roster();
        const wrapper = mountInputArea();
        await flushPromises();
        await wrapper.get('[data-testid="chat-input"]').setValue("no recipients touched");
        await wrapper.get('[data-testid="chat-send-button"]').trigger("click");
        await flushPromises();
        expect(wrapper.emitted("send")![0][4]).toBeUndefined();
    });

    it("排队路径同样带显式空集（不能只有立即发送修了）", async () => {
        storeState.participants = roster();
        const wrapper = mount(InputArea, {
            props: { sessionId: "session-1", queueMode: true },
            global: {
                plugins: [
                    createI18n({
                        legacy: false,
                        locale: "zh-CN",
                        fallbackLocale: "zh-CN",
                        messages,
                    }),
                ],
                stubs,
            },
        });
        await flushPromises();
        await wrapper.get('[data-testid="to-targets-input"]').setValue("Helper");
        await wrapper.get('[data-testid="to-targets-input"]').trigger("keydown", { key: " " });
        await flushPromises();
        await wrapper.get('[data-testid="to-targets-chip-remove"]').trigger("click");
        await flushPromises();
        await wrapper.get('[data-testid="chat-input"]').setValue("queued, nobody addressed");
        // 排队态的按钮是 chat-queue-button（InputArea.vue:1503），不是 chat-send-button
        await wrapper.get('[data-testid="chat-queue-button"]').trigger("click");
        await flushPromises();
        expect(wrapper.emitted("queue")![0][4]).toEqual([]);
    });
});

/**
 * task-453（F-16 / Lead 裁 P1，D-1300）：定向发送与默认「代发」的联动。
 * CP 契约（ChatController:569-577，PLAN-0665 M1/Q1）：显式 TO 非空时 asParticipantId 必须
 * **等于首目标**或缺席，否则 400 INVALID_REQUEST。而 InputArea 会自动把代发默认成 PRIMARY
 * （D30-14 历史语义：那时「发送」栏就是单 TO）⇒ 用户一用定向栏就必然冲突。
 * 真栈实证：To=MiMo 直接发 ⇒ 400「asParticipantId conflicts with toParticipantIds[0]」；
 * 手动点掉代发 chip 后同一条 ⇒ 202 且 MiMo 真作答（task445-case-b2/b3.json）。
 */
describe("InputArea · task-453 定向发送让位默认代发", () => {
    function mountWithSpeakAs() {
        storeState.canSpeakAs = true;
        storeState.speakAsCandidates = roster();
        storeState.participants = roster();
        return mountInputArea();
    }

    async function pickTo(wrapper: ReturnType<typeof mountInputArea>, name: string) {
        await wrapper.get('[data-testid="to-targets-input"]').setValue(name);
        await wrapper.get('[data-testid="to-targets-input"]').trigger("keydown", { key: " " });
        await flushPromises();
    }

    async function send(wrapper: ReturnType<typeof mountInputArea>) {
        await wrapper.get('[data-testid="chat-input"]').setValue("hello");
        await wrapper.get('[data-testid="chat-send-button"]').trigger("click");
        await flushPromises();
        return wrapper.emitted("send")![0];
    }

    it("To 非空且首目标≠默认代发 ⇒ 省略 asParticipantId，且代发 chip 不再显示", async () => {
        const wrapper = mountWithSpeakAs();
        await flushPromises();
        expect(wrapper.findAll('[data-testid="speak-as-chip"]')).toHaveLength(1);
        await pickTo(wrapper, "Helper");
        const args = await send(wrapper);
        expect(args[4]).toEqual([HELPER_ID]);
        expect(args[2]).toBeUndefined();
        expect(wrapper.findAll('[data-testid="speak-as-chip"]')).toHaveLength(0);
    });

    it("To 首目标 == 默认代发 ⇒ 保留 asParticipantId（CP 允许相等）", async () => {
        const wrapper = mountWithSpeakAs();
        await flushPromises();
        await pickTo(wrapper, "Alpha");
        const args = await send(wrapper);
        expect(args[4]).toEqual([PRIMARY_ID]);
        expect(args[2]).toBe(PRIMARY_ID);
    });

    it("To 为空 ⇒ 旧单响应者路径不变（仍带默认代发）", async () => {
        const wrapper = mountWithSpeakAs();
        await flushPromises();
        const args = await send(wrapper);
        expect(args[4]).toBeUndefined();
        expect(args[2]).toBe(PRIMARY_ID);
    });
});

/** task-453 follow-up（Lead 准）：让位后抄送候选按**有效**代发排除，而不是原始默认值。 */
describe("InputArea · task-453 让位后的抄送候选", () => {
    it("To 非空让位 ⇒ 默认代发那个人重新可被抄送", async () => {
        storeState.canSpeakAs = true;
        storeState.speakAsCandidates = roster();
        storeState.participants = roster();
        const wrapper = mountInputArea();
        await flushPromises();
        // 抄送栏默认收起，先展开才有 RecipientField（cc-expand）
        await wrapper.get('[data-testid="cc-expand"]').trigger("click");
        await flushPromises();
        const ccField = () =>
            wrapper.findAllComponents(RecipientField).find((f) => f.props("testid") === "cc");
        const candidateIds = () => {
            const field = ccField();
            expect(field, "抄送栏必须已展开").toBeTruthy();
            return (field!.props("candidates") as { participantId: string }[]).map(
                (c) => c.participantId,
            );
        };
        const idsBefore = candidateIds();
        expect(idsBefore).not.toContain(PRIMARY_ID);
        await wrapper.get('[data-testid="to-targets-input"]').setValue("Helper");
        await wrapper.get('[data-testid="to-targets-input"]').trigger("keydown", { key: " " });
        await flushPromises();
        const idsAfter = candidateIds();
        expect(idsAfter).toContain(PRIMARY_ID);
        expect(idsAfter).not.toContain(HELPER_ID);
    });
});
