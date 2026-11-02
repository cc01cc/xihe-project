import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type DOMWrapper } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { createPinia, setActivePinia } from "pinia";
import InputArea from "../components/InputArea.vue";
import type { SessionParticipantView } from "../../../../types/participant";

/**
 * PLAN-0635 M1 ①：`@` 成员候选（同一输入触发器面，见 `InputArea.vue` 的 `TriggerKind`）。
 *
 * store 用受控替身：数据来源（roster 归约、fail-closed）已由
 * `stores/__tests__/sessionParticipants.spec.ts` 覆盖，这里只验**触发 / 候选 / 插入 / 键盘 / aria**。
 *
 * ⚠️ 插入格式的尾空格是**wire 契约**（`MentionParser` 要求名字后有空白边界），
 * 所以下面有一条断言专门钉住它 —— 去掉尾空格不会让任何 UI 测试变红，只会让提及静默失效。
 */
const storeState = vi.hoisted(() => ({
    canSpeakAs: false,
    speakAsCandidates: [] as SessionParticipantView[],
    participants: null as SessionParticipantView[] | null,
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
    en: {
        chat: {
            placeholder: "Type a message...",
            send: "Send",
            stop: "Stop",
            input: {
                commandsTitle: "Commands",
                mentionsTitle: "Session members",
                mentionAll: "Everyone",
                mentionAgent: "Agent",
                mentionHuman: "Human",
                commandClear: "Clear the draft (does not send)",
                commandHelp: "Show available commands",
                helpTitle: "Available commands",
                helpHint: "↑↓ to select, Enter to insert, Esc to close",
            },
        },
        workspace: { participantUnknownName: "Unknown" },
        multimodal: { image: "Image", screenshot: "Screenshot", voice: "Voice" },
        common: { cancel: "Cancel" },
    },
};

// Multimodal children are irrelevant here and `ScreenshotCapture` reads `navigator.mediaDevices`
// at setup time — stub them instead of patching browser globals (same approach as
// `InputAreaSpeakAs.spec.ts`).
const stubs = {
    ModelPopover: { template: "<div />" },
    LoaderCircle: { template: "<span />" },
    ImageUpload: { template: "<div />" },
    FileUpload: { template: "<div />" },
    ScreenshotCapture: { template: "<div />" },
    VoiceInput: { template: "<div />" },
};

function participant(overrides: Partial<SessionParticipantView>): SessionParticipantView {
    return {
        participantId: "p",
        principalKind: "HUMAN",
        principalId: "00000000-0000-4000-8000-000000000001",
        displayName: "Ada Lovelace",
        role: "MEMBER",
        orderIndex: 10,
        wakePolicy: "MENTION",
        respondPolicy: "WHEN_MENTIONED",
        disabledAt: null,
        ...overrides,
    };
}

function mountInput() {
    const i18n = createI18n({ legacy: false, locale: "en", messages });
    return mount(InputArea, {
        props: { sessionId: "session-1" },
        global: { plugins: [i18n], stubs },
    });
}

/**
 * Type text into the textarea the way a user does: caret at the end, then an `input` event.
 * `setSelectionRange` matters — the trigger reads `selectionStart` to decide the replace range.
 */
async function typeText(textarea: DOMWrapper<HTMLTextAreaElement>, value: string): Promise<void> {
    const element = textarea.element;
    element.value = value;
    element.selectionStart = value.length;
    element.selectionEnd = value.length;
    await textarea.trigger("input");
    await flushPromises();
}

function menu(wrapper: ReturnType<typeof mountInput>) {
    return wrapper.find('[role="listbox"]');
}

beforeEach(() => {
    setActivePinia(createPinia());
    storeState.participants = null;
    storeState.canSpeakAs = false;
    storeState.speakAsCandidates = [];
    storeState.ensureLoaded.mockReset();
});

describe("InputArea @ mention candidates (PLAN-0635 M1)", () => {
    it("opens the mention menu when @ is typed at a word start", async () => {
        storeState.participants = [participant({})];
        const wrapper = mountInput();
        await typeText(wrapper.find("textarea"), "@");

        expect(menu(wrapper).exists()).toBe(true);
        expect(wrapper.text()).toContain("@Ada Lovelace");
        // `@all` is a fixed candidate and comes first.
        expect(wrapper.text()).toContain("@all");
    });

    it("filters candidates by the text after @", async () => {
        storeState.participants = [
            participant({ participantId: "p1", displayName: "Ada Lovelace" }),
            participant({ participantId: "p2", displayName: "Grace Hopper" }),
        ];
        const wrapper = mountInput();
        await typeText(wrapper.find("textarea"), "@gra");

        const labels = wrapper.findAll('[role="option"]').map((item) => item.text());
        expect(labels.some((label) => label.includes("@Grace Hopper"))).toBe(true);
        expect(labels.some((label) => label.includes("@Ada Lovelace"))).toBe(false);
        // "all" does not start with "gra" ⇒ the fixed candidate is filtered out too.
        expect(labels.some((label) => label.includes("@all"))).toBe(false);
    });

    it("does not open for a @ glued to a preceding word (email address)", async () => {
        storeState.participants = [participant({})];
        const wrapper = mountInput();
        await typeText(wrapper.find("textarea"), "ada@example.com");

        expect(menu(wrapper).exists()).toBe(false);
    });

    it("stays closed when nothing matches (silent, no empty menu)", async () => {
        storeState.participants = [participant({})];
        const wrapper = mountInput();
        await typeText(wrapper.find("textarea"), "@zzz");

        expect(menu(wrapper).exists()).toBe(false);
    });

    it("excludes disabled participants", async () => {
        storeState.participants = [
            participant({ participantId: "p1", displayName: "Ada Lovelace" }),
            participant({
                participantId: "p2",
                displayName: "Retired Member",
                disabledAt: "2026-11-02T00:00:00Z",
            }),
        ];
        const wrapper = mountInput();
        await typeText(wrapper.find("textarea"), "@retired");

        expect(menu(wrapper).exists()).toBe(false);
    });

    it("inserts `@displayName ` with the trailing space MentionParser requires", async () => {
        storeState.participants = [participant({})];
        const wrapper = mountInput();
        const textarea = wrapper.find("textarea");
        await typeText(textarea, "@ada");

        // index 0 is `@all`; ArrowDown moves to the participant.
        await textarea.trigger("keydown", { key: "ArrowDown" });
        await textarea.trigger("keydown", { key: "Enter" });
        await flushPromises();

        // Exact string, trailing space included — this is the wire contract, not formatting.
        expect((wrapper.find("textarea").element as HTMLTextAreaElement).value).toBe(
            "@Ada Lovelace ",
        );
        expect(wrapper.emitted("send")).toBeFalsy();
        expect(menu(wrapper).exists()).toBe(false);
    });

    it("inserts the fixed @all candidate", async () => {
        storeState.participants = [participant({})];
        const wrapper = mountInput();
        const textarea = wrapper.find("textarea");
        await typeText(textarea, "@");

        await textarea.trigger("keydown", { key: "Enter" });
        await flushPromises();

        expect((wrapper.find("textarea").element as HTMLTextAreaElement).value).toBe("@all ");
    });

    it("replaces only the typed token, keeping surrounding text", async () => {
        storeState.participants = [participant({})];
        const wrapper = mountInput();
        const textarea = wrapper.find("textarea");
        await typeText(textarea, "hello @ada");

        await textarea.trigger("keydown", { key: "ArrowDown" });
        await textarea.trigger("keydown", { key: "Enter" });
        await flushPromises();

        expect((wrapper.find("textarea").element as HTMLTextAreaElement).value).toBe(
            "hello @Ada Lovelace ",
        );
    });

    it("closes the menu with Escape without inserting", async () => {
        storeState.participants = [participant({})];
        const wrapper = mountInput();
        const textarea = wrapper.find("textarea");
        await typeText(textarea, "@");

        await textarea.trigger("keydown", { key: "Escape" });
        await flushPromises();

        expect(menu(wrapper).exists()).toBe(false);
        expect((wrapper.find("textarea").element as HTMLTextAreaElement).value).toBe("@");
    });

    it("does not open while an IME composition is in progress", async () => {
        storeState.participants = [participant({})];
        const wrapper = mountInput();
        const textarea = wrapper.find("textarea");

        await textarea.trigger("compositionstart");
        await typeText(textarea, "@");

        expect(menu(wrapper).exists()).toBe(false);
    });

    it("exposes listbox/option/aria-activedescendant for assistive tech", async () => {
        storeState.participants = [participant({})];
        const wrapper = mountInput();
        const textarea = wrapper.find("textarea");
        await typeText(textarea, "@");

        const listbox = menu(wrapper);
        expect(listbox.attributes("role")).toBe("listbox");
        expect(listbox.attributes("aria-label")).toBe("Session members");

        const options = wrapper.findAll('[role="option"]');
        expect(options.length).toBeGreaterThan(0);
        expect(options[0]!.attributes("aria-selected")).toBe("true");
        expect(options[1]!.attributes("aria-selected")).toBe("false");

        // The textarea holds the expanded state; selection moves via aria-activedescendant.
        expect(textarea.attributes("aria-expanded")).toBe("true");
        expect(textarea.attributes("aria-controls")).toBe("chat-input-trigger-menu");
        expect(textarea.attributes("aria-activedescendant")).toBe(options[0]!.attributes("id"));
    });
});
