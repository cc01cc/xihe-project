<script setup lang="ts">
import { computed, type Component } from "vue";
import { useI18n } from "vue-i18n";
import { BookOpen, Bot, Circle, KeyRound, Plug, Sparkles } from "@lucide/vue";
import { Badge } from "../ui/badge";
import { SidebarGroupLabel, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import type { ResourceNavItem } from "../../lib/settingsIa";

const { t } = useI18n();

const props = defineProps<{
    /** 分组标签 i18n key（实例层「实例资源」/ 用户层「我的资源」）。 */
    groupLabelKey: string;
    items: ResourceNavItem[];
    /**
     * PLAN-0772 M2：资源模块里「当前在看的资源」。设置区侧栏不传（那里资源组已整体搬走，
     * 由 `ResourcesLayout` 独占），资源模块传 `meta.resourceId` ⇒ 选中行拿 vendor 的
     * `data-active` 样式与 `aria-current`。
     */
    activeId?: string;
}>();

/**
 * D7（PLAN-0752，用户 2026-11-10）：后端没实现的资源**留位、不隐藏**；
 * P0-N-09（settings-ui-issue-inventory）：缺口项**不得与真链接同形**。
 *
 * <p>task-156 把两者合起来的形态定为「不可点的一行 + 说明」：缺口项不再是
 * button（D7 早期「点击弹说明」会让它看起来可点），说明改为**组级可见 hint** +
 * 条目 title 携带缺口细节；真入口才渲染 router-link。外观用「无 hover + 禁用光标 +
 * 虚线徽标」与真链接区分（灰度截图下也能分辨，N-09 判据）。</p>
 *
 * <p>task-175：视觉层级与 SettingsSidebar 对齐 —— 组标签 12px / 条目 pl-6 三级缩进 /
 * 选中指示条 / 条目图标（skill A13）；缺口徽标与组级 hint 提至 12px（DEV-011 辅助字阶）。</p>
 */
const gapItems = computed(() => props.items.filter((item) => !item.path));

/** task-175：资源条目图标；未知 id 回落 Circle。 */
const RESOURCE_ICONS: Record<string, Component> = {
    agents: Bot,
    mcp: Plug,
    credentials: KeyRound,
    skills: Sparkles,
    knowledge: BookOpen,
};

function iconFor(id: string): Component {
    return RESOURCE_ICONS[id] ?? Circle;
}

function gapTitle(item: ResourceNavItem): string {
    // task-509（T-02）：徽标只说「暂不可用」，**不再插值缺口编号**（G3/G4 是内部编号，
    // 用户读到的是实现进度）。编号仍留在渲染处的 `data-gap-codes` 属性上供调试与 e2e。
    const badge = t("settings.ia.backendGapBadgeGeneric");
    const note = item.gapNoteKey ? t(item.gapNoteKey) : "";
    return note ? badge + " · " + note : badge;
}
</script>

<template>
    <div data-testid="settings-nav-resource-group" class="mt-1">
        <SidebarGroupLabel
            as="p"
            :data-testid="`settings-nav-group-${((groupLabelKey ?? '') as string).split('.').pop() || 'resources'}`"
            class="h-auto px-0 pb-1 pl-4 pr-2 pt-2 text-xs font-medium text-muted-foreground"
        >
            {{ t(groupLabelKey) }}
            <!--
                task-293（T2.1）：组标签右侧的条目计数徽标 —— 稿面 S1 一直画着「资源 5」，代码此前没渲染，
                于是稿在替产品承诺一个不存在的读数（同 `D-1053` 那族：稿面/页面对不上时，缺的那半句必须补上）。

                <p>为什么**把缺口项也计入**：与 `SettingsSidebar` 的实例层计数同口径 —— 那是「可见条目数」
                （12 域 + 2 运维 + 3 安全 = 17，缺口/灰显都算），不是「可用条目数」。两处口径必须一致，
                否则同一个数字在设置区表示 A、在资源区表示 B。</p>
            -->
            <!--
                task-140：计数徽标原为 `text-muted-foreground/70`（单层 color alpha .7），实测浅 2.747 /
                深 4.236 —— **两侧都不达 4.5**，且改前就存在（task-124 复扫发现，不是 task-124/125 引入）。
                判「文字不达」而非「背景不达」：本 span 自身 background-color 是 transparent（实测
                rgba(0,0,0,0)），缺陷在**字形自身的 alpha**，底（侧栏 245）没问题 —— 修法只能是提字色，
                给字加底/加面板都是修错对象。它承载「本组有几个条目」这个可读信息（与 SettingsSidebar
                计数同口径），不是 decorative，且非 aria-hidden ⇒ 4.5 族（12px、400 ⇒ 小字，不适用 3.0 大字档）。
                修法 = 去掉 `/70` 这一层：实色 muted-foreground 实测浅 4.816 / 深 7.663（浅侧与左栏
                条目文字的 4.816 同值，即回到与兄弟元素同一档）。
            -->
            <span
                data-testid="resources-nav-count"
                class="ml-1.5 shrink-0 text-xs font-normal text-muted-foreground"
                >{{ items.length }}</span
            >
        </SidebarGroupLabel>
        <SidebarMenu class="gap-0.5">
            <SidebarMenuItem v-for="item in items" :key="item.id">
                <!-- PLAN-0762 T3.1：真链接走 `SidebarMenuButton as-child` + router-link —— 语义与
                     样式仍由条目自己决定（class 落在被克隆的 `<a>` 上），组件族只提供 hover/选中/
                     `data-active` 约定。**不传 `tooltip`**：两层 asChild 会让 `TooltipTrigger` 的
                     `data-slot` 顶掉 `sidebar-menu-button`（实测见 SettingsSidebar 模板注释）。 -->
                <SidebarMenuButton
                    v-if="item.path"
                    as-child
                    :is-active="props.activeId === item.id"
                    class="flex min-h-[32px] items-center gap-2 truncate rounded-md border-l-2 border-l-transparent py-1.5 pl-6 pr-2 text-sm text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                >
                    <router-link :to="item.path" :data-testid="'settings-nav-resource-' + item.id">
                        <component
                            :is="iconFor(item.id)"
                            class="size-4 shrink-0"
                            aria-hidden="true"
                        />
                        <span class="min-w-0 truncate">{{ t(item.labelKey) }}</span>
                    </router-link>
                </SidebarMenuButton>
                <!-- 缺口项：不可点（无 click、aria-disabled），说明分别在组级 hint 与 title。
                     N-09 要求「禁用光标 + title 可达」⇒ 必须把 vendor 的
                     `aria-disabled:pointer-events-none` 顶回 `auto`（twMerge 同一 variant 组后写者胜），
                     否则 title 提示在缺口项上永远弹不出来。
                     **禁用观感不靠整行 `opacity`**：vendor 的 `aria-disabled:opacity-50` 会与文字自身的半透明
                     alpha 叠成两层，把「降对比」压到 3:1 以下读不了（DEV-011 disabled 行要求 ≥3:1）。这里用
                     `aria-disabled:opacity-100` 顶掉整行透明度，禁用语义交给行内文字 alpha
                     `text-muted-foreground/85`（比启用态 link 的实色明显淡、但仍 ≥3:1）、`cursor-not-allowed`、
                     `aria-disabled`、虚线「暂不可用」徽标与 title 长说明。**同时必须一并顶掉 vendor 的
                     `hover:bg-sidebar-accent` / `hover:text-sidebar-accent-foreground`**：整行 opacity 撤掉后，这两个
                     hover 会以全强度出现，缺口项反而比可点条目更「亮」（实测悬停底色 0.94，可点条目 0.93/0.6）。
                     顶成 `hover:bg-transparent hover:text-muted-foreground/85` ⇒ 悬停外观零变化，反差交给可点条目。
                     读数见 ProviderHub:677 注释所指证据包。 -->
                <SidebarMenuButton
                    v-else
                    as="div"
                    :data-testid="'settings-nav-resource-gap-' + item.id"
                    :data-gap-codes="(item.gaps ?? []).join(',')"
                    :title="gapTitle(item)"
                    aria-disabled="true"
                    class="flex min-h-[32px] w-full cursor-not-allowed select-none items-center gap-2 rounded-md py-1.5 pl-6 pr-2 text-left text-sm text-muted-foreground/85 hover:bg-transparent hover:text-muted-foreground/85 aria-disabled:pointer-events-auto aria-disabled:opacity-100"
                >
                    <component :is="iconFor(item.id)" class="size-4 shrink-0" aria-hidden="true" />
                    <span class="min-w-0 flex-1 truncate">{{ t(item.labelKey) }}</span>
                    <Badge
                        variant="outline"
                        class="shrink-0 border-dashed text-xs text-muted-foreground"
                    >
                        {{ t("settings.ia.backendGapBadgeGeneric") }}
                    </Badge>
                </SidebarMenuButton>
            </SidebarMenuItem>
        </SidebarMenu>
        <p
            v-if="gapItems.length"
            data-testid="settings-nav-gap-hint"
            class="mt-1 px-2 pl-6 text-xs leading-relaxed text-muted-foreground"
        >
            {{ t("settings.ia.backendGapHint") }}
        </p>
    </div>
</template>
