<script setup lang="ts">
import { ref, computed, markRaw, nextTick, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useSessionParticipantsStore } from "../../stores/sessionParticipants";
import { useWorkspaceStore } from "../../stores/workspace";
import { useChatStore } from "../stores/chat";
import type { AttachmentFile, FileNode } from "../../../../types";
import { toast } from "vue-sonner";
import { Send, Square, LoaderCircle } from "@lucide/vue";
import ImageUpload from "../../../../components/multimodal/ImageUpload.vue";
import FileUpload from "../../../../components/multimodal/FileUpload.vue";
import ScreenshotCapture from "../../../../components/multimodal/ScreenshotCapture.vue";
import VoiceInput from "../../../../components/multimodal/VoiceInput.vue";
import ModelPopover from "./ModelPopover.vue";
import InputToolbar, { type ToolbarAction } from "./InputToolbar.vue";
import { uploadAttachments, validateAttachment } from "../../../../services/attachmentService";
import { api } from "../../../../composables/api";
import { logger } from "../../../../lib/logger";
import {
    commandReasonKey,
    useSessionCommands,
    type SlashCommand,
} from "../composables/useSessionCommands";

/**
 * PLAN-0635 M2: the `@` menu carries **two groups in one listbox** (D35-01/03) — session
 * members and workspace files/directories. Two separate menus would duplicate the keyboard and
 * aria contract, so the grouping lives in the data (`group`) and is only a rendering concern.
 */
type TriggerGroup = "command" | "member" | "file";

/** One row of the unified trigger menu (`/` command, `@` member or `@` file). */
interface TriggerItem {
    /** Unique per menu — the textarea's `aria-activedescendant` points at it. */
    id: string;
    label: string;
    hint: string;
    group: TriggerGroup;
    /** Slash options only: server says the command may not run (kept visible, greyed out). */
    disabled?: boolean;
}

/** A rendered group: a heading plus its options carrying their flat index in the menu. */
interface MenuGroup {
    id: TriggerGroup;
    titleKey: string;
    items: (TriggerItem & { flatIndex: number })[];
}

/** Upper bound on file candidates in the menu — path matching is cheap but the list is long. */
const MAX_FILE_CANDIDATES = 8;

const URL = window.URL;

const props = defineProps<{
    sessionId: string;
    isStreaming?: boolean;
    queueMode?: boolean;
    queueFull?: boolean;
    queuePaused?: boolean;
    queueSubmitting?: boolean;
    queueActionBusy?: boolean;
}>();

const emit = defineEmits<{
    send: [content: string, attachments?: AttachmentFile[], asParticipantId?: string];
    queue: [content: string, attachments?: AttachmentFile[], asParticipantId?: string];
    stop: [];
}>();

const { t } = useI18n();

/**
 * D23-27「代发」：以某个参与者身份发言。
 * - 入口由 `capabilities.speakAs`（同一响应里的归约）决定**显不显示**，false 时**不渲染**（不是禁用）；
 * - 候选 = store 的 `speakAsCandidates`（`selfOwned === true` 且未停用）；
 * - 默认选自己（HUMAN 行），没有则选第一个 —— 绝不默认代别人发言。
 */
const participantsStore = useSessionParticipantsStore();
/** PLAN-0635 M2: already-loaded workspace tree feeds `@文件/目录` candidates (no request here). */
const workspaceStore = useWorkspaceStore();
/** PLAN-0635 M3: `/export` and `/compact` are branch-scoped — read the selected branch here. */
const chatStore = useChatStore();
const speakAsId = ref("");

const speakAsOptions = computed(() => participantsStore.speakAsCandidates);

const showSpeakAs = computed(() => participantsStore.canSpeakAs && speakAsOptions.value.length > 0);

/** 只有真的选了候选才带 `asParticipantId`：空串不发，避免把"以某人身份"误当默认行为。 */
const activeSpeakAsId = computed(() =>
    showSpeakAs.value && speakAsOptions.value.some((item) => item.participantId === speakAsId.value)
        ? speakAsId.value
        : "",
);

watch(
    () => props.sessionId,
    (id) => void participantsStore.ensureLoaded(id ?? null),
    { immediate: true },
);

watch(
    speakAsOptions,
    (options) => {
        if (options.some((item) => item.participantId === speakAsId.value)) return;
        const own = options.find((item) => item.principalKind === "HUMAN") ?? options[0];
        speakAsId.value = own?.participantId ?? "";
    },
    { immediate: true },
);
const input = ref(""),
    isComposing = ref(false),
    attachments = ref<File[]>([]);
