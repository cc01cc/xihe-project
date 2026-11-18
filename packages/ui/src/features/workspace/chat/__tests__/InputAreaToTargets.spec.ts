import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { createPinia, setActivePinia } from "pinia";
import InputArea from "../components/InputArea.vue";
import RecipientField from "../components/RecipientField.vue";
import type { SessionParticipantView } from "../../../../types/participant";
import { useAuthStore } from "../../../../stores/auth";

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
                // task-114：夹具跟产品走（三栏都有栏外说明）。
                toLabelHint: "本条以所选身份的账号发出，对方看到的是它，不是你",
                toTargetsLabel: "发送",
                toEmptyHint: "本条不会通知任何参与者（消息仍会记录在当前会话）",
                toEmptyHintDismiss: "知道了",
                ccLabel: "抄送",
                ccAdd: "添加…",
                ccRemove: "移除抄送",
            },
        },
        workspace: {
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
// task-102：调用者本人（登录用户）的 user id —— 名册里那一行的 principalId 就是它。
const SELF_USER_ID = "77777777-7777-4777-8777-777777777777";

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

/** 名册里「我自己的真人行」：HUMAN + principalId === 当前用户 id（types/participant.ts:28）。 */
function selfHumanRow(): SessionParticipantView {
    return participant({
        participantId: "part-self-human",
        principalKind: "HUMAN",
        principalId: SELF_USER_ID,
        displayName: "Me",
        selfOwned: true,
    });
}

/** 读某个 RecipientField 实际收到的候选（props 是唯一真源，不猜 DOM 条数）。 */
function candidatesOf(
    fieldTestid: string,
    wrapper: ReturnType<typeof mountInputArea>,
): SessionParticipantView[] | null {
    const field = wrapper
        .findAllComponents(RecipientField)
        .find((item) => item.props("testid") === fieldTestid);
    return field ? (field.props("candidates") as SessionParticipantView[]) : null;
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
    // task-102：把「当前登录用户」显式钉成 SELF_USER_ID（真 store，不 mock）——
    // 否则 currentUserId 恒空、剔除逻辑永远不触发，新用例就等于没测。
    useAuthStore().user = { id: SELF_USER_ID, email: "me@example.com" };
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
 * task-55（D-1882③）改写：本节原先钉「发送（多选收件人）与默认代发」的联动（task-453 / F-16 / D-1300：
 * CP 要求 TO 非空时 `asParticipantId` 必须等于首目标或缺席，否则 400 INVALID_REQUEST）。
 * composer 的代发身份入口已移除 ⇒ UI 恒**不发**该字段，联动退化成一条单向判据：
 * **任何 TO 形态下 emit 第 3 位都是 undefined**。
 * 真栈实证见 internal/A03-xihe/evidence/2026-11-19-branchid-mainpath/（task-53）：
 * POST body 键集不含 asParticipantId、TO=[ewLead] ⇒ 202 且 run 归属 ewLead。
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

    it("To 非空 ⇒ 第 5 位是 TO、第 3 位恒 undefined（代发入口已移除）", async () => {
        const wrapper = mountWithSpeakAs();
        await flushPromises();
        expect(
            wrapper.findAll('[data-testid="speak-as-chip"]'),
            "composer 不得再渲染代发面（D-1882③）",
        ).toHaveLength(0);
        await pickTo(wrapper, "Helper");
        const args = await send(wrapper);
        expect(args[4]).toEqual([HELPER_ID]);
        expect(args[2]).toBeUndefined();
    });

    /**
     * task-114 的栏外说明与 task-453 的让位提示描述的都是**已经不存在的控件** ⇒ 两个 testid 必须都不出现。
     * 只钉「新元素不在」而不钉「旧元素也不在」，就会留下幽灵说明：DOM 里有文案、界面上没控件。
     */
    it("task-114 / task-453 的代发说明均不渲染（入口移除后不留幽灵文案）", async () => {
        const wrapper = mountWithSpeakAs();
        await flushPromises();
        for (const id of ["composer-speak-as-hint", "speak-as-overridden-hint"]) {
            expect(
                wrapper.find('[data-testid="' + id + '"]').exists(),
                id + " 必须随代发入口一起移除（D-1882③）",
            ).toBe(false);
        }
        await pickTo(wrapper, "Helper");
        expect(wrapper.find('[data-testid="speak-as-overridden-hint"]').exists()).toBe(false);
    });

    it("To 首目标 == 原默认代发 ⇒ 仍不带 as（相等分支随入口一起消失）", async () => {
        const wrapper = mountWithSpeakAs();
        await flushPromises();
        await pickTo(wrapper, "Alpha");
        const args = await send(wrapper);
        expect(args[4]).toEqual([PRIMARY_ID]);
        expect(args[2], "缺席是 CP 允许的形态：归属由 TO 里第一个 AGENT 目标决定").toBeUndefined();
    });

    it("To 为空 ⇒ 第 5 位省略、第 3 位同样省略（旧单响应者路径由 CP 默认）", async () => {
        const wrapper = mountWithSpeakAs();
        await flushPromises();
        const args = await send(wrapper);
        expect(args[4]).toBeUndefined();
        expect(args[2], "入口移除后 UI 不再自动带 PRIMARY 代发（D-1882③）").toBeUndefined();
    });
});

