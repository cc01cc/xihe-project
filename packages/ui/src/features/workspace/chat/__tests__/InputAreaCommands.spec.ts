import { beforeEach, describe, expect, it, vi } from "vitest";
import { effectScope, ref } from "vue";
import { flushPromises, mount, type DOMWrapper } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { createPinia, setActivePinia } from "pinia";
import InputArea from "../components/InputArea.vue";
import { useSessionCommands } from "../composables/useSessionCommands";
import { useChatStore } from "../stores/chat";
import type { SessionParticipantView } from "../../../../types/participant";

/**
 * PLAN-0635 M3 ④: the composer's `/` menu reads the **server** registry and merges it with the
 * local table. Each case below pins one invariant that a regression would break:
 *
 * 1. a failed registry read degrades to `fallback` and still has commands;
 * 2. a server row with a local name is deduped (one `/help` row, not two);
 * 3. an unknown reason renders localized fallback copy — never the raw enum;
 * 4. `/help` renders the merged table, so server-only `/export` is visible.
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

vi.mock("../../stores/workspace", () => ({
    useWorkspaceStore: () => ({ fileTree: [] }),
}));

const authState = vi.hoisted(() => ({ isAuthenticated: true }));

// The registry read is gated on being signed in; the tests are about the read itself.
vi.mock("../../../../stores/auth", () => ({
    useAuthStore: () => authState,
}));

vi.mock("../../../../services/attachmentService", () => ({
    uploadAttachments: vi.fn<() => Promise<{ success: never[]; failed: never[] }>>(),
    validateAttachment: () => ({ valid: true }),
}));

/**
 * The `/compact` cases assert the **toast copy**, so the sonner surface is replaced by a recorder:
 * `toast.error` renders nothing in jsdom and its message would be unreachable.
 */
const toastState = vi.hoisted(() => ({
    error: vi.fn<(message: string) => void>(),
    success: vi.fn<(message: string) => void>(),
}));

vi.mock("vue-sonner", () => ({ toast: { error: toastState.error, success: toastState.success } }));

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
            commands: {
                description: {
                    export: "Export this conversation as a Markdown file",
                    compact: "Compact the context and keep a summary",
                    unknown: "Command registered by the server (not implemented in this UI yet)",
                },
                reason: {
                    approvalRequired: "Approval is required before this command can run",
                    denied: "Policy denied this command",
                    policyUnavailable: "Policy is unavailable, so permission cannot be confirmed",
                    branchLocked: "A chat run is active; try again when it finishes",
                    unknown: "Unavailable for an unknown reason",
                },
                branchUnavailable: "This session has no usable branch yet; the command was not run",
                compacted: "Context compacted",
                failed: "Command failed; please try again",
                unknown: "This command is not implemented in the current UI yet",
            },
        },
        workspace: { participantUnknownName: "Unknown" },
        multimodal: { image: "Image", screenshot: "Screenshot", voice: "Voice" },
        common: { cancel: "Cancel" },
    },
};

const stubs = {
    LoaderCircle: { template: "<span />" },
    ImageUpload: { template: "<div />" },
    FileUpload: { template: "<div />" },
    ScreenshotCapture: { template: "<div />" },
    VoiceInput: { template: "<div />" },
};

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

function mountInput() {
    const i18n = createI18n({ legacy: false, locale: "en", messages });
    return mount(InputArea, {
        props: { sessionId: "session-1" },
        global: { plugins: [i18n], stubs },
    });
}

function registryResponse(body: unknown): Response {
    return {
        ok: true,
        status: 200,
        json: () => Promise.resolve(body),
    } as unknown as Response;
}

async function typeText(textarea: DOMWrapper<HTMLTextAreaElement>, value: string): Promise<void> {
    const element = textarea.element;
    element.value = value;
    element.selectionStart = value.length;
    element.selectionEnd = value.length;
    await textarea.trigger("input");
    await flushPromises();
}

/** Submits `/help` (local command) and returns the rendered help panel. */
async function openHelp(wrapper: ReturnType<typeof mountInput>) {
    const textarea = wrapper.find("textarea");
    await typeText(textarea, "/help");
    await textarea.trigger("keydown", { key: "Enter" });
    await flushPromises();
    return wrapper.get('[data-testid="chat-input-help"]');
}

beforeEach(() => {
    setActivePinia(createPinia());
    authState.isAuthenticated = true;
    storeState.participants = null;
    storeState.canSpeakAs = false;
    storeState.speakAsCandidates = [];
    storeState.ensureLoaded.mockReset();
    fetchMock.mockReset();
    toastState.error.mockReset();
    toastState.success.mockReset();
    vi.stubGlobal("fetch", fetchMock);
});

