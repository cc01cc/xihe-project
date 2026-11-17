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
                // task-114：夹具跟产品走（三栏都有栏外说明）。
                toLabelHint: "本条以所选身份的账号发出，对方看到的是它，不是你",
                toTargetsLabel: "发送",
                // task-102：夹具跟产品走 —— 两条都回答「会不会被免打扰屏蔽」（旧夹具只有 cc 回答，
                // 且写的是「可能被」而代码两侧都不吃 muted，等于夹具在替过期文案背书）。
                toHint: "相当于 {'@'}，会作为重要通知送达，不会被免打扰屏蔽（可多选）",
                ccHint: "普通抄送通知（不会被免打扰屏蔽）",
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
        workspace: { participantUnknownName: "未知用户" },
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
        // task-102：**同一条问题两条都要回答** —— 只让抄送说「不会被免打扰屏蔽」，读者会以为
        // 重要通知会被屏蔽（事实：HUMAN TO 在 muted 闸之前就 return 了）。
        expect(wrapper.get('[data-testid="composer-send-hint"]').text()).toContain("免打扰");

        await wrapper.get('[data-testid="cc-expand"]').trigger("click");
        await flushPromises();
        // 产品文案是「普通**抄送**通知（…）」—— 用户裁定 P-6 的原话里「抄送」是必须保留的词，
        // 所以这里断两个片段而不是「普通通知」（后者在「普通抄送通知」里不连续，会假红）。
        expect(wrapper.get('[data-testid="composer-cc-hint"]').text()).toContain("普通");
        expect(wrapper.get('[data-testid="composer-cc-hint"]').text()).toContain("抄送通知");
        expect(wrapper.get('[data-testid="composer-cc-hint"]').text()).toContain("免打扰");
        wrapper.unmount();
    });

    it("②b 代发身份也有栏外说明，且与另两条同构（task-114）", async () => {
        const wrapper = mountInputArea();
        await flushPromises();

        const hint = wrapper.get('[data-testid="composer-speak-as-hint"]');
        // 同构判据：类名元组必须与 composer-send-hint / composer-cc-hint 逐字相同
        // （不是「看起来差不多」—— 三栏说明必须是同一种东西，否则就是第四种样式）。
        expect(hint.classes()).toEqual(wrapper.get('[data-testid="composer-send-hint"]').classes());
        await wrapper.get('[data-testid="cc-expand"]').trigger("click");
        await flushPromises();
        expect(wrapper.get('[data-testid="composer-speak-as-hint"]').classes()).toEqual(
            wrapper.get('[data-testid="composer-cc-hint"]').classes(),
        );

        // 文案判据：回答「本条以谁的账号发出」（读者据此知道该选谁），
        // **不是**解释「代发身份」这个词是什么意思 —— 后者对要动手选的人毫无帮助。
        const text = hint.text();
        expect(text).toContain("所选身份");
        expect(text).toContain("账号发出");
        expect(text).toContain("不是你");
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

    it("④ 发送候选含真人（task-88 放开；改前读数 humans=0 / agents=2）", async () => {
        // task-88：task-65 起 CP 接受人类 TO（真人只收通知、不作答），UI 的 kind 过滤是能力缺失。
        // 读数：花名册 2 AGENT + 2 HUMAN，两者都进候选 ⇒ total 4。
        const wrapper = mountInputArea();
        await flushPromises();

        const kinds = candidateKinds("to-targets", wrapper);
        expect(kinds, "发送栏必须在有候选时渲染").not.toBeNull();
        expect(kinds).toEqual({
            total: 4,
            humans: 2,
            agents: 2,
            names: ["Alpha", "Ada Lovelace", "Helper", "Grace Hopper"],
        });
        wrapper.unmount();
    });
});