let uploadedByFile = new WeakMap<File, Map<string, AttachmentFile>>();
const attachmentErrors = ref<Record<string, string>>({});

/**
 * PLAN-0635 M1（D35-01）：`/` 命令与 `@` 提及共用**一个**输入触发器模型 —— 同一份候选渲染、
 * 同一套键盘（↑↓ / Enter / Tab / Esc）、同一套 aria。两套实现必然漂移，故不各写一份。
 */
type TriggerKind = "slash" | "mention";
const TRIGGER_MENU_ID = "chat-input-trigger-menu",
    triggerKind = ref<TriggerKind | null>(null),
    triggerFilter = ref(""),
    triggerIndex = ref(0),
    /** Index of the `@` that opened the mention menu (the replace range on insert). */
    mentionAnchor = ref(-1),
    showHelpPanel = ref(false),
    textareaRef = ref<HTMLTextAreaElement | null>(null),
    isUploading = ref(false);

/**
 * PLAN-0635 M3（D35-02）：菜单 = 服务端注册表 ∪ 本地表。
 *
 * 合并、按 name 去重、失败兜底都在 `useSessionCommands` 里（服务端优先、本地独有保留、请求失败
 * 仍有本地表）。这里只消费结果，不再维护第二套命令列表 —— `/clear` 与 `/help` 是纯浏览器动作，
 * 永远保留。
 */
const { commands: slashCommands } = useSessionCommands(computed(() => props.sessionId));

function isWordStart(value: string, index: number): boolean {
    return index === 0 || /\s/.test(value[index - 1] ?? "");
}

/**
 * Anchor of the `@` that should open the mention menu, or -1 when there is none.
 *
 * Boundary rule mirrors `MentionParser` (a `@` glued to a preceding word, e.g. an email address,
 * is not a token), and a whitespace after `@` ends the token — so `@al ice` never opens a menu.
 */
function findMentionAnchor(value: string, caret: number): number {
    const upto = value.slice(0, caret),
        at = upto.lastIndexOf("@");
    if (at < 0 || !isWordStart(upto, at)) return -1;
    return /\s/.test(upto.slice(at + 1)) ? -1 : at;
}

const slashItems = computed<TriggerItem[]>(() => {
    const filter = triggerFilter.value.toLowerCase();
    // One row per command name: aria ids and keyboard indices are derived from this list, so a
    // duplicate name would make two options share an id. (The composable already merges; this is
    // the menu's own guarantee.)
    const byName = new Map<string, SlashCommand>();
    for (const cmd of slashCommands.value) {
        if (filter && !cmd.key.toLowerCase().includes(filter)) continue;
        if (!byName.has(cmd.key)) byName.set(cmd.key, cmd);
    }
    return [...byName.values()].map((cmd) => ({
        id: `xihe-slash-${cmd.key.slice(1)}`,
        label: cmd.key,
        hint: cmd.disabled
            ? `${t(cmd.descriptionKey)} · ${t(commandReasonKey(cmd.reason))}`
            : t(cmd.descriptionKey),
        group: "command" as const,
        disabled: cmd.disabled,
    }));
});

/**
 * Candidates come from the **existing** participant store (same single source as the members
 * panel and the speak-as dropdown) — no endpoint, no second fetch.
 * Disabled participants are invisible here for the same reason `MentionParser` skips them.
 */
const memberItems = computed<TriggerItem[]>(() => {
    const filter = triggerFilter.value.toLowerCase();
    const items: TriggerItem[] = [];
    if ("all".startsWith(filter)) {
        items.push({
            id: "xihe-mention-all",
            label: "@all",
            hint: t("chat.input.mentionAll"),
            group: "member",
        });
    }
    for (const participant of participantsStore.participants ?? []) {
        const name = participant.displayName ?? "";
        if (!name || participant.disabledAt) continue;
        if (!name.toLowerCase().includes(filter)) continue;
        items.push({
            id: `xihe-mention-${participant.participantId}`,
            label: `@${name}`,
            hint:
                participant.principalKind === "AGENT"
                    ? t("chat.input.mentionAgent")
                    : t("chat.input.mentionHuman"),
            group: "member",
        });
    }
    return items;
});

