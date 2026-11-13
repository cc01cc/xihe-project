<script setup lang="ts">
/**
 * task-402 / `D-1243 G2`：**实例档**智能体的技能绑定面（列 / 绑 / 解绑）。
 *
 * <p>为什么是新组件而不是往面板里堆：工作区层已有一整套（`WorkspaceAgentsPanel:2165-2300`），
 * 但它的 api 调用强制拼 workspaceId；实例档是**另一个 scope**，混在一个两千行面板里会让
 * 「这次绑定到底落在哪一层」变得不可读。这里自足：自己取数、自己绑解、自己管加载/失败/空三态。</p>
 *
 * <p>**scope 由服务端派生，客户端不选**（CP `AgentPrincipalSkillBindingService#deriveScope:196`）：
 * 调用省掉 `workspaceId` ⇒ 实例档行，要 `MANAGE_AGENT_PRINCIPALS`
 * （`AgentPrincipalBindingAuthority:60`）。所以这里没有任何「层」开关 —— 给了就是假选择。</p>
 *
 * <p>权限不在本组件里再判一遍：入口按钮由挂载方的写门（`useInstanceWriteGate`）管，
 * 本组件只做「打得开就能用」。第二份权限判断会与写门漂移。</p>
 *
 * <p>候选只给**实例库**定义：工作区私有定义在实例档绑定会被 CP 回 404 `SKILL_NOT_FOUND`
 * （`AgentPrincipalSkillBindingService:122-126` 固定顺序可见性），个人层两轴都不可绑（I-6）。
 * 已绑的不再列出。列表则**照实显示两种 scope**：同一个 principal 可能有工作区档行，
 * 实例档可删任意 scope 行（`mayDeleteAtRowScope:180`），藏起来反而让人以为没绑。</p>
 */
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import type { AcceptableValue } from "reka-ui";

import {
    api,
    ApiError,
    type AgentSkillBinding,
    type AgentSkillSummary,
} from "../../composables/api";
import { logger } from "../../lib/logger";
// 资格判定复用工作区层已有的纯函数（PLAN-0680 B-1：实例档只收实例库定义，未知 scope 丢弃，
// 按绑定键去重）—— 不写第二份过滤器。components→features 的引用有既有先例
// （WorkspacePicker / GlobalRail / Sidebar）。
import { selectSkillCandidates } from "../../features/workspace/components/agentSkillCandidates";
import { Button } from "../ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "../ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Skeleton } from "../ui/skeleton";

const props = defineProps<{
    open: boolean;
    /** 目标 principal；null 时不取数（挂载方用同一个 ref 表达「没选中」）。 */
    principal: { id: string; name: string } | null;
}>();

const emit = defineEmits<{ "update:open": [value: boolean] }>();

const { t } = useI18n();
const K = "settings.instanceResources.agents.";

const bindings = ref<AgentSkillBinding[]>([]);
const candidates = ref<AgentSkillSummary[]>([]);
const loading = ref(false);
const loadFailed = ref(false);
const candidatesFailed = ref(false);
const busy = ref(false);
const actionError = ref<string | null>(null);
const selectedSkillId = ref("");

/** 实例库定义才可绑（复用 selectSkillCandidates）；已绑的不重复列出。 */
const bindableCandidates = computed(() => {
    const bound = new Set(bindings.value.map((item) => item.skillId));
    return selectSkillCandidates(candidates.value, { scopeType: "instance", scopeId: null }).filter(
        (item) => !bound.has(item.skillId),
    );
});

function errorCopy(cause: unknown, fallbackKey: string): string {
    const code = cause instanceof ApiError ? cause.problem.code : undefined;
    if (code === "SKILL_NOT_FOUND" || code === "SKILL_BINDING_NOT_FOUND") {
        return t(K + "skillsNotFound");
    }
    if (code === "SKILL_BINDING_EXISTS") return t(K + "skillsExists");
    if (code === "FORBIDDEN") return t(K + "skillsForbidden");
    return t(K + fallbackKey);
}