describe("InputArea command registry (PLAN-0635 M3)", () => {
    it("falls back to the local table when the registry request rejects", async () => {
        fetchMock.mockRejectedValue(new TypeError("network down"));

        const scope = effectScope();
        const harness = scope.run(() => useSessionCommands(ref("session-1")));
        expect(harness).toBeTruthy();
        if (!harness) throw new Error("effect scope did not return the composable");
        await vi.waitFor(() => expect(harness.state.value).toBe("fallback"));
        expect(harness.commands.value.length).toBeGreaterThan(0);
        expect(harness.commands.value.some((cmd) => cmd.key === "/clear")).toBe(true);
        scope.stop();

        const wrapper = mountInput();
        await typeText(wrapper.find("textarea"), "/");
        const options = wrapper.findAll('[role="option"]');
        expect(options.length).toBeGreaterThan(0);
        expect(options.map((option) => option.text()).join(" ")).toContain("/clear");
    });

    it("renders exactly one /help row when the server also lists /help", async () => {
        fetchMock.mockResolvedValue(
            registryResponse({
                commands: [
                    { name: "/help", source: "builtin", available: true, reason: null },
                    { name: "/export", source: "builtin", available: true, reason: null },
                ],
            }),
        );

        const wrapper = mountInput();
        await openHelp(wrapper);
        // `/export` only exists after the registry read lands, so this waits for the merge.
        await vi.waitFor(() =>
            expect(wrapper.find('[data-testid="slash-command-export"]').exists()).toBe(true),
        );
        expect(wrapper.findAll('[data-testid="slash-command-help"]')).toHaveLength(1);
    });

    it("renders localized fallback copy for an unknown availability reason", async () => {
        fetchMock.mockResolvedValue(
            registryResponse({
                commands: [
                    {
                        name: "/export",
                        source: "builtin",
                        available: false,
                        reason: "future_reason",
                    },
                ],
            }),
        );

        const wrapper = mountInput();
        const help = await openHelp(wrapper);
        await vi.waitFor(() =>
            expect(wrapper.find('[data-testid="slash-command-export"]').exists()).toBe(true),
        );
        const reason = wrapper.get('[data-testid="slash-command-reason-export"]');
        expect(help.text()).toContain("/export");
        expect(reason.text().trim().length).toBeGreaterThan(0);
        expect(reason.text()).not.toContain("future_reason");
    });

    it("lists the server-only /export command in /help", async () => {
        fetchMock.mockResolvedValue(
            registryResponse({
                commands: [{ name: "/export", source: "builtin", available: true, reason: null }],
            }),
        );

        const wrapper = mountInput();
        const help = await openHelp(wrapper);
        await vi.waitFor(() => expect(help.text()).toContain("/export"));
    });
});

/**
 * PLAN-0635 M3: `/compact` is **branch-scoped** — the wire body carries `branchId`. When the store
 * has no selected branch there is nothing to compact, so the endpoint must not be called at all
 * (a request that comes back 400 is a different, worse behaviour: it burns a round-trip and shows
 * the generic failure copy) and the user gets the dedicated localized "no usable branch" message.
 */
describe("InputArea /compact without a selected branch (PLAN-0635 M3)", () => {
    const NO_BRANCH_COPY = "This session has no usable branch yet; the command was not run";

    /** Only counts compaction calls — the registry read at mount also goes through `fetch`. */
    function compactCalls(): number {
        return fetchMock.mock.calls.filter(([input]) => String(input).includes("/compact")).length;
    }

    async function submitCompact(wrapper: ReturnType<typeof mountInput>) {
        const textarea = wrapper.find("textarea");
        await typeText(textarea, "/compact");
        // Readiness: the menu row only exists once the registry merge has landed. Without this
        // wait the run could race the registry and assert on a composer that never knew `/compact`.
        await vi.waitFor(() =>
            expect(wrapper.find('[data-testid="chat-input-trigger-menu"]').exists()).toBe(true),
        );
        await textarea.trigger("keydown", { key: "Enter" });
        await flushPromises();
        return textarea;
    }

    beforeEach(() => {
        fetchMock.mockResolvedValue(
            registryResponse({
                commands: [{ name: "/compact", source: "builtin", available: true, reason: null }],
            }),
        );
    });

    for (const missing of [undefined, null] as const) {
        const label = missing === null ? "null" : "undefined";
        it(`sends no request and toasts the localized copy when the branch is ${label}`, async () => {
            const chatStore = useChatStore();
            // `null` is outside the declared `string | undefined` return type, but the guard is
            // `!branchId` on purpose — pin the falsy contract for both shapes the wire can hand in.
            vi.spyOn(chatStore, "getSelectedBranchId").mockReturnValue(
                missing as unknown as undefined,
            );

            const wrapper = mountInput();
            await flushPromises();
            const callsBefore = fetchMock.mock.calls.length;
            const textarea = await submitCompact(wrapper);

            expect(compactCalls()).toBe(0);
            expect(fetchMock.mock.calls.length).toBe(callsBefore);
            expect(toastState.error).toHaveBeenCalledTimes(1);
            expect(toastState.error).toHaveBeenCalledWith(NO_BRANCH_COPY);
            expect(toastState.success).not.toHaveBeenCalled();

            // Not stuck in a loading/busy state: no upload spinner, the composer is still editable
            // and the send button re-enables as soon as there is text again.
            expect(wrapper.find('[data-testid="attachment-uploading-indicator"]').exists()).toBe(
                false,
            );
            expect(textarea.attributes("disabled")).toBeUndefined();
            await typeText(textarea, "still usable");
            expect(
                wrapper.get('[data-testid="chat-send-button"]').attributes("disabled"),
            ).toBeUndefined();
        });
    }
});
