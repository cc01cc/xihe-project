<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { KeyRound, Plus, Trash2, Eye } from "@lucide/vue";

import { useAuthStore } from "../../stores/auth";
import { logger } from "../../lib/logger";
import {
    createInstanceCredential,
    deleteInstanceCredential,
    listInstanceCredentials,
    revealInstanceCredential,
    type InstanceCredential,
} from "../../services/instanceResources";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent } from "../ui/card";
import { Skeleton } from "../ui/skeleton";
import {
    Empty,
    EmptyContent,
    EmptyDescription,
    EmptyHeader,
    EmptyMedia,
    EmptyTitle,
} from "../ui/empty";
import {
    AlertDialog,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "../ui/alert-dialog";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import SettingsErrorSurface from "./SettingsErrorSurface.vue";
import SettingsPermissionGate from "./SettingsPermissionGate.vue";

/**
 * task-165 · 实例层「凭据」面板（`/settings/instance/credentials`）。
 *
 * <p><b>为什么这页有 403 档</b>：实例凭据（D-1009）是**实例级资源**，写面只给 instance admin
 * （D-1006 B7）。读面同样按实例管理员收口——它与 `skills` 不同，`skills` 的读面对所有已认证
 * 调用者开放（openapi 原文），所以那页用信息条而不是 403 卡片。这两档在
 * `SettingsPermissionGate` 里是两个 testid（`settings-no-atom-notice` / `settings-atom-denied`），
 * 混用会把「授权不足」说成「后端缺口」。</p>
 *
 * <p><b>不手搓组件</b>：表格/空态/骨架/确认弹窗/表单弹窗一律用 vendor（`Card`/`Empty`/
 * `Skeleton`/`AlertDialog`/`Dialog`/`Input`/`Select`/`Badge`/`Button`）。仓库**没有**
 * `components/ui/table`（vendor 未纳入 shadcn-vue 的 table），所以行结构用原生 `<table>` +
 * 产品 token 的字阶/描边 —— 这与既有 `RolesView`/`ConfigLocksView` 的写法一致；换成
 * 「引入新 vendor 目录」属于新增依赖面，本卡不做（理由见证据 §vendor 台账）。</p>
 *
 * <p><b>四态 + 出口</b>：加载（骨架）/ 错误（`SettingsErrorSurface` + 重试）/ 空（`Empty` +
 * 「创建第一份实例凭据」按钮）/ 无权限（403 卡片）。空态**必须**有出口，否则用户看到的是
 * 一句「还没有」而不知道该去哪。</p>
 */
const { t, locale } = useI18n();
const auth = useAuthStore();

/** 实例资源写面 = instance admin（CP 端点级判定；UI 只决定渲染哪一档）。 */
const canManage = computed(() => auth.isAdmin);

const credentials = ref<InstanceCredential[]>([]);
const loading = ref(false);
const loadCause = ref<unknown>(null);
const submitting = ref(false);
const actionError = ref<string | null>(null);

const createOpen = ref(false);
const formLabel = ref("");
const formKind = ref<"token" | "key_pair">("token");
const formTier = ref<"lease" | "reveal">("lease");
const formToken = ref("");
const formAccessKey = ref("");
const formSecretKey = ref("");

const deleteTarget = ref<InstanceCredential | null>(null);
/**
 * 确认删除时的**稳定对象**：reka 的 `AlertDialogAction` 点下即无条件关闭，先触发
 * `@update:open(false)`（把 `deleteTarget` 清空）再派发我们的 click ⇒ handler 里再读
 * `deleteTarget` 会读到 null。所以动作对象在「点垃圾桶」时就拍快照，确认时用快照。
 */
const deleteTargetId = ref<string | null>(null);

function requestDelete(credential: InstanceCredential): void {
    deleteTargetId.value = credential.id;
    deleteTarget.value = credential;
}

const revealTarget = ref<InstanceCredential | null>(null);
const revealPassword = ref("");
const revealBusy = ref(false);
const revealed = ref<{ token?: string; accessKey?: string; secretKey?: string } | null>(null);

const countLabel = computed(() =>
    t("settings.instanceResources.credentials.count", { count: credentials.value.length }),
);

function formatTime(iso: string | null): string {
    if (!iso) return "—";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat(locale.value, { dateStyle: "medium" }).format(date);
}

async function load(): Promise<void> {
    loading.value = true;
    loadCause.value = null;
    try {
        const payload = await listInstanceCredentials();
        credentials.value = payload.credentials;
    } catch (cause) {
        loadCause.value = cause;
        logger.warn("Failed to load instance credentials", cause);
    } finally {
        loading.value = false;
    }
}

/** 能力位是异步到的（`/auth/me`）：用 watch immediate，比 onMounted 更早一档也不重复取数。 */
watch(
    canManage,
    (allowed) => {
        if (allowed) void load();
    },
    { immediate: true },
);

function resetForm(): void {
    formLabel.value = "";
    formKind.value = "token";
    formTier.value = "lease";
    formToken.value = "";
    formAccessKey.value = "";
    formSecretKey.value = "";
    actionError.value = null;
}

function openCreate(): void {
    resetForm();
    createOpen.value = true;
}

const canSubmit = computed(() => {
    if (!formLabel.value.trim()) return false;
    if (formKind.value === "token") return Boolean(formToken.value.trim());
    return Boolean(formAccessKey.value.trim()) && Boolean(formSecretKey.value.trim());
});

async function submitCreate(): Promise<void> {
    if (!canSubmit.value || submitting.value) return;
    submitting.value = true;
    actionError.value = null;
    try {
        await createInstanceCredential({
            label: formLabel.value.trim(),
            kind: formKind.value,
            deliveryTier: formTier.value,
            ...(formKind.value === "token"
                ? { token: formToken.value.trim() }
                : { accessKey: formAccessKey.value.trim(), secretKey: formSecretKey.value.trim() }),
        });
        createOpen.value = false;
        toast.success(t("settings.instanceResources.credentials.created"));
        await load();
    } catch (cause) {
        actionError.value = t("settings.instanceResources.actionFailed");
        logger.warn("Failed to create instance credential", cause);
    } finally {
        submitting.value = false;
    }
}

async function confirmDelete(): Promise<void> {
    const id = deleteTargetId.value;
    if (!id) return;
    submitting.value = true;
    try {
        await deleteInstanceCredential(id);
        deleteTarget.value = null;
        deleteTargetId.value = null;
        toast.success(t("settings.instanceResources.credentials.deleted"));
        await load();
    } catch (cause) {
        actionError.value = t("settings.instanceResources.actionFailed");
        logger.warn("Failed to delete instance credential", cause);
    } finally {
        submitting.value = false;
    }
}

function openReveal(credential: InstanceCredential): void {
    revealTarget.value = credential;
    revealPassword.value = "";
    revealed.value = null;
    actionError.value = null;
}

async function submitReveal(): Promise<void> {
    const target = revealTarget.value;
    if (!target || revealBusy.value) return;
    revealBusy.value = true;
    actionError.value = null;
    try {
        const payload = await revealInstanceCredential(target.id, revealPassword.value);
        revealed.value = {
            token: payload.token,
            accessKey: payload.accessKey,
            secretKey: payload.secretKey,
        };
    } catch (cause) {
        actionError.value = t("settings.instanceResources.credentials.revealFailed");
        logger.warn("Failed to reveal instance credential", cause);
    } finally {
        revealBusy.value = false;
    }
}
</script>

<template>
    <section data-testid="instance-credentials-panel" class="space-y-4">
        <SettingsPermissionGate v-if="!canManage" variant="atom-denied" atom="credential_manage" />

        <template v-else>
            <header class="flex flex-wrap items-center justify-between gap-2">
                <div class="min-w-0">
                    <h3 class="text-base font-medium" data-testid="instance-credentials-heading">
                        {{ t("settings.instanceResources.credentials.title") }}
                    </h3>
                    <p class="mt-1 text-xs leading-5 text-muted-foreground">
                        {{ t("settings.instanceResources.credentials.subtitle") }}
                    </p>
                </div>
                <div class="flex items-center gap-2">
                    <span class="text-xs text-muted-foreground">{{ countLabel }}</span>
                    <Button data-testid="instance-credentials-create" @click="openCreate">
                        <Plus class="size-4" aria-hidden="true" />
                        {{ t("settings.instanceResources.credentials.createCta") }}
                    </Button>
                </div>
            </header>

            <SettingsErrorSurface :cause="loadCause" :retry="load" />
            <p
                v-if="actionError"
                data-testid="instance-credentials-action-error"
                class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
                {{ actionError }}
            </p>

            <div
                v-if="loading"
                data-testid="instance-credentials-loading"
                class="space-y-2"
                aria-busy="true"
            >
                <Skeleton v-for="row in 3" :key="row" class="h-11 w-full rounded-md" />
            </div>

            <Empty
                v-else-if="!credentials.length && !loadCause"
                data-testid="instance-credentials-empty"
            >
                <EmptyHeader>
                    <EmptyMedia variant="icon">
                        <KeyRound class="size-4" aria-hidden="true" />
                    </EmptyMedia>
                    <EmptyTitle>{{
                        t("settings.instanceResources.credentials.emptyTitle")
                    }}</EmptyTitle>
                    <EmptyDescription>
                        {{ t("settings.instanceResources.credentials.emptyBody") }}
                    </EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                    <Button data-testid="instance-credentials-empty-create" @click="openCreate">
                        <Plus class="size-4" aria-hidden="true" />
                        {{ t("settings.instanceResources.credentials.emptyCta") }}
                    </Button>
                </EmptyContent>
            </Empty>

            <Card v-else-if="credentials.length">
                <CardContent class="pt-4">
                    <div class="overflow-x-auto">
                        <table
                            class="w-full text-left text-sm"
                            data-testid="instance-credentials-table"
                        >
                            <thead class="text-xs text-muted-foreground">
                                <tr>
                                    <th class="py-1.5">
                                        {{ t("settings.instanceResources.columnName") }}
                                    </th>
                                    <th class="py-1.5">
                                        {{ t("settings.instanceResources.credentials.columnKind") }}
                                    </th>
                                    <th class="py-1.5">
                                        {{ t("settings.instanceResources.columnUpdated") }}
                                    </th>
                                    <th class="py-1.5 text-right">
                                        {{ t("settings.instanceResources.columnActions") }}
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr
                                    v-for="credential in credentials"
                                    :key="credential.id"
                                    :data-testid="`instance-credential-row-${credential.id}`"
                                    class="border-t border-border"
                                >
                                    <td class="py-2">
                                        <span class="font-medium">{{ credential.label }}</span>
                                        <span
                                            v-if="credential.referenceCount"
                                            class="ml-2 text-xs text-muted-foreground"
                                        >
                                            {{
                                                t(
                                                    "settings.instanceResources.credentials.references",
                                                    { count: credential.referenceCount },
                                                )
                                            }}
                                        </span>
                                    </td>
                                    <td class="py-2">
                                        <Badge variant="secondary" class="font-normal">
                                            {{
                                                credential.kind === "key_pair"
                                                    ? t(
                                                          "settings.instanceResources.credentials.kindKeyPair",
                                                      )
                                                    : t(
                                                          "settings.instanceResources.credentials.kindToken",
                                                      )
                                            }}
                                        </Badge>
                                    </td>
                                    <td class="py-2 text-xs text-muted-foreground">
                                        {{
                                            formatTime(
                                                credential.replacedAt ?? credential.createdAt,
                                            )
                                        }}
                                    </td>
                                    <td class="space-x-1 py-2 text-right">
                                        <Button
                                            variant="ghost"
                                            size="icon-sm"
                                            :data-testid="`instance-credential-reveal-${credential.id}`"
                                            :title="
                                                t('settings.instanceResources.credentials.reveal')
                                            "
                                            @click="openReveal(credential)"
                                        >
                                            <Eye class="size-3.5" aria-hidden="true" />
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="icon-sm"
                                            :data-testid="`instance-credential-delete-${credential.id}`"
                                            :title="t('settings.instanceResources.delete')"
                                            @click="requestDelete(credential)"
                                        >
                                            <Trash2 class="size-3.5" aria-hidden="true" />
                                        </Button>
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </CardContent>
            </Card>

            <Dialog :open="createOpen" @update:open="(open: boolean) => (createOpen = open)">
                <DialogContent data-testid="instance-credentials-create-dialog">
                    <DialogHeader>
                        <DialogTitle>
                            {{ t("settings.instanceResources.credentials.createTitle") }}
                        </DialogTitle>
                        <DialogDescription>
                            {{ t("settings.instanceResources.credentials.createBody") }}
                        </DialogDescription>
                    </DialogHeader>
                    <div class="space-y-3">
                        <div class="space-y-1">
                            <Label for="instance-credential-label">
                                {{ t("settings.instanceResources.credentials.fieldLabel") }}
                            </Label>
                            <Input
                                id="instance-credential-label"
                                v-model="formLabel"
                                data-testid="instance-credentials-form-label"
                                :placeholder="
                                    t(
                                        'settings.instanceResources.credentials.fieldLabelPlaceholder',
                                    )
                                "
                            />
                        </div>
                        <div class="space-y-1">
                            <Label>{{
                                t("settings.instanceResources.credentials.fieldKind")
                            }}</Label>
                            <Select v-model="formKind">
                                <SelectTrigger data-testid="instance-credentials-form-kind">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="token">{{
                                        t("settings.instanceResources.credentials.kindToken")
                                    }}</SelectItem>
                                    <SelectItem value="key_pair">{{
                                        t("settings.instanceResources.credentials.kindKeyPair")
                                    }}</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                        <div class="space-y-1">
                            <Label>{{
                                t("settings.instanceResources.credentials.fieldTier")
                            }}</Label>
                            <Select v-model="formTier">
                                <SelectTrigger data-testid="instance-credentials-form-tier">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="lease">{{
                                        t("settings.instanceResources.credentials.tierLease")
                                    }}</SelectItem>
                                    <SelectItem value="reveal">{{
                                        t("settings.instanceResources.credentials.tierReveal")
                                    }}</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                        <div v-if="formKind === 'token'" class="space-y-1">
                            <Label for="instance-credential-token">
                                {{ t("settings.instanceResources.credentials.fieldToken") }}
                            </Label>
                            <Input
                                id="instance-credential-token"
                                v-model="formToken"
                                type="password"
                                data-testid="instance-credentials-form-token"
                            />
                        </div>
                        <template v-else>
                            <div class="space-y-1">
                                <Label for="instance-credential-access-key">
                                    {{ t("settings.instanceResources.credentials.fieldAccessKey") }}
                                </Label>
                                <Input
                                    id="instance-credential-access-key"
                                    v-model="formAccessKey"
                                    data-testid="instance-credentials-form-access-key"
                                />
                            </div>
                            <div class="space-y-1">
                                <Label for="instance-credential-secret-key">
                                    {{ t("settings.instanceResources.credentials.fieldSecretKey") }}
                                </Label>
                                <Input
                                    id="instance-credential-secret-key"
                                    v-model="formSecretKey"
                                    type="password"
                                    data-testid="instance-credentials-form-secret-key"
                                />
                            </div>
                        </template>
                    </div>
                    <DialogFooter>
                        <Button
                            variant="outline"
                            data-testid="instance-credentials-create-cancel"
                            @click="createOpen = false"
                        >
                            {{ t("settings.instanceResources.cancel") }}
                        </Button>
                        <Button
                            :disabled="!canSubmit || submitting"
                            data-testid="instance-credentials-create-submit"
                            @click="submitCreate"
                        >
                            {{ t("settings.instanceResources.credentials.createSubmit") }}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog
                :open="revealTarget !== null"
                @update:open="(open: boolean) => !open && (revealTarget = null)"
            >
                <DialogContent data-testid="instance-credential-reveal-dialog">
                    <DialogHeader>
                        <DialogTitle>
                            {{ t("settings.instanceResources.credentials.revealTitle") }}
                        </DialogTitle>
                        <DialogDescription>
                            {{ t("settings.instanceResources.credentials.revealBody") }}
                        </DialogDescription>
                    </DialogHeader>
                    <div v-if="!revealed" class="space-y-1">
                        <Label for="instance-credential-reveal-password">
                            {{ t("settings.instanceResources.credentials.revealPassword") }}
                        </Label>
                        <Input
                            id="instance-credential-reveal-password"
                            v-model="revealPassword"
                            type="password"
                            data-testid="instance-credential-reveal-password"
                        />
                    </div>
                    <div v-else class="space-y-2" data-testid="instance-credential-revealed">
                        <div v-if="revealed.token" class="space-y-1">
                            <Label>
                                {{ t("settings.instanceResources.credentials.fieldToken") }}
                            </Label>
                            <Input :model-value="revealed.token" readonly />
                        </div>
                        <div v-if="revealed.accessKey" class="space-y-1">
                            <Label>
                                {{ t("settings.instanceResources.credentials.fieldAccessKey") }}
                            </Label>
                            <Input :model-value="revealed.accessKey" readonly />
                        </div>
                        <div v-if="revealed.secretKey" class="space-y-1">
                            <Label>
                                {{ t("settings.instanceResources.credentials.fieldSecretKey") }}
                            </Label>
                            <Input :model-value="revealed.secretKey" readonly />
                        </div>
                        <p class="text-xs text-muted-foreground">
                            {{ t("settings.instanceResources.credentials.revealOnceNote") }}
                        </p>
                    </div>
                    <DialogFooter>
                        <Button
                            variant="outline"
                            data-testid="instance-credential-reveal-close"
                            @click="revealTarget = null"
                        >
                            {{ t("settings.instanceResources.close") }}
                        </Button>
                        <Button
                            v-if="!revealed"
                            :disabled="!revealPassword || revealBusy"
                            data-testid="instance-credential-reveal-submit"
                            @click="submitReveal"
                        >
                            {{ t("settings.instanceResources.credentials.revealSubmit") }}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <AlertDialog
                :open="deleteTarget !== null"
                @update:open="
                    (open: boolean) => !open && ((deleteTarget = null), (deleteTargetId = null))
                "
            >
                <AlertDialogContent data-testid="instance-credential-delete-dialog">
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            {{ t("settings.instanceResources.credentials.deleteTitle") }}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            {{
                                t("settings.instanceResources.credentials.deleteBody", {
                                    label: deleteTarget?.label ?? "",
                                })
                            }}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel data-testid="instance-credential-delete-cancel">
                            {{ t("settings.instanceResources.cancel") }}
                        </AlertDialogCancel>
                        <!--
                            用普通 destructive `Button` 而不是 `AlertDialogAction`：後者**点下即无条件关闭**
                            （先关弹窗再派发我们的事件，动作对象已被清空）—— 这是本仓已记的 reka 陷阱
                            （`packages/ui/AGENTS.md` §Reka UI 交互陷阱）。删除是异步动作，弹窗必须留到
                            本次请求返回，否则用户看到「点了就没了，也不知道删没删」。
                        -->
                        <Button
                            variant="destructive"
                            data-testid="instance-credential-delete-confirm"
                            :disabled="submitting"
                            @click="confirmDelete"
                        >
                            {{ t("settings.instanceResources.delete") }}
                        </Button>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </template>
    </section>
</template>
