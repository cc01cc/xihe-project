<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useAuthStore } from "../../../stores/auth";
import { api, ApiError } from "../../../composables/api";
import type {
    WorkspaceBackendMaturity,
    WorkspaceCapabilityPreflight,
    WorkspaceDirectAttachExecutionMode,
    WorkspaceStorageMode,
} from "../../../types";
import { logger } from "../../../lib/logger";
import { validateField } from "../../../lib/formValidation";
import { writeTabWorkspace } from "../../../lib/workspaceContext";
import { toast } from "vue-sonner";
import Dialog from "../../../components/ui/dialog/Dialog.vue";
import DialogContent from "../../../components/ui/dialog/DialogContent.vue";
import DialogHeader from "../../../components/ui/dialog/DialogHeader.vue";
import DialogTitle from "../../../components/ui/dialog/DialogTitle.vue";
import DialogDescription from "../../../components/ui/dialog/DialogDescription.vue";
import DialogFooter from "../../../components/ui/dialog/DialogFooter.vue";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Checkbox } from "../../../components/ui/checkbox";
import { FileText, FolderOpen, LoaderCircle, Plus, ShieldAlert, X } from "@lucide/vue";

/**
 * task-957（R42/R43）：单份配置的表单默认同页。
 *
 * 旧版是 `storage → source → execution → confirm` 四步四页；用户 2026-11-23 裁定单份配置
 * 表单必须同页并用字段联动代替分页：存储方式决定源目录/执行后端是否出现，目录决定执行
 * 后端的可用集合，执行模式决定风险确认是否出现。这里只有一个 `workspace-step-config`
 * 页面；`WorkspaceDialogs.spec.ts` 以「testid 以 `workspace-step-` 开头的元素数 == 1」
 * 为结构判据，改回分步会直接红。
 *
 * R48：打开向导即从系统根出内容，纯鼠标逐级下钻；手输路径保留，但不再需要先点「读取」。
 * Runtime-visible source browser 契约不变：目录始终由 Runtime 解析与校验，前端不伪造
 * 宿主机路径（无 `File.path`、无 native picker）。
 */
interface SourceEntry {
    name: string;
    kind: string;
    readable: boolean;
    size: number;
    /**
     * R44/task-981：Runtime `SourceDirectoryEntry` 已提供 `gitRepo` / `gitKind`；
     * 徽标只读 `gitRepo`，不读 `.git`（那条路在浏览器里本来也走不通）。
     */
    gitRepo?: boolean;
}

interface RootDraft {
    id: string;
    path: string;
}

interface SystemRoot {
    path: string;
    label: string;
}

const props = withDefaults(
    defineProps<{
        open: boolean;
    }>(),
    {
        open: false,
    },
);

const emit = defineEmits<{
    close: [];
    created: [workspaceId: string];
}>();

const { t } = useI18n();
const auth = useAuthStore();

/**
 * PLAN-0612 M4.3 / PLAN-0618：托管副本的 Docker 后端冻结，产品面不再提供该选项。
 * 于是「存储方式」只有一个合法取值 —— 按 R42 第 5 条不单独占一页，直接预置为
 * `direct_attach` 并用一行页脚说明（`workspace.directAttachDesc` 已含「当前唯一可用方式」）。
 */
const managedImportAvailable = false;
const storageMode = ref<WorkspaceStorageMode>("direct_attach");
const executionMode = ref<WorkspaceDirectAttachExecutionMode>("windows-mxc"),
    name = ref(""),
    description = ref("");
const saving = ref(false),
    submitError = ref(""),
    idempotencyKey = ref<string | null>(null);

// R45/R49: CP already stores WorkspaceRoot rows by position; the dialog can declare many roots.
const roots = ref<RootDraft[]>([createRoot()]);
const activeRootId = ref<string>(roots.value[0]!.id);

// Source browser (Runtime-visible directory tree).
const sourcePath = ref(""),
    sourceEntries = ref<SourceEntry[]>([]),
    sourceLoading = ref(false),
    sourceError = ref("");
const systemRoots = ref<SystemRoot[]>([]),
    systemRootsLoading = ref(false),
    systemRootsError = ref("");

// Runtime capability preflight (direct-attach only, aggregated across roots).
const preflightLoading = ref(false),
    preflightError = ref("");
const mxcPreflight = ref<WorkspaceCapabilityPreflight | null>(null);
const hostPreflight = ref<WorkspaceCapabilityPreflight | null>(null);

const hostRiskAck = ref(false);
const nameTouched = ref(false),
    descriptionTouched = ref(false),
    rootsTouched = ref(false);

