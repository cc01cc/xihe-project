import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { createPinia, setActivePinia } from "pinia";
import InputArea from "../components/InputArea.vue";
import RecipientField from "../components/RecipientField.vue";
import type { SessionParticipantView } from "../../../../types/participant";

/**
 * PLAN-0665 M2 T2.1 + task-88：composer「发送」多选 chips（1..N 个参与者，真人也算）。
 *
 * task-88：候选不再按 principalKind 过滤 —— task-65 起 CP 接受人类 TO（真人只收「重要通知」、
 * 不作答），所以「纯真人会话」里这一栏必须出现且能选中真人；旧断言（只列 AGENT + 「只能选智能体」
 * 提示）正好把这条能力缺失钉成了"正确"，本卡一并改。
 *
 * 与 0659 的「代发」栏分开：代发是**身份**（单选），发送是**响应者集合**（多选，
 * 每个目标各起一个 run）。这里只钉渲染与发送契约（第 5 个 emit 参数 `toParticipantIds`）。
 *
 * task-50：术语收口为两词制「发送 / 抄送」（用户裁定 P-6）—— 旧的第三词已删除，
 * 该栏的 label 现在就是「发送」，代发身份栏改叫「代发身份」（判据：全仓 grep 旧词命中 0）。
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
                toLabel: "代发身份",
                toTargetsLabel: "发送",
                toEmptyHint: "本条不会通知任何参与者（消息仍会记录在当前会话）",
                toEmptyHintDismiss: "知道了",
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
const HUMAN_ID = "44444444-4444-4444-8444-444444444444";

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

describe("InputArea 发送多选（PLAN-0665 M2 T2.1）", () => {
    it("renders for ANY selectable participant — a humans-only session included (task-88)", async () => {
        // 改前：纯真人会话里「发送」栏整栏消失（候选被 principalKind === "AGENT" 过滤掉，
        // showToTargets 又要求「≥1 个 AGENT」）⇒ 用户 P-6 要的「发送也能给实人」在 UI 上不可达。
        storeState.participants = [
            participant({ participantId: HUMAN_ID, principalKind: "HUMAN" }),
        ];
        const humansOnly = mountInputArea();
        await flushPromises();
        expect(humansOnly.find('[data-testid="to-targets-bar"]').exists()).toBe(true);
        // 「只能选智能体」那条会骗人的提示已删（i18n 键同批删除）——留着它就与产品行为相反。
        expect(humansOnly.find('[data-testid="to-agents-only-hint"]').exists()).toBe(false);

        storeState.participants = roster();
        const withAgents = mountInputArea();
        await flushPromises();
        expect(withAgents.find('[data-testid="to-targets-bar"]').exists()).toBe(true);
    });

    it("selects a HUMAN target and puts it on the wire (task-88 / task-65 delivery contract)", async () => {
        storeState.participants = [
            participant({ participantId: HUMAN_ID, principalKind: "HUMAN", displayName: "Ada" }),
        ];
        const wrapper = mountInputArea();
        await flushPromises();

        await wrapper.get('[data-testid="to-targets-input"]').setValue("Ada");
        await wrapper.get('[data-testid="to-targets-input"]').trigger("keydown", { key: " " });
        await flushPromises();
        expect(
            wrapper
                .findAll('[data-testid="to-targets-chip"]')
                .map((chip) => chip.attributes("data-participant-id")),
        ).toEqual([HUMAN_ID]);

        await wrapper.get('[data-testid="chat-input"]').setValue("给同事的重要通知");
        await wrapper.get('[data-testid="chat-send-button"]').trigger("click");
        await flushPromises();
        expect(wrapper.emitted("send")![0][4]).toEqual([HUMAN_ID]);
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
 * task-453（F-16 / Lead 裁 P1，D-1300）：发送（多选收件人）与默认「代发」的联动。
 * CP 契约（ChatController:569-577，PLAN-0665 M1/Q1）：显式 TO 非空时 asParticipantId 必须
 * **等于首目标**或缺席，否则 400 INVALID_REQUEST。而 InputArea 会自动把代发默认成 PRIMARY
 * （D30-14 历史语义：那时「发送」栏就是单 TO）⇒ 用户一用多选栏就必然冲突。
 * 真栈实证：To=MiMo 直接发 ⇒ 400「asParticipantId conflicts with toParticipantIds[0]」；
 * 手动点掉代发 chip 后同一条 ⇒ 202 且 MiMo 真作答（task445-case-b2/b3.json）。
 */
