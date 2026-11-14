<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import SkillsPanel from "../../components/settings/SkillsPanel.vue";
import PersonalSkillsPanel from "../../components/resources/PersonalSkillsPanel.vue";
import WorkspaceLayerMovedNotice from "../../components/settings/WorkspaceLayerMovedNotice.vue";
import { resolveResourceLayer, type ResourceLayer } from "../../lib/settingsIa";
import { readTabWorkspaceId } from "../../lib/workspaceContext";

/**
 * PLAN-0772 M2 / `T2b.3`：技能资源页（`/resources/skills?layer=USER|WORKSPACE|INSTANCE`）。
 *
 * <p>三层的后端成熟度**不一样**（`task-187` 重画 S4 时钉的，别把它们画成一个样子）：</p>
 * <ul>
 *   <li><b>全平台</b>（`INSTANCE`）—— `GET /api/v1/skills` 默认 instance scope，面板现成（`SkillsPanel`）。</li>
 *   <li><b>本工作区</b>（`WORKSPACE`）—— <b>D-1432 / task-41 起搬回工作区设置</b>
 *       （`/workspace/:id/settings?tab=skills`，宿主 `WorkspaceSkillsPanel`，只读面未变）；
 *       本页该层改为**指路**，不再渲染面板。</li>
 *   <li><b>个人</b>（`USER`）—— `T2b.2` 后端已交付（`V156` / `SkillLibraryService`）⇒ 本页接
 *       `PersonalSkillsPanel`：读面 `GET /skills?definitionScope=user`（**只带 scope、不带 workspaceId**，
 *       `openapi.yaml:5465`），写面 `POST /skills/import` 的 `type=user`，门是 `MANAGE_PERSONAL_SKILLS`。</li>
 * </ul>
 *
 * <p>`T2b.3` 之前这里是一张「本层后端尚未实现」的虚线占位卡 —— 那句话在后端落地后就是假话，
 * 已同批删除（`resources.pendingBackendNotice` / `resources.reasonPendingSkills` 一并从 i18n 撤掉）。</p>
 */
/** task-210（PLAN-0773 M4-2）：两个可选 prop 让工作区页/资源页钉死本工作区层（详见 McpResourceView）。 */
const props = defineProps<{ layer?: ResourceLayer; workspaceId?: string }>();

const route = useRoute();
const layer = computed(() => props.layer ?? resolveResourceLayer("skills", route.query.layer));
/** 先看显式 prop（工作区页），再回落本页签上下文（全局资源页的既有口径）。 */
const workspaceId = computed(() => props.workspaceId?.trim() || readTabWorkspaceId() || "");
</script>

<template>
    <SkillsPanel v-if="layer === 'INSTANCE'" />
    <PersonalSkillsPanel v-else-if="layer === 'USER'" />
    <WorkspaceLayerMovedNotice v-else resource="skills" :workspace-id="workspaceId" />
</template>