const isDirectAttach = computed(() => storageMode.value === "direct_attach");
const mxcAvailable = computed(() => mxcPreflight.value?.available === true);
const hostAvailable = computed(() => hostPreflight.value?.available === true);
const validRootPaths = computed(() => roots.value.map((root) => root.path.trim()).filter(Boolean));
const hasRootPath = computed(() => validRootPaths.value.length > 0);

// R13/R24: instant, shared-rule validation (no blur gate).
const nameValidation = computed(() =>
    validateField("workspaceForm.name", name.value, { touched: nameTouched.value }),
);
const descriptionValidation = computed(() =>
    validateField("workspaceForm.description", description.value, {
        touched: descriptionTouched.value,
    }),
);
const rootValidations = computed(() =>
    roots.value.map((root) =>
        validateField("workspaceForm.rootPath", root.path, {
            touched: rootsTouched.value || root.path.length > 0,
        }),
    ),
);
const rootIssue = computed(
    () => rootValidations.value.find((validation) => validation.showError)?.primaryIssue ?? null,
);

const mxcCardDisabled = computed(() => {
    if (!isDirectAttach.value) return false;
    return preflightLoading.value || !hasRootPath.value || !mxcAvailable.value;
});

const hostCardDisabled = computed(() => {
    if (!isDirectAttach.value) return false;
    return preflightLoading.value || !hasRootPath.value || !hostAvailable.value;
});

const executionSelectionValid = computed(() => {
    if (!isDirectAttach.value) return true;
    if (!hasRootPath.value) return false;
    return executionMode.value === "windows-mxc" ? mxcAvailable.value : hostAvailable.value;
});

const showMxcGuidance = computed(
    () =>
        isDirectAttach.value &&
        !preflightLoading.value &&
        mxcPreflight.value !== null &&
        !mxcAvailable.value,
);

const storageModeLabel = computed(() =>
    isDirectAttach.value ? t("workspace.directAttach") : t("workspace.managedImport"),
);

const executionModeLabel = computed(() => {
    // Managed import stays on the implemented backend contract (docker only);
    // the Docker execution line is postponed, so it is shown as such, not as MXC.
    if (!isDirectAttach.value) return t("workspace.executionModeDocker");
    return executionMode.value === "windows-mxc"
        ? t("workspace.executionModeMxc")
        : t("workspace.executionModeHost");
});

const activePreflight = computed(() =>
    executionMode.value === "windows-mxc" ? mxcPreflight.value : hostPreflight.value,
);

const executionMaturity = computed(() => {
    if (!isDirectAttach.value) return "—";
    return maturityLabel(activePreflight.value?.maturity);
});

const executionAvailability = computed(() => {
    if (!isDirectAttach.value) return t("workspace.dockerPostponed");
    const preflight = activePreflight.value;
    if (!preflight) return t("workspace.capabilityUnknown");
    if (preflight.available) return t("workspace.capabilityAvailable");
    return `${t("workspace.capabilityUnavailable")} · ${preflight.reason ?? t("workspace.capabilityUnknownReason")}`;
});

const canSubmit = computed(() => {
    if (saving.value) return false;
    if (nameValidation.value.submitDisabled) return false;
    if (descriptionValidation.value.submitDisabled) return false;
    if (isDirectAttach.value) {
        if (rootValidations.value.some((validation) => validation.submitDisabled)) return false;
        if (!executionSelectionValid.value) return false;
    }
    if (executionMode.value === "windows-host" && !hostRiskAck.value) return false;
    return true;
});

/** `..` appears only when the current path is not a system root. */
const canGoUp = computed(() => parentPath(sourcePath.value) !== "");
const currentParent = computed(() => parentPath(sourcePath.value));

function createRoot(path = ""): RootDraft {
    return { id: globalThis.crypto.randomUUID(), path };
}

function maturityLabel(maturity: WorkspaceBackendMaturity | undefined | null): string {
    if (maturity === "experimental") return t("workspace.maturityExperimental");
    if (maturity === "preview") return t("workspace.maturityPreview");
    if (maturity === "stable") return t("workspace.maturityStable");
    return t("workspace.capabilityUnknown");
}

function reset() {
    storageMode.value = managedImportAvailable ? "managed_import" : "direct_attach";
    executionMode.value = "windows-mxc";
    name.value = "";
    description.value = "";
    saving.value = false;
    submitError.value = "";
    idempotencyKey.value = null;
    roots.value = [createRoot()];
    activeRootId.value = roots.value[0]!.id;
    sourcePath.value = "";
    sourceEntries.value = [];
    sourceLoading.value = false;
    sourceError.value = "";
    systemRoots.value = [];
    systemRootsLoading.value = false;
    systemRootsError.value = "";
    preflightLoading.value = false;
    preflightError.value = "";
    mxcPreflight.value = null;
    hostPreflight.value = null;
    hostRiskAck.value = false;
    nameTouched.value = false;
    descriptionTouched.value = false;
    rootsTouched.value = false;
}

