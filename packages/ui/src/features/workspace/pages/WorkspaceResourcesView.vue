<script setup lang="ts">
import { computed, defineAsyncComponent, markRaw, ref, watch, type Component } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { Button } from "../../../components/ui/button";
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
} from "../../../components/ui/collapsible";
import {
    RESOURCE_DEFS,
    resourceDef,
    resourcePath,
    workspaceLayerMoved,
    type ResourceId,
    type ResourceLayer,
    type WorkspaceSettingsResourceId,
} from "../../../lib/settingsIa";
import { RESOURCE_VIEWS } from "../../../lib/resourceViews";
import ResourcePaneLoading from "../components/ResourcePaneLoading.vue";
import WorkspaceLayerMovedNotice from "../../../components/settings/WorkspaceLayerMovedNotice.vue";

/**
 * PLAN-0773 **M4-2**（task-210）：`/workspace/:id/resources` —— 本工作区的资源页。
 *
 * <p><b>形态 = A：复用既有四个资源视图 + 由本页把层钉死「本工作区」</b>，为什么不是别的形态：</p>
 * <ul>
 *   <li><b>不是「新写四套面板」</b>：`/resources/<id>?layer=WORKSPACE` 渲染的就是同一批组件
 *       （`WorkspaceSkillsPanel` / `WorkspaceMcpPanel` / `CredentialsPanel ownerType=WORKSPACE` /
 *       `WorkspaceAgentsPanel`）。写第二套 = 两个入口两份实现，而 `task-209`（D-1019）刚把
 *       「设置页里再开一份」按这个理由撤掉。</li>
 *   <li><b>不是「复用 `ResourcesLayout` 并强制 `?layer=WORKSPACE`」</b>：那会把**层 tab** 一起带出来，
 *       用户能一键切到平台/用户层 ⇒ 与本卡「层固定」直接冲突（`?layer` 还能被手改）。</li>
 *   <li><b>不是「/`resources/<id>?layer=WORKSPACE` 当工作区资源页」</b>：URL 里没有工作区身份，
 *       与 design 的 `/workspace/:id/resources` 不符（M4-6 的旧链接 302 目标也指着后者）。</li>
 * </ul>
 *
 * <p><b>D-1432 / task-41（用户 2026-11-15 裁定）—— 本页的「已迁资源」处理：</b>
 * MCP 与技能的**本工作区层搬回工作区设置** ⇒ 这两个资源**不再出现在本页页签里**，页签上方给一行
 * 「已迁到工作区设置」的直链说明；深链 `?resource=mcp` **不静默回落到别的资源**，而是就地渲染同一张
 * 指路卡（`WorkspaceLayerMovedNotice`）。凭据 / 智能体（以及将来真正落在本层的资源）照旧渲染面板 ——
 * 「把整页清空」与「悄悄少两个页签」都不是本裁定要的结果。</p>
 *
 * <p><b>三个 SSOT 纪律（这页自己不持有一份清单）</b>：</p>
 * <ol>
 *   <li>资源清单 = `RESOURCE_DEFS` 里**真实有 WORKSPACE 层**的那些（`layerRules`），只在本文件
 *       派生一次；页面不写死 `["skills","mcp",...]`。**`knowledge` 因此自然不入选** ——
 *       它的 `layerRules` 为空（G3 缺口：CP 无库实体），所以这是**派生结果**而不是白名单过滤；
 *       已迁资源同样来自派生（`workspaceLayerMoved()` 读同一份 `WORKSPACE_SETTINGS_RESOURCE_IDS`）</li>
 *   <li>「哪个 id 对应哪个组件」= `lib/resourceViews.ts` 的唯一映射（本卡把这表从 `router/index.ts`
 *       搬出来，路由与这页**都读它**）</li>
 *   <li>层标签 = 既有 `resources.layerTab.<资源>.<层>` i18n 键（全局资源页的层 tab 用的同一批），
 *       本页不新增第二套层名文案</li>
 * </ol>
 *
 * <p><b>平台/用户层在本页只作「只读引用」</b>：给出指向 `/resources/<id>?layer=…` 的链接，
 * 不在本页渲染它们的编辑面 —— 否则本页就成了「层 tab 的另一种写法」。</p>
 */
const WORKSPACE_LAYER: ResourceLayer = "WORKSPACE";

/** 派生口径 ①：`RESOURCE_DEFS` 里有 WORKSPACE 层的资源（顺序即矩阵顺序）—— 用于**深链校验**。 */
const WORKSPACE_LAYER_RESOURCE_IDS: readonly ResourceId[] = RESOURCE_DEFS.filter((def) =>
    def.layerRules.some((rule) => rule.layer === WORKSPACE_LAYER),
).map((def) => def.id);

/** 派生口径 ②：已迁到工作区设置的那几个（本页要指路）；③ 页签 = ① 减 ②。 */
const MOVED_RESOURCE_IDS: readonly WorkspaceSettingsResourceId[] =
    WORKSPACE_LAYER_RESOURCE_IDS.filter((id): id is WorkspaceSettingsResourceId =>
        workspaceLayerMoved(id),
    );
