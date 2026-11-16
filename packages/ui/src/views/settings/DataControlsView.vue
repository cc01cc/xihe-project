<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { logger } from "../../lib/logger";
import ImportPreview, { type ImportData } from "../../components/settings/ImportPreview.vue";
import { apiRaw, api } from "../../composables/api";
import SettingsPermissionGate from "../../components/settings/SettingsPermissionGate.vue";
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
} from "../../components/ui/collapsible";
import { presentCauseError, type ErrorPresentation } from "../../lib/errorMessages";
import { useAuthStore } from "../../stores/auth";
import { useCheckpointStore } from "../../stores/checkpoint";
import type { CheckpointRetention } from "../../types";

const { t } = useI18n(),
    authStore = useAuthStore(),
    checkpointStore = useCheckpointStore(),
    exporting = ref(false),
    importing = ref(false),
    importFile = ref<File | null>(null),
    showImportPreview = ref(false),
    result = ref<string | null>(null);
/**
 * 导入结果里的 `warnings[]`（CP 按域合并时跳过/降级项，如
 * `provider-connections: 1 credential(s) skipped - rebuild them via …`）。
 * 旧配置页 `ConfigSettings.vue` 有渲染（`config-import-warnings`），M1 页面替换时丢失；
 * 这里沿用同一 testid，文案直接展示 CP 原文（后端生成的自然语言，翻译反而失真）。
 */
const importWarnings = ref<string[]>([]);

// PLAN-0339: informational retention view + explicit workspace shadow cleanup.
// Constants are server-reported (N=50 / TTL 30d); the UI never invents them.
/**
 * task-5（D-1521 #3=A）：**按动作分判** —— 每个按钮用**它真正调用的端点**的判据，整页一个 OR/AND
 * 都算错层（要么窄化一半、要么放宽另一半）：
 *
 * <ul>
 *   <li><b>import</b> → `POST /api/v1/config/import`，CP 门 = 动作原子 `WRITE_INSTANCE_CONTENT`
 *       （`ConfigController.java:572`）；</li>
 *   <li><b>export</b>（两个按钮都打 `GET /api/v1/config/export`）→ CP 门 = **能力位**
 *       `hasAuthority('cap:instance:admin')`（`ConfigController.java:607-610`，注释写明那是
 *       「读内容 ∧ 看密文」的复合门，没有单一动作原子可表达 ⇒ 不能改成原子）；</li>
 *   <li><b>保留期清理</b> → 工作区成员面（那半条判据归 `task-153`，本次不动）。</li>
 * </ul>
 *
 * 密文可见性不是 UI 门：不持 `VIEW_SECRET_CONTENT` 时服务端**脱敏**而不是 403
 * （`ConfigController.java:93-99`）⇒ UI 不为它加第三个门。
 */
const canImport = computed(() => authStore.hasInstanceAtom("WRITE_INSTANCE_CONTENT"));
/** 能力位来自 `/auth/me` 投影（登录时即落地），不在本页的异步链上。 */
const canExport = computed(() => authStore.hasInstanceAdminCapability);

/**
 * 三态而不是两态：原子投影是异步的。若一上来就按「没权限」渲染 403，已授权用户会先看到一屏
 * 「权限不足」再跳成正常页（假 403）。`permissionsChecked` 落定前只渲染标题，两边的谎都不说。
 */
const permissionsChecked = ref(false);
/**
 * 403 卡片只在**实例数据面的两个动作都不可用**时出现（否则会连坐另一半：比如把「只有能力位」的
 * 账号挡在导出之外）。403 卡片仍点名 import 那一半的原子，因为它是唯一"可被授予"的机器码。
 * task-20（D-1667）：这层门只守 import / export；保留期清理属 workspace 成员面，已拆到门外。
 */
const dataDenied = computed(() => permissionsChecked.value && !canImport.value && !canExport.value);

const workspaceId = computed(() => authStore.currentWorkspaceId),
    retention = ref<CheckpointRetention | null>(null),
    retentionLoading = ref(false),
    retentionError = ref<ErrorPresentation | null>(null),
    cleanupConfirming = ref(false),
    cleanupBusy = ref(false),
    cleanupResult = ref<string | null>(null);

/**
 * task-45：**单一入口**取错误呈现（不再本地拼 `<code>: <detail>`）。
 *
 * <p>改前的 `errorText` 会渲染出 `AUDIT_ERROR: API error 500` 这种「英文码 + 英文兜底」，
 * 违反 DEV-011。现在三件事由 `presentError` 拆开：本页是**诊断面**（设置区），所以原始
 * detail 允许出现在 vendor `Collapsible` 里（默认折叠）；非 ApiError 仍回落到本页文案。</p>
 */
function errorPresentation(cause: unknown, fallback: string): ErrorPresentation {
    return presentCauseError(t, cause, fallback);
}

