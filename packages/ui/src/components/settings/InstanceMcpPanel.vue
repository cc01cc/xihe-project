<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { Info, Plug, Plus, Trash2 } from "@lucide/vue";

import { useAuthStore } from "../../stores/auth";
import { logger } from "../../lib/logger";
import {
    createInstanceMcpServer,
    deleteInstanceMcpServer,
    listInstanceCredentials,
    listInstanceMcpServers,
    type InstanceCredential,
    type InstanceMcpServer,
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
import { Alert, AlertDescription } from "../ui/alert";

/**
 * task-165 · 实例层「MCP 注册表」面板（`/settings/instance/mcp`）。
 *
 * <p><b>语义（D-1006 B5 / D-1007）</b>：实例注册表 + 与工作区级「继承 + 工作区可覆盖同名」；
 * 唯一标识用 `name`（同 url 可换协议/auth，换掉不该算同一 server）；**只可引用实例凭据**——
 * 所以凭据下拉只列 `instance/credentials` 的结果，不提供「填一个 id」的自由输入（那会绕过
 * 归属约束，把个人凭据塞进实例 server）。</p>
 *
 * <p><b>为什么没有 oauth/session 动作</b>：D-1008 的 M1 最小端点集只铺集合 GET/POST +
 * `{id}` PATCH/DELETE；子动作（oauth/session/bindings）**按需二期**，本页不预埋假按钮。</p>
 */
const { t, locale } = useI18n();
const auth = useAuthStore();

/**
 * task-447（D-1286）：写面判据 = **能力位** `instance:admin`（契约 `openapi.yaml:5102`：
 * 「Gate: cap:instance:admin (CAP_INSTANCE_ADMIN) evaluated at the capability-atom layer」）。
 * 用 store 提供的访问器而不是 `auth.isAdmin` —— 两者同源（`stores/auth.ts:71` 与 `:150` 都是
 * `capabilities.value.isInstanceAdmin`），但 `:148-149` 明确要求调用点用访问器，避免写出
 * 「看起来像角色判断」的字面量。**不是**角色特判，也**不是**动作原子（本面 CP 没有动作原子门）。
 */
const canManage = computed(() => auth.hasInstanceAdminCapability);

const servers = ref<InstanceMcpServer[]>([]);
const credentialOptions = ref<InstanceCredential[]>([]);
const loading = ref(false);
const loadCause = ref<unknown>(null);
const submitting = ref(false);
const actionError = ref<string | null>(null);

const createOpen = ref(false);
const formName = ref("");
const formTransport = ref("http");
const formUrl = ref("");
/** 「不引用凭据」的哨兵值：reka 的 SelectItem 不接受空串（空串=清空选中），所以用一个显式值。 */
const NO_CREDENTIAL = "__none__";
const formCredentialId = ref(NO_CREDENTIAL);
const deleteTarget = ref<InstanceMcpServer | null>(null);

const countLabel = computed(() =>
    t("settings.instanceResources.mcp.count", { count: servers.value.length }),
);

/** 传输方式按语义显示（HTTP/SSE/stdio），不把 wire 小写字面量直接端给用户。 */
function transportLabel(transport: string): string {
    if (transport === "sse") return t("settings.instanceResources.mcp.transportSse");
    if (transport === "stdio") return t("settings.instanceResources.mcp.transportStdio");
    return t("settings.instanceResources.mcp.transportHttp");
}

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
        const payload = await listInstanceMcpServers();
        servers.value = payload.servers;
    } catch (cause) {
        loadCause.value = cause;
        logger.warn("Failed to load instance MCP servers", cause);
    } finally {
        loading.value = false;
    }
}

/** 凭据下拉是**非阻断**的：取不到就只剩「不引用凭据」，不让它把整页拖进错误态。 */
async function loadCredentialOptions(): Promise<void> {
    try {
        const payload = await listInstanceCredentials();
        credentialOptions.value = payload.credentials;
    } catch (cause) {
        credentialOptions.value = [];
        logger.warn("Failed to load instance credentials for the MCP form", cause);
    }
}