function sourceReadReason(cause: unknown): string {
    if (cause instanceof ApiError) {
        if (cause.problem.code === "RUNTIME_UNAVAILABLE") return t("workspace.runtimeUnavailable");
        return cause.problem.detail || cause.message;
    }
    return cause instanceof Error ? cause.message : t("workspace.sourceReadFailed");
}

function preflightReason(cause: unknown): string {
    if (cause instanceof ApiError) {
        if (cause.problem.code === "RUNTIME_UNAVAILABLE") return t("workspace.runtimeUnavailable");
        if (cause.problem.code === "INVALID_EXECUTION_MODE")
            return t("workspace.preflightInvalidMode");
        if (cause.problem.code === "INVALID_HOST_PATH")
            return t("workspace.preflightInvalidHostPath");
        return cause.problem.detail || cause.message;
    }
    return cause instanceof Error ? cause.message : t("workspace.preflightFailed");
}

function createReason(cause: unknown): string {
    if (cause instanceof ApiError) {
        if (cause.problem.code === "RUNTIME_UNAVAILABLE") return t("workspace.runtimeUnavailable");
        if (cause.problem.code === "DIRECT_ATTACH_UNAVAILABLE")
            return t("workspace.directAttachUnavailable");
        if (cause.problem.code === "IDEMPOTENCY_KEY_REUSE")
            return t("workspace.idempotencyConflict");
        return cause.problem.detail || cause.message;
    }
    return cause instanceof Error ? cause.message : t("workspace.createFailed");
}

function joinPath(base: string, entryName: string): string {
    return `${base.replace(/[\\/]+$/, "")}/${entryName}`;
}

/** Returns "" at a system root (drive root or `/`), so the UI can hide `..`. */
function parentPath(path: string): string {
    const trimmed = path.replace(/[\\/]+$/, "");
    if (!trimmed || trimmed === "/") return "";
    if (/^[A-Za-z]:$/.test(trimmed)) return "";
    const separator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
    if (separator < 0) return "";
    const parent = trimmed.slice(0, separator);
    if (!parent) return trimmed.startsWith("/") ? "/" : "";
    if (/^[A-Za-z]:$/.test(parent)) return `${parent}\\`;
    return parent;
}

async function browse(nextPath = sourcePath.value) {
    const target = nextPath.trim();
    if (!target || sourceLoading.value) return;
    sourceLoading.value = true;
    sourceError.value = "";
    try {
        const result = await api.listImportSources(target);
        sourcePath.value = result.path;
        // Extra runtime fields (e.g. a future `gitRepo`) survive the typed API shape.
        sourceEntries.value = result.entries as SourceEntry[];
    } catch (cause) {
        sourceError.value = sourceReadReason(cause);
        logger.error("Workspace source browse failed", cause);
    } finally {
        sourceLoading.value = false;
    }
}

/**
 * R48/task-980：打开向导即展示系统根。根列表由 CP 的
 * `GET /workspaces/import-source-roots` 枚举（服务端过滤不可读/不存在的盘符）；
 * 前端不再并行探测 26 个盘符。端点失败时隐藏根快捷入口，保留手输路径并给出可读提示。
 */
async function discoverSystemRoots() {
    if (systemRootsLoading.value || systemRoots.value.length > 0) return;
    systemRootsLoading.value = true;
    systemRootsError.value = "";
    try {
        const discovered = await api.listImportSourceRoots();
        systemRoots.value = discovered.map((root) => ({
            path: root.path,
            label: root.label,
        }));
    } catch (cause) {
        systemRoots.value = [];
        systemRootsError.value = t("workspace.sourceReadFailed");
        logger.error("Workspace system root discovery failed", cause);
    } finally {
        systemRootsLoading.value = false;
    }
    const firstRoot = systemRoots.value[0];
    if (firstRoot) await browse(firstRoot.path);
}

function browseSystemRoot(root: SystemRoot) {
    void browse(root.path);
}

function browseRoot(root: RootDraft) {
    activeRootId.value = root.id;
    const target = root.path.trim() || systemRoots.value[0]?.path || sourcePath.value;
    if (target) void browse(target);
}

