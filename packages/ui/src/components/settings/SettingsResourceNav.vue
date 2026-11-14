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
            <span
                data-testid="resources-nav-count"
                class="ml-1.5 shrink-0 text-xs font-normal text-muted-foreground/70"
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
                     否则 title 提示在缺口项上永远弹不出来。 -->
                <SidebarMenuButton
                    v-else
                    as="div"
                    :data-testid="'settings-nav-resource-gap-' + item.id"
                    :data-gap-codes="(item.gaps ?? []).join(',')"
                    :title="gapTitle(item)"
                    aria-disabled="true"
                    class="flex min-h-[32px] w-full cursor-not-allowed select-none items-center gap-2 rounded-md py-1.5 pl-6 pr-2 text-left text-sm text-muted-foreground/60 aria-disabled:pointer-events-auto"
                >
                    <component :is="iconFor(item.id)" class="size-4 shrink-0" aria-hidden="true" />
                    <span class="min-w-0 flex-1 truncate">{{ t(item.labelKey) }}</span>
                    <Badge variant="outline" class="shrink-0 border-dashed text-xs">
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
