<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Plus, RefreshCw } from "@lucide/vue";
import { toast } from "vue-sonner";
import { Button } from "../../ui/button";
import { Badge } from "../../ui/badge";
import CredentialCreateDialog from "./CredentialCreateDialog.vue";
import SettingsPermissionGate from "../SettingsPermissionGate.vue";
import SettingsErrorSurface from "../SettingsErrorSurface.vue";
import CredentialDetailDialog from "./CredentialDetailDialog.vue";
import CredentialLinkDialog from "./CredentialLinkDialog.vue";
import CredentialReplaceDialog from "./CredentialReplaceDialog.vue";
import CredentialRevealDialog from "./CredentialRevealDialog.vue";
import { useAuthStore } from "../../../stores/auth";
import { useCredentialsStore } from "../../../stores/credentials";
import type { CredentialOwnerType, CredentialSummary } from "../../../types";

/**
 * PLAN-0752 T4.2：**按层收窄的凭据面板**。
 *
 * <p>凭据后端只有 `owner_type ∈ {USER, WORKSPACE}` 两档（`V63__credential_core.sql:37`
 * 的 CHECK 约束），所以同一份面板在用户层（默认，不带 scope = 我可见的全部）与工作区层
 * （`ownerType="WORKSPACE"`）复用；实例层没有承载，走缺口说明而不是这里。</p>
 */
const props = defineProps<{
    /** 该层只看/新建哪种归属的凭据；不传 = 服务端默认视图（用户层）。 */
    ownerType?: CredentialOwnerType;
}>();

const { t } = useI18n(),
    store = useCredentialsStore(),
    auth = useAuthStore();

/**
 * PLAN-0752 T4.4：凭据页**不是**整页 403 —— 列表在 CP 侧没有 atom（只按归属收窄，
 * `CredentialController:57-58`），整页拒绝会骗人。有 atom 的是**写操作**：注册需要
 * `credential_manage@credential:*`（`CredentialAdminService:265-286`）。所以这里把 403 语义
 * 落在「新建」这个动作上：没被授予就换成 403 说明，而不是给一个点了必然 403 的按钮。
 */
const canManage = computed(() => auth.hasInstanceAtom("credential_manage"));

/** 只在面板被限定到某一层时，把「这里管的是哪种归属」说清楚（避免和另一层的列表混淆）。 */
const scopeNote = computed(() =>
    props.ownerType === "WORKSPACE" ? t("credentials.scopeWorkspaceNote") : "",
);

const createOpen = ref(false),
    activeDialog = ref<"detail" | "replace" | "reveal" | "link" | null>(null),
    selectedId = ref<string | null>(null),
    reloading = ref(false);

const selected = computed<CredentialSummary | null>(
    () => store.credentials.find((item) => item.id === selectedId.value) ?? null,
);

function selectRow(credential: CredentialSummary) {
    selectedId.value = credential.id;
    activeDialog.value = "detail";
}

function closeDialogs() {
    activeDialog.value = null;
}

function openLink(credential: CredentialSummary) {
    selectedId.value = credential.id;
    activeDialog.value = "link";
}

/** PLAN-0498: bind/unbind keeps the detail dialog open — refresh the list only.
 *  Deletion closes the detail dialog itself (the detail emits `close` after `changed`). */
function refreshAfterChange() {
    void store.load(props.ownerType);
}

/**
 * task-189（P1-1）：刷新必须「真的重发 + 有可见反馈」。store.load 本身会重新请求，
 * 这里补上成功/失败两种 toast —— 旧版失败时页面只是把同一条 404 原样再画一遍，
 * 用户看不出刷新到底有没有发生。
 */
async function refresh() {
    reloading.value = true;
    try {
        await store.load(props.ownerType);
        if (store.error) {
            toast.error(t("credentials.refreshFailed"));
        } else {
            toast.success(t("credentials.refreshDone"));
        }
    } finally {
        reloading.value = false;
    }
}

function fingerprintShort(value: string): string {
    return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}

function ownerLabel(credential: CredentialSummary): string {
    return credential.ownerType === "WORKSPACE"
        ? t("credentials.ownerWorkspace")
        : t("credentials.ownerUser");
}

onMounted(async () => {
    await auth.ensureSelfPermissions();
    void store.load(props.ownerType);
});
</script>

