<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { useI18n } from "vue-i18n";
import { useAuthStore } from "../../../stores/auth";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../../components/ui/tabs";
import WorkspaceAgentsPanel from "../components/WorkspaceAgentsPanel.vue";
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

/**
 * task-174 A1（`D-1538`）：工具栏 `Bot` 入口退役后，智能体管理的入口归到成员页 ——
 * 成员页承载两个一级 tab：**成员**（默认，既有面板不动）与**智能体**（`WorkspaceAgentsPanel`，
 * 与此前 dock 面板 `agents` 分支同一组件、同一份逻辑，不复制状态）。
 * 默认 tab 固定为「成员」：刷新/直连的行为与本次改动前一致，深链参数不新增。
 */
const activeTab = ref<"members" | "agents">("members");

// 与设置页 tab 时代完全同一份 readonly 推导：角色未解析 = undefined（面板首帧禁用表单），
// 解析后 EDITOR 只读、OWNER 可管理。
const panelReadonly = computed(() =>
    auth.workspace?.workspaceRole === undefined ? undefined : !auth.canManageWorkspace,
);

/**
 * task-470：管理面判据（task-414）读的是 `/me/permissions` **原子投影**，而启动路径只加载
 * `capabilities`（`App.vue` 的 `refreshCapabilities`）——两者不是同一个面。成员页此前不加载投影，
 * 于是**直连或刷新本页**的真实 OWNER 也拿到只读面板（先逛过设置页才正常，因为那边会加载）。
 * 这里与 `DataControlsView.vue` 同形：单飞、失败 fail-closed，不新增契约、不改判据。
 */
onMounted(() => {
    void auth.ensureSelfPermissions();
});
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
            <Tabs v-model="activeTab">
                <!--
                    task-90（与 task-81 P1-2 同一病因，这里是**漏改的姊妹页**）：
                    `aria-label` 必须落在**有 `role=tablist` 的那个元素**上（即 `TabsList`）。

                    改前实测：label 挂在 `<Tabs>` 根上。reka 的 `TabsRoot.cjs` **不输出任何
                    `role`**（源码 `grep -c role` = 0 命中），而 vendor `Tabs.vue` 只是把 attrs
                    透传给 `TabsRoot` ⇒ label 落到一个**无 role 的外层 div** 上，
                    `[role="tablist"]` 自身的可访问名仍是空 ⇒ 屏幕阅读器**不会播报这个分组名**。
                    「有 aria-label」看起来满足了，实际没说话（比完全没有更危险）。

                    为什么不是「两边都挂」：同一个组名挂在两个元素上会让读屏念两遍，且外层那个
                    无 role 的 label 仍是无意义属性 ⇒ 只保留 tablist 这一处。
                -->
                <!--
                    task-10 / batch-2 ④（触控）：SC 2.5.8 要 24×24 CSS px。实测（ui-2 batch-3 rect 表，
                    钉在 3.5px 栅格时代）这两个触发器是 40.5 × **21.8** —— 高度只有文本行盒（当时
                    text-sm 行高 1.55 × 14 = 21.7），因为 vendor `TabsTrigger` 的 `h-8` 挂在
                    `group-data-horizontal/tabs` 上，`variant="line"` 下没落到这层 ⇒ 盒高由内容撑。
                    加 `min-h-7`：本仓 `--spacing` = 4px（`styles/main.css:290` 的 `@theme` 默认，
                    D-1842 删掉了此前的 3.5px 覆盖）⇒ **7 步 = 28px**（`h-6`/`min-h-6` 今天是 24px，
                    恰好压在下限上、零余量，仍不当 24 档用）。
                    `inline-flex items-center` 自带，所以撑高后文案仍居中。
                -->
                <TabsList variant="line" :aria-label="t('workspace.membersTabLabel')">
                    <TabsTrigger data-testid="members-tab-members" value="members" class="min-h-7">
                        {{ t("workspace.membersTabMembers") }}
                    </TabsTrigger>
                    <TabsTrigger data-testid="members-tab-agents" value="agents" class="min-h-7">
                        {{ t("workspace.membersTabAgents") }}
                    </TabsTrigger>
                </TabsList>
                <TabsContent value="members" class="mt-4">
                    <WorkspaceMembersPanel
                        v-if="auth.canViewMembers !== false"
                        :workspace-id="workspaceId"
                        :readonly="panelReadonly"
                    />
                </TabsContent>
                <TabsContent value="agents" class="mt-4">
                    <!-- 同一组件、同一逻辑：不复制智能体状态。 -->
                    <WorkspaceAgentsPanel :key="workspaceId" :workspace-id="workspaceId" />
                </TabsContent>
            </Tabs>
        </div>
    </section>
</template>
