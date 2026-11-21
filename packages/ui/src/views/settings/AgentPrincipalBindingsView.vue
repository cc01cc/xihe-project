<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import AgentDelegatedSessionsTable from "../../components/settings/AgentDelegatedSessionsTable.vue";
import AgentWorkspaceBindingsPanel from "../../components/settings/AgentWorkspaceBindingsPanel.vue";
import { useSettingsTrail } from "../../components/settings/settingsTrail";
import { api } from "../../composables/api";
// task-92（缺口二）：绑定面板的勾选草稿是整页草稿，离开本页要确认；复用域页/组页/角色页同一套 composable。
import { useDraftLeaveGuard } from "../../composables/useDraftLeaveGuard";
import {
    AlertDialog,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "../../components/ui/alert-dialog";
import { Button } from "../../components/ui/button";

/**
 * task-153 S1：一个 agent 主体的**工作区绑定**整页（Lead C1=B）。
 *
 * <p>为什么是整页（不塞抽屉第 7 组）：`check-form-contract.mjs` 的 F4 判据
 * （DEV-011 §17.8）是抽屉顶级 section ≤6，而详情抽屉正好 6 组；绑定面本身是
 * 「工作区多选 × 每项 cap/角色」+ 委派会话表两处数据密集面。</p>
 *
 * <p>**主体名缺口（§H8 / 卡面 H11，Lead 04:08 裁定）**：`api.ts` 没有
 * `GET /api/v1/agent-principals/{id}` 单条读面（CP 侧在 task-195 落地）。这里先拿
 * `listAgentPrincipals()` 做**精确 id 匹配**取真名；取不到就显示 principalId +
 * 标注「名称读面未提供」——**不写**「不存在 / 加载失败 / 无权限」（三者在无读面下都
 * 证明不了），**不做**前缀模糊匹配，也**不从路由 query 传名**（深链与刷新都要成立）。</p>
 */
const props = defineProps<{ id: string }>();

const route = useRoute();
const { t } = useI18n();

/** 路由参数优先；`props.id` 由路由 `props: true` 传入（两条都成立，防将来改壳漏接）。 */
const principalId = computed(() => props.id || String(route.params.id ?? ""));

/** 已绑工作区（绑定面板上报）——委派子会话表只查这些工作区。 */
const boundWorkspaces = ref<Array<{ workspaceId: string; workspaceName: string }>>([]);

function onBoundWorkspaces(rows: Array<{ workspaceId: string; workspaceName: string }>): void {
    boundWorkspaces.value = rows;
}

/**
 * task-92（缺口二）：页面层只做「脏没脏 → 点名」的翻译，不自己推断草稿（与 `SettingsDomainView`、
 * `RolesView` 同一分工）。点名用主体名 —— 用户在这一页看的标题就是它。
 */
const {
    draftLabels,
    promptOpen: leavePromptOpen,
    setDrafts,
    keepEditing,
    discardDrafts,
} = useDraftLeaveGuard();

function onBindingsDirty(dirty: boolean): void {
    setDrafts(dirty ? [displayName.value] : []);
}

const resolvedName = ref<string | null>(null);
const nameUnavailable = computed(() => resolvedName.value === null);

const displayName = computed(() => resolvedName.value ?? principalId.value);

/**
 * 面包屑四段（卡面 H7 ③）：设置 / 智能体主体（→ 实例级列表页） / {主体名} / 绑定。
 *
 * <p>第二段的链接是**同层向上**的 `/settings/instance/agent-principals`，不跨到
 * `/members`（那是工作区成员面，不是设置层页面）。</p>
 */
useSettingsTrail(() => [
    { label: t("agentBindings.crumbSubjects"), to: "/settings/instance/agent-principals" },
    { label: displayName.value },
    { label: t("agentBindings.crumbBindings") },
]);

onMounted(async () => {
    try {
        const principals = await api.listAgentPrincipals();
        const match = principals.find((item) => item.principalId === principalId.value);
        resolvedName.value = match?.name?.trim() ? match.name.trim() : null;
    } catch {
        // 读面失败 = 名字仍然拿不到；按卡面 H11 的默认回落（principalId），不额外解释成因。
        resolvedName.value = null;
    }
});
</script>

<template>
    <section class="min-h-full" data-testid="settings-agent-principal-bindings">
        <header class="border-b">
            <div class="mx-auto w-full max-w-6xl px-6 pt-4 pb-3">
                <div class="flex flex-wrap items-center gap-2">
                    <h2
                        data-testid="agent-bindings-subject-name"
                        class="text-xl leading-tight font-semibold tracking-tight break-all"
                    >
                        {{ displayName }}
                    </h2>
                    <span
                        v-if="nameUnavailable"
                        class="rounded border px-1.5 py-0.5 text-xs text-muted-foreground"
                        data-testid="agent-bindings-name-unavailable"
                        >{{ t("agentBindings.nameUnavailable") }}</span
                    >
                </div>
                <p class="mt-1 text-xs text-muted-foreground break-all">
                    {{ t("agentBindings.subjectIdLabel") }}
                    <code class="select-all font-mono text-[11px]">{{ principalId }}</code>
                </p>
            </div>
        </header>

        <div class="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-4">
            <AgentWorkspaceBindingsPanel
                :principal-id="principalId"
                @bound-workspaces="onBoundWorkspaces"
                @dirty="onBindingsDirty"
            />
            <!-- S3-a：委派子会话读面（spawn-sessions count 为准；数据源只认这个端点）。 -->
            <AgentDelegatedSessionsTable
                :principal-id="principalId"
                :workspaces="boundWorkspaces"
            />
        </div>

        <!-- task-92：整页勾选草稿的离开确认（与域页/组页/角色页同 testid 同一动作）。 -->
        <AlertDialog
            :open="leavePromptOpen"
            @update:open="(value: boolean) => !value && keepEditing()"
        >
            <AlertDialogContent data-testid="settings-leave-confirm">
                <AlertDialogHeader>
                    <AlertDialogTitle>{{ t("settings.ia.leaveDraftTitle") }}</AlertDialogTitle>
                    <AlertDialogDescription>
                        {{
                            t("settings.ia.leaveDraftDesc", {
                                domains: draftLabels.join(" / "),
                            })
                        }}
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel data-testid="settings-leave-keep" @click="keepEditing">
                        {{ t("settings.ia.leaveDraftKeep") }}
                    </AlertDialogCancel>
                    <Button
                        type="button"
                        variant="destructive"
                        data-testid="settings-leave-discard"
                        @click="discardDrafts"
                    >
                        {{ t("settings.ia.leaveDraftDiscard") }}
                    </Button>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    </section>
</template>