async function loadRetention() {
    const wsId = workspaceId.value;
    if (!wsId) {
        retention.value = null;
        return;
    }
    retentionLoading.value = true;
    retentionError.value = null;
    try {
        retention.value = await api.getWorkspaceCheckpointRetention(wsId);
    } catch (cause) {
        retentionError.value = errorPresentation(cause, t("settings.checkpointLoadFailed"));
        logger.warn("Failed to load checkpoint retention", cause);
    } finally {
        retentionLoading.value = false;
    }
}

async function cleanupCheckpoints() {
    const wsId = workspaceId.value;
    if (!wsId || cleanupBusy.value) return;
    cleanupBusy.value = true;
    cleanupResult.value = null;
    try {
        const outcome = await api.cleanupWorkspaceCheckpoints(wsId);
        checkpointStore.clearWorkspace(wsId);
        cleanupResult.value = outcome.removed
            ? t("settings.checkpointCleanupDone")
            : t("settings.checkpointCleanupEmpty");
        cleanupConfirming.value = false;
        await loadRetention();
    } catch (cause) {
        // 瞬时结果行：只给可读文案，原始 detail 已在下一行 logger.warn 留痕（不在结果行里塞折叠控件）。
        cleanupResult.value = `${t("settings.checkpointCleanupFailed")}: ${errorPresentation(cause, "").copy}`;
        logger.warn("Failed to clean workspace checkpoints", cause);
    } finally {
        cleanupBusy.value = false;
    }
}

onMounted(async () => {
    // 先拿原子投影（单飞、失败 fail-closed），再决定取不取实例数据：无权限时不发请求（T4.4 判据②）。
    await authStore.ensureSelfPermissions();
    permissionsChecked.value = true;
    // task-20（D-1667）：保留期清理的判据是 **workspace 成员面**（CP 只校验 `isAuthenticated()`
    // + `requireAccessibleWorkspace` → `memberships.isMember`），与实例原子无关 ⇒ 只要有工作区
    // 上下文就取保留期，不再被 canImport / canExport 连坐。无工作区时不发请求（走空态）。
    if (workspaceId.value) await loadRetention();
});
watch(workspaceId, () => {
    cleanupConfirming.value = false;
    cleanupResult.value = null;
    if (workspaceId.value) void loadRetention();
});

async function exportSettings() {
    exporting.value = true;
    try {
        const res = await apiRaw("/config/export"),
            blob = await res.blob();
        downloadBlob(blob, "xihe-settings.json");
    } catch (e) {
        logger.error(`Settings export failed: ${e instanceof Error ? e.message : String(e)}`);
        result.value = "Export failed";
    }
    exporting.value = false;
}

async function exportChats() {
    exporting.value = true;
    try {
        const res = await apiRaw("/config/export"),
            blob = await res.blob();
        downloadBlob(blob, "xihe-chats.json");
    } catch (e) {
        logger.error(`Chats export failed: ${e instanceof Error ? e.message : String(e)}`);
        result.value = "Export failed";
    }
    exporting.value = false;
}

function handleFileSelected(e: Event) {
    const files = (e.target as HTMLInputElement).files;
    if (!files?.length) return;
    importFile.value = files[0];
    showImportPreview.value = true;
}

async function handleConfirmImport(data: ImportData) {
    importing.value = true;
    importWarnings.value = [];
    try {
        const text = await data.file.text(),
            res = await apiRaw("/config/import", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: text,
            }),
            resultData = (await res.json()) as {
                imported?: number;
                skipped?: number;
                warnings?: unknown;
            };
        result.value = `Imported: ${resultData.imported}, Skipped: ${resultData.skipped}`;
        // 只渲染非空字符串；形状异常时降级为「无 warnings」而不是把 [object Object] 摆上页。
        importWarnings.value = Array.isArray(resultData.warnings)
            ? resultData.warnings.filter(
                  (warning): warning is string =>
                      typeof warning === "string" && warning.trim().length > 0,
              )
            : [];
    } catch (e) {
        logger.error(`Chats import failed: ${e instanceof Error ? e.message : String(e)}`);
        result.value = "Import failed";
        importWarnings.value = [];
    }
    importing.value = false;
    showImportPreview.value = false;
}

function handleCancelImport() {
    showImportPreview.value = false;
}

function downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob),
        a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}
</script>

