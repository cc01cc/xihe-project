<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import { useI18n } from "vue-i18n";
import { useAuthStore } from "../../../stores/auth";
import WorkspaceMembersPanel from "../components/WorkspaceMembersPanel.vue";

/**
 * PLAN-0773 M4-3（task-236）：成员从设置页 tab 提升为**工作区一级页**（order 45）。
 * 能力本体是 `WorkspaceMembersPanel`（PLAN-0565：列表 / 按 username 添加 / 改角色 /
 * AlertDialog 移除 / CP 权威），本页只做壳 —— 标题 + 同一个面板，**不复制成员逻辑、
 * 不发明第二套状态**。
 *
 * <p>`canViewMembers === false`（VIEWER）时**不渲染成员列表**，也**不发明 403 页** ——
 * 沿用设置页 tab 时代的既有语义（tab 隐藏 = 面板不渲染；PLAN-0565 裁定 #2）。三态语义
 * 与 BL-344 同口径：`undefined`（未解析）照常挂载面板（表单禁用、节点不抖动）。</p>
 *
 * <p>旧深链 `/workspace/:id/settings?tab=members` 由设置页**重定向**到本页（单入口；
 * 内容同一组件，不回落、不 404）。移动端入口 = 二级导航项本身（`MobileMembersSheet`
 * 是**会话参与者**面板，属不同域，不给本页挂）。</p>
 */
const route = useRoute(),
    auth = useAuthStore();
const { t } = useI18n();

const workspaceId = computed(() => String(route.params.workspaceId ?? "").trim());

// 与设置页 tab 时代完全同一份 readonly 推导：角色未解析 = undefined（面板首帧禁用表单），
// 解析后 EDITOR 只读、OWNER 可管理。
const panelReadonly = computed(() =>
    auth.workspace?.workspaceRole === undefined ? undefined : !auth.canManageWorkspace,
);
</script>

<template>
    <section class="min-h-full" data-testid="workspace-members-page">
        <header class="border-b">
            <div class="mx-auto w-full max-w-6xl px-6 pt-4 pb-3">
                <h1
                    data-testid="workspace-members-title"
                    class="text-2xl leading-tight font-semibold tracking-tight"
                >
                    {{ t("workspaceNav.members") }}
                </h1>
                <p class="mt-1 max-w-3xl text-sm text-muted-foreground">
                    {{ t("workspace.membersPageDesc") }}
                </p>
            </div>
        </header>
        <div class="mx-auto w-full max-w-6xl px-6 py-6">
            <WorkspaceMembersPanel
                v-if="auth.canViewMembers !== false"
                :workspace-id="workspaceId"
                :readonly="panelReadonly"
            />
        </div>
    </section>
</template>
