import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { createPinia, setActivePinia } from "pinia";
import InputArea from "../components/InputArea.vue";
import type { SessionParticipantView } from "../../../../types/participant";

/**
 * task-55（D-1882③）：composer 的「代发身份」入口**已移除** —— 本文件从「入口行为契约」改写为
 * 「入口缺席 + wire 不带 as + TO 未被牵连」三组钉子。
 *
 * <p>为什么不干脆删掉这个 spec：删掉断言 = 下一个人没有东西挡他重新加回入口（D-1879 同一课，
 * 与「判据先行、产品缺失」互为反面）。这里钉的是**移除本身**，不是旧行为的残留。</p>
 *
 * <p>wire 能力仍然保留：`emit("send")` 的第 3 位、ChatPanel → SSEStream → useSSE 的
 * `asParticipantId` 通路一律未动（本 UI 恒传 undefined ⇒ 字段省略）；排队发送（emit("queue")）
 * 走同一段代码与同一个 undefined，故不再单列用例。数据来源（`selfOwned` 归约、fail-closed）
 * 仍在 `stores/__tests__/sessionParticipants.spec.ts` 验证 —— store 面本卡未动。</p>
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
                // task-114：夹具跟产品走（三栏都有栏外说明）。
                toLabelHint: "本条以所选身份的账号发出，对方看到的是它，不是你",
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

describe("InputArea · task-55 代发身份入口已移除（D-1882③）", () => {
    function mountWithCandidates() {
        storeState.canSpeakAs = true;
        storeState.speakAsCandidates = [
            participant({ participantId: "self", displayName: "Ada Lovelace" }),
            participant({ participantId: "agent", principalKind: "AGENT", displayName: "Helper" }),
        ];
        storeState.participants = [...storeState.speakAsCandidates];
        return mountInputArea();
    }

    // 判据主体：**入口缺席**。能力开着、候选齐了也不许出现任何代发面（旧代码在这里会渲染 speak-as-bar）。
    it("capabilities.speakAs 为真且候选齐备，也不渲染任何代发面", async () => {
        const wrapper = mountWithCandidates();
        await flushPromises();

        for (const testid of [
            "speak-as-bar",
            "speak-as-input",
            "speak-as-chip",
            "speak-as-option",
            "composer-speak-as-hint",
            "speak-as-overridden-hint",
        ]) {
            expect(
                wrapper.find(`[data-testid="${testid}"]`).exists(),
                `代发面 ${testid} 不得再出现（入口已按 D-1882③ 移除）`,
            ).toBe(false);
        }
        wrapper.unmount();
    });

    // 第二轴：wire。发送的第 3 位恒 undefined ⇒ useSSE 的 `if (asParticipantId)` 不写 body 字段。
    it("发送不带 asParticipantId：第 3 位恒 undefined，即使候选里有人", async () => {
        const wrapper = mountWithCandidates();
        await flushPromises();

        await wrapper.get('[data-testid="chat-input"]').setValue("hello");
        await wrapper.get('[data-testid="chat-send-button"]').trigger("click");
        await flushPromises();

        const args = wrapper.emitted("send");
        expect(args).toBeTruthy();
        expect(
            args![0][2],
            "代发入口移除后 UI 不得再带 asParticipantId（D-1882③）",
        ).toBeUndefined();
        wrapper.unmount();
    });

    // 牵连面：本卡只移除代发，「发送（TO）」必须原样还在、照发第 5 位。
    it("「发送（TO）」栏仍在且照发第 5 位 —— 移除只针对代发面", async () => {
        const wrapper = mountWithCandidates();
        await flushPromises();

        expect(
            wrapper.find('[data-testid="to-targets-input"]').exists(),
            "TO 栏不得被本卡牵连删掉（谁作答现在只由 TO 回答）",
        ).toBe(true);

        await wrapper.get('[data-testid="to-targets-input"]').setValue("Helper");
        await wrapper.get('[data-testid="to-targets-input"]').trigger("keydown", { key: " " });
        await wrapper.get('[data-testid="chat-input"]').setValue("hello");
        await wrapper.get('[data-testid="chat-send-button"]').trigger("click");
        await flushPromises();

        const args = wrapper.emitted("send")!;
        expect(args[0][4], "TO 载荷仍走第 5 位").toEqual(["agent"]);
        expect(args[0][2], "同一一次发送不得再带 as").toBeUndefined();
        wrapper.unmount();
    });

    // 防复活钉子：composer 顶层子元素里不再有代发栏 ⇒ 行数判据交给 task-50，这里只钉「代发面为零」。
    it("整个 composer 内没有任何「代发身份」文案（入口缺席的可见面）", async () => {
        const wrapper = mountWithCandidates();
        await flushPromises();

        expect(wrapper.text()).not.toContain("代发");
        wrapper.unmount();
    });
});
