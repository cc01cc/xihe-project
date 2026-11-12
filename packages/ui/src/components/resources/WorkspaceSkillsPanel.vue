<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { AlertCircle, LoaderCircle } from "@lucide/vue";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { api, type AgentSkillSummary } from "../../composables/api";
import { logger } from "../../lib/logger";

/**
 * PLAN-0772 M2（Lead 裁定一）：技能「本工作区」层的**只读**面板。
 *
 * <p>为什么需要它（而不是继续给"未接线"）：后端读面早就就绪 —— `GET /api/v1/skills?
 * definitionScope=workspace&workspaceId=`（`api.ts` 的 `getWorkspaceSkills`，PLAN-0680 M2 T2.3），
 * 但全仓唯一调用点是把候选塞进智能体绑定下拉（`WorkspaceAgentsPanel`）。没有列表 UI ⇒
 * 用户切到「本工作区技能」看不到任何东西，会以为"这一层没有技能"。只读列表把"看见"补上。</p>
 *
 * <p>三条硬口径：</p>
 * <ul>
 *   <li><b>读失败必须显式</b>（Lead 原话）：失败 ⇒ 错误态 + 理由 + 重试，**不许静默成空列表**
 *       —— 空列表会把"接口挂了"说成"没有技能"。</li>
 *   <li><b>写面不接线、如实写明</b>：既有 `SkillsImportDialog` 的 scope 由用户手填的 JSON 里
 *       `definitionScope` 决定，本页**不预填 workspace scope**（那等于把对话框改成"看起来支持
 *       工作区"的入口）。所以本页只说"读可看、写未接线"。</li>
 *   <li><b>数据只来自本层契约</b>：只调 `getWorkspaceSkills(workspaceId)`，不拿实例层列表兜底
 *       （那会让两层显示同一批数据，正是 V11 禁的"拿别人层的数据冒充本层"）。</li>
 * </ul>
 */
const props = defineProps<{
    /** 工作区 id（由 `SkillsResourceView` 从页签上下文解析后传入；本组件不自己去猜）。 */
    workspaceId: string;
}>();

const { t } = useI18n();

const skills = ref<AgentSkillSummary[]>([]);
const loading = ref(false);
const loadError = ref("");

/**
 * 只显示**确实属于这个工作区**的行（`definitionScope` 是契约里判归属的唯一字段）。
 * 服务端已经按 scope 过滤过，这里再挡一层：真栈/夹具出错时，本层页面上绝不许出现别的层的行
 * —— 那会变成「拿实例定义冒充本工作区技能」。
 */
const visibleSkills = computed(() =>
    skills.value.filter(
        (skill) =>
            skill.definitionScope?.type === "workspace" &&
            (!skill.definitionScope.workspaceId ||
                skill.definitionScope.workspaceId === props.workspaceId),
    ),
);

/** 被挡掉的条数：>0 时页面上要说出来（静默丢弃 = 用户以为数据完好）。 */
const foreignCount = computed(() => skills.value.length - visibleSkills.value.length);

const countLabel = computed(() =>
    t("resources.workspaceSkillsCount", { count: visibleSkills.value.length }),
);

/** 徽标按**行的真实 scope**取，不按页面所在层硬编码（否则读错数据的行也会显示成「本工作区」）。 */
function scopeLabel(skill: AgentSkillSummary): string {
    const type = skill.definitionScope?.type;
    if (type === "workspace") return t("resources.layerWorkspace");
    if (type === "instance") return t("resources.layerInstance");
    if (type === "user") return t("resources.layerUser");
    return "—";
}

async function load(): Promise<void> {
    loading.value = true;
    loadError.value = "";
    try {
        skills.value = await api.getWorkspaceSkills(props.workspaceId);
    } catch (cause) {
        // 失败要能说清"是读不到"而不是"没有"：文案 + 原始原因都留在页面上。
        skills.value = [];
        loadError.value = cause instanceof Error ? cause.message : String(cause);
        logger.warn("Failed to load workspace skills", cause);
    } finally {
        loading.value = false;
    }
}

onMounted(() => {
    void load();
});

watch(
    () => props.workspaceId,
    () => {
        void load();
    },
);
</script>

<template>
    <section data-testid="workspace-skills-panel" class="space-y-4">
        <header class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 data-testid="workspace-skills-heading" class="text-base font-medium">
                {{ t("resources.workspaceSkillsTitle") }}
            </h2>
            <span data-testid="workspace-skills-count" class="text-xs text-muted-foreground">
                {{ countLabel }}
            </span>
        </header>
        <p class="text-xs leading-5 text-muted-foreground">
            {{ t("resources.workspaceSkillsSubtitle") }}
        </p>
        <!-- 写面未接线：入口不隐藏、也不假装可用（点了会有反应却什么都不发生才是假入口）。 -->
        <!-- 被挡掉的条目要说出来：静默丢弃会让用户以为"接口就给了这些"。 -->
        <p
            v-if="foreignCount > 0"
            data-testid="workspace-skills-foreign-ignored"
            class="text-xs leading-5 text-amber-600 dark:text-amber-500"
        >
            {{ t("resources.workspaceSkillsForeignIgnored", { count: foreignCount }) }}
        </p>
        <p
            data-testid="workspace-skills-write-unavailable"
            class="text-xs leading-5 text-muted-foreground"
        >
            {{ t("resources.workspaceSkillsWriteUnavailable") }}
        </p>

        <div
            v-if="loading"
            data-testid="workspace-skills-loading"
            class="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground"
        >
            <LoaderCircle class="size-4 animate-spin" aria-hidden="true" />
            {{ t("resources.workspaceSkillsLoading") }}
        </div>

        <div
            v-else-if="loadError"
            data-testid="workspace-skills-error"
            class="flex flex-col items-center gap-2 py-8 text-sm text-destructive"
        >
            <AlertCircle class="size-6" aria-hidden="true" />
            <p>{{ t("resources.workspaceSkillsErrorTitle") }}</p>
            <p class="text-xs text-balance">{{ loadError }}</p>
            <Button variant="outline" size="sm" data-testid="workspace-skills-retry" @click="load">
                {{ t("resources.workspaceSkillsRetry") }}
            </Button>
        </div>

        <div
            v-else-if="!visibleSkills.length"
            data-testid="workspace-skills-empty"
            class="rounded-lg border border-dashed border-border px-4 py-8 text-center"
        >
            <p class="text-sm font-medium">{{ t("resources.workspaceSkillsEmptyTitle") }}</p>
            <p class="mt-1 text-xs text-muted-foreground">
                {{ t("resources.workspaceSkillsEmptyBody") }}
            </p>
        </div>

        <ul v-else class="space-y-2">
            <li
                v-for="skill in visibleSkills"
                :key="skill.skillId"
                :data-testid="`workspace-skill-item-${skill.skillId}`"
                class="rounded-lg border border-border bg-card px-3 py-2.5"
            >
                <div class="flex flex-wrap items-center gap-2">
                    <span class="text-sm font-medium">{{ skill.name }}</span>
                    <Badge variant="secondary" class="text-[11px] font-normal">
                        {{ scopeLabel(skill) }}
                    </Badge>
                </div>
                <p class="mt-1 font-mono text-[11px] break-all text-muted-foreground">
                    {{ skill.skillId }}
                </p>
            </li>
        </ul>
    </section>
</template>