/**
 * task-447（D-1286）/ Lead 裁定⑵：**读面对任何已认证调用者开放**（`openapi.yaml:5079` 原文
 * 「Read face is open to every authenticated caller」）⇒ 取数不再等能力位。与同门
 * `InstanceAgentsPanel:279-293` 同形（那里 watch 的也是 `auth.isAuthenticated`）。
 * 此前 `watch(canManage)` 让非管理员**根本不取数**，比契约读面窄。
 */
watch(
    () => auth.isAuthenticated,
    (authenticated) => {
        if (!authenticated) return;
        void load();
    },
    { immediate: true },
);

/**
 * 凭据候选只服务**新建表单**（写面）⇒ 只在有能力位时取：非管理员取它只会拿到 403
 * （`InstanceCredentialController` 全部能力位守卫），是无谓请求。能力位后到也能补取。
 */
watch(
    canManage,
    (allowed) => {
        if (allowed && auth.isAuthenticated) void loadCredentialOptions();
    },
    { immediate: true },
);

function openCreate(): void {
    formName.value = "";
    formTransport.value = "http";
    formUrl.value = "";
    formCredentialId.value = NO_CREDENTIAL;
    actionError.value = null;
    createOpen.value = true;
}

const canSubmit = computed(() => Boolean(formName.value.trim()));

async function submitCreate(): Promise<void> {
    if (!canSubmit.value || submitting.value) return;
    submitting.value = true;
    actionError.value = null;
    try {
        await createInstanceMcpServer({
            name: formName.value.trim(),
            transport: formTransport.value,
            ...(formUrl.value.trim() ? { url: formUrl.value.trim() } : {}),
            ...(formCredentialId.value && formCredentialId.value !== NO_CREDENTIAL
                ? { credentialId: formCredentialId.value }
                : {}),
        });
        createOpen.value = false;
        toast.success(t("settings.instanceResources.mcp.created"));
        await load();
    } catch (cause) {
        actionError.value = t("settings.instanceResources.actionFailed");
        logger.warn("Failed to create instance MCP server", cause);
    } finally {
        submitting.value = false;
    }
}

async function confirmDelete(): Promise<void> {
    const target = deleteTarget.value;
    if (!target) return;
    submitting.value = true;
    try {
        await deleteInstanceMcpServer(target.id);
        deleteTarget.value = null;
        toast.success(t("settings.instanceResources.mcp.deleted"));
        await load();
    } catch (cause) {
        actionError.value = t("settings.instanceResources.actionFailed");
        logger.warn("Failed to delete instance MCP server", cause);
    } finally {
        submitting.value = false;
    }
}
</script>

