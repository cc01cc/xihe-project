<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import SkillsPanel from "../../components/settings/SkillsPanel.vue";
import ResourceWorkspaceRequired from "../../components/resources/ResourceWorkspaceRequired.vue";
import WorkspaceSkillsPanel from "../../components/resources/WorkspaceSkillsPanel.vue";
import { resolveResourceLayer } from "../../lib/settingsIa";
import { readTabWorkspaceId } from "../../lib/workspaceContext";

/**
 * PLAN-0772 M2：技能资源页（`/resources/skills?layer=USER|WORKSPACE|INSTANCE`）。
 *
 * <p>三层的后端成熟度**不一样**（`task-187` 重画 S4 时钉的，别把它们画成一个样子）：</p>
 * <ul>
 *   <li><b>全平台</b>（`INSTANCE`）—— `GET /api/v1/skills` 默认 instance scope，面板现成（`SkillsPanel`）。</li>
 *   <li><b>本工作区</b>（`WORKSPACE`）—— 读面走 `GET /skills?definitionScope=workspace&workspaceId=`
 *       （`api.ts` 的 `getWorkspaceSkills`），由 `WorkspaceSkillsPanel` 做**只读**呈现；写面未接线
 *       且面板自己写明（Lead 2026-11-12 裁定一：读可看 / 写保持现状，不为它改导入对话框）。</li>
 *   <li><b>个人</b>（`USER`）—— 后端尚未实现（决策 12/13 的 T2b）⇒ 只在形状上存在，无可用操作。</li>
 * </ul>
 */
const route = useRoute();
const { t } = useI18n();
const layer = computed(() => resolveResourceLayer("skills", route.query.layer));
const workspaceId = computed(() => readTabWorkspaceId());
</script>

<template>
    <SkillsPanel v-if="layer === 'INSTANCE'" />
    <ResourceWorkspaceRequired v-else-if="layer === 'WORKSPACE' && !workspaceId" />
    <WorkspaceSkillsPanel v-else-if="layer === 'WORKSPACE'" :workspace-id="workspaceId ?? ''" />
    <section
        v-else
        data-testid="resources-skills-user-pending"
        class="rounded-md border border-dashed bg-muted/30 px-4 py-6"
    >
        <h2 class="text-base font-semibold">{{ t("resources.layerTab.skills.USER") }}</h2>
        <p class="mt-1 text-sm leading-relaxed text-muted-foreground">
            {{ t("resources.pendingBackendNotice") }}
        </p>
    </section>
</template>