const TAB_RESOURCE_IDS: readonly ResourceId[] = WORKSPACE_LAYER_RESOURCE_IDS.filter(
    (id) => !workspaceLayerMoved(id),
);

/**
 * 视图表只装载**本页会用到**的那几个（`markRaw` + 模块级建一次）：每次渲染都新建
 * async 组件会让 Vue 反复重建子树（层切换变成整片重挂）。
 */
const RESOURCE_VIEW_COMPONENTS = new Map<ResourceId, Component>(
    TAB_RESOURCE_IDS.map((id) => [
        id,
        // task-10 / batch-2 ①：异步面板在 chunk 下载期原先**整片空白**（无骨架无提示）⇒
        // 与「加载失败」「本层没有内容」三种情况在视觉上无法区分。这里补一个占位：
        // `delay: 150` 让快加载不闪骨架（Vue 默认 200，收紧一点让慢链路更早给出反馈）。
        markRaw(
            defineAsyncComponent({
                loader: RESOURCE_VIEWS[id],
                loadingComponent: ResourcePaneLoading,
                delay: 150,
            }),
        ),
    ]),
);

const route = useRoute();
const router = useRouter();
const { t } = useI18n();

const workspaceId = computed(() => String(route.params.workspaceId ?? "").trim());

/**
 * task-52 / batch-02 ③：顶部说明默认**折叠**。
 *
 * <p>默认关而不是默认开：用户来这页要做的是管凭据，不是读迁移公告；两条说明的完整内容
 * （含直链）在展开后仍然齐全，所以「折叠」不等于「藏起来」—— 摘要行常驻可见，随时可点开。</p>
 */
const hintsOpen = ref(false);

/** `?resource=` 的唯一解析口径（读与写都走它，避免两处各写一份白名单）。 */
function resourceFromQuery(q: unknown): ResourceId {
    return typeof q === "string" && (WORKSPACE_LAYER_RESOURCE_IDS as readonly string[]).includes(q)
        ? (q as ResourceId)
        : TAB_RESOURCE_IDS[0];
}

const activeResource = ref<ResourceId>(resourceFromQuery(route.query.resource));

watch(
    () => route.query.resource,
    (q) => {
        const next = resourceFromQuery(q);
        if (next !== activeResource.value) activeResource.value = next;
    },
);

const tabs = computed(() =>
    TAB_RESOURCE_IDS.map((id) => ({ id, label: t(resourceDef(id).labelKey) })),
);

function selectResource(id: ResourceId) {
    if (id === activeResource.value) return;
    activeResource.value = id;
    // 深链可分享：选中项进 URL（与设置页 `?tab=` 同一手法），刷新/前进后退都能回到同一资源。
    void router.replace({ query: { ...route.query, resource: id } });
}

/** 当前资源是否已迁走（深链 `?resource=mcp` 也要落在指路卡上，不静默换资源）。 */
const activeMovedId = computed<WorkspaceSettingsResourceId | null>(() =>
    workspaceLayerMoved(activeResource.value)
        ? (activeResource.value as WorkspaceSettingsResourceId)
        : null,
);

const activeView = computed(() =>
    activeMovedId.value ? undefined : RESOURCE_VIEW_COMPONENTS.get(activeResource.value),
);

/**
 * 其它层（平台 / 用户）—— **只作只读引用**。取自同一份 `layerRules`（顺序由 `RESOURCE_LAYERS`
 * 决定），因此不会与全局资源页的层 tab 漂开。
 */
const referenceLayers = computed<ResourceLayer[]>(() =>
    resourceDef(activeResource.value)
        .layerRules.map((rule) => rule.layer)
        .filter((layer) => layer !== WORKSPACE_LAYER),
);

function layerLabel(id: ResourceId, layer: ResourceLayer): string {
    return t(`resources.layerTab.${id}.${layer}`);
}

function referenceHref(id: ResourceId, layer: ResourceLayer): string {
    return `${resourcePath(id)}?layer=${layer}`;
}

/** 已迁资源在工作区设置里的深链（页签 id 与资源 id 同名，见 WorkspaceSettingsView 的 tabs）。 */
function movedHref(id: WorkspaceSettingsResourceId): string {
    return `/workspace/${workspaceId.value}/settings?tab=${id}`;
}
</script>