async function load(): Promise<void> {
    const principal = props.principal;
    if (!principal) return;
    loading.value = true;
    loadFailed.value = false;
    candidatesFailed.value = false;
    actionError.value = null;
    try {
        // 省 workspaceId ⇒ 实例档（契约 required=false）。两条读各自失败各自降级：
        // 候选挂了不该把「已绑了什么」也藏掉。
        const [list, catalog] = await Promise.allSettled([
            api.getAgentSkills(null, principal.id),
            api.getSkills(),
        ]);
        if (list.status === "fulfilled") {
            bindings.value = list.value;
        } else {
            bindings.value = [];
            loadFailed.value = true;
            logger.warn("Failed to load instance agent skill bindings", list.reason);
        }
        if (catalog.status === "fulfilled") {
            candidates.value = catalog.value;
        } else {
            candidates.value = [];
            candidatesFailed.value = true;
            logger.warn("Failed to load instance skill catalog", catalog.reason);
        }
    } finally {
        loading.value = false;
    }
}

async function bindSelected(): Promise<void> {
    const principal = props.principal;
    if (!principal || !selectedSkillId.value || busy.value) return;
    busy.value = true;
    actionError.value = null;
    try {
        await api.bindAgentSkill(null, principal.id, selectedSkillId.value);
        selectedSkillId.value = "";
        toast.success(t(K + "skillsBound"));
        await load();
    } catch (cause) {
        actionError.value = errorCopy(cause, "skillsBindFailed");
        logger.warn("Failed to bind skill at instance scope", cause);
    } finally {
        busy.value = false;
    }
}

async function unbind(binding: AgentSkillBinding): Promise<void> {
    const principal = props.principal;
    if (!principal || busy.value) return;
    busy.value = true;
    actionError.value = null;
    try {
        await api.unbindAgentSkill(null, principal.id, binding.bindingId);
        toast.success(t(K + "skillsUnbound"));
        await load();
    } catch (cause) {
        actionError.value = errorCopy(cause, "skillsUnbindFailed");
        logger.warn("Failed to unbind skill at instance scope", cause);
    } finally {
        busy.value = false;
    }
}

watch(
    () => [props.open, props.principal?.id] as const,
    ([open]) => {
        if (!open) return;
        selectedSkillId.value = "";
        void load();
    },
    { immediate: true },
);
</script>

