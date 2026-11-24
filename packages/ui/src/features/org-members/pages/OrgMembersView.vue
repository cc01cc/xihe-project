<script setup lang="ts">
import { nextTick, ref } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import OrgUnitTreePanel from "../components/OrgUnitTreePanel.vue";
import OrgUnitMemberList from "../components/OrgUnitMemberList.vue";
import OrgUnitWritePanel from "../components/OrgUnitWritePanel.vue";
import type { ApiOrgUnitMember, ApiOrgUnitNode } from "../../../composables/api";
import type { OrgWriteKind } from "../composables/useOrgUnitWrites";

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
 * 写面（task-136）：六个操作接真实契约，入口在 `OrgUnitWritePanel`。
 *
 * <p>**写成功后不在这里改任何本地副本**（J5 / task-43 裁定）：只 bump 两个刷新令牌，
 * 让树与成员列表各自重取 —— `name/depth/hasChildren/orgUnitId` 都是服务端算的，
 * 本地拼一份等于制造第二套真相。</p>
 */
const treeRefresh = ref(0),
    memberRefresh = ref(0),
    writePanel = ref<InstanceType<typeof OrgUnitWritePanel> | null>(null),
    treePanel = ref<InstanceType<typeof OrgUnitTreePanel> | null>(null);

function onWritten(kind: OrgWriteKind): void {
    treeRefresh.value += 1;
    memberRefresh.value += 1;
    if (kind !== "create-unit" || !selectedUnit.value) return;
    // 新单元挂在选中单元下；该单元若在树上收起，重取后新节点仍不可见 ⇒ 展开它（只展开，不塞节点）。
    const parentId = selectedUnit.value.id;
    void nextTick(() => treePanel.value?.expandUnit(parentId));
}

/** 详情抽屉的写入口 → 页面写窗口（预选该成员）。 */
function onMemberWrite(mode: "remove-member" | "roles", member: ApiOrgUnitMember): void {
    void writePanel.value?.openForMember(mode, member);
}
</script>

<template>
    <!-- task-22（task-34 改白残项）：白底挂页面根（bg-card），与 SettingsLayout/ResourcesLayout 同形态。
         task-81：本页直挂 ModuleStage（上方没有 layout 给 main），故页面根由 section 改为 **main**，
         给出顶层 landmark（W3C ARIA APG · Main Landmark：每页一个、应为顶层地标、用 main 元素定义）。
         class 与 data-testid 一字未动 ⇒ 盒子与既有选择器不变；旧注释那句「本页没有 <main>」已随本次改动过期，
         留着会让下一个人照着它再判一次缺。

         task-135（用户截图报障「组织成员页都没法滚动」）：本页是**直挂 ModuleStage 的顶层路由页**
         （router/index.ts 的 /members 记录无 layout），而 ModuleStage 是 overflow-hidden 的裁剪盒
         ⇒ 页面根不声明滚动就永远滚不动（改前实测 1920×1080：main 高 1080 / 内容 4123 /
         overflowY=visible，滚的是外层 module-stage）。故本 main 自己当滚动容器：
         flex-1 拿满舞台高度、min-h-0 允许收缩、overflow-y-auto 承担滚动。
         结构门 internal/A03-xihe/scripts/check-ui-route-scroll.mjs 钉的就是这条判据。 -->
    <main
        id="main-content"
        tabindex="-1"
        class="flex min-h-0 flex-1 flex-col overflow-y-auto bg-card"
        data-testid="org-members-page"
    >
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
            <OrgUnitWritePanel ref="writePanel" :unit="selectedUnit" @written="onWritten" />
        </div>
        <!--
            task-135 J4：lg 下两栏同高、各自内部滚动。
            面板根是 flex h-full（OrgUnitTreePanel.vue:143 / OrgUnitMemberList.vue:99），
            但 h-full 只有在**行高确定**时才生效；此前 grid 行高是 auto ⇒ 树随内容塌、
            右栏比树高，两栏高度对不上（用户截图的那三个问题之一）。
            修法：lg 下给容器一个**确定行高** 420px（卡面允许的下限值），两格各自
            h-full + 内部 overflow-y-auto ⇒ 同高、各自滚；矮屏也不会把两栏挤成一条缝。
            `shrink-0` 是必须的：页面根是 flex 列容器（为了自持滚动），grid 作为 flex item
            默认 flex-shrink:1；task-135 首次实测时下方智能体主体段有几十行（3726px），
            把它压到 min-height 上（写出 calc(100dvh-19rem)=776px，量到 420px）。
            task-1010 已移除该段，但 `lg:shrink-0` 保留：页面根仍是 flex 列容器，将来任何
            追加的页脚/提示都会重现同一压缩；这条是结构契约，不是给旧段留下的补丁。
            lg 断点以下不设高 ⇒ 单列仍按内容高度，页面滚动即可。
        -->
        <div
            class="mx-auto grid w-full max-w-6xl grid-cols-1 gap-0 px-6 pb-6 lg:h-[420px] lg:shrink-0 lg:grid-cols-[320px_1fr]"
        >
            <div class="min-h-0 rounded-md border lg:me-4" data-testid="org-tree-scope">
                <OrgUnitTreePanel ref="treePanel" :refresh-token="treeRefresh" @select="onSelect" />
            </div>
            <div class="min-h-0 rounded-md border max-lg:mt-4">
                <OrgUnitMemberList
                    :unit="selectedUnit"
                    :refresh-token="memberRefresh"
                    @request-write="onMemberWrite"
                />
            </div>
        </div>
        <!--
            task-1010（用户 2026-11-24 裁定 A）：组织树 + 成员表 + 详情是成员与智能体的
            唯一读面，独立「智能体主体」列表与「创建智能体」按钮从本页移除。

            保留的只是一个去实例设置「平台智能体」页的轻量入口：平台级主体的创建、删除
            与凭据仍属于设置域，本页不再重复承载同一列表（否则两处各自取数、各自分页，
            用户看到的是两套不完全同步的真相）。
        -->
        <div class="mx-auto w-full max-w-6xl px-6 pb-8" data-testid="org-members-agents-link">
            <p class="text-sm text-muted-foreground">
                {{ t("orgMembers.platformAgentsHint") }}
                <RouterLink
                    :to="{ name: 'settings-instance-agent-principals' }"
                    class="font-medium text-foreground underline underline-offset-2 hover:text-primary"
                >
                    {{ t("settings.instanceResources.agents.title") }}
                </RouterLink>
            </p>
        </div>
    </main>
</template>
