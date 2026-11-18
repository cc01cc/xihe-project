<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { Check, ChevronRight } from "@lucide/vue";
import type { GlobalModuleDef } from "../../lib/globalModules";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";

/**
 * GlobalRail 的一个模块行 + 它的二级菜单（`task-189`）。
 *
 * <p>拆成独立组件是为了**一处实现、两处使用**（`SidebarContent` 里的「工作台/资源」与
 * `SidebarFooter` 里的「设置」）—— 复制一份标记语言就等于两份可各自演化的交互（aria 属性、
 * 菜单宽度迟早分叉），这与 `D-896`「内容必须由 SSOT 派生」同源：能派生就不复制。</p>
 *
 * <p>两条打开通道（`task-259` 后）：<b>可点击</b>（行内 chevron 触发 `DropdownMenu`）、
 * <b>可键盘</b>（chevron 是原生 `<button>`，Tab 可达、Enter/Space 打开；折叠态用 `sr-only`
 * 藏**但不排除出可达性树**，所以键盘用户在折叠态也能开菜单）。行本身仍是导航：点行直接去
 * 模块落地页。</p>
 *
 * <p><b>没有「悬浮自动打开」—— 这条要留着看</b>：`task-189` 曾实现「折叠态悬浮即开」并绑到
 * 延时上，但那是**违反裁定**的：`D-896 ④b`（「不论是否折叠都要有悬浮二级菜单」）在同日
 * 10:0x 由用户本人推翻 —— `D-899` 原话「悬浮二级菜单放 bl 先不做，太丑了」⇒ 不进产品 MVP、
 * 登记 `BL-578` 缓做。`task-259` 因此删除了该通道（连同 `RAIL_HOVER_OPEN_DELAY_MS` 与全部
 * 指针处理），**菜单本体与点击/键盘通道保留**。要把它加回来，先看 `BL-578` 状态与该面 D 号的
 * 最新裁定 —— 引 `D-896 ④b` 是引一条被推翻的裁定。</p>
 */
const props = defineProps<{
    module: GlobalModuleDef;
    /** 菜单是否打开（由父组件统一持有，保证同一时刻只开一个）。 */
    open: boolean;
    /** 当前路由路径（用于二级菜单项的选中态）。 */
    activePath: string;
    /** 本模块是否处于激活态（父组件按 `basePath` 前缀判定后传入）。 */
    active: boolean;
}>();

const emit = defineEmits<{
    navigate: [path: string];
    "update:open": [value: boolean];
}>();

const { t } = useI18n();

function isItemActive(path: string) {
    return props.activePath === path;
}
</script>

