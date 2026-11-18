<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import OrgUnitTreePanel from "../components/OrgUnitTreePanel.vue";
import OrgUnitMemberList from "../components/OrgUnitMemberList.vue";
import AgentPrincipalsPanel from "../../../components/settings/AgentPrincipalsPanel.vue";
import type { ApiOrgUnitNode } from "../../../composables/api";

const { t } = useI18n();

/**
 * PLAN-0773 M3（task-240，Lead 2026-11-13 裁 (a)）：组织成员 = **全局模块**（实例级面）。
 * org-units 契约明写「org 与 workspace 平行、不过滤工作区」（openapi.yaml listOrgUnits）
 * ⇒ 本页不挂任何工作区上下文；与工作区容器页 /workspace/:id/members（成员**资格**面，
 * task-236）是两个面，入口也不共享（全局 rail 第 4 项 vs 工作区二级导航）。
 */
const selectedUnit = ref<ApiOrgUnitNode | null>(null);

function onSelect(unit: ApiOrgUnitNode) {
    selectedUnit.value = unit;
}

/**
 * 写面（M3-3）一律禁用 + 解释，不造可点入口（卡面 ④，SettingsResourceNav 同规矩）。
 * 说明文本按现状写：写端点已登记契约（D-1115，cp-1 已实现），**UI 写面随 M3-3 批次开放**
 * —— 不是「后端缺口」，禁用理由是「本批未落地」，不假装、也不谎称缺口。
 */
/** 写面六项：testid 与 i18n 键**全量显式**列出（lint:i18n 会扫源码里的键字面量，不许字符串拼接造键）。 */
const WRITE_ACTIONS: ReadonlyArray<{ testid: string; labelKey: string }> = [
    { testid: "org-write-new-unit", labelKey: "orgMembers.writeNewUnit" },
    { testid: "org-write-rename", labelKey: "orgMembers.writeRename" },
    { testid: "org-write-move", labelKey: "orgMembers.writeMove" },
    { testid: "org-write-add-member", labelKey: "orgMembers.writeAddMember" },
    { testid: "org-write-remove-member", labelKey: "orgMembers.writeRemoveMember" },
    { testid: "org-write-change-role", labelKey: "orgMembers.writeChangeRole" },
];
</script>

<template>
    <!-- task-22（task-34 改白残项）：白底挂页面根（bg-card），与 SettingsLayout/ResourcesLayout 同形态。
         task-81：本页直挂 ModuleStage（上方没有 layout 给 main），故页面根由 section 改为 **main**，
         给出顶层 landmark（W3C ARIA APG · Main Landmark：每页一个、应为顶层地标、用 main 元素定义）。
         class 与 data-testid 一字未动 ⇒ 盒子与既有选择器不变；旧注释那句「本页没有 <main>」已随本次改动过期，
         留着会让下一个人照着它再判一次缺。 -->
    <main class="min-h-full bg-card" data-testid="org-members-page">
        <header class="border-b">
            <div class="mx-auto w-full max-w-6xl px-6 pt-4 pb-3">
                <h1
                    data-testid="org-members-title"
                    class="text-2xl leading-tight font-semibold tracking-tight"
                >
                    {{ t("orgMembers.title") }}
                </h1>
                <p class="mt-1 max-w-3xl text-sm text-muted-foreground">
                    {{ t("orgMembers.desc") }}
                </p>
            </div>
        </header>
        <div class="mx-auto w-full max-w-6xl px-6 py-4">
            <div class="flex flex-wrap items-center gap-2" data-testid="org-write-actions">
                <button
                    v-for="action in WRITE_ACTIONS"
                    :key="action.testid"
                    type="button"
                    disabled
                    :data-testid="action.testid"
                    :title="t('orgMembers.writeHint')"
                    class="rounded-md border bg-muted/30 px-2 py-1 text-sm text-muted-foreground cursor-not-allowed"
                >
                    {{ t(action.labelKey) }}
                </button>
                <p class="w-full text-xs text-muted-foreground">{{ t("orgMembers.writeHint") }}</p>
            </div>
        </div>
        <div
            class="mx-auto grid w-full max-w-6xl grid-cols-1 gap-0 px-6 pb-6 lg:grid-cols-[320px_1fr]"
        >
            <div class="min-h-0 rounded-md border lg:me-4" data-testid="org-tree-scope">
                <OrgUnitTreePanel @select="onSelect" />
            </div>
            <div class="min-h-0 rounded-md border max-lg:mt-4">
                <OrgUnitMemberList :unit="selectedUnit" />
            </div>
        </div>
        <!--
            task-91（用户裁定「智能体是组织成员，不是资源」；沿用用户 2026-11-14 ④
            「智能体个人属于成员管理，并不是在设置域里面」）：个人智能体主体的落点。

            面板仍是 `components/settings/AgentPrincipalsPanel.vue` —— 原先挂在资源区
            `/resources/agents?layer=USER`，权限门（读面已认证、创建走 `CREATE_OWN_AGENT`）
            在面板里，与它挂在资源区时逐条相同，本页不加第二道判据。

            标题文案复用既有 i18n 键（「智能体主体」）：迁移不是新概念；键名不写在这里——
            Vue 开发态保留模板注释，注释里出现真实键名会被 `test-utils/i18nKeys.ts` 的
            裸键护栏当成渲染结果（实测踩到一次）。键的去留见 task-91 收口。
        -->
        <div class="mx-auto w-full max-w-6xl px-6 pb-8" data-testid="org-members-agents">
            <h2
                data-testid="org-members-agents-title"
                class="text-lg leading-tight font-semibold tracking-tight"
            >
                {{ t("settings.ia.resourceAgentPrincipals") }}
            </h2>
            <div class="mt-3 rounded-md border">
                <AgentPrincipalsPanel />
            </div>
        </div>
    </main>
</template>