/** task-55（D-1882③）：原节钉「让位后抄送候选按**有效**代发排除」；入口移除后没有代发可排除。 */
describe("InputArea · task-55 抄送候选不再排除代发身份", () => {
    it("原默认代发（PRIMARY）现在恒在抄送候选里", async () => {
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
        // 改前这一格**不含** PRIMARY（默认代发把它剔掉了）⇒ 翻转是本卡的真实语义变化，不是笔误。
        expect(candidateIds()).toContain(PRIMARY_ID);
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

describe("task-102：TO/CC 候选排除「调用者自己的真人行」", () => {
    it("TO 候选不含自己，但别人的真人行与 AGENT 行都还在", async () => {
        storeState.participants = [
            ...roster(),
            selfHumanRow(),
            participant({ participantId: HUMAN_ID, principalKind: "HUMAN", displayName: "Ada" }),
        ];
        const wrapper = mountInputArea();
        await flushPromises();

        const candidates = candidatesOf("to-targets", wrapper);
        expect(candidates, "发送栏必须渲染").not.toBeNull();
        const ids = candidates!.map((item) => item.participantId);
        // ① 自己的真人行不在候选里（CP 对它会返回 400 PARTICIPANT_SELF_TARGET）。
        expect(ids).not.toContain("part-self-human");
        // ② 别人的真人行没被一起剔掉 —— 防「整栏过滤过宽」（task-88 的人类 TO 能力还在）。
        expect(ids).toContain(HUMAN_ID);
        // ③ AGENT 行也还在（202 的正常形态：as ∈ TO 合法，不得剔除）。
        expect(ids).toContain(PRIMARY_ID);
        expect(ids).toContain(HELPER_ID);
        wrapper.unmount();
    });

    it("抄送候选同样不含自己（与发送同一口径）", async () => {
        storeState.participants = [
            ...roster(),
            selfHumanRow(),
            participant({ participantId: HUMAN_ID, principalKind: "HUMAN", displayName: "Ada" }),
        ];
        const wrapper = mountInputArea();
        await flushPromises();
        await wrapper.get('[data-testid="cc-expand"]').trigger("click");
        await flushPromises();

        const candidates = candidatesOf("cc", wrapper);
        expect(candidates, "抄送栏必须展开并带候选").not.toBeNull();
        const ids = candidates!.map((item) => item.participantId);
        expect(ids).not.toContain("part-self-human");
        expect(ids).toContain(HUMAN_ID);
        wrapper.unmount();
    });

    it("原代发候选与某个 AGENT 目标同行时：TO 候选仍含它，但 as 不再发", async () => {
        // task-55（D-1882③）改写。Lead 2026-11-15 的旧判据「以 A 代发 + TO=[A] ⇒ CP 判 202」仍然成立，
        // 但 UI 现在只走 TO 一条轴：候选照旧含 A，第 3 位恒 undefined ⇒ 归属由 TO 里第一个 AGENT 目标决定。
        storeState.canSpeakAs = true;
        storeState.speakAsCandidates = [roster()[0]];
        storeState.participants = roster();
        const wrapper = mountInputArea();
        await flushPromises();

        expect(candidatesOf("to-targets", wrapper)!.map((item) => item.participantId)).toContain(
            PRIMARY_ID,
        );

        await wrapper.get('[data-testid="to-targets-input"]').setValue("Alpha");
        await wrapper.get('[data-testid="to-targets-input"]').trigger("keydown", { key: " " });
        await flushPromises();
        expect(
            wrapper.findAll('[data-testid="speak-as-chip"]'),
            "代发面不得复活（D-1882③）",
        ).toHaveLength(0);

        await wrapper.get('[data-testid="chat-input"]').setValue("通知 A 并由 A 作答");
        await wrapper.get('[data-testid="chat-send-button"]').trigger("click");
        await flushPromises();
        const args = wrapper.emitted("send")![0];
        expect(args[2], "UI 恒不带 asParticipantId").toBeUndefined();
        expect(args[4]).toEqual([PRIMARY_ID]);
        wrapper.unmount();
    });

    it("store 的 speakAsCandidates 仍在（CP 投影未动），但 UI 不再渲染它的候选", async () => {
        // task-55（D-1882③）：本卡只移除入口，store 面一律不动 —— speakAsCandidates 仍在原处产出，
        // 只是没有任何控件消费它。**两套候选仍是两个对象**，这条判据的轴从「候选形状」换成「不渲染」。
        storeState.canSpeakAs = true;
        storeState.speakAsCandidates = [selfHumanRow()];
        storeState.participants = [...roster(), selfHumanRow()];
        const wrapper = mountInputArea();
        await flushPromises();

        expect(storeState.speakAsCandidates.map((item) => item.participantId)).toContain(
            "part-self-human",
        );
        expect(
            candidatesOf("speak-as", wrapper),
            "代发面已移除，不该再有任何 speak-as 候选浮层（D-1882③）",
        ).toBeNull();
        wrapper.unmount();
    });
});
/**
 * task-124（源 `cp-1` 的 `task-121`）：**删光 TO chip 但保留 CC chip 时，emit 出去的是什么**。
 *
 * <p>与 `task-450` 的区别：那条只钉 TO 三态（省略 / 显式 `[]` / 非空），**没有 CC 参与**；
 * 而 `cp-1` 要的前提是「显式空 TO **和** 非空 CC 同一次发送」⇒ 两参必须同时被钉住，
 * 否则「UI 吞了 CC」与「CP 抑制了 CC」无法区分。</p>
 *
 * <p>emit 参数位：`0 text / 1 attachments / 2 asParticipantId / 3 cc / 4 toParticipantIds`。</p>
 */
describe("InputArea · task-124 显式空 TO 与非空 CC 同发", () => {
    it("删光 TO chip、保留 CC chip ⇒ 第 5 参 [] 且第 4 参非空", async () => {
        storeState.participants = roster();
        const wrapper = mountInputArea();
        await flushPromises();

        // 抄送栏默认收起，先展开才有 RecipientField（cc-expand）
        await wrapper.get('[data-testid="cc-expand"]').trigger("click");
        await flushPromises();
        await wrapper.get('[data-testid="cc-input"]').setValue("Alpha");
        await wrapper.get('[data-testid="cc-input"]').trigger("keydown", { key: " " });
        await flushPromises();
        expect(wrapper.findAll('[data-testid="cc-chip"]').length, "CC chip 必须先落座").toBe(1);

        // 选一个 TO 再删光它 —— 这一删就是「用户清空了收件人」的意图。
        await wrapper.get('[data-testid="to-targets-input"]').setValue("Helper");
        await wrapper.get('[data-testid="to-targets-input"]').trigger("keydown", { key: " " });
        await flushPromises();
        await wrapper.get('[data-testid="to-targets-chip-remove"]').trigger("click");
        await flushPromises();

        await wrapper.get('[data-testid="chat-input"]').setValue("hello");
        await wrapper.get('[data-testid="chat-send-button"]').trigger("click");
        await flushPromises();

        const emitted = wrapper.emitted("send")![0]!;
        // 索引 4 = toParticipantIds：必须是显式空集（省略会被 CP 读成「没提收件人」）。
        expect(emitted[4], "TO 必须是显式空集").toEqual([]);
        // 索引 3 = cc：必须照发 —— 这半句才是 `cp-1` 缺的前提。
        expect(Array.isArray(emitted[3]), "CC 必须存在").toBe(true);
        expect((emitted[3] as string[]).length).toBe(1);
    });
});
