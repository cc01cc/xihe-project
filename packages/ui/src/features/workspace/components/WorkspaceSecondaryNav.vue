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
                <!--
                    task-297：中间段 = **哪个工作区**。此前 trail.container 一直算出来却没人渲染
                    （死字段），面包屑只剩「工作区 › <页>」⇒ 用户读不出是哪个工作区，而旁边 tab
                    也写着「会话」，两处同词都没信息量。这段就是用户说的「不明所以」的机制。

                    为什么用普通 span 而不是 BreadcrumbPage：vendor 的 BreadcrumbPage **硬写**
                    aria-current="page"（BreadcrumbPage.vue:16），而 aria-current="page" 一页只能
                    有一个、属于**最后一个**面包屑段。中间段是祖先容器不是当前页，用它就会让
                    屏幕阅读器读出两个「当前页」。同段不可点是因为它和第一段「工作区」指向同一个
                    地址（trail.container.path === trail.rootPath），做成链接等于两个相邻链接去同一处。
                -->
                <BreadcrumbItem>
                    <span
                        data-testid="workspace-breadcrumb-container"
                        class="max-w-[16rem] truncate"
                    >
                        {{ trail.container.label }}
                    </span>
                </BreadcrumbItem>
                <BreadcrumbSeparator v-if="trail.page" />
                <BreadcrumbItem v-if="trail.page">
                    <BreadcrumbPage>{{ t(trail.page.labelKey) }}</BreadcrumbPage>
                </BreadcrumbItem>
            </BreadcrumbList>
        </Breadcrumb>
    </nav>
</template>
