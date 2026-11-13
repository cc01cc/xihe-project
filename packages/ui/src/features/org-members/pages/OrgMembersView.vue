<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import OrgUnitTreePanel from "../components/OrgUnitTreePanel.vue";
import OrgUnitMemberList from "../components/OrgUnitMemberList.vue";
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
    <section class="min-h-full" data-testid="org-members-page">
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
                    class="rounded-md border px-2 py-1 text-sm text-muted-foreground opacity-60 cursor-not-allowed"
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
    </section>
</template>
