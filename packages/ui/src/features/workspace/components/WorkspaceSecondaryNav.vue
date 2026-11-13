<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Circle } from "@lucide/vue";
import {
    Breadcrumb,
    BreadcrumbItem,
    BreadcrumbLink,
    BreadcrumbList,
    BreadcrumbPage,
    BreadcrumbSeparator,
} from "../../../components/ui/breadcrumb";
import { useWorkspaceNav } from "../composables/useWorkspaceNav";

/**
 * 工作区内部二级导航 + 面包屑（PLAN-0773 `M4-4` / `task-190`）。
 *
 * <p><b>清单从哪来</b>：`useWorkspaceNav()` 从路由表派生（路由 `meta.workspacePage`），
 * 本组件**不持有任何页面清单**——加一页只需在路由表上加一条带 meta 的记录，导航与面包屑自动跟上。</p>
 *
 * <p><b>为什么用 vendor 的 `Breadcrumb` 组件族</b>（而不是 `" › "` 文本拼接）：
 * `PLAN-0762 T1.2` 已把设置区那处手搓换掉（`SettingsLayerHeader.vue:24-29`），本页是第二处；
 * 分隔符由 `BreadcrumbSeparator` 的 `ChevronRight` 提供，**不保留第二套文本分隔**。
 * 末段带 `aria-current="page"`（`BreadcrumbPage` 自带），每级可点段用 `RouterLink`。</p>
 *
 * <p><b>高度链</b>：`PLAN-0626` 的不变量是「路由页拿到的就是页签栏以下的剩余高度」。本组件是
 * 路由页里的**一行固定高度**，所以 `WorkspaceShell` 把剩余高度用 `min-h-0 flex-1` 交给
 * `RouterView` —— 这里不写任何固定像素高度，也不改外层 viewport 的滚动语义。</p>
 */
const { t } = useI18n();
const { items, active, trail } = useWorkspaceNav();

const containerLabel = computed(() => t("workspaceNav.workspaceContainer"));
</script>

<template>
    <nav
        data-testid="workspace-secondary-nav"
        :aria-label="t('workspaceNav.ariaLabel')"
        class="flex flex-wrap items-center justify-between gap-3 border-b bg-background/95 px-4 py-2 backdrop-blur"
    >
        <ul class="flex flex-wrap items-center gap-1" role="tablist">
            <li v-for="item in items" :key="item.id" role="none">
                <RouterLink
                    :to="item.path"
                    role="tab"
                    :data-testid="`workspace-nav-${item.id}`"
                    :aria-selected="active?.name === item.name"
                    :aria-current="active?.name === item.name ? 'page' : undefined"
                    class="rounded-md px-2 py-1 text-xs font-medium transition-colors"
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

        <Breadcrumb
            data-testid="workspace-breadcrumb"
            :aria-label="t('workspaceNav.breadcrumbLabel')"
            class="text-muted-foreground"
        >
            <BreadcrumbList class="gap-1 text-xs">
                <BreadcrumbItem>
                    <BreadcrumbLink as-child class="hover:text-foreground">
                        <RouterLink :to="trail.rootPath">{{ containerLabel }}</RouterLink>
                    </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
                <BreadcrumbItem v-if="trail.page">
                    <BreadcrumbPage>{{ t(trail.page.labelKey) }}</BreadcrumbPage>
                </BreadcrumbItem>
                <BreadcrumbItem v-else>
                    <BreadcrumbPage>{{ containerLabel }}</BreadcrumbPage>
                </BreadcrumbItem>
            </BreadcrumbList>
        </Breadcrumb>
    </nav>
</template>
