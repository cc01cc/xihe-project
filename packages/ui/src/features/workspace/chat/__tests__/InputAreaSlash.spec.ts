import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type DOMWrapper } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { createPinia, setActivePinia } from "pinia";
import InputArea from "../components/InputArea.vue";
import type { SessionParticipantView } from "../../../../types/participant";

/**
 * PLAN-0635 M1 ②：`/` 命令面。
 *
 * **本文件改写自一个"保护缺陷"的版本**：旧 spec 的最后一条断言"选 `/help` 后 `emit("send")` 为真"
 * —— 而当时的实现是把一句固定英文提示当用户消息发给模型。也就是说那条测试把 bug 断言成了正确行为。
 * 现在 `/` 在 M1 是**纯本地命令**，断言方向统一为"**不产生 send**"。
 *
 * `/search`（死命令）与 `/export`（假命令）已删除，故同时断言它们**不再出现**。
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

// PLAN-0635 M2: the component also reads the workspace tree for `@文件`; `/` never uses it.
vi.mock("../../stores/workspace", () => ({
    useWorkspaceStore: () => ({ fileTree: [] }),
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
                filesTitle: "Files and folders",
                mentionAll: "Everyone",
                mentionAgent: "Agent",
                mentionHuman: "Human",
                mentionFile: "File",
                mentionDirectory: "Folder",
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

function mountInput() {
    const i18n = createI18n({ legacy: false, locale: "en", messages });
    return mount(InputArea, {
        props: { sessionId: "session-1" },
        global: { plugins: [i18n], stubs },
    });
}

async function typeText(textarea: DOMWrapper<HTMLTextAreaElement>, value: string): Promise<void> {
    const element = textarea.element;
    element.value = value;
    element.selectionStart = value.length;
    element.selectionEnd = value.length;
    await textarea.trigger("input");
    await flushPromises();
}

beforeEach(() => {
    setActivePinia(createPinia());
    storeState.participants = null;
    storeState.canSpeakAs = false;
    storeState.speakAsCandidates = [];
    storeState.ensureLoaded.mockReset();
});

describe("InputArea slash commands (PLAN-0635 M1)", () => {
    it("shows the command menu when / is typed", async () => {
        const wrapper = mountInput();
        await typeText(wrapper.find("textarea"), "/");

        expect(wrapper.find('[role="listbox"]').exists()).toBe(true);
        expect(wrapper.text()).toContain("/clear");
        expect(wrapper.text()).toContain("/help");
    });

    it("no longer offers /search or /export (both were fake commands)", async () => {
        const wrapper = mountInput();
        await typeText(wrapper.find("textarea"), "/");

        expect(wrapper.text()).not.toContain("/search");
        expect(wrapper.text()).not.toContain("/export");
    });

    it("renders localized command hints instead of hardcoded English descriptions", async () => {
        const wrapper = mountInput();
        await typeText(wrapper.find("textarea"), "/");

        expect(wrapper.text()).toContain("Clear the draft (does not send)");
        expect(wrapper.text()).toContain("Show available commands");
    });

    it("hides the command menu once a space is typed", async () => {
        const wrapper = mountInput();
        const textarea = wrapper.find("textarea");
        await typeText(textarea, "/cl");
        expect(wrapper.find('[role="listbox"]').exists()).toBe(true);

        await typeText(textarea, "/cl some arg");
        expect(wrapper.find('[role="listbox"]').exists()).toBe(false);
    });

    it("filters commands as the user types", async () => {
        const wrapper = mountInput();
        await typeText(wrapper.find("textarea"), "/he");

        const labels = wrapper.findAll('[role="option"]').map((item) => item.text());
        expect(labels.some((label) => label.includes("/help"))).toBe(true);
        expect(labels.some((label) => label.includes("/clear"))).toBe(false);
    });

    it("closes the menu on Escape", async () => {
        const wrapper = mountInput();
        const textarea = wrapper.find("textarea");
        await typeText(textarea, "/");
        expect(wrapper.find('[role="listbox"]').exists()).toBe(true);

        await textarea.trigger("keydown", { key: "Escape" });
        await flushPromises();
        expect(wrapper.find('[role="listbox"]').exists()).toBe(false);
    });

    it("runs /help locally: renders the command list, sends nothing, clears the draft", async () => {
        const wrapper = mountInput();
        const textarea = wrapper.find("textarea");
        await typeText(textarea, "/help");

        await textarea.trigger("keydown", { key: "Enter" });
        await flushPromises();

        // The regression this test exists for: /help must never be emitted as a message.
        expect(wrapper.emitted("send")).toBeFalsy();
        expect(wrapper.emitted("queue")).toBeFalsy();
        expect(wrapper.find('[data-testid="chat-input-help"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="chat-input-help"]').text()).toContain("/clear");
        expect((wrapper.find("textarea").element as HTMLTextAreaElement).value).toBe("");
    });

    it("still runs /help locally when it is submitted as plain text", async () => {
        const wrapper = mountInput();
        const textarea = wrapper.find("textarea");
        // Trailing space closes the menu, so Enter reaches the send path — the guard must catch it.
        await typeText(textarea, "/help ");

        await textarea.trigger("keydown", { key: "Enter" });
        await flushPromises();

        expect(wrapper.emitted("send")).toBeFalsy();
        expect(wrapper.find('[data-testid="chat-input-help"]').exists()).toBe(true);
    });

    it("runs /clear locally: clears the draft and sends nothing", async () => {
        const wrapper = mountInput();
        const textarea = wrapper.find("textarea");
        await typeText(textarea, "/clear");

        await textarea.trigger("keydown", { key: "Enter" });
        await flushPromises();

        expect(wrapper.emitted("send")).toBeFalsy();
        expect((wrapper.find("textarea").element as HTMLTextAreaElement).value).toBe("");
        expect(wrapper.find('[role="listbox"]').exists()).toBe(false);
    });

    it("exposes listbox/option/aria-activedescendant for assistive tech", async () => {
        const wrapper = mountInput();
        const textarea = wrapper.find("textarea");
        await typeText(textarea, "/");

        const listbox = wrapper.find('[role="listbox"]');
        expect(listbox.attributes("aria-label")).toBe("Commands");

        const options = wrapper.findAll('[role="option"]');
        expect(options.length).toBe(2);
        expect(options[0]!.attributes("aria-selected")).toBe("true");
        expect(options[1]!.attributes("aria-selected")).toBe("false");

        expect(textarea.attributes("aria-expanded")).toBe("true");
        expect(textarea.attributes("aria-controls")).toBe("chat-input-trigger-menu");
        expect(textarea.attributes("aria-activedescendant")).toBe(options[0]!.attributes("id"));
    });

    it("keeps sending normal text (the trigger must not swallow Enter)", async () => {
        const wrapper = mountInput();
        const textarea = wrapper.find("textarea");
        await typeText(textarea, "hello team");

        await textarea.trigger("keydown", { key: "Enter" });
        await flushPromises();

        expect(wrapper.emitted("send")).toBeTruthy();
    });
});