<template>
    <div>
        <header class="mb-6 flex flex-wrap items-end justify-between gap-4">
            <div>
                <p class="mb-1 text-xs uppercase tracking-[0.18em] text-muted-foreground">
                    XH / Credentials
                </p>
                <!-- task-189（P1-2）：页面标题是 h2；层标题（settings-layer-title）才是唯一 h1。 -->
                <h2 data-testid="settings-page-title" class="text-xl font-semibold tracking-tight">
                    {{ t("credentials.heading") }}
                </h2>
                <p class="mt-1 text-sm text-muted-foreground">{{ t("credentials.desc") }}</p>
                <p
                    v-if="scopeNote"
                    data-testid="credentials-scope-note"
                    class="mt-1 text-xs text-muted-foreground"
                >
                    {{ scopeNote }}
                </p>
            </div>
            <div class="flex items-center gap-2">
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid="credentials-refresh"
                    :disabled="reloading"
                    @click="refresh"
                >
                    <RefreshCw aria-hidden="true" />
                    {{ t("credentials.refresh") }}
                </Button>
                <Button
                    v-if="canManage"
                    type="button"
                    size="sm"
                    data-testid="credentials-create-button"
                    @click="createOpen = true"
                >
                    <Plus aria-hidden="true" />
                    {{ t("credentials.create") }}
                </Button>
            </div>
        </header>

        <!-- 无 credential_manage ⇒ 403 说明（不是「后端缺口」，也不是「无此概念」）。
             外层 div 自带 testid：组件根节点已有 settings-atom-denied，直接透传 data-testid 会覆盖它。 -->
        <div v-if="!canManage" data-testid="credentials-manage-denied" class="mb-4">
            <SettingsPermissionGate variant="atom-denied" atom="credential_manage" />
        </div>

        <!-- task-189（P1-1）：接 168 统一错误面 —— 本地化文案 + 重试出口，绝不渲染 ApiError.message 原文。
             外层保留 credentials-error 作为本页定位点（SettingsErrorSurface 内部自带 settings-error-panel /
             settings-error-retry 两个 testid）。 -->
        <div v-if="store.error" data-testid="credentials-error" class="mb-4">
            <SettingsErrorSurface
                :cause="store.error"
                :message="t('credentials.loadFailed')"
                :retry="refresh"
                retry-key="settings.errorSurface.retry"
            />
        </div>

        <section class="min-w-0 rounded-lg border border-border bg-card">
            <div class="flex items-center justify-between border-b border-border px-4 py-3">
                <h2 class="text-sm font-medium" data-testid="credentials-list-heading">
                    {{ t("credentials.heading") }}
                </h2>
                <span class="text-xs text-muted-foreground">{{ store.credentials.length }}</span>
            </div>
            <div v-if="store.loading" class="p-4 text-sm text-muted-foreground">
                {{ t("common.loading") }}
            </div>
            <div
                v-else-if="store.credentials.length === 0"
                data-testid="credentials-empty"
                class="p-8 text-center text-sm text-muted-foreground"
            >
                {{ t("credentials.empty") }}
            </div>
            <ul v-else data-testid="credentials-list" class="divide-y divide-border">
                <li
                    v-for="credential in store.credentials"
                    :key="credential.id"
                    class="flex items-start gap-2 px-4 py-3 hover:bg-muted/50"
                >
                    <button
                        type="button"
                        class="min-w-0 flex-1 text-left"
                        :data-testid="`credentials-row-${credential.id}`"
                        @click="selectRow(credential)"
                    >
                        <div class="flex items-start justify-between gap-3">
                            <span
                                class="min-w-0 truncate text-sm font-medium"
                                :data-testid="`credentials-row-label-${credential.id}`"
                            >
                                {{ credential.label }}
                            </span>
                            <Badge
                                v-if="credential.status === 'active'"
                                variant="secondary"
                                data-testid="credentials-row-status-active"
                            >
                                {{ t("credentials.statusActive") }}
                            </Badge>
                            <Badge
                                v-else
                                variant="outline"
                                data-testid="credentials-row-status-disabled"
                            >
                                {{ t("credentials.statusDisabled") }}
                            </Badge>
                        </div>
                        <div
                            class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground"
                        >
                            <span>{{
                                credential.kind === "token"
                                    ? t("credentials.kindToken")
                                    : t("credentials.kindKeyPair")
                            }}</span>
                            <span>{{
                                credential.deliveryTier === "lease"
                                    ? t("credentials.tierLease")
                                    : t("credentials.tierReveal")
                            }}</span>
                            <span>{{ ownerLabel(credential) }}</span>
                            <span class="font-mono" :title="credential.fingerprint">
                                {{ fingerprintShort(credential.fingerprint) }}
                            </span>
                            <span>{{
                                credential.referenceCount > 0
                                    ? t("credentials.refCount", {
                                          count: credential.referenceCount,
                                      })
                                    : t("credentials.refEmpty")
                            }}</span>
                        </div>
                    </button>
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        class="shrink-0"
                        :data-testid="`credentials-link-action-${credential.id}`"
                        @click="openLink(credential)"
                    >
                        {{ t("credentials.linkAction") }}
                    </Button>
                </li>
            </ul>
        </section>

        <CredentialCreateDialog :open="createOpen" @close="createOpen = false" />
        <CredentialDetailDialog
            :open="activeDialog === 'detail'"
            :credential="selected"
            @close="closeDialogs"
            @replace="activeDialog = 'replace'"
            @reveal="activeDialog = 'reveal'"
            @changed="refreshAfterChange"
        />
        <CredentialReplaceDialog
            :open="activeDialog === 'replace'"
            :credential-id="selectedId ?? ''"
            :kind="selected?.kind ?? 'token'"
            @close="activeDialog = selected ? 'detail' : null"
            @replaced="activeDialog = selected ? 'detail' : null"
        />
        <CredentialRevealDialog
            :open="activeDialog === 'reveal'"
            :credential-id="selectedId ?? ''"
            :label="selected?.label ?? ''"
            @close="activeDialog = selected ? 'detail' : null"
        />
        <CredentialLinkDialog
            :open="activeDialog === 'link'"
            :credential-id="selectedId ?? ''"
            :credential-label="selected?.label"
            @close="activeDialog = null"
            @linked="refreshAfterChange"
        />
    </div>
</template>