function commitRootPath(root: RootDraft) {
    root.path = root.path.trim();
    activeRootId.value = root.id;
    if (!root.path) {
        mxcPreflight.value = null;
        hostPreflight.value = null;
        preflightError.value = "";
        return;
    }
    void browse(root.path);
    void runPreflight();
}

function openEntry(entry: SourceEntry) {
    if (entry.kind !== "directory") return;
    void browse(joinPath(sourcePath.value, entry.name));
}

function useThisDirectory() {
    const path = sourcePath.value.trim();
    const activeRoot = roots.value.find((root) => root.id === activeRootId.value) ?? roots.value[0];
    if (!path || !activeRoot) return;
    activeRoot.path = path;
    executionMode.value = "windows-mxc";
    hostRiskAck.value = false;
    void runPreflight();
}

function addRoot() {
    roots.value.push(createRoot());
    activeRootId.value = roots.value[roots.value.length - 1]!.id;
}

function removeRoot(root: RootDraft) {
    if (roots.value.length <= 1) return;
    roots.value = roots.value.filter((item) => item.id !== root.id);
    if (!roots.value.some((item) => item.id === activeRootId.value)) {
        activeRootId.value = roots.value[0]!.id;
    }
    void runPreflight();
}

function aggregatePreflights(
    results: WorkspaceCapabilityPreflight[],
): WorkspaceCapabilityPreflight | null {
    if (results.length === 0) return null;
    if (results.every((preflight) => preflight.available)) return results[0]!;
    return results.find((preflight) => !preflight.available) ?? results[0]!;
}

async function runPreflight() {
    const paths = validRootPaths.value;
    if (!isDirectAttach.value || paths.length === 0) {
        mxcPreflight.value = null;
        hostPreflight.value = null;
        preflightError.value = "";
        return;
    }
    preflightLoading.value = true;
    preflightError.value = "";
    mxcPreflight.value = null;
    hostPreflight.value = null;
    try {
        const pairs = await Promise.all(
            paths.map((hostPath) =>
                Promise.all([
                    api.preflightDirectAttach({
                        hostPath,
                        executionMode: "windows-mxc",
                    }),
                    api.preflightDirectAttach({
                        hostPath,
                        executionMode: "windows-host",
                    }),
                ]),
            ),
        );
        mxcPreflight.value = aggregatePreflights(pairs.map((pair) => pair[0]));
        hostPreflight.value = aggregatePreflights(pairs.map((pair) => pair[1]));
        // Keep MXC as the recommended default. When it is unavailable the UI shows explicit
        // guidance and never silently switches to host execution (no automatic fallback).
        if (mxcAvailable.value) executionMode.value = "windows-mxc";
    } catch (cause) {
        preflightError.value = preflightReason(cause);
        logger.error("Workspace capability preflight failed", cause);
    } finally {
        preflightLoading.value = false;
    }
}

function chooseExecutionMode(mode: WorkspaceDirectAttachExecutionMode) {
    if (isDirectAttach.value) {
        if (mode === "windows-mxc" && !mxcAvailable.value) return;
        if (mode === "windows-host" && !hostAvailable.value) return;
    }
    executionMode.value = mode;
    submitError.value = "";
}

/** Explicit user action from the MXC-unavailable guidance; never applied automatically. */
function switchToHostExecution() {
    if (isDirectAttach.value && !hostAvailable.value) return;
    executionMode.value = "windows-host";
}

function mxcCardStatus(): string {
    if (!isDirectAttach.value) return t("workspace.managedExecutionUnknown");
    if (preflightLoading.value) return t("workspace.preflightChecking");
    if (!hasRootPath.value) return t("workspace.capabilityUnknown");
    const preflight = mxcPreflight.value;
    if (!preflight) return t("workspace.capabilityUnknown");
    return preflight.available
        ? t("workspace.capabilityAvailable")
        : `${t("workspace.capabilityUnavailable")} · ${preflight.reason ?? t("workspace.capabilityUnknownReason")}`;
}

function hostCardStatus(): string {
    if (!isDirectAttach.value) return t("workspace.managedExecutionUnknown");
    if (preflightLoading.value) return t("workspace.preflightChecking");
    if (!hasRootPath.value) return t("workspace.capabilityUnknown");
    const preflight = hostPreflight.value;
    if (!preflight) return t("workspace.capabilityUnknown");
    return preflight.available
        ? t("workspace.capabilityAvailable")
        : `${t("workspace.capabilityUnavailable")} · ${preflight.reason ?? t("workspace.capabilityUnknownReason")}`;
}

