<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { Circle } from "@lucide/vue";
import { useWorkspaceNav } from "../composables/useWorkspaceNav";

/**
 * 工作区内部**一行导航**（PLAN-0773 `M4-4` / `task-190`；task-160 / S2a 收成一行）。
 *
 * <p><b>清单从哪来</b>：`useWorkspaceNav()` 从路由表派生（路由 `meta.workspacePage`），
 * 本组件**不持有任何页面清单**——加一页只需在路由表上加一条带 meta 的记录，导航自动跟上。</p>
 *
 * <p><b>task-160 改了什么（D-1527 ②③）</b>：</p>
 * <ul>
 *   <li>面包屑整段搬进底部状态栏（`WorkspaceStatusBar.vue`），这里只剩导航项；
 *       搬走的理由见设计 `internal/A03-xihe/docs/workspace-shell-refresh-design.md` §3.2。</li>
 *   <li>单行化：去掉 `flex-wrap` 与 `justify-between`（面包屑走后不再需要左右两栏），
 *       高度钉 `h-8`（8 × `--spacing` 3.5 = **28 px**，与 `packages/ui/AGENTS.md` 的 spacing 轴口径一致）。</li>
 *   <li>**去掉 `aria-current="page"`**：面包屑末段的 `BreadcrumbPage` 自带它，一页只能有一个
 *       「当前页」。导航项是 `role="tab"` + `aria-selected`，那是对 tablist 的正确语义，不需要再叠 aria-current。</li>
 *   <li>**用户裁定：导航行不是浮窗**（「导航行不应该是浮窗，导航行只是提供了快捷键」）。
 *       现状（`[源码]` 2026-11-15 核对）本组件是流内的普通 `<nav>`，**没有** sticky/fixed/absolute ——
 *       任何人后来想加定位都必须先改这条裁定，不要顺手加 `sticky`。</li>
 * </ul>
 *
 * <p><b>高度链</b>：本组件是壳层的第一条 chrome，占自己的高度；剩余高度由
 * `WorkspaceShell` 的 `min-h-0 flex-1` 交给路由页 —— 这里不写固定像素高度，也不改外层 viewport 的滚动语义。</p>
 */
const { t } = useI18n();
const { items, active } = useWorkspaceNav();
</script>

<template>
    <nav
        data-testid="workspace-secondary-nav"
        :aria-label="t('workspaceNav.ariaLabel')"
        class="flex h-8 shrink-0 items-center gap-1 overflow-x-auto bg-card px-4"
    >
        <ul class="flex items-center gap-1" role="tablist">
            <li v-for="item in items" :key="item.id" role="none">
                <RouterLink
                    :to="item.path"
                    role="tab"
                    :data-testid="`workspace-nav-${item.id}`"
                    :aria-selected="active?.name === item.name"
                    aria-current-value="false"
                    class="inline-flex items-center rounded-md px-2 py-1 text-xs font-medium whitespace-nowrap transition-colors"
                    :class="
                        active?.name === item.name
                            ? 'bg-primary/10 text-foreground'
                            : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                    "
                >
                    <component
                        :is="item.icon ?? Circle"
                        class="mr-1 inline-block h-3.5 w-3.5 align-middle"
                    />
                    {{ t(item.labelKey) }}
                </RouterLink>
            </li>
        </ul>
        <!--
            task-38 C1（DEV-011 §13.1「顶栏单行」）：顶栏 = 这一条带，承载「页面导航 + 面板开关」。
            面板开关簇原本在 WorkspaceToolbar 那条**内容区**工具带里（桌面 h-40，与 nav 分行），
            由那边用 <Teleport> 搬进这个挂载点 —— props/emits/testid 一律不变，不为此上提
            workbench 契约。判据的度量方式见 DEV-011 §13.1（getBoundingClientRect + 反例锚点）。
        -->
        <div
            id="workspace-nav-actions"
            data-testid="workspace-secondary-nav-actions"
            class="ml-auto flex shrink-0 items-center gap-1"
        />
    </nav>
</template>