<template>
    <section data-testid="instance-mcp-panel" class="space-y-4">
        <!--
            PLAN-0772 M2 / Lead 裁定三（保留）：原先点名的原子在 CP 目录里不存在（幻影原子），
            写面按 openapi 原文是 instance-admin only，所以只点名能力位 `instance:admin`，
            不点名任何不存在的动作原子。

            task-447（D-1286）/ Lead 裁定⑵⑶：主体不再按能力位阻断 —— 读面对任何已认证调用者开放
            （`openapi.yaml:5079`），非管理员看**只读**列表。原先的 `atom-denied` 403 卡片有两处假陈述：
            ① 把能力位当动作原子点名；② 卡片正文声称「不是后端缺口」，而本面恰是 CP 未实现的
            PLANNED_API（`RouteContractParityTest:216-217`，PLAN-0771 M3）⇒ **是**后端缺口。
            缺口改由下面的 `SettingsErrorSurface` 照实显示（404 就是 404），写面门槛用非阻断提示点名。
        -->
        <template v-if="auth.isAuthenticated">
            <header class="flex flex-wrap items-center justify-between gap-2">
                <div class="min-w-0">
                    <h2 class="text-base font-medium" data-testid="instance-mcp-heading">
                        {{ t("settings.instanceResources.mcp.title") }}
                    </h2>
                    <p class="mt-1 text-xs leading-5 text-muted-foreground">
                        {{ t("settings.instanceResources.mcp.subtitle") }}
                    </p>
                </div>
                <div class="flex items-center gap-2">
                    <span class="text-xs text-muted-foreground">{{ countLabel }}</span>
                    <Button v-if="canManage" data-testid="instance-mcp-create" @click="openCreate">
                        <Plus class="size-4" aria-hidden="true" />
                        {{ t("settings.instanceResources.mcp.createCta") }}
                    </Button>
                </div>
            </header>

            <Alert
                v-if="!canManage"
                data-testid="instance-mcp-write-capability-notice"
                role="status"
                class="rounded-md border-border bg-muted/40 px-3 py-2 text-xs leading-5 text-muted-foreground"
            >
                <Info class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <AlertDescription class="text-pretty text-xs leading-5 text-muted-foreground">
                    {{ t("settings.instanceResources.mcp.writeRequiresCapability") }}
                </AlertDescription>
            </Alert>

            <SettingsErrorSurface :cause="loadCause" :retry="load" />
            <p
                v-if="actionError"
                data-testid="instance-mcp-action-error"
                class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
                {{ actionError }}
            </p>

            <div
                v-if="loading"
                data-testid="instance-mcp-loading"
                class="space-y-2"
                aria-busy="true"
            >
                <Skeleton v-for="row in 3" :key="row" class="h-11 w-full rounded-md" />
            </div>

            <Empty v-else-if="!servers.length && !loadCause" data-testid="instance-mcp-empty">
                <EmptyHeader>
                    <EmptyMedia variant="icon">
                        <Plug class="size-4" aria-hidden="true" />
                    </EmptyMedia>
                    <EmptyTitle>{{ t("settings.instanceResources.mcp.emptyTitle") }}</EmptyTitle>
                    <EmptyDescription>
                        {{ t("settings.instanceResources.mcp.emptyBody") }}
                    </EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                    <Button
                        v-if="canManage"
                        data-testid="instance-mcp-empty-create"
                        @click="openCreate"
                    >
                        <Plus class="size-4" aria-hidden="true" />
                        {{ t("settings.instanceResources.mcp.emptyCta") }}
                    </Button>
                </EmptyContent>
            </Empty>

            <Card v-else-if="servers.length">
                <CardContent class="pt-4">
                    <div class="overflow-x-auto">
                        <table class="w-full text-left text-sm" data-testid="instance-mcp-table">
                            <thead class="text-xs text-muted-foreground">
                                <tr>
                                    <th class="py-1.5">
                                        {{ t("settings.instanceResources.columnName") }}
                                    </th>
                                    <th class="py-1.5">
                                        {{ t("settings.instanceResources.mcp.columnTransport") }}
                                    </th>
                                    <th class="py-1.5">
                                        {{ t("settings.instanceResources.mcp.columnUrl") }}
                                    </th>
                                    <th class="py-1.5">
                                        {{ t("settings.instanceResources.columnCreated") }}
                                    </th>
                                    <th class="py-1.5 text-right">
                                        {{ t("settings.instanceResources.columnActions") }}
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr
                                    v-for="server in servers"
                                    :key="server.id"
                                    :data-testid="`instance-mcp-row-${server.id}`"
                                    class="border-t border-border"
                                >
                                    <td class="py-2">
                                        <span class="font-medium">{{ server.name }}</span>
                                        <Badge
                                            v-if="!server.enabled"
                                            variant="outline"
                                            class="ml-2 font-normal"
                                        >
                                            {{ t("settings.instanceResources.mcp.disabled") }}
                                        </Badge>
                                    </td>
                                    <td class="py-2 text-xs text-muted-foreground">
                                        {{ transportLabel(server.transport) }}
                                    </td>
                                    <td
                                        class="max-w-xs truncate py-2 font-mono text-xs text-muted-foreground"
                                        :title="server.url ?? ''"
                                    >
                                        {{ server.url ?? "—" }}
                                    </td>
                                    <td class="py-2 text-xs text-muted-foreground">
                                        {{ formatTime(server.createdAt) }}
                                    </td>
                                    <td class="space-x-1 py-2 text-right">
                                        <Button
                                            v-if="canManage"
                                            variant="ghost"
                                            size="icon-sm"
                                            :data-testid="`instance-mcp-delete-${server.id}`"
                                            :title="t('settings.instanceResources.delete')"
                                            @click="deleteTarget = server"
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
                <DialogContent data-testid="instance-mcp-create-dialog">
                    <DialogHeader>
                        <DialogTitle>{{
                            t("settings.instanceResources.mcp.createTitle")
                        }}</DialogTitle>
                        <DialogDescription>
                            {{ t("settings.instanceResources.mcp.createBody") }}
                        </DialogDescription>
                    </DialogHeader>
                    <div class="space-y-3">
                        <div class="space-y-1">
                            <Label for="instance-mcp-name">
                                {{ t("settings.instanceResources.mcp.fieldName") }}
                            </Label>
                            <Input
                                id="instance-mcp-name"
                                v-model="formName"
                                data-testid="instance-mcp-form-name"
                                :placeholder="
                                    t('settings.instanceResources.mcp.fieldNamePlaceholder')
                                "
                            />
                        </div>
                        <div class="space-y-1">
                            <Label>{{ t("settings.instanceResources.mcp.fieldTransport") }}</Label>
                            <Select v-model="formTransport">
                                <SelectTrigger data-testid="instance-mcp-form-transport">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="http">http</SelectItem>
                                    <SelectItem value="sse">sse</SelectItem>
                                    <SelectItem value="stdio">stdio</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                        <div class="space-y-1">
                            <Label for="instance-mcp-url">
                                {{ t("settings.instanceResources.mcp.fieldUrl") }}
                            </Label>
                            <Input
                                id="instance-mcp-url"
                                v-model="formUrl"
                                data-testid="instance-mcp-form-url"
                                :placeholder="
                                    t('settings.instanceResources.mcp.fieldUrlPlaceholder')
                                "
                            />
                        </div>
                        <div class="space-y-1">
                            <Label>{{ t("settings.instanceResources.mcp.fieldCredential") }}</Label>
                            <Select v-model="formCredentialId">
                                <SelectTrigger data-testid="instance-mcp-form-credential">
                                    <SelectValue
                                        :placeholder="
                                            t('settings.instanceResources.mcp.credentialNone')
                                        "
                                    />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem :value="NO_CREDENTIAL">
                                        {{ t("settings.instanceResources.mcp.credentialNone") }}
                                    </SelectItem>
                                    <SelectItem
                                        v-for="credential in credentialOptions"
                                        :key="credential.id"
                                        :value="credential.id"
                                    >
                                        {{ credential.label }}
                                    </SelectItem>
                                </SelectContent>
                            </Select>
                            <p class="text-xs text-muted-foreground">
                                {{ t("settings.instanceResources.mcp.credentialHint") }}
                            </p>
                        </div>
                    </div>
                    <DialogFooter>
                        <Button
                            variant="outline"
                            data-testid="instance-mcp-create-cancel"
                            @click="createOpen = false"
                        >
                            {{ t("settings.instanceResources.cancel") }}
                        </Button>
                        <Button
                            :disabled="!canSubmit || submitting"
                            data-testid="instance-mcp-create-submit"
                            @click="submitCreate"
                        >
                            {{ t("settings.instanceResources.mcp.createSubmit") }}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <AlertDialog
                :open="deleteTarget !== null"
                @update:open="(open: boolean) => !open && (deleteTarget = null)"
            >
                <AlertDialogContent data-testid="instance-mcp-delete-dialog">
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            {{ t("settings.instanceResources.mcp.deleteTitle") }}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            {{
                                t("settings.instanceResources.mcp.deleteBody", {
                                    name: deleteTarget?.name ?? "",
                                })
                            }}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel data-testid="instance-mcp-delete-cancel">
                            {{ t("settings.instanceResources.cancel") }}
                        </AlertDialogCancel>
                        <!--
                            用普通 destructive `Button`，不用 `AlertDialogAction`：后者点下即无条件关闭
                            （动作对象先被清空，异步删除还没发出去），见 `packages/ui/AGENTS.md` §Reka UI 交互陷阱。
                        -->
                        <Button
                            variant="destructive"
                            data-testid="instance-mcp-delete-confirm"
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