<template>
    <Dialog :open="open" @update:open="(value: boolean) => emit('update:open', value)">
        <DialogContent data-testid="instance-agent-skills-dialog" class="max-w-xl">
            <DialogHeader>
                <DialogTitle>{{ t(K + "skillsTitle") }}</DialogTitle>
                <DialogDescription>
                    {{ t(K + "skillsBody", { name: principal?.name ?? "" }) }}
                </DialogDescription>
            </DialogHeader>

            <div class="space-y-3">
                <div v-if="loading" class="space-y-1.5" data-testid="instance-agent-skills-loading">
                    <Skeleton v-for="row in 2" :key="row" class="h-9 w-full" />
                </div>

                <div
                    v-else-if="loadFailed"
                    class="rounded-md border border-dashed p-3 text-xs"
                    data-testid="instance-agent-skills-load-failed"
                >
                    <p class="text-destructive">{{ t(K + "skillsLoadFailed") }}</p>
                    <Button
                        variant="outline"
                        size="sm"
                        class="mt-2"
                        data-testid="instance-agent-skills-retry"
                        @click="load"
                    >
                        {{ t(K + "skillsRetry") }}
                    </Button>
                </div>

                <template v-else>
                    <p
                        v-if="bindings.length === 0"
                        class="rounded-md border border-dashed p-2 text-xs text-muted-foreground"
                        data-testid="instance-agent-skills-empty"
                    >
                        {{ t(K + "skillsEmpty") }}
                    </p>
                    <ul v-else class="space-y-1.5" data-testid="instance-agent-skills-list">
                        <li
                            v-for="binding in bindings"
                            :key="binding.bindingId"
                            class="flex flex-wrap items-center gap-1.5 rounded-md border p-2 text-xs"
                            :data-testid="`instance-agent-skill-item-${binding.bindingId}`"
                        >
                            <span class="font-medium">{{ binding.name }}</span>
                            <span
                                class="rounded-full border px-1.5 py-0.5"
                                :title="binding.scopeName ?? undefined"
                                :data-testid="`instance-agent-skill-scope-${binding.scopeType}`"
                            >
                                {{
                                    t(
                                        binding.scopeType === "workspace"
                                            ? K + "skillsScopeWorkspace"
                                            : K + "skillsScopeInstance",
                                    )
                                }}
                            </span>
                            <span
                                v-if="binding.sourceType"
                                class="rounded border px-1 py-0.5 text-muted-foreground"
                                :data-testid="`instance-agent-skill-source-${binding.bindingId}`"
                            >
                                {{
                                    t(
                                        binding.sourceType === "workspace"
                                            ? K + "skillsSourceWorkspace"
                                            : K + "skillsSourceInstance",
                                    )
                                }}
                            </span>
                            <span
                                v-if="binding.tokenEstimate != null"
                                class="text-muted-foreground"
                            >
                                {{ t(K + "skillsTokens", { tokens: binding.tokenEstimate }) }}
                            </span>
                            <Button
                                variant="outline"
                                size="sm"
                                class="ml-auto h-6 px-2 text-xs"
                                :disabled="busy"
                                :data-testid="`instance-agent-skill-unbind-${binding.bindingId}`"
                                @click="unbind(binding)"
                            >
                                {{ t(K + "skillsUnbind") }}
                            </Button>
                        </li>
                    </ul>

                    <div class="flex flex-wrap items-center gap-2">
                        <Select
                            :model-value="selectedSkillId"
                            :disabled="busy || bindableCandidates.length === 0"
                            @update:model-value="
                                (value: AcceptableValue) =>
                                    (selectedSkillId = typeof value === 'string' ? value : '')
                            "
                        >
                            <SelectTrigger
                                class="h-8 min-w-56 flex-1"
                                data-testid="instance-agent-skills-select"
                            >
                                <SelectValue :placeholder="t(K + 'skillsSelectPlaceholder')" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem
                                    v-for="skill in bindableCandidates"
                                    :key="skill.skillId"
                                    :value="skill.skillId"
                                >
                                    {{ skill.name }}
                                </SelectItem>
                            </SelectContent>
                        </Select>
                        <Button
                            size="sm"
                            :disabled="busy || !selectedSkillId"
                            data-testid="instance-agent-skills-bind"
                            @click="bindSelected"
                        >
                            {{ t(K + "skillsBind") }}
                        </Button>
                    </div>
                    <p
                        v-if="candidatesFailed"
                        class="text-xs text-muted-foreground"
                        data-testid="instance-agent-skills-catalog-failed"
                    >
                        {{ t(K + "skillsCatalogFailed") }}
                    </p>
                    <p
                        v-else-if="bindableCandidates.length === 0"
                        class="text-xs text-muted-foreground"
                        data-testid="instance-agent-skills-no-candidates"
                    >
                        {{ t(K + "skillsNoCandidates") }}
                    </p>
                    <p
                        v-if="actionError"
                        class="text-xs text-destructive"
                        data-testid="instance-agent-skills-error"
                    >
                        {{ actionError }}
                    </p>
                </template>
            </div>

            <DialogFooter>
                <Button
                    variant="outline"
                    data-testid="instance-agent-skills-close"
                    @click="emit('update:open', false)"
                >
                    {{ t("settings.instanceResources.cancel") }}
                </Button>
            </DialogFooter>
        </DialogContent>
    </Dialog>
</template>
