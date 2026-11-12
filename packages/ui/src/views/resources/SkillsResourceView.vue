<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import SkillsPanel from "../../components/settings/SkillsPanel.vue";
import PersonalSkillsPanel from "../../components/resources/PersonalSkillsPanel.vue";
import ResourceWorkspaceRequired from "../../components/resources/ResourceWorkspaceRequired.vue";
import WorkspaceSkillsPanel from "../../components/resources/WorkspaceSkillsPanel.vue";
import { resolveResourceLayer } from "../../lib/settingsIa";
import { readTabWorkspaceId } from "../../lib/workspaceContext";

/**
 * PLAN-0772 M2 / `T2b.3`：技能资源页（`/resources/skills?layer=USER|WORKSPACE|INSTANCE`）。
 *
 * <p>三层的后端成熟度**不一样**（`task-187` 重画 S4 时钉的，别把它们画成一个样子）：</p>
 * <ul>
 *   <li><b>全平台</b>（`INSTANCE`）—— `GET /api/v1/skills` 默认 instance scope，面板现成（`SkillsPanel`）。</li>
 *   <li><b>本工作区</b>（`WORKSPACE`）—— 读面走 `GET /skills?definitionScope=workspace&workspaceId=`
 *       （`api.ts` 的 `getWorkspaceSkills`），由 `WorkspaceSkillsPanel` 做**只读**呈现；写面未接线
 *       且面板自己写明（Lead 2026-11-12 裁定一：读可看 / 写保持现状，不为它改导入对话框）。</li>
 *   <li><b>个人</b>（`USER`）—— `T2b.2` 后端已交付（`V156` / `SkillLibraryService`）⇒ 本页接
 *       `PersonalSkillsPanel`：读面 `GET /skills?definitionScope=user`（**只带 scope、不带 workspaceId**，
 *       `openapi.yaml:5465`），写面 `POST /skills/import` 的 `type=user`，门是 `MANAGE_PERSONAL_SKILLS`。</li>
 * </ul>
 *
 * <p>`T2b.3` 之前这里是一张「本层后端尚未实现」的虚线占位卡 —— 那句话在后端落地后就是假话，
 * 已同批删除（`resources.pendingBackendNotice` / `resources.reasonPendingSkills` 一并从 i18n 撤掉）。</p>
 */
const route = useRoute();
const layer = computed(() => resolveResourceLayer("skills", route.query.layer));
const workspaceId = computed(() => readTabWorkspaceId());
</script>

<template>
    <SkillsPanel v-if="layer === 'INSTANCE'" />
    <ResourceWorkspaceRequired v-else-if="layer === 'WORKSPACE' && !workspaceId" />
    <WorkspaceSkillsPanel v-else-if="layer === 'WORKSPACE'" :workspace-id="workspaceId ?? ''" />
    <PersonalSkillsPanel v-else />
</template>