/** Depth-first walk of the already-loaded workspace tree (no request is made here). */
function flattenFileTree(nodes: FileNode[], out: FileNode[] = []): FileNode[] {
    for (const node of nodes) {
        out.push(node);
        if (node.children?.length) flattenFileTree(node.children, out);
    }
    return out;
}

/**
 * PLAN-0635 M2: `@文件/目录` candidates come from the **already-loaded** `workspace.fileTree`
 * (filled by the view through `api.listDirectory`) — no new endpoint, no extra fetch (D35-03).
 *
 * Two deliberate rules:
 * <ul>
 *   <li>an <b>empty</b> filter lists nothing: otherwise every file in the workspace would flood
 *       the menu the moment the user types `@` and bury the member candidates;</li>
 *   <li>basename matches rank before deeper path matches, so typing `@input` offers
 *       `chat/components/InputArea.vue` instead of an arbitrary deep path containing "input".</li>
 * </ul>
 */
const fileItems = computed<TriggerItem[]>(() => {
    const filter = triggerFilter.value.toLowerCase();
    if (!filter) return [];
    const matched = flattenFileTree(workspaceStore.fileTree ?? []).filter((node) =>
        node.path.toLowerCase().includes(filter),
    );
    matched.sort((left, right) => {
        const leftName = left.name.toLowerCase().includes(filter) ? 0 : 1,
            rightName = right.name.toLowerCase().includes(filter) ? 0 : 1;
        if (leftName !== rightName) return leftName - rightName;
        return left.path.length - right.path.length;
    });
    return matched.slice(0, MAX_FILE_CANDIDATES).map((node, index) => ({
        // Index-based id keeps `aria-activedescendant` valid: a raw path can contain characters
        // that are not allowed in an IDREF.
        id: `xihe-file-${index}`,
        label: `@${node.path}`,
        hint:
            node.type === "directory"
                ? t("chat.input.mentionDirectory")
                : t("chat.input.mentionFile"),
        group: "file",
    }));
});

/** Member group first (existing behaviour), file group second — one listbox, two headings. */
const mentionGroups = computed<{ id: TriggerGroup; titleKey: string; items: TriggerItem[] }[]>(
    () => {
        const groups: { id: TriggerGroup; titleKey: string; items: TriggerItem[] }[] = [];
        if (memberItems.value.length) {
            groups.push({
                id: "member",
                titleKey: "chat.input.mentionsTitle",
                items: memberItems.value,
            });
        }
        if (fileItems.value.length) {
            groups.push({ id: "file", titleKey: "chat.input.filesTitle", items: fileItems.value });
        }
        return groups;
    },
);

const activeItems = computed<TriggerItem[]>(() => {
    if (triggerKind.value === "slash") return slashItems.value;
    if (triggerKind.value === "mention") return mentionGroups.value.flatMap((group) => group.items);
    return [];
});

/** What the template renders: headings + options with their flat index for `aria`/keyboard. */
const menuGroups = computed<MenuGroup[]>(() => {
    if (triggerKind.value === "slash") {
        return slashItems.value.length
            ? [
                  {
                      id: "command",
                      titleKey: "chat.input.commandsTitle",
                      items: slashItems.value.map((item, flatIndex) => ({ ...item, flatIndex })),
                  },
              ]
            : [];
    }
    if (triggerKind.value !== "mention") return [];
    let flatIndex = 0;
    return mentionGroups.value.map((group) => ({
        id: group.id,
        titleKey: group.titleKey,
        items: group.items.map((item) => ({ ...item, flatIndex: flatIndex++ })),
    }));
});

const menuOpen = computed(() => triggerKind.value !== null && activeItems.value.length > 0);

const activeItemId = computed(() => activeItems.value[triggerIndex.value]?.id ?? "");

const sendDisabled = computed(() => {
    if (props.queueMode) {
        return (
            !input.value.trim() ||
            Boolean(props.queueFull) ||
            Boolean(props.queueSubmitting) ||
            Boolean(props.queueActionBusy)
        );
    }
    return !input.value.trim() && attachments.value.length === 0;
});