<template>
    <div data-testid="workspace-resources-view" class="flex h-full min-h-0 flex-col">
        <!--
            task-44（a11y P0）：本页此前**没有 h1** —— 模板根直接是 tablist，读屏「按标题导航」
            时这一页没有任何锚点（成员 / 设置 / 环境三页各有自己的 h1）。
            标题密度按本页体型走：这是占满高度的面板页（不是 6xl 内容页），故用紧凑 header、
            不加描述行；标题字号与另三页一致（text-2xl），保证四页层级一致。
        -->
        <header class="shrink-0 border-b border-border px-6 pt-3 pb-2">
            <h1
                data-testid="workspace-resources-title"
                class="text-2xl leading-tight font-semibold tracking-tight"
            >
                {{ t("workspace.resourcesTitle") }}
            </h1>
        </header>
        <!-- 资源切换：本页**固定在本工作区层**，所以这里是「资源」而不是「层」的页签。 -->
        <div
            class="flex shrink-0 items-center gap-1 border-b border-border px-2 pt-1"
            role="tablist"
            :aria-label="t('workspaceNav.resources')"
        >
            <button
                v-for="tab in tabs"
                :key="tab.id"
                role="tab"
                :data-testid="`ws-resources-tab-${tab.id}`"
                :aria-selected="activeResource === tab.id"
                class="px-4 py-2 text-sm border-b-2 transition-colors"
                :class="
                    activeResource === tab.id
                        ? 'border-primary text-foreground font-medium'
                        : 'border-transparent text-muted-foreground hover:text-foreground'
                "
                @click="selectResource(tab.id)"
            >
                {{ tab.label }}
            </button>
        </div>

        <!--
            D-1432 / task-41：已迁到工作区设置的资源在这页**不再开页签**，
            但仍要「就地说明 + 直链」—— 否则用户只看到页签少了两个，无处可问。

            task-52 / batch-02 ③（P1，截图 `.tmp/xh/b02-tab-资源.png`）：上面那句说明与下面的
            「平台 / 个人层只读引用」**各自占一整行**，两条内部说明条压在页头主位，而用户来这页
            要做的事（凭据管理面板）被挤到下面且是空态 —— 信息层级倒置。

            改法（选项之一，理由写在这里而不是卡面）：**并成一条可折叠摘要**，默认只留一行
            低权重摘要 + 一个「?」触发器，展开才看到两份明细与直链。为什么不直接删掉：
            直链是用户点回设置页的**唯一**入口（页签里已经没有 mcp/skills 了），删掉等于
            把「搬去哪了」变成无处可问 —— 那正是 task-41 当初要解决的问题。为什么不并成
            两行不可折叠的短句：两条说明的**类型不同**（一条是「搬走了」、一条是「只读」），
            并成一行会让「只读」听起来也像「搬走了」。
        -->
        <Collapsible
            v-if="MOVED_RESOURCE_IDS.length > 0 || referenceLayers.length > 0"
            :open="hintsOpen"
            class="shrink-0 border-b border-border"
            data-testid="ws-resources-hints"
            @update:open="(value: boolean) => (hintsOpen = value)"
        >
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-xs">
                <span class="text-muted-foreground">{{ t("resources.resourcesHintSummary") }}</span>
                <CollapsibleTrigger as-child>
                    <Button
                        variant="ghost"
                        size="sm"
                        data-testid="ws-resources-hints-toggle"
                        class="h-6 gap-1 px-1.5 text-xs text-muted-foreground"
                        :aria-expanded="hintsOpen"
                    >
                        <span aria-hidden="true">?</span>
                        <span>{{
                            hintsOpen
                                ? t("resources.resourcesHintHide")
                                : t("resources.resourcesHintShow")
                        }}</span>
                    </Button>
                </CollapsibleTrigger>
            </div>
            <CollapsibleContent>
                <div
                    v-if="MOVED_RESOURCE_IDS.length > 0"
                    data-testid="ws-resources-moved-hint"
                    class="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 pb-2 text-xs text-muted-foreground"
                >
                    <span>{{ t("resources.workspaceLayerMovedInlineHint") }}</span>
                    <RouterLink
                        v-for="id in MOVED_RESOURCE_IDS"
                        :key="id"
                        :to="movedHref(id)"
                        :data-testid="`ws-resources-moved-link-${id}`"
                        class="text-foreground underline-offset-2 hover:underline"
                    >
                        {{ t(resourceDef(id).labelKey) }}
                    </RouterLink>
                </div>
                <!-- 平台 / 用户层：只读引用（不在这里编辑，也不给层切换入口）。 -->
                <div
                    v-if="referenceLayers.length > 0"
                    class="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 pb-2 text-xs text-muted-foreground"
                >
                    <span>{{ t("workspace.resourcesRefHint") }}</span>
                    <RouterLink
                        v-for="layer in referenceLayers"
                        :key="layer"
                        :to="referenceHref(activeResource, layer)"
                        :data-testid="`ws-resources-ref-layer-${layer}`"
                        class="text-foreground underline-offset-2 hover:underline"
                    >
                        {{ layerLabel(activeResource, layer) }}
                    </RouterLink>
                </div>
            </CollapsibleContent>
        </Collapsible>

        <div class="min-h-0 flex-1 overflow-y-auto">
            <component
                :is="activeView"
                v-if="activeView"
                :layer="WORKSPACE_LAYER"
                :workspace-id="workspaceId"
            />
            <div v-else-if="activeMovedId" class="p-4">
                <WorkspaceLayerMovedNotice :resource="activeMovedId" :workspace-id="workspaceId" />
            </div>
        </div>
    </div>
</template>
