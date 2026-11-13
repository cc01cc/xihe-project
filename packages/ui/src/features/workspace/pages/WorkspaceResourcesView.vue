<script setup lang="ts">
import { computed, defineAsyncComponent, markRaw, ref, watch, type Component } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import {
    RESOURCE_DEFS,
    resourceDef,
    resourcePath,
    type ResourceId,
    type ResourceLayer,
} from "../../../lib/settingsIa";
import { RESOURCE_VIEWS } from "../../../lib/resourceViews";

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
 * <p><b>三个 SSOT 纪律（这页自己不持有一份清单）</b>：</p>
 * <ol>
 *   <li>资源清单 = `RESOURCE_DEFS` 里**真实有 WORKSPACE 层**的那些（`layerRules`），只在本文件
 *       派生一次；页面不写死 `["skills","mcp",...]`。**`knowledge` 因此自然不入选** ——
 *       它的 `layerRules` 为空（G3 缺口：CP 无库实体），所以这是**派生结果**而不是白名单过滤</li>
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

/** 唯一派生口径：`RESOURCE_DEFS` 里有 WORKSPACE 层的资源（顺序即矩阵顺序）。 */
const WORKSPACE_RESOURCE_IDS: readonly ResourceId[] = RESOURCE_DEFS.filter((def) =>
    def.layerRules.some((rule) => rule.layer === WORKSPACE_LAYER),
).map((def) => def.id);

/**
 * 视图表只装载**本页会用到**的那几个（`markRaw` + 模块级建一次）：每次渲染都新建
 * async 组件会让 Vue 反复重建子树（层切换变成整片重挂）。
 */
const RESOURCE_VIEW_COMPONENTS = new Map<ResourceId, Component>(
    WORKSPACE_RESOURCE_IDS.map((id) => [id, markRaw(defineAsyncComponent(RESOURCE_VIEWS[id]))]),
);

const route = useRoute();
const router = useRouter();
const { t } = useI18n();

const workspaceId = computed(() => String(route.params.workspaceId ?? "").trim());

/** `?resource=` 的唯一解析口径（读与写都走它，避免两处各写一份白名单）。 */
function resourceFromQuery(q: unknown): ResourceId {
    return typeof q === "string" && (WORKSPACE_RESOURCE_IDS as readonly string[]).includes(q)
        ? (q as ResourceId)
        : WORKSPACE_RESOURCE_IDS[0];
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
    WORKSPACE_RESOURCE_IDS.map((id) => ({ id, label: t(resourceDef(id).labelKey) })),
);

function selectResource(id: ResourceId) {
    if (id === activeResource.value) return;
    activeResource.value = id;
    // 深链可分享：选中项进 URL（与设置页 `?tab=` 同一手法），刷新/前进后退都能回到同一资源。
    void router.replace({ query: { ...route.query, resource: id } });
}

const activeView = computed(() => RESOURCE_VIEW_COMPONENTS.get(activeResource.value));

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
</script>

<template>
    <div data-testid="workspace-resources-view" class="flex h-full min-h-0 flex-col">
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

        <!-- 平台 / 用户层：只读引用（不在这里编辑，也不给层切换入口）。 -->
        <div
            v-if="referenceLayers.length > 0"
            class="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-2 text-xs text-muted-foreground"
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

        <div class="min-h-0 flex-1 overflow-y-auto">
            <component
                :is="activeView"
                v-if="activeView"
                :layer="WORKSPACE_LAYER"
                :workspace-id="workspaceId"
            />
        </div>
    </div>
</template>