const toolbarActions = computed<ToolbarAction[]>(() => [
    {
        key: "model",
        position: "left",
        component: markRaw(ModelPopover),
    },
    {
        key: "image",
        position: "left",
        component: markRaw(ImageUpload),
        props: { onUpload: addAttachment },
    },
    {
        key: "file",
        position: "left",
        component: markRaw(FileUpload),
        props: { onUpload: addAttachment },
    },
    {
        key: "screenshot",
        position: "left",
        component: markRaw(ScreenshotCapture),
        props: { onCapture: addAttachmentBlob },
    },
    {
        key: "voice",
        position: "left",
        component: markRaw(VoiceInput),
        props: { onTranscript: handleTranscript },
    },
    {
        key: props.isStreaming ? "stop" : "send",
        position: "right",
        component: "button",
        props: {
            class: "shrink-0 size-8 flex items-center justify-center rounded-lg bg-action text-action-foreground hover:opacity-90 disabled:opacity-50 transition-opacity",
            disabled: props.isStreaming ? false : sendDisabled.value,
            "data-testid": props.isStreaming ? "chat-stop-button" : "chat-send-button",
            "aria-label": props.isStreaming ? t("chat.stop") : t("chat.send"),
            onClick: props.isStreaming ? stopInput : handleSend,
        },
        icon: markRaw(props.isStreaming ? Square : Send),
        visible: props.isStreaming || !props.queueMode,
    },
]);

async function handleSend() {
    const text = input.value.trim();
    // A registered command submitted as text (menu already closed, e.g. a trailing space) must
    // still run through the command path — otherwise the literal "/help" would be emitted as the
    // user's message.
    const command = slashCommands.value.find((cmd) => cmd.key === text);
    if (command) {
        await executeSlash(command);
        return;
    }
    if (sendDisabled.value || isUploading.value || props.queueSubmitting || props.queueActionBusy)
        return;
    const uploadSessionId = props.sessionId;
    let uploadedForSubmit: AttachmentFile[] = [],
        uploadFailed = false;

    if (attachments.value.length > 0) {
        const filesToUpload = props.queueMode
            ? attachments.value.filter((file) => !uploadedByFile.get(file)?.has(uploadSessionId))
            : attachments.value;
        if (filesToUpload.length > 0) {
            isUploading.value = true;
            attachmentErrors.value = {};
            try {
                const { success, failed } = await uploadAttachments(uploadSessionId, filesToUpload);
                if (props.sessionId !== uploadSessionId) return;
                uploadedForSubmit = success;
                uploadFailed = failed.length > 0;
                for (const item of failed) {
                    attachmentErrors.value[item.name] = item.reason;
                    toast.error(`${item.name}: ${item.reason}`);
                }
                if (props.queueMode) {
                    const matchedFiles = new Set<File>();
                    for (const uploaded of success) {
                        const file =
                            filesToUpload.find(
                                (candidate) =>
                                    !matchedFiles.has(candidate) &&
                                    candidate.name === uploaded.name &&
                                    candidate.size === uploaded.size &&
                                    candidate.type === uploaded.type,
                            ) ??
                            filesToUpload.find(
                                (candidate) =>
                                    !matchedFiles.has(candidate) &&
                                    candidate.name === uploaded.name,
                            );
                        if (file) {
                            const bySession =
                                uploadedByFile.get(file) ?? new Map<string, AttachmentFile>();
                            bySession.set(uploadSessionId, uploaded);
                            uploadedByFile.set(file, bySession);
                            matchedFiles.add(file);
                        }
                    }
                }
            } finally {
                isUploading.value = false;
            }
        }
        if (props.queueMode) {
            uploadedForSubmit = attachments.value
                .map((file) => uploadedByFile.get(file)?.get(uploadSessionId))
                .filter((attachment): attachment is AttachmentFile => attachment !== undefined);
        }
    }

    if (props.queueMode && uploadFailed) return;
    if (attachments.value.length > 0 && uploadedForSubmit.length === 0) return;
    if (props.queueMode)
        emit(
            "queue",
            text,
            uploadedForSubmit.length > 0 ? uploadedForSubmit : undefined,
            activeSpeakAsId.value,
        );
    else
        emit(
            "send",
            text,
            uploadedForSubmit.length > 0 ? uploadedForSubmit : undefined,
            activeSpeakAsId.value,
        );
}

function stopInput() {
    emit("stop");
}

function closeTriggerMenu(): void {
    triggerKind.value = null;
    triggerFilter.value = "";
    triggerIndex.value = 0;
    mentionAnchor.value = -1;
}

/**
 * `/export` filename: prefer the server's `Content-Disposition`, fall back to the stable session
 * name. The server value is treated as untrusted text — only its basename is used.
 */