async function handleCreate() {
    if (!canSubmit.value) return;
    saving.value = true;
    submitError.value = "";
    idempotencyKey.value ??= globalThis.crypto.randomUUID();
    try {
        const ws = await api.createWorkspace({
            name: name.value.trim(),
            description: description.value.trim() || null,
            storageMode: storageMode.value,
            // Managed import uses the server default executionMode (docker); only
            // direct-attach sends an explicit Windows execution mode.
            // PLAN-0639 M1 / task-957 R45+R49: direct-attach sends every declared root,
            // ordered (root[0] = primary). CP already stores WorkspaceRoot rows by position.
            ...(isDirectAttach.value
                ? {
                      executionMode: executionMode.value,
                      roots: validRootPaths.value.map((path) => ({ path })),
                  }
                : {}),
            idempotencyKey: idempotencyKey.value,
        });
        auth.workspace = ws;
        writeTabWorkspace(ws);
        toast.success(t("workspace.createdToast"));
        emit("created", ws.id);
        emit("close");
        reset();
    } catch (cause) {
        submitError.value = createReason(cause);
        logger.error("Create workspace failed", cause);
        toast.error(submitError.value);
    } finally {
        saving.value = false;
    }
}

function handleOpenChange(value: boolean) {
    if (!value) emit("close");
}

watch(
    () => props.open,
    (open) => {
        if (!open) return;
        reset();
        void discoverSystemRoots();
    },
    { immediate: true },
);
</script>