<template>
    <div class="space-y-4">
        <h3 data-testid="settings-data-heading" class="font-medium">
            {{ t("settings.dataControls") }}
        </h3>

        <template v-if="permissionsChecked">
            <!-- 实例数据面（import 门 = 写原子 / export 门 = 能力位）：无授权时只留 403 说明；
                 实例主体不挂载 ⇒ 不会发出无谓请求。task-20（D-1667）：这层门**不再连坐**下面的
                 工作区切片保留 / 清理（那半条判据是 workspace 成员面，见本段下方）。 -->
            <SettingsPermissionGate
                v-if="dataDenied"
                variant="atom-denied"
                atom="WRITE_INSTANCE_CONTENT"
            />
            <div v-if="!dataDenied" class="space-y-2">
                <button
                    data-testid="settings-data-export-settings"
                    class="w-full px-3 py-2 rounded text-xs border bg-background hover:bg-muted text-left transition-colors"
                    :disabled="exporting || !canExport"
                    @click="exportSettings"
                >
                    {{ t("settings.exportSettings") }}
                </button>
                <button
                    data-testid="settings-data-export-chats"
                    class="w-full px-3 py-2 rounded text-xs border bg-background hover:bg-muted text-left transition-colors"
                    :disabled="exporting || !canExport"
                    @click="exportChats"
                >
                    {{ t("settings.exportChats") }}
                </button>
                <!-- #3=A：导出那一半的判据是能力位（CP 的复合门），缺它时禁用 + 就地说明。 -->
                <p
                    v-if="!canExport"
                    data-testid="settings-data-export-denied"
                    class="text-xs leading-relaxed text-muted-foreground"
                >
                    {{
                        t("settings.ia.instanceExportCapabilityNeeded", {
                            capability: "cap:instance:admin",
                        })
                    }}
                </p>
            </div>

            <div v-if="!dataDenied" class="border-t pt-3 space-y-2">
                <button
                    data-testid="settings-data-import"
                    class="px-3 py-2 rounded text-xs border bg-background hover:bg-muted transition-colors disabled:pointer-events-none disabled:opacity-50"
                    :disabled="!canImport"
                    @click="($refs.fileInput as HTMLInputElement)?.click()"
                >
                    {{ t("settings.import") }}
                </button>
                <!-- #3=A：导入那一半的判据是动作原子（CP `ConfigController:572`），缺它时禁用 + 点名原子。 -->
                <p
                    v-if="!canImport"
                    data-testid="settings-data-import-denied"
                    class="text-xs leading-relaxed text-muted-foreground"
                >
                    {{
                        t("settings.ia.instanceWriteAtomNeeded", { atom: "WRITE_INSTANCE_CONTENT" })
                    }}
                </p>
                <input
                    ref="fileInput"
                    data-testid="settings-data-import-file"
                    type="file"
                    accept=".json"
                    class="hidden"
                    @change="handleFileSelected"
                />

                <ImportPreview
                    v-if="showImportPreview"
                    :file="importFile"
                    @confirm="handleConfirmImport"
                    @cancel="handleCancelImport"
                />
            </div>

            <!-- 工作区切片保留 / 清理：判据是 **workspace 成员面**，不是实例原子（task-20 / D-1667）。
                 CP `RunCheckpointController` 的 retention:183-198 / cleanup:214-232 都是
                 `@PreAuthorize("isAuthenticated()")` + `requireWorkspaceAccess` →
                 `WorkspaceService.requireAccessibleWorkspace`:278-288 的 `memberships.isMember`；
                 而 import 是写原子 `WRITE_INSTANCE_CONTENT`、export 是能力位 `cap:instance:admin`
                 ⇒ 三者不是同一层。放在实例原子门之外：工作区成员即使无任何实例原子也能看到并点击。 -->
            <div class="border-t pt-3 space-y-2" data-testid="settings-checkpoint-retention">
                <h4 class="text-xs font-medium">{{ t("settings.checkpointRetention") }}</h4>
                <p class="text-xs text-muted-foreground">
                    {{ t("settings.checkpointRetentionDesc") }}
                </p>

                <p
                    v-if="retentionLoading"
                    data-testid="settings-checkpoint-loading"
                    class="text-xs text-muted-foreground"
                >
                    {{ t("common.loading") }}
                </p>
                <div
                    v-else-if="retentionError"
                    data-testid="settings-checkpoint-error"
                    class="space-y-1"
                >
                    <p
                        data-testid="settings-checkpoint-error-copy"
                        class="text-xs text-destructive"
                        role="alert"
                    >
                        {{ retentionError.copy }}
                    </p>
                    <!--
                        task-45：原始 detail 是**诊断信息**，不是主文案 —— 本页属诊断面（设置区），
                        所以收进 vendor Collapsible 默认折叠；toast 面（聊天/变更面板）不放折叠控件，
                        那些地方只 logger.warn 留痕。没有 detail 时不渲染空折叠区。
                    -->
                    <Collapsible v-if="retentionError.technicalDetail">
                        <CollapsibleTrigger as-child>
                            <button
                                type="button"
                                data-testid="settings-checkpoint-error-detail-toggle"
                                class="rounded text-xs text-muted-foreground underline underline-offset-2"
                            >
                                {{ t("errors.technicalDetail") }}
                            </button>
                        </CollapsibleTrigger>
                        <CollapsibleContent>
                            <pre
                                data-testid="settings-checkpoint-error-detail-body"
                                class="mt-1 max-h-40 overflow-auto rounded border bg-muted/40 p-2 font-mono text-[11px] whitespace-pre-wrap break-all text-muted-foreground"
                                >{{ retentionError.technicalDetail }}</pre>
                        </CollapsibleContent>
                    </Collapsible>
                    <button
                        type="button"
                        data-testid="settings-checkpoint-retry"
                        class="px-2 py-1 rounded text-xs border bg-background hover:bg-muted transition-colors"
                        @click="loadRetention"
                    >
                        {{ t("common.retry") }}
                    </button>
                </div>
                <p
                    v-else-if="!workspaceId"
                    data-testid="settings-checkpoint-no-workspace"
                    class="text-xs text-muted-foreground"
                >
                    {{ t("settings.checkpointNoWorkspace") }}
                </p>
                <template v-else-if="retention">
                    <dl
                        data-testid="settings-checkpoint-constants"
                        class="grid grid-cols-2 gap-2 text-xs"
                    >
                        <div
                            class="flex justify-between gap-2 rounded border bg-muted/20 px-2 py-1"
                        >
                            <dt class="text-muted-foreground">
                                {{ t("settings.checkpointMaxRuns") }}
                            </dt>
                            <dd data-testid="settings-checkpoint-max-runs" class="font-medium">
                                {{ retention.maxRuns }}
                            </dd>
                        </div>
                        <div
                            class="flex justify-between gap-2 rounded border bg-muted/20 px-2 py-1"
                        >
                            <dt class="text-muted-foreground">
                                {{ t("settings.checkpointTtlDays") }}
                            </dt>
                            <dd data-testid="settings-checkpoint-ttl-days" class="font-medium">
                                {{ retention.ttlDays }}
                            </dd>
                        </div>
                        <div
                            class="flex justify-between gap-2 rounded border bg-muted/20 px-2 py-1"
                        >
                            <dt class="text-muted-foreground">
                                {{ t("settings.checkpointCurrentRuns") }}
                            </dt>
                            <dd data-testid="settings-checkpoint-current-runs" class="font-medium">
                                {{ retention.currentRuns }}
                            </dd>
                        </div>
                        <div
                            class="flex justify-between gap-2 rounded border bg-muted/20 px-2 py-1"
                        >
                            <dt class="text-muted-foreground">
                                {{ t("settings.checkpointCurrentRefs") }}
                            </dt>
                            <dd data-testid="settings-checkpoint-current-refs" class="font-medium">
                                {{ retention.currentRefs }}
                            </dd>
                        </div>
                    </dl>
                </template>

                <div v-if="!cleanupConfirming">
                    <button
                        type="button"
                        data-testid="settings-checkpoint-cleanup"
                        class="px-3 py-2 rounded text-xs border bg-background hover:bg-muted transition-colors disabled:opacity-50"
                        :disabled="!workspaceId || cleanupBusy"
                        @click="cleanupConfirming = true"
                    >
                        {{ t("settings.checkpointCleanup") }}
                    </button>
                </div>
                <div
                    v-else
                    data-testid="settings-checkpoint-cleanup-confirm-box"
                    class="space-y-2 rounded border border-amber-500/40 bg-amber-500/10 p-2"
                >
                    <p class="text-xs">{{ t("settings.checkpointCleanupWarning") }}</p>
                    <div class="flex flex-wrap gap-2">
                        <button
                            type="button"
                            data-testid="settings-checkpoint-cleanup-cancel"
                            class="px-2 py-1 rounded text-xs border bg-background hover:bg-muted transition-colors"
                            :disabled="cleanupBusy"
                            @click="cleanupConfirming = false"
                        >
                            {{ t("common.cancel") }}
                        </button>
                        <button
                            type="button"
                            data-testid="settings-checkpoint-cleanup-confirm"
                            class="px-2 py-1 rounded text-xs border border-destructive/40 bg-background text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
                            :disabled="cleanupBusy"
                            @click="cleanupCheckpoints"
                        >
                            {{ t("settings.checkpointCleanupConfirm") }}
                        </button>
                    </div>
                </div>
                <p
                    v-if="cleanupResult"
                    data-testid="settings-checkpoint-cleanup-result"
                    class="text-xs text-muted-foreground"
                >
                    {{ cleanupResult }}
                </p>
            </div>

            <p v-if="result" class="text-xs text-muted-foreground">{{ result }}</p>
            <ul
                v-if="importWarnings.length"
                data-testid="config-import-warnings"
                class="text-xs text-amber-600 list-disc pl-4"
            >
                <li v-for="(warning, index) in importWarnings" :key="index">{{ warning }}</li>
            </ul>
        </template>
    </div>
</template>