function exportFileName(contentDisposition: string | null): string {
    const fallback = `session-${props.sessionId}.md`;
    const match = contentDisposition?.match(/filename\*?=(?:UTF-8''|")?([^";]+)"?/i);
    const raw = match?.[1]?.trim();
    if (!raw) return fallback;
    let decoded = raw;
    try {
        decoded = decodeURIComponent(raw);
    } catch (error) {
        logger.debug("Content-Disposition filename is not percent-encoded; using it verbatim", {
            error: error instanceof Error ? error.message : String(error),
        });
    }
    const base = decoded.split(/[\\/]/).pop()?.trim();
    return base || fallback;
}

function logCommandFailure(context: { command: string; sessionId: string }, error: unknown): void {
    logger.warn("Slash command failed", {
        ...context,
        error: error instanceof Error ? error.message : String(error),
    });
}

/**
 * PLAN-0635 M3: `/export` = a real download. The registry decides whether the command may run; the
 * artifact itself comes from `GET /sessions/{id}/export?branchId=` as `text/markdown` + attachment.
 */
async function downloadSessionExport(): Promise<void> {
    const branchId = chatStore.getSelectedBranchId(props.sessionId);
    if (!branchId) {
        toast.error(t("chat.commands.branchUnavailable"));
        return;
    }
    let objectUrl: string | null = null;
    try {
        const response = await api.exportSession(props.sessionId, branchId);
        const blob = await response.blob();
        objectUrl = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = exportFileName(response.headers.get("content-disposition"));
        anchor.rel = "noopener";
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
    } catch (error) {
        logCommandFailure({ command: "/export", sessionId: props.sessionId }, error);
        toast.error(t("chat.commands.failed"));
    } finally {
        // The click has already handed the blob to the browser; a leaked object URL would pin the
        // whole session export in memory.
        if (objectUrl) URL.revokeObjectURL(objectUrl);
    }
}

/** PLAN-0635 M3: `/compact` reuses the existing manual-compaction endpoint (body needs `branchId`). */
async function compactSessionContext(): Promise<void> {
    const branchId = chatStore.getSelectedBranchId(props.sessionId);
    if (!branchId) {
        toast.error(t("chat.commands.branchUnavailable"));
        return;
    }
    try {
        await api.compactSession(props.sessionId, branchId);
        toast.success(t("chat.commands.compacted"));
    } catch (error) {
        logCommandFailure({ command: "/compact", sessionId: props.sessionId }, error);
        toast.error(t("chat.commands.failed"));
    }
}

/**
 * A slash command never becomes a chat message. Selecting one either runs a browser/server action
 * or opens the help panel; an unavailable command is refused with its localized reason (it is still
 * listed — hiding it would hide the capability itself).
 */
async function executeSlash(cmd: SlashCommand): Promise<void> {
    closeTriggerMenu();
    showHelpPanel.value = false;
    input.value = "";
    if (cmd.disabled) {
        toast.error(t(commandReasonKey(cmd.reason)));
        return;
    }
    if (cmd.key === "/help") {
        showHelpPanel.value = true;
        return;
    }
    // `/clear` = clear the draft (input + pending attachments) and send nothing.
    if (cmd.key === "/clear") {
        clearDraft();
        return;
    }
    if (cmd.key === "/export") {
        await downloadSessionExport();
        return;
    }
    if (cmd.key === "/compact") {
        await compactSessionContext();
        return;
    }
    // A command the registry knows but this UI does not implement yet: say so instead of doing
    // nothing silently (or sending the literal text to the model).
    toast.error(t("chat.commands.unknown"));
}

/**
 * Insert `@displayName ` at the trigger anchor.
 *
 * The trailing space is a **wire contract**, not cosmetics: `MentionParser` requires a whitespace
 * (or end-of-text) boundary after the name, otherwise the token stays literal and the participant
 * is never woken. Same format as the members-panel `insertMention` click path.
 */
function insertMentionToken(name: string): void {
    const element = textareaRef.value,
        caret = element?.selectionStart ?? input.value.length,
        anchor = mentionAnchor.value >= 0 ? mentionAnchor.value : caret,
        before = input.value.slice(0, anchor),
        after = input.value.slice(caret),
        inserted = `@${name} `;
    input.value = `${before}${inserted}${after}`;
    closeTriggerMenu();
    void nextTick(() => {
        const position = before.length + inserted.length;
        element?.setSelectionRange(position, position);
        element?.focus();
    });
}

