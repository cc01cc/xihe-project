<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { Bot, Plus, Trash2 } from "@lucide/vue";

import { useAuthStore } from "../../stores/auth";
import { logger } from "../../lib/logger";
import {
    createInstanceAgent,
    deleteInstanceAgent,
    listInstanceAgents,
    type InstanceAgent,
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
import { Textarea } from "../ui/textarea";
import SettingsErrorSurface from "./SettingsErrorSurface.vue";
import SettingsPermissionGate from "./SettingsPermissionGate.vue";

/**
 * task-165 · 实例层「平台智能体」面板（`/settings/instance/agents`）。
 *
 * <p><b>语义（D-1006 B4）</b>：平台智能体默认全局可见、**无需逐工作区绑定**、仅 instance admin
 * 可建；不做 fork、不收录 `workspace_agents`。所以这里**不提供**「绑定到工作区」动作——
 * 那是工作区自有智能体的事，放这里会造出第二套归属。</p>
 *
 * <p><b>与用户层 `agent-principals` 的区别</b>：那一页是「我的主体身份」（`created_by=self`），
 * 这一页是**全平台可用**的平台智能体。两页文案不得都叫「智能体」而不加限定词——左栏 id 仍是
 * `agents`，但显示名带「平台」前缀（见 `settingsIa.instanceResourceGroup` 注释）。</p>
 */
const { t, locale } = useI18n();
const auth = useAuthStore();

const canManage = computed(() => auth.isAdmin);

const agents = ref<InstanceAgent[]>([]);
const loading = ref(false);
const loadCause = ref<unknown>(null);
const submitting = ref(false);
const actionError = ref<string | null>(null);

const createOpen = ref(false);
const formName = ref("");
const formDescription = ref("");
const deleteTarget = ref<InstanceAgent | null>(null);

const countLabel = computed(() =>
    t("settings.instanceResources.agents.count", { count: agents.value.length }),
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
        const payload = await listInstanceAgents();
        agents.value = payload.agents;
    } catch (cause) {
        loadCause.value = cause;
        logger.warn("Failed to load instance agents", cause);
    } finally {
        loading.value = false;
    }
}

watch(
    canManage,
    (allowed) => {
        if (allowed) void load();
    },
    { immediate: true },
);

function openCreate(): void {
    formName.value = "";
    formDescription.value = "";
    actionError.value = null;
    createOpen.value = true;
}

const canSubmit = computed(() => Boolean(formName.value.trim()));

async function submitCreate(): Promise<void> {
    if (!canSubmit.value || submitting.value) return;
    submitting.value = true;
    actionError.value = null;
    try {
        await createInstanceAgent({
            name: formName.value.trim(),
            ...(formDescription.value.trim() ? { description: formDescription.value.trim() } : {}),
        });
        createOpen.value = false;
        toast.success(t("settings.instanceResources.agents.created"));
        await load();
    } catch (cause) {
        actionError.value = t("settings.instanceResources.actionFailed");
        logger.warn("Failed to create instance agent", cause);
    } finally {
        submitting.value = false;
    }
}

async function confirmDelete(): Promise<void> {
    const target = deleteTarget.value;
    if (!target) return;
    submitting.value = true;
    try {
        await deleteInstanceAgent(target.id);
        deleteTarget.value = null;
        toast.success(t("settings.instanceResources.agents.deleted"));
        await load();
    } catch (cause) {
        actionError.value = t("settings.instanceResources.actionFailed");
        logger.warn("Failed to delete instance agent", cause);
    } finally {
        submitting.value = false;
    }
}
</script>