<template>
    <Dialog :open="open" @update:open="handleOpenChange">
        <DialogContent
            width="form"
            aria-modal="true"
            data-testid="workspace-create-dialog"
            class="max-h-[85vh] overflow-y-auto"
        >
            <DialogHeader>
                <DialogTitle>{{ t("workspace.addWorkspaceTitle") }}</DialogTitle>
                <DialogDescription>{{ t("workspace.addWorkspaceDesc") }}</DialogDescription>
            </DialogHeader>

            <!-- R43: one page for one configuration. `workspace-step-config` is the only
                 element whose testid starts with `workspace-step-`; the structural test
                 counts them, so a step-by-step rewrite fails mechanically. -->
            <div data-testid="workspace-step-config" class="grid gap-5">
                <section class="grid gap-2" data-testid="workspace-config-storage">
                    <!-- PLAN-0612 M4.3 / 2026-10-31 裁定: the workspace Docker execution backend
                         counts as frozen, so the product surface must not offer it at all. The
                         entry is hidden (not merely disabled): an unavailable option with a live
                         click handler invites the user to reach the container-creation error. -->
                    <div
                        v-if="!managedImportAvailable"
                        data-testid="workspace-storage-managed-frozen"
                        class="rounded-md border border-dashed p-3"
                    >
                        <span class="block text-sm font-semibold text-muted-foreground">
                            {{ t("workspace.managedImport") }}
                            <span class="font-normal"
                                >· {{ t("workspace.managedImportFrozen") }}</span
                            >
                        </span>
                        <span class="mt-1 block text-xs text-muted-foreground">
                            {{ t("workspace.managedImportFrozenHint") }}
                        </span>
                    </div>
                    <button
                        v-else
                        type="button"
                        data-testid="workspace-storage-managed"
                        class="rounded-md border p-3 text-left transition-colors hover:bg-accent"
                    >
                        <span class="block text-sm font-semibold">{{
                            t("workspace.managedImport")
                        }}</span>
                        <span class="mt-1 block text-xs text-muted-foreground">{{
                            t("workspace.managedImportDesc")
                        }}</span>
                    </button>
                    <!-- R42 #5: the only legal storage mode is preset; one footer line explains it
                         instead of giving it a page of its own. -->
                    <p
                        data-testid="workspace-storage-single-option"
                        class="text-xs text-muted-foreground"
                    >
                        {{ t("workspace.directAttachDesc") }}
                    </p>
                </section>

                <section v-if="isDirectAttach" class="grid gap-2" data-testid="workspace-roots">
                    <div class="flex items-center justify-between gap-2">
                        <p class="text-sm font-medium">{{ t("workspace.hostDirectory") }}</p>
                        <Button
                            type="button"
                            variant="outline"
                            data-testid="workspace-root-add"
                            @click="addRoot"
                        >
                            <Plus class="size-3.5" aria-hidden="true" />
                            {{ t("workspace.hostDirectory") }}
                        </Button>
                    </div>
                    <div data-testid="workspace-root-list" class="grid gap-2">
                        <div
                            v-for="(root, index) in roots"
                            :key="root.id"
                            data-testid="workspace-root-row"
                            class="flex items-center gap-2 rounded-md border p-1.5"
                            :class="root.id === activeRootId ? 'border-primary' : ''"
                        >
                            <span class="w-5 shrink-0 text-center text-xs text-muted-foreground">
                                {{ index + 1 }}
                            </span>
                            <Input
                                v-model="root.path"
                                data-testid="workspace-root-path"
                                data-form-field="workspaceForm.rootPath"
                                class="font-mono text-xs"
                                :placeholder="t('workspace.sourcePathPlaceholder')"
                                @update:model-value="rootsTouched = true"
                                @keyup.enter="commitRootPath(root)"
                                @change="commitRootPath(root)"
                            />
                            <Button
                                type="button"
                                variant="outline"
                                class="shrink-0"
                                data-testid="workspace-root-browse"
                                :aria-label="t('workspace.hostDirectory')"
                                @click="browseRoot(root)"
                            >
                                <FolderOpen class="size-3.5" aria-hidden="true" />
                            </Button>
                            <Button
                                v-if="roots.length > 1"
                                type="button"
                                variant="ghost"
                                class="shrink-0"
                                data-testid="workspace-root-remove"
                                :aria-label="t('workspace.cancel')"
                                @click="removeRoot(root)"
                            >
                                <X class="size-3.5" aria-hidden="true" />
                            </Button>
                        </div>
                    </div>
                    <p
                        v-if="rootIssue"
                        class="text-xs text-destructive"
                        data-testid="workspace-root-error"
                    >
                        {{ t(rootIssue.messageKey) }}
                    </p>
                </section>

                <section v-if="isDirectAttach" class="grid gap-2" data-testid="workspace-browser">
                    <div class="flex items-center justify-between gap-2">
                        <p class="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                            {{ sourcePath || t("workspace.sourceEmpty") }}
                        </p>
                        <LoaderCircle
                            v-if="sourceLoading || systemRootsLoading"
                            class="size-3.5 animate-spin"
                            aria-hidden="true"
                        />
                    </div>
                    <div
                        v-if="systemRoots.length > 0"
                        data-testid="workspace-system-roots"
                        class="flex flex-wrap gap-2"
                    >
                        <button
                            v-for="root in systemRoots"
                            :key="root.path"
                            type="button"
                            data-testid="workspace-system-root"
                            class="rounded border px-2 py-1 font-mono text-xs hover:bg-muted/50"
                            @click="browseSystemRoot(root)"
                        >
                            {{ root.label }}
                        </button>
                    </div>
                    <p
                        v-if="systemRootsError"
                        class="text-xs text-muted-foreground"
                        data-testid="workspace-system-roots-error"
                    >
                        {{ systemRootsError }}
                    </p>
                    <p
                        v-if="sourceError"
                        class="text-sm text-destructive"
                        data-testid="workspace-source-error"
                    >
                        {{ sourceError }}
                    </p>
                    <div
                        data-testid="workspace-source-browser"
                        class="max-h-52 overflow-auto rounded-md border text-sm"
                    >
                        <button
                            v-if="canGoUp"
                            type="button"
                            data-testid="workspace-source-up"
                            class="flex w-full items-center gap-2 border-b px-3 py-2 text-left hover:bg-muted/50"
                            @click="browse(currentParent)"
                        >
                            <span class="truncate">..</span>
                        </button>
                        <p
                            v-if="sourceLoading"
                            class="p-3 text-muted-foreground"
                            data-testid="workspace-source-loading"
                        >
                            {{ t("workspace.preflightChecking") }}
                        </p>
                        <p v-else-if="sourceEntries.length === 0" class="p-3 text-muted-foreground">
                            {{ t("workspace.sourceEmpty") }}
                        </p>
                        <button
                            v-for="entry in sourceEntries"
                            :key="entry.name"
                            type="button"
                            class="flex w-full items-center gap-2 border-b px-3 py-2 text-left last:border-0 hover:bg-muted/50 disabled:opacity-60"
                            :disabled="entry.kind !== 'directory'"
                            :data-entry-kind="entry.kind"
                            :data-entry-name="entry.name"
                            :data-git="entry.gitRepo === true ? 'true' : 'false'"
                            @click="openEntry(entry)"
                        >
                            <FolderOpen
                                v-if="entry.kind === 'directory'"
                                class="size-3.5 shrink-0"
                                aria-hidden="true"
                            />
                            <FileText v-else class="size-3.5 shrink-0" aria-hidden="true" />
                            <span class="truncate">{{ entry.name }}</span>
                            <!-- R44: Runtime-driven git badge. No runtime flag ⇒ no badge; the
                                 client never infers `.git` from the directory name. -->
                            <span
                                v-if="entry.gitRepo === true"
                                data-testid="workspace-entry-git"
                                class="ml-auto shrink-0 rounded border px-1.5 py-0.5 text-xs font-medium"
                            >
                                Git
                            </span>
                        </button>
                    </div>
                    <p class="text-xs text-muted-foreground">
                        {{ t("workspace.sourceBrowserHint") }}
                    </p>
                    <div class="flex justify-end">
                        <Button
                            type="button"
                            data-testid="workspace-source-use"
                            :disabled="sourceLoading || !sourcePath.trim()"
                            @click="useThisDirectory"
                        >
                            {{ t("workspace.useThisDirectory") }}
                        </Button>
                    </div>
                </section>

                <section
                    v-if="isDirectAttach"
                    data-testid="workspace-execution-section"
                    class="grid gap-3"
                >
                    <p class="text-sm font-medium">{{ t("workspace.executionBackend") }}</p>
                    <p v-if="preflightLoading" class="text-xs text-muted-foreground">
                        {{ t("workspace.preflightChecking") }}
                    </p>
                    <p
                        v-if="preflightError"
                        class="text-sm text-destructive"
                        data-testid="workspace-preflight-error"
                    >
                        {{ preflightError }}
                    </p>

                    <button
                        type="button"
                        data-testid="workspace-execution-mode-mxc"
                        class="rounded-md border p-3 text-left transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
                        :class="executionMode === 'windows-mxc' ? 'border-primary' : ''"
                        :disabled="mxcCardDisabled"
                        :aria-pressed="executionMode === 'windows-mxc'"
                        @click="chooseExecutionMode('windows-mxc')"
                    >
                        <span class="flex items-center gap-2 text-sm font-semibold">
                            {{ t("workspace.executionModeMxc") }}
                            <span
                                v-if="mxcPreflight?.maturity === 'experimental'"
                                class="rounded border border-amber-500/40 px-1.5 py-0.5 text-xs font-normal text-amber-600"
                            >
                                {{ t("workspace.maturityExperimental") }}
                            </span>
                        </span>
                        <span
                            class="mt-1 block text-xs text-muted-foreground"
                            data-testid="workspace-execution-mxc-status"
                            >{{ mxcCardStatus() }}</span
                        >
                    </button>

                    <div
                        v-if="showMxcGuidance"
                        data-testid="workspace-mxc-guidance"
                        class="rounded-md border border-amber-500/40 bg-amber-50/60 p-3 dark:bg-amber-950/30"
                    >
                        <p class="text-xs text-muted-foreground">
                            {{ t("workspace.mxcUnavailableGuidance") }}
                        </p>
                        <Button
                            type="button"
                            variant="outline"
                            class="mt-2"
                            data-testid="workspace-switch-to-host"
                            :disabled="!hostAvailable"
                            @click="switchToHostExecution"
                        >
                            {{ t("workspace.switchToHostExecution") }}
                        </Button>
                    </div>

                    <button
                        type="button"
                        data-testid="workspace-execution-mode-host"
                        class="rounded-md border p-3 text-left transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
                        :class="executionMode === 'windows-host' ? 'border-primary' : ''"
                        :disabled="hostCardDisabled"
                        :aria-pressed="executionMode === 'windows-host'"
                        @click="chooseExecutionMode('windows-host')"
                    >
                        <span class="flex items-center gap-2 text-sm font-semibold">
                            <ShieldAlert class="size-3.5 text-amber-600" aria-hidden="true" />
                            {{ t("workspace.executionModeHost") }}
                        </span>
                        <span class="mt-1 block text-xs text-muted-foreground">{{
                            t("workspace.hostBackendDesc")
                        }}</span>
                        <span
                            class="mt-1 block text-xs text-muted-foreground"
                            data-testid="workspace-execution-host-status"
                            >{{ hostCardStatus() }}</span
                        >
                    </button>

                    <button
                        type="button"
                        data-testid="workspace-execution-mode-docker"
                        class="rounded-md border p-3 text-left opacity-60"
                        disabled
                    >
                        <span class="block text-sm font-semibold">{{
                            t("workspace.executionModeDocker")
                        }}</span>
                        <span class="mt-1 block text-xs text-muted-foreground">{{
                            t("workspace.dockerPostponed")
                        }}</span>
                    </button>
                </section>

                <section class="grid gap-4" data-testid="workspace-config-identity">
                    <div class="grid gap-2">
                        <label class="text-sm font-medium" for="ws-create-name">{{
                            t("workspace.nameLabel")
                        }}</label>
                        <Input
                            id="ws-create-name"
                            v-model="name"
                            data-testid="workspace-create-name"
                            data-form-field="workspaceForm.name"
                            :placeholder="t('workspace.namePlaceholder')"
                            maxlength="120"
                            @update:model-value="nameTouched = true"
                        />
                        <p
                            v-if="nameValidation.showError"
                            class="text-xs text-destructive"
                            data-testid="workspace-name-error"
                        >
                            {{ t(nameValidation.primaryIssue!.messageKey) }}
                        </p>
                    </div>
                    <div class="grid gap-2">
                        <label class="text-sm font-medium" for="ws-create-description">{{
                            t("workspace.descriptionLabel")
                        }}</label>
                        <Input
                            id="ws-create-description"
                            v-model="description"
                            data-form-field="workspaceForm.description"
                            :placeholder="t('workspace.descriptionPlaceholder')"
                            maxlength="500"
                            @update:model-value="descriptionTouched = true"
                        />
                        <p
                            v-if="descriptionValidation.showError"
                            class="text-xs text-destructive"
                            data-testid="workspace-description-error"
                        >
                            {{ t(descriptionValidation.primaryIssue!.messageKey) }}
                        </p>
                    </div>
                </section>

                <dl
                    data-testid="workspace-create-summary"
                    class="grid gap-2 rounded-md border p-3 text-xs"
                >
                    <div class="flex justify-between gap-3">
                        <dt class="text-muted-foreground">
                            {{ t("workspace.summaryStorageMode") }}
                        </dt>
                        <dd>{{ storageModeLabel }}</dd>
                    </div>
                    <div v-if="isDirectAttach" class="flex items-start justify-between gap-3">
                        <dt class="shrink-0 text-muted-foreground">
                            {{ t("workspace.summaryDirectory") }}
                        </dt>
                        <dd
                            class="break-all text-right font-mono"
                            data-testid="workspace-summary-roots"
                        >
                            {{ validRootPaths.join(" · ") }}
                        </dd>
                    </div>
                    <div class="flex justify-between gap-3">
                        <dt class="text-muted-foreground">
                            {{ t("workspace.summaryExecutionMode") }}
                        </dt>
                        <dd data-testid="workspace-summary-execution-mode">
                            {{ executionModeLabel }}
                        </dd>
                    </div>
                    <div class="flex justify-between gap-3">
                        <dt class="text-muted-foreground">{{ t("workspace.summaryMaturity") }}</dt>
                        <dd data-testid="workspace-summary-maturity">{{ executionMaturity }}</dd>
                    </div>
                    <div class="flex items-start justify-between gap-3">
                        <dt class="shrink-0 text-muted-foreground">
                            {{ t("workspace.summaryAvailability") }}
                        </dt>
                        <dd
                            data-testid="workspace-summary-availability"
                            :class="
                                isDirectAttach && !activePreflight?.available
                                    ? 'text-destructive'
                                    : ''
                            "
                        >
                            {{ executionAvailability }}
                        </dd>
                    </div>
                </dl>

                <div
                    v-if="executionMode === 'windows-host'"
                    class="rounded-md border border-amber-500/40 bg-amber-50/60 p-3 dark:bg-amber-950/30"
                >
                    <p class="text-xs font-medium">{{ t("workspace.hostRiskTitle") }}</p>
                    <p class="mt-1 text-xs text-muted-foreground">
                        {{ t("workspace.hostRiskDescription") }}
                    </p>
                    <label class="mt-2 flex items-start gap-2 text-xs">
                        <Checkbox
                            data-testid="workspace-host-risk-ack"
                            :model-value="hostRiskAck"
                            @update:model-value="hostRiskAck = $event === true"
                        />
                        <span>{{ t("workspace.hostRiskAckLabel") }}</span>
                    </label>
                    <p v-if="!hostRiskAck" class="mt-1 text-xs text-destructive">
                        {{ t("workspace.hostRiskAckRequired") }}
                    </p>
                </div>

                <p
                    v-if="submitError"
                    class="text-sm text-destructive"
                    data-testid="workspace-create-error"
                >
                    {{ submitError }}
                </p>
            </div>

            <DialogFooter>
                <Button variant="ghost" @click="emit('close')">{{ t("workspace.cancel") }}</Button>
                <Button
                    type="button"
                    data-testid="workspace-create-submit"
                    :disabled="!canSubmit"
                    @click="handleCreate"
                >
                    <LoaderCircle v-if="saving" class="animate-spin" aria-hidden="true" />
                    {{ t("workspace.create") }}
                </Button>
            </DialogFooter>
        </DialogContent>
    </Dialog>
</template>