function selectActiveItem(): void {
    const item = activeItems.value[triggerIndex.value];
    if (!item) return;
    if (triggerKind.value === "slash") {
        const command = slashCommands.value.find((cmd) => cmd.key === item.label);
        if (command) void executeSlash(command);
        return;
    }
    insertMentionToken(item.label.slice(1));
}

function pickItem(index: number): void {
    triggerIndex.value = index;
    selectActiveItem();
}

function handleKeydown(e: KeyboardEvent) {
    // IME composition owns Enter/arrow keys — never steal them or an IME confirm fires a command.
    if (isComposing.value) return;

    if (menuOpen.value) {
        const count = activeItems.value.length;
        if (e.key === "ArrowDown") {
            e.preventDefault();
            triggerIndex.value = (triggerIndex.value + 1) % count;
            return;
        }
        if (e.key === "ArrowUp") {
            e.preventDefault();
            triggerIndex.value = triggerIndex.value > 0 ? triggerIndex.value - 1 : count - 1;
            return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
            e.preventDefault();
            selectActiveItem();
            return;
        }
        if (e.key === "Escape") {
            e.preventDefault();
            closeTriggerMenu();
            return;
        }
    }

    if (e.key === "Escape" && showHelpPanel.value) {
        e.preventDefault();
        showHelpPanel.value = false;
        return;
    }

    if (e.key === "Enter" && !e.shiftKey && !isComposing.value) {
        e.preventDefault();
        if (props.queueMode) {
            handleSend();
        } else if (props.isStreaming) {
            stopInput();
        } else {
            handleSend();
        }
    }
}

function handleInput() {
    if (isComposing.value) return;
    showHelpPanel.value = false;
    const element = textareaRef.value,
        caret = element?.selectionStart ?? input.value.length,
        value = input.value;

    const at = findMentionAnchor(value, caret);
    if (at >= 0) {
        triggerKind.value = "mention";
        mentionAnchor.value = at;
        triggerFilter.value = value.slice(at + 1, caret);
        triggerIndex.value = 0;
        return;
    }

    if (value === "/" || (value.startsWith("/") && !value.includes(" "))) {
        triggerKind.value = "slash";
        triggerFilter.value = value.slice(1);
        mentionAnchor.value = -1;
        triggerIndex.value = 0;
        return;
    }

    closeTriggerMenu();
}

function addAttachment(files: File[]) {
    const validFiles: File[] = [];
    for (const file of files) {
        const validation = validateAttachment(file);
        if (!validation.valid) {
            toast.error(`${file.name}: ${validation.reason}`);
            continue;
        }
        validFiles.push(file);
    }
    attachments.value.push(...validFiles);
}

function addAttachmentBlob(blob: Blob) {
    const file = new File([blob], "capture.png", { type: "image/png" });
    addAttachment([file]);
}

function removeAttachment(index: number) {
    const file = attachments.value[index];
    if (file) {
        const nextErrors = { ...attachmentErrors.value };
        delete nextErrors[file.name];
        attachmentErrors.value = nextErrors;
    }
    attachments.value.splice(index, 1);
}

function handleTranscript(text: string) {
    input.value += text;
}

function attachmentObjectUrl(file: File): string {
    return URL.createObjectURL(file);
}

function focusInput(): void {
    const element = document.querySelector<HTMLTextAreaElement>('[data-testid="chat-input"]');
    element?.focus();
}

function clearDraft() {
    input.value = "";
    attachments.value = [];
    uploadedByFile = new WeakMap<File, Map<string, AttachmentFile>>();
    attachmentErrors.value = {};
}

/**
 * PLAN-0623：把 `@displayName` 插入草稿（参与者面板的"提及"）。
 * 只改本地草稿，不发消息 —— 发送仍走用户自己的发送动作。
 */
function insertMention(name: string): void {
    const mention = `@${name}`;
    const current = input.value;
    if (!current.trim()) {
        input.value = `${mention} `;
    } else if (current.endsWith(" ") || current.endsWith("\n")) {
        input.value = `${current}${mention} `;
    } else {
        input.value = `${current} ${mention} `;
    }
    focusInput();
}

defineExpose({ clearDraft, insertMention });
</script>