describe("InputArea · task-453 发送让位默认代发", () => {
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

/**
 * task-17（源 = task-6 候选 C-1）：**显式空 TO 的语义可见性**。
 *
 * <p>背景（task-450 真栈取证）：清空定向栏后发送，wire 上是显式 `[]`、CP 抑制通知
 * ⇒ 消息真的发出去了、真的一个人都没通知，而界面与正常发送一模一样。
 * 这里钉的是**界面说了一句**，且必须是**一次性**的：`chat-to-empty-hint`。</p>
 *
 * <p>三条判据的顺序 = 卡面顺序；反例与正例必须同时存在（只有正例时，"逢发必提示" 也会全绿）。</p>
 */
describe("InputArea · task-17 显式空 TO 的一次性提示", () => {
    const HINT = '[data-testid="chat-to-empty-hint"]';

    async function pickThenClear(wrapper: ReturnType<typeof mountInputArea>, name: string) {
        await wrapper.get('[data-testid="to-targets-input"]').setValue(name);
        await wrapper.get('[data-testid="to-targets-input"]').trigger("keydown", { key: " " });
        await flushPromises();
        await wrapper.get('[data-testid="to-targets-chip-remove"]').trigger("click");
        await flushPromises();
    }

    async function sendText(wrapper: ReturnType<typeof mountInputArea>, text: string) {
        await wrapper.get('[data-testid="chat-input"]').setValue(text);
        await wrapper.get('[data-testid="chat-send-button"]').trigger("click");
        await flushPromises();
    }

    it("① 动过定向栏且最终为空 ⇒ 发送后提示恰好 1 次，且 wire 仍是显式空数组", async () => {
        storeState.participants = roster();
        const wrapper = mountInputArea();
        await flushPromises();
        // 基线：发送前没有提示（这句话只在"真的发出去之后"才有意义，不能提前劝退）。
        expect(wrapper.findAll(HINT)).toHaveLength(0);

        await pickThenClear(wrapper, "Helper");
        await sendText(wrapper, "hello");

        expect(wrapper.findAll(HINT)).toHaveLength(1);
        expect(wrapper.get(HINT).text()).toContain("本条不会通知任何参与者");
        // 提示不得改 wire：显式空集仍是显式空集（CP 只认它来抑制通知）。
        expect(wrapper.emitted("send")![0][4]).toEqual([]);
    });

    it("② 从未动过定向栏 ⇒ 发送后 0 次提示（防「逢发必提示」）", async () => {
        storeState.participants = roster();
        const wrapper = mountInputArea();
        await flushPromises();

        await sendText(wrapper, "no recipients touched");

        expect(wrapper.findAll(HINT)).toHaveLength(0);
        // 与 task-450 同一条不变式：未触碰仍是 undefined（旧单响应者路径）。
        expect(wrapper.emitted("send")![0][4]).toBeUndefined();
    });

    it("③ 一次性：连发 2 次只出现 1 次；关掉后再清空重发也不再出现", async () => {
        storeState.participants = roster();
        const wrapper = mountInputArea();
        await flushPromises();

        await pickThenClear(wrapper, "Helper");
        await sendText(wrapper, "first");
        expect(wrapper.findAll(HINT)).toHaveLength(1);

        // 连发第 2 次：提示不重复出现（同一个节点，不是两条）。
        await sendText(wrapper, "second");
        expect(wrapper.findAll(HINT)).toHaveLength(1);
        expect(wrapper.emitted("send")).toHaveLength(2);

        // 用户关掉它之后，即使再次清空 TO 发送，也不再打扰（语义已教过一次）。
        await wrapper.get('[data-testid="chat-to-empty-hint-dismiss"]').trigger("click");
        expect(wrapper.findAll(HINT)).toHaveLength(0);
        await pickThenClear(wrapper, "Alpha");
        await sendText(wrapper, "third");
        expect(wrapper.findAll(HINT)).toHaveLength(0);
        expect(wrapper.emitted("send")![2][4]).toEqual([]);
    });
});