<template>
    <section data-testid="instance-agents-panel" class="space-y-4">
        <SettingsPermissionGate v-if="!canManage" variant="atom-denied" atom="MANAGE_AGENTS" />

        <template v-else>
            <header class="flex flex-wrap items-center justify-between gap-2">
                <div class="min-w-0">
                    <h2 class="text-base font-medium" data-testid="instance-agents-heading">
                        {{ t("settings.instanceResources.agents.title") }}
                    </h2>
                    <p class="mt-1 text-xs leading-5 text-muted-foreground">
                        {{ t("settings.instanceResources.agents.subtitle") }}
                    </p>
                </div>
                <div class="flex items-center gap-2">
                    <span class="text-xs text-muted-foreground">{{ countLabel }}</span>
                    <Button data-testid="instance-agents-create" @click="openCreate">
                        <Plus class="size-4" aria-hidden="true" />
                        {{ t("settings.instanceResources.agents.createCta") }}
                    </Button>
                </div>
            </header>

            <SettingsErrorSurface :cause="loadCause" :retry="load" />
            <p
                v-if="actionError"
                data-testid="instance-agents-action-error"
                class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
                {{ actionError }}
            </p>

            <div
                v-if="loading"
                data-testid="instance-agents-loading"
                class="space-y-2"
                aria-busy="true"
            >
                <Skeleton v-for="row in 3" :key="row" class="h-11 w-full rounded-md" />
            </div>

            <Empty v-else-if="!agents.length && !loadCause" data-testid="instance-agents-empty">
                <EmptyHeader>
                    <EmptyMedia variant="icon">
                        <Bot class="size-4" aria-hidden="true" />
                    </EmptyMedia>
                    <EmptyTitle>{{ t("settings.instanceResources.agents.emptyTitle") }}</EmptyTitle>
                    <EmptyDescription>
                        {{ t("settings.instanceResources.agents.emptyBody") }}
                    </EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                    <Button data-testid="instance-agents-empty-create" @click="openCreate">
                        <Plus class="size-4" aria-hidden="true" />
                        {{ t("settings.instanceResources.agents.emptyCta") }}
                    </Button>
                </EmptyContent>
            </Empty>

            <Card v-else-if="agents.length">
                <CardContent class="pt-4">
                    <div class="overflow-x-auto">
                        <table class="w-full text-left text-sm" data-testid="instance-agents-table">
                            <thead class="text-xs text-muted-foreground">
                                <tr>
                                    <th class="py-1.5">
                                        {{ t("settings.instanceResources.columnName") }}
                                    </th>
                                    <th class="py-1.5">
                                        {{ t("settings.instanceResources.agents.columnModel") }}
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
                                    v-for="agent in agents"
                                    :key="agent.id"
                                    :data-testid="`instance-agent-row-${agent.id}`"
                                    class="border-t border-border"
                                >
                                    <td class="py-2">
                                        <span class="font-medium">{{ agent.name }}</span>
                                        <Badge
                                            v-if="agent.disabled"
                                            variant="outline"
                                            class="ml-2 font-normal"
                                        >
                                            {{ t("settings.instanceResources.agents.disabled") }}
                                        </Badge>
                                        <p
                                            v-if="agent.description"
                                            class="mt-0.5 max-w-md truncate text-xs text-muted-foreground"
                                        >
                                            {{ agent.description }}
                                        </p>
                                    </td>
                                    <td class="py-2 text-xs text-muted-foreground">
                                        <template v-if="agent.modelName">
                                            {{ agent.modelProvider }} / {{ agent.modelName }}
                                        </template>
                                        <template v-else>—</template>
                                    </td>
                                    <td class="py-2 text-xs text-muted-foreground">
                                        {{ formatTime(agent.createdAt) }}
                                    </td>
                                    <td class="space-x-1 py-2 text-right">
                                        <Button
                                            variant="ghost"
                                            size="icon-sm"
                                            :data-testid="`instance-agent-delete-${agent.id}`"
                                            :title="t('settings.instanceResources.delete')"
                                            @click="deleteTarget = agent"
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
                <DialogContent data-testid="instance-agents-create-dialog">
                    <DialogHeader>
                        <DialogTitle>{{
                            t("settings.instanceResources.agents.createTitle")
                        }}</DialogTitle>
                        <DialogDescription>
                            {{ t("settings.instanceResources.agents.createBody") }}
                        </DialogDescription>
                    </DialogHeader>
                    <div class="space-y-3">
                        <div class="space-y-1">
                            <Label for="instance-agent-name">
                                {{ t("settings.instanceResources.agents.fieldName") }}
                            </Label>
                            <Input
                                id="instance-agent-name"
                                v-model="formName"
                                data-testid="instance-agents-form-name"
                                :placeholder="
                                    t('settings.instanceResources.agents.fieldNamePlaceholder')
                                "
                            />
                        </div>
                        <div class="space-y-1">
                            <Label for="instance-agent-description">
                                {{ t("settings.instanceResources.agents.fieldDescription") }}
                            </Label>
                            <Textarea
                                id="instance-agent-description"
                                v-model="formDescription"
                                data-testid="instance-agents-form-description"
                            />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button
                            variant="outline"
                            data-testid="instance-agents-create-cancel"
                            @click="createOpen = false"
                        >
                            {{ t("settings.instanceResources.cancel") }}
                        </Button>
                        <Button
                            :disabled="!canSubmit || submitting"
                            data-testid="instance-agents-create-submit"
                            @click="submitCreate"
                        >
                            {{ t("settings.instanceResources.agents.createSubmit") }}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <AlertDialog
                :open="deleteTarget !== null"
                @update:open="(open: boolean) => !open && (deleteTarget = null)"
            >
                <AlertDialogContent data-testid="instance-agent-delete-dialog">
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            {{ t("settings.instanceResources.agents.deleteTitle") }}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            {{
                                t("settings.instanceResources.agents.deleteBody", {
                                    name: deleteTarget?.name ?? "",
                                })
                            }}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel data-testid="instance-agent-delete-cancel">
                            {{ t("settings.instanceResources.cancel") }}
                        </AlertDialogCancel>
                        <!--
                            用普通 destructive `Button`，不用 `AlertDialogAction`：后者点下即无条件关闭
                            （动作对象先被清空，异步删除还没发出去），见 `packages/ui/AGENTS.md` §Reka UI 交互陷阱。
                        -->
                        <Button
                            variant="destructive"
                            data-testid="instance-agent-delete-confirm"
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