<template>
    <div class="min-w-0 border-t bg-background px-4 py-3">
        <div class="mx-auto w-full max-w-4xl space-y-2">
            <!--
                D23-27「代发」：只有 capabilities.speakAs 为真才**渲染**（false 时不渲染，不是禁用）。
                候选只含我拥有的、未停用的参与者（selfOwned 由 CP 归约）。
            -->
            <div v-if="showSpeakAs" class="flex items-center gap-2 px-2" data-testid="speak-as-bar">
                <label class="text-[11px] text-muted-foreground" :for="'speak-as-select'">{{
                    t("workspace.speakAsLabel")
                }}</label>
                <select
                    id="speak-as-select"
                    v-model="speakAsId"
                    class="rounded border bg-background px-1.5 py-0.5 text-[11px]"
                    data-testid="speak-as-select"
                >
                    <option
                        v-for="option in speakAsOptions"
                        :key="option.participantId"
                        :value="option.participantId"
                        :data-participant-id="option.participantId"
                    >
                        {{ option.displayName ?? t("workspace.participantUnknownName") }}
                    </option>
                </select>
            </div>
            <p
                v-if="queueMode"
                class="px-2 text-[11px] text-muted-foreground"
                role="status"
                data-testid="follow-up-composer-notice"
            >
                {{
                    queueFull
                        ? t("chat.followUpFullNotice")
                        : queuePaused
                          ? t("chat.followUpPausedNotice")
                          : t("chat.followUpComposerNotice")
                }}
            </p>
            <div v-if="attachments.length" class="flex flex-wrap gap-2">
                <div
                    v-for="(file, i) in attachments"
                    :key="file.name + i"
                    class="relative group"
                    data-testid="selected-attachment"
                >
                    <div
                        class="relative flex h-16 w-16 items-center justify-center overflow-hidden rounded border bg-muted/30 text-xs text-muted-foreground"
                        :class="attachmentErrors[file.name] ? 'border-destructive' : ''"
                    >
                        <img
                            v-if="file.type.startsWith('image/')"
                            :src="attachmentObjectUrl(file)"
                            class="w-full h-full object-cover"
                        />
                        <span v-else class="p-1">{{ file.name }}</span>
                        <span
                            v-if="attachmentErrors[file.name]"
                            class="absolute inset-x-0 bottom-0 bg-destructive px-1 py-0.5 text-center text-[9px] font-medium text-destructive-foreground"
                        >
                            {{ t("multimodal.uploadFailed") }}
                        </span>
                    </div>
                    <button
                        class="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-destructive text-destructive-foreground text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                        data-testid="remove-attachment-button"
                        @click="removeAttachment(i)"
                    >
                        ×
                    </button>
                    <div
                        v-if="attachmentErrors[file.name]"
                        data-testid="attachment-upload-error"
                        class="mt-1 w-16 space-y-1 text-[10px] text-destructive"
                    >
                        <span class="block truncate" :title="attachmentErrors[file.name]">{{
                            t("multimodal.uploadFailed")
                        }}</span>
                        <div class="flex gap-1">
                            <button
                                type="button"
                                data-testid="attachment-retry-button"
                                class="font-medium underline underline-offset-2 hover:no-underline"
                                @click="handleSend"
                            >
                                {{ t("common.retry") }}
                            </button>
                            <button
                                type="button"
                                data-testid="attachment-error-remove-button"
                                class="font-medium underline underline-offset-2 hover:no-underline"
                                @click="removeAttachment(i)"
                            >
                                {{ t("settings.removeServer") }}
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <div class="relative">
                <!--
                    `/help` renders the merged registry locally (server rows + local-only commands).
                    Unavailable rows stay visible, greyed, with their localized reason.
                    role=status so assistive tech announces it without stealing focus.
                -->
                <div
                    v-if="showHelpPanel"
                    class="absolute bottom-full left-0 mb-2 w-full overflow-hidden rounded-lg border bg-popover p-3 shadow-lg"
                    role="status"
                    data-testid="chat-input-help"
                >
                    <p class="mb-1 text-xs font-medium">{{ t("chat.input.helpTitle") }}</p>
                    <ul class="space-y-1">
                        <li
                            v-for="cmd in slashCommands"
                            :key="cmd.key"
                            class="text-xs"
                            :data-testid="`slash-command-${cmd.key.slice(1)}`"
                        >
                            <span class="font-medium" :class="cmd.disabled ? 'opacity-60' : ''">{{
                                cmd.key
                            }}</span>
                            <span
                                class="ml-2 text-muted-foreground"
                                :class="cmd.disabled ? 'opacity-60' : ''"
                                >{{ t(cmd.descriptionKey) }}</span
                            >
                            <span
                                v-if="cmd.disabled"
                                class="ml-2 text-destructive/80"
                                :data-testid="`slash-command-reason-${cmd.key.slice(1)}`"
                            >
                                {{ t(commandReasonKey(cmd.reason)) }}
                            </span>
                        </li>
                    </ul>
                    <p class="mt-2 text-xs text-muted-foreground">{{ t("chat.input.helpHint") }}</p>
                </div>
                <!--
                    PLAN-0635 M1/M2: one candidate surface for `/`, `@` member and `@` file
                    (D35-01) — a single listbox means the keyboard/aria contract cannot drift.
                    M2 adds the file group **inside** this listbox (group headings only).
                -->
                <div
                    v-if="menuOpen"
                    :id="TRIGGER_MENU_ID"
                    class="absolute bottom-full left-0 mb-2 max-h-72 w-72 overflow-y-auto rounded-lg border bg-popover shadow-lg"
                    role="listbox"
                    :aria-label="
                        triggerKind === 'mention'
                            ? t('chat.input.mentionsTitle')
                            : t('chat.input.commandsTitle')
                    "
                    data-testid="chat-input-trigger-menu"
                >
                    <template v-for="group in menuGroups" :key="group.id">
                        <div
                            class="border-b bg-muted/40 px-2 py-1 text-xs font-medium text-muted-foreground"
                            role="presentation"
                            :data-testid="`chat-input-group-${group.id}`"
                        >
                            {{ t(group.titleKey) }}
                        </div>
                        <button
                            v-for="item in group.items"
                            :id="item.id"
                            :key="item.id"
                            role="option"
                            :aria-selected="item.flatIndex === triggerIndex"
                            :aria-disabled="item.disabled ? 'true' : undefined"
                            class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
                            :class="[
                                item.flatIndex === triggerIndex ? 'bg-accent' : '',
                                item.disabled ? 'opacity-50' : '',
                            ]"
                            @mousedown.prevent
                            @click="pickItem(item.flatIndex)"
                        >
                            <span class="truncate font-medium">{{ item.label }}</span>
                            <span class="ml-auto shrink-0 text-xs text-muted-foreground">{{
                                item.hint
                            }}</span>
                        </button>
                    </template>
                </div>
            </div>

            <div
                class="rounded-2xl border bg-card p-2 shadow-sm transition-shadow focus-within:ring-2 focus-within:ring-ring"
            >
                <textarea
                    ref="textareaRef"
                    v-model="input"
                    data-testid="chat-input"
                    class="w-full min-h-[44px] max-h-[200px] px-2 py-2 bg-transparent resize-none text-sm placeholder:text-muted-foreground focus:outline-none field-sizing-content"
                    :placeholder="queueMode ? t('chat.followUpPlaceholder') : t('chat.placeholder')"
                    rows="1"
                    :style="{ fieldSizing: 'content' }"
                    :aria-expanded="menuOpen"
                    :aria-controls="menuOpen ? TRIGGER_MENU_ID : undefined"
                    :aria-activedescendant="menuOpen && activeItemId ? activeItemId : undefined"
                    :aria-autocomplete="menuOpen ? 'list' : undefined"
                    @compositionstart="isComposing = true"
                    @compositionend="isComposing = false"
                    @keydown="handleKeydown"
                    @input="handleInput"
                />
                <div class="flex min-w-0 items-center gap-2">
                    <InputToolbar :actions="toolbarActions" />
                    <LoaderCircle
                        v-if="isUploading"
                        data-testid="attachment-uploading-indicator"
                        class="size-4 shrink-0 animate-spin text-muted-foreground"
                    />
                    <button
                        v-if="queueMode"
                        type="button"
                        data-testid="chat-queue-button"
                        :aria-label="t('chat.followUpEnqueue')"
                        :disabled="
                            sendDisabled || isUploading || queueSubmitting || queueActionBusy
                        "
                        class="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-lg px-3 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                        :class="
                            queuePaused
                                ? 'border border-border bg-background text-foreground hover:bg-accent'
                                : 'bg-action text-action-foreground hover:opacity-90'
                        "
                        @click="handleSend"
                    >
                        <LoaderCircle v-if="queueSubmitting" class="size-3.5 animate-spin" />
                        <Send v-else class="size-3.5" />
                        <span>{{
                            queueSubmitting
                                ? t("chat.followUpEnqueuing")
                                : t("chat.followUpEnqueue")
                        }}</span>
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>