<template>
    <SidebarMenuItem>
        <div class="relative">
            <!--
                task-30（ui-2 自审 batch-1，四页复现的 P0）：折叠态（`collapsible=icon`）下标签
                `<span>` 是 `display:none` ⇒ 这一排 28×28 的 icon-only 按钮**没有可访问名**
                （`readings/verify.json` 的 `ariaSnapshot` 五个全是 `- button`，WCAG 4.1.2
                Name/Role/Value 判红）。修法对齐同组件既有做法：下方二级菜单触发器已有
                aria-label（复用 sidebar 命名空间里的 moduleMenu 键）。按钮名字直接复用
                `module.labelKey`（与可见标签同源，**不新增 i18n 键**）；折叠/展开两态同值 ——
                展开态不会重复朗读（`aria-label` 覆盖子树文本，只出一个名字）。
            -->
            <SidebarMenuButton
                :data-testid="`global-rail-module-${module.id}`"
                :is-active="active"
                :aria-current="active ? 'page' : undefined"
                :aria-label="t(module.labelKey)"
                class="data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground data-[active=true]:font-medium"
                @click="emit('navigate', module.path)"
            >
                <component :is="module.icon" class="size-4 shrink-0" aria-hidden="true" />
                <span class="truncate group-data-[collapsible=icon]:hidden">{{
                    t(module.labelKey)
                }}</span>
            </SidebarMenuButton>
            <!--
                二级菜单触发器：折叠态用 `sr-only` 藏起，**不排除出可达性树** ——
                Tab 仍可聚焦、Enter/Space 仍能打开，只是视觉上让位给 56px 图标栏。
            -->
            <!--
                **记录曾经的坑（`task-189` 实测，`task-259` 后此坑已不可达但留着）**：reka 的
                `DropdownMenu` 默认 modal，打开时会把内容区外的页面标成 `pointer-events: none`
                ⇒ 指针下方从「模块按钮」变成 `html`，浏览器合成出 `pointerleave`。当年我们有一条
                「折叠态悬浮即开 / 指针离开 160ms 后关」的计时器，于是：关掉菜单 ⇒ 指针恢复 ⇒
                又 `pointerenter` ⇒ **菜单自激开关**（实测 100ms 粒度采样下 open/closed 交替，周期
                ≈700ms，`pointerleave:DIV → BODY → pointerover:HTML` 三连事件就是指纹）。
                同一件事在断言层面也是坑：e2e 里「hover 后**立刻**断言可见」正好落在开的那一帧 ⇒
                假绿，只有「等一会儿再断言」才抓得到 —— 这条反例对任何"靠指针状态维持的浮层"都成立。
                **2026-11-13 `task-259`**：悬浮打开这条通道本身违反 `D-899`（已被用户推翻的
                `D-896 ④b`），已整条删除 ⇒ 本坑今天不可达，故 `:modal="false"` 也已撤掉、回到
                reka 默认的模态语义（焦点陷阱与外部指针屏蔽都回来了）。上面的分析留作下一次
                「想用指针维持浮层」时的前车之鉴，不要因为它已不可达就删掉。
            -->
            <DropdownMenu
                :open="open"
                @update:open="(value: boolean) => emit('update:open', value)"
            >
                <DropdownMenuTrigger as-child>
                    <button
                        type="button"
                        :data-testid="`global-rail-menu-${module.id}`"
                        :aria-label="t('sidebar.moduleMenu')"
                        class="rail-module-menu absolute top-1/2 right-1 flex min-h-7 min-w-7 -translate-y-1/2 items-center justify-center rounded-sm text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring group-data-[collapsible=icon]:sr-only"
                    >
                        <ChevronRight class="size-3.5" aria-hidden="true" />
                    </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                    side="right"
                    align="start"
                    class="min-w-56"
                    :data-testid="`global-rail-menu-content-${module.id}`"
                >
                    <DropdownMenuLabel>{{ t(module.labelKey) }}</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                        v-for="item in module.items"
                        :key="item.id"
                        :data-testid="`global-rail-menu-item-${module.id}-${item.id}`"
                        class="gap-2"
                        @select="emit('navigate', item.path)"
                    >
                        <span class="truncate">{{ t(item.labelKey) }}</span>
                        <Check
                            v-if="isItemActive(item.path)"
                            class="ml-auto size-3.5"
                            aria-hidden="true"
                        />
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </div>
    </SidebarMenuItem>
</template>

<style scoped>
/*
 * task-10 / batch-3（触控，裁定 D）：折叠态（`collapsible=icon`）下这个二级菜单触发器被
 * `sr-only` 接管 —— 布局上让位是对的（折叠态没有横向空间放 chevron），但它**仍然可聚焦**，
 * 于是键盘用户 Tab 到的就是一个 1×1、被 `clip` 掉、看不见的按钮（ui-2 rect 表四页一致 1×1）。
 *
 * 修法：不拆触发器、不加 `tabindex="-1"`（那是收回能力）、不复制第二份菜单 ——
 * 只让它在**获得键盘焦点时现形**：撤销 `sr-only` 的 `clip`/`overflow`/1px 限制，给出
 * ≥24×24 的命中盒（`focus-visible:ring-2` 已在 class 上，焦点环随之可见）。
 *
 * 为什么不用 Tailwind 的 `focus-visible:not-sr-only`：`not-sr-only` 会把 `position` 重置成
 * `static`，而这里必须是 `absolute`（`top-1/2 right-1`）—— 否则焦点一出现就参与流式布局、
 * 把整行顶歪。所以只撤销「视觉隐藏」相关的属性，位置语义保持不变。
 *
 * 数值：本仓 `--spacing` = 3.5px（`styles/main.css`）⇒ 24 档 = 7 步 = **24.5px**；
 * `h-6`/`size-6` 只有 21px，不是 24 档（这才是「改了还违例」的那条坑）。
 */
[data-collapsible="icon"] .rail-module-menu:focus-visible {
    position: absolute;
    width: 24.5px;
    height: 24.5px;
    margin: 0;
    padding: 0;
    overflow: visible;
    clip: auto;
    clip-path: none;
    white-space: normal;
    z-index: 20;
}
</style>
