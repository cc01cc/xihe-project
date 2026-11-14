import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { createPinia, setActivePinia } from "pinia";
import InputArea from "../components/InputArea.vue";
import RecipientField from "../components/RecipientField.vue";
import type { SessionParticipantView } from "../../../../types/participant";

/**
 * task-50（用户裁定 P-6）：composer 术语两词制 —— 「发送」= @ 重要通知，「抄送」= 普通通知。
 *
 * <p>钉四件事，任何一条单独成立都不够：
 * ① 两个栏的 label 就是「发送 / 抄送」，身份选择叫「代发身份」（字典里不能再出现两个「发送」）；
 * ② 两栏各自的语义说明**可见**（用户看不出差别时，两个词等于一个词）；
 * ③ 抄送候选里**必须有人类参与者**（改前读数：mock 花名册 1 HUMAN + 1 AGENT，抄送栏有真人）；
 * ④ 发送候选仍**只列智能体** —— CP 侧对人类目标硬抛 400（`SessionParticipantService`
 *    `authorizeToTargets`，注释挂 BL-238），放开要等 task-48/task-49。这条是**护栏**，
 *    等 CP 放开时由 task-49 翻转成「人类也在发送候选里」。</p>
 */
const storeState = vi.hoisted(() => ({
    canSpeakAs: true,
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
            placeholder: "输入消息…",
            send: "发送",
            stop: "停止",
            followUpComposerNotice: "当前任务之后执行",
            followUpPausedNotice: "追加到暂停队列末尾",
            followUpFullNotice: "队列已满，草稿保留",
            delegation: { button: "委派", reasonUnknown: "未知原因" },
            input: {
                toLabel: "代发身份",
                toTargetsLabel: "发送",
                toHint: "相当于 {'@'}，会作为重要通知送达（可多选）",
                ccHint: "普通通知（可能被免打扰屏蔽）",
                toAgentsOnlyHint: "发送目前只能选智能体；给真人请用抄送",
                toEmptyHint: "本条不会通知任何参与者（消息仍会记录在当前会话）",
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
        },
        workspace: { speakAsLabel: "以此身份发言", participantUnknownName: "未知用户" },
        multimodal: { image: "图片", screenshot: "截屏", voice: "语音" },
        common: { cancel: "取消" },
    },
};

const stubs = {
    ImageUpload: { template: "<div />" },
    FileUpload: { template: "<div />" },
    ScreenshotCapture: { template: "<div />" },
    VoiceInput: { template: "<div />" },
};

const PRIMARY_ID = "11111111-1111-4111-8111-111111111111";
const SELF_ID = "22222222-2222-4222-8222-222222222222";
const HELPER_ID = "33333333-3333-4333-8333-333333333333";
const COLLEAGUE_ID = "44444444-4444-4444-8444-444444444444";

function participant(overrides: Partial<SessionParticipantView>): SessionParticipantView {
    return {
        participantId: "p",
        principalKind: "HUMAN",
        principalId: "5a2b7c9d-2222-4222-8222-bbbbbbbbbbbb",
        displayName: "Ada Lovelace",
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

/** 花名册与 mock 夹具同形（1 个真人 + 1 个智能体），另加一个真人同事与一个智能体助手。 */
function roster(): SessionParticipantView[] {
    return [
        participant({
            participantId: PRIMARY_ID,
            principalKind: "AGENT",
            displayName: "Alpha",
            role: "PRIMARY",
            orderIndex: 10,
        }),
        participant({ participantId: SELF_ID, displayName: "Ada Lovelace" }),
        participant({
            participantId: HELPER_ID,
            principalKind: "AGENT",
            displayName: "Helper",
            orderIndex: 30,
        }),
        participant({ participantId: COLLEAGUE_ID, displayName: "Grace Hopper", selfOwned: false }),
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

function candidateKinds(fieldTestid: string, wrapper: ReturnType<typeof mountInputArea>) {
    const field = wrapper
        .findAllComponents(RecipientField)
        .find((item) => item.props("testid") === fieldTestid);
    if (!field) return null;
    const candidates = field.props("candidates") as SessionParticipantView[];
    return {
        total: candidates.length,
        humans: candidates.filter((item) => item.principalKind === "HUMAN").length,
        agents: candidates.filter((item) => item.principalKind === "AGENT").length,
        names: candidates.map((item) => item.displayName),
    };
}

beforeEach(() => {
    setActivePinia(createPinia());
    storeState.canSpeakAs = true;
    storeState.participants = roster();
    storeState.speakAsCandidates = roster().filter((item) => item.selfOwned);
    storeState.ensureLoaded.mockReset();
    storeState.ensureLoaded.mockResolvedValue(undefined);
});

describe("task-50 composer 两词制（发送 / 抄送）", () => {
    it("① 栏位定义：发送 = 收件人（多选），代发身份 = 身份（单选），抄送 = 抄送", async () => {
        const wrapper = mountInputArea();
        await flushPromises();

        expect(wrapper.get('[data-testid="to-targets-bar"]').attributes("data-testid")).toBe(
            "to-targets-bar",
        );
        // RecipientField 把 label 渲染成首段文本；这里断言三个栏各自的 label 不再互相撞词。
        expect(wrapper.get('[data-testid="speak-as-bar"]').text()).toContain("代发身份");
        expect(wrapper.get('[data-testid="to-targets-bar"]').text()).toContain("发送");
        expect(wrapper.get('[data-testid="to-targets-bar"]').text()).not.toContain("代发");

        await wrapper.get('[data-testid="cc-expand"]').trigger("click");
        await flushPromises();
        expect(wrapper.get('[data-testid="cc-bar"]').text()).toContain("抄送");
        wrapper.unmount();
    });

    it("② 两栏的语义说明可见：发送 = @ 重要通知；抄送 = 普通通知", async () => {
        const wrapper = mountInputArea();
        await flushPromises();

        expect(wrapper.get('[data-testid="composer-send-hint"]').text()).toContain("相当于 @");
        expect(wrapper.get('[data-testid="composer-send-hint"]').text()).toContain("重要通知");
        expect(wrapper.get('[data-testid="composer-send-hint"]').text()).toContain("可多选");
        // 人类目标尚未开放这件事要说出来（不是静默少一个选项）
        expect(wrapper.get('[data-testid="to-agents-only-hint"]').text()).toContain("只能选智能体");
        expect(wrapper.get('[data-testid="to-agents-only-hint"]').text()).toContain("抄送");

        await wrapper.get('[data-testid="cc-expand"]').trigger("click");
        await flushPromises();
        expect(wrapper.get('[data-testid="composer-cc-hint"]').text()).toContain("普通通知");
        wrapper.unmount();
    });

    it("③ 抄送候选里有人类参与者（改前/改后都成立，防线不是本次新增）", async () => {
        const wrapper = mountInputArea();
        await flushPromises();
        await wrapper.get('[data-testid="cc-expand"]').trigger("click");
        await flushPromises();

        const kinds = candidateKinds("cc", wrapper);
        expect(kinds, "抄送栏必须渲染并带候选").not.toBeNull();
        // 花名册 2 AGENT + 2 HUMAN；默认代发（PRIMARY=Alpha）被排除 ⇒ 1 AGENT + 2 HUMAN = 3 条。
        // 这几个数是**读数**不是装饰：改前就是这个形状（抄送栏本来就能选真人），
        // 所以「人类从候选里消失」只可能是回归 —— 那就是下面 mutation 要抓的东西。
        expect(kinds).toEqual({
            total: 3,
            humans: 2,
            agents: 1,
            names: ["Ada Lovelace", "Helper", "Grace Hopper"],
        });
        wrapper.unmount();
    });

    it("④ 发送候选仍只列智能体（CP 对人类目标硬 400；放开归 task-48/task-49）", async () => {
        const wrapper = mountInputArea();
        await flushPromises();

        const kinds = candidateKinds("to-targets", wrapper);
        expect(kinds, "发送栏必须在有 AGENT 时渲染").not.toBeNull();
        expect(kinds?.humans).toBe(0);
        expect(kinds?.agents).toBe(2);
        wrapper.unmount();
    });
});
