<script setup lang="ts">
import { ref } from "vue";
import { ChevronsLeft, ChevronsRight, Languages } from "@lucide/vue";
import { SUPPORTED_LOCALES } from "@/i18n/locale";
import type { Language } from "@/types";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
    Sidebar,
    SidebarContent,
    SidebarFooter,
    SidebarGroup,
    SidebarGroupContent,
    SidebarGroupLabel,
    SidebarHeader,
    SidebarInset,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
    SidebarProvider,
    SidebarSeparator,
    SidebarTrigger,
} from "@/components/ui/sidebar";
import { domains, modules, opsItems } from "../data";
// 当前域只从这一处取（模块栏的 settings 常亮是另一回事，见 :is-active="m.id === 'settings'"）
import { activeDomainId } from "../data/all-domains";

/**
 * Sheet 04 — the global module bar in both states.
 *
 * `collapsible="icon"` is the vendored answer to "one rail, two widths".
 *
 * **Width ruling (lead, 2026-11-10, goes into PLAN-0762 M2)**: the product keeps **56px**. shadcn's
 * default is `--sidebar-width-icon` = 3rem = **48px** (see `src/components/ui/sidebar/utils.ts`); we
 * do **not** adopt it, because 56px is already the value in `useWorkspaceLayout.ts#RAIL_WIDTH` and the
 * DEV-010 §10 contract, and 48px drops the icon hit area below our existing touch-target standard.
 * So the provider below overrides `--sidebar-width-icon: 3.5rem`, **without touching the vendored
 * source** (vendor must stay re-addable). The 48px fact is kept here on purpose.
 *
 * Both panes drive `SidebarProvider` with `v-model:open`, because the provider only reflects a
 * one-way `:open` prop once its internal state is writable — a static `:open="false"` renders
 * expanded (observed while building this sheet).
 */
const activeDomain = activeDomainId();

const collapsedOpen = ref(false);
const expandedOpen = ref(true);

/**
 * D-896（用户 2026-11-11 裁定，PLAN-0762 决策 bbc2d189）：折叠态只剩图标时，必须让人知道
 * 「这是什么、下面有什么」；且语言项不得写死「中 / EN」两条（「以后又不一定只有一种语言」）。
 *
 * <p>④a **可见切换键**：两态用**同一个控件、同一个位置**（面板顶栏右侧），图标按当前态指向
 * 「接下来会变成什么」—— 展开态 ChevronsLeft / 折叠态 ChevronsRight；不做两套控件，
 * 用户只需学一个语义。</p>
 *
 * <p>④b **悬浮二级菜单**：菜单项 = 展开态列表的**同一份数据**（`modules`）且顺序一致 ——
 * 「菜单里第 2 项」必须等于「列表里第 2 项」。hover / 点击 / tap 开；键盘 Tab+Enter 开、Esc 关。</p>
 *
 * <p>④c **语言由 SSOT 派生**：`SUPPORTED_LOCALES`（i18n/locale.ts:12）。稿上能数到几条语言，
 * 答案永远是 `SUPPORTED_LOCALES.length`，不存在第二处字面量。</p>
 */
const toggleCollapsed = () => {
    collapsedOpen.value = !collapsedOpen.value;
};
const toggleExpanded = () => {
    expandedOpen.value = !expandedOpen.value;
};

/** ④b hover：用户点名「悬浮」也要能开二级菜单（点击/键盘是可达性底线，不是替代）。
 * reka DropdownMenu 只由 trigger 交互开 ⇒ 这里用 ref 手动控制，并与 click/keyboard 不互斥。
 */
const moduleMenuOpen = ref(false);
function openModuleMenu() {
    moduleMenuOpen.value = true;
}
function closeModuleMenu() {
    moduleMenuOpen.value = false;
}

/** 语言显示名：只有 id → i18n key 的映射，没有「两条语言」的清单。 */
const LANGUAGE_LABEL_KEY: Record<Language, string> = {
    "zh-CN": "settings.languageZh",
    "en-US": "settings.languageEn",
};

/** 稿侧不做真实切换，只把语言显示出来（产品侧走 settings.setLanguage）。 */
const localeLabel = (locale: Language) => LANGUAGE_LABEL_KEY[locale] ?? locale;
</script>

<template>
    <div class="flex h-full min-h-0 flex-col">
        <div class="flex h-10 shrink-0 border-b border-border bg-muted/40 mk-caption">
            <div class="flex flex-1 items-center gap-2 border-r border-border px-5">
                <span class="font-semibold">A · 折叠态</span>
                <span class="mk-caption text-muted-foreground"
                    >折叠 56px（覆盖 --sidebar-width-icon = 3.5rem；shadcn 默认 3rem =
                    48px，不采用）</span
                >
            </div>
            <div class="flex flex-1 items-center gap-2 px-5">
                <span class="font-semibold">B · 展开态</span>
                <span class="mk-caption text-muted-foreground"
                    >图标 + 文字 + 模块名 · 256px（--sidebar-width = 16rem）</span
                >
            </div>
        </div>

        <div class="flex min-h-0 flex-1">
            <!-- A：折叠 -->
            <section class="flex min-w-0 flex-1 border-r border-border">
                <SidebarProvider
                    v-model:open="collapsedOpen"
                    class="h-full min-h-0"
                    :style="{ '--sidebar-width': '3.5rem', '--sidebar-width-icon': '3.5rem' }"
                >
                    <Sidebar collapsible="icon" class="relative h-full md:relative md:h-full">
                        <SidebarHeader class="items-center px-1 py-2">
                            <div
                                class="flex size-8 items-center justify-center rounded-md bg-foreground mk-caption font-semibold text-background"
                            >
                                XH
                            </div>
                        </SidebarHeader>
                        <SidebarContent class="px-0.5">
                            <SidebarGroup class="p-1">
                                <SidebarGroupContent>
                                    <SidebarMenu>
                                        <SidebarMenuItem v-for="m in modules" :key="m.id">
                                            <!-- ④b 二级菜单：与展开态列表同源同序（modules）；hover/点击/tap 开，
                                                 键盘 Tab+Enter 开、Esc 关（reka 原生）。 -->
                                            <DropdownMenu v-model:open="moduleMenuOpen">
                                                <DropdownMenuTrigger
                                                    :is-active="m.id === 'settings'"
                                                    :tooltip="m.label"
                                                    class="justify-center"
                                                    @pointerenter="openModuleMenu"
                                                    @pointerleave="closeModuleMenu"
                                                >
                                                    <component :is="m.icon" class="size-5" />
                                                </DropdownMenuTrigger>
                                                <DropdownMenuContent
                                                    side="right"
                                                    align="start"
                                                    class="w-44"
                                                >
                                                    <p
                                                        class="px-2 py-1 mk-caption text-muted-foreground"
                                                    >
                                                        全局条 · 模块（折叠态）
                                                    </p>
                                                    <DropdownMenuItem
                                                        v-for="entry in modules"
                                                        :key="entry.id"
                                                        :data-testid="`s4-collapsed-menu-${entry.id}`"
                                                        :inset="true"
                                                    >
                                                        <component
                                                            :is="entry.icon"
                                                            class="size-4"
                                                        />
                                                        <span>{{ entry.label }}</span>
                                                    </DropdownMenuItem>
                                                </DropdownMenuContent>
                                            </DropdownMenu>
                                        </SidebarMenuItem>
                                    </SidebarMenu>
                                </SidebarGroupContent>
                            </SidebarGroup>
                        </SidebarContent>
                        <SidebarFooter class="px-0.5 pb-2">
                            <!-- ④c 语言：折叠态也要能换语言，且项由 SUPPORTED_LOCALES 派生（不写死两条）。 -->
                            <SidebarMenu>
                                <SidebarMenuItem>
                                    <DropdownMenu>
                                        <DropdownMenuTrigger
                                            tooltip="界面语言"
                                            data-testid="s4-collapsed-lang-trigger"
                                            class="justify-center"
                                        >
                                            <Languages class="size-5" />
                                        </DropdownMenuTrigger>
                                        <DropdownMenuContent
                                            side="right"
                                            align="start"
                                            class="w-44"
                                        >
                                            <p class="px-2 py-1 mk-caption text-muted-foreground">
                                                界面语言（{{ SUPPORTED_LOCALES.length }} 种）
                                            </p>
                                            <DropdownMenuItem
                                                v-for="locale in SUPPORTED_LOCALES"
                                                :key="locale"
                                                :data-testid="`s4-collapsed-lang-${locale}`"
                                                :inset="true"
                                            >
                                                <span>{{ localeLabel(locale) }}</span>
                                            </DropdownMenuItem>
                                        </DropdownMenuContent>
                                    </DropdownMenu>
                                </SidebarMenuItem>
                            </SidebarMenu>
                            <SidebarMenu>
                                <SidebarMenuItem>
                                    <SidebarMenuButton tooltip="账号" class="justify-center">
                                        <span
                                            class="flex size-5 items-center justify-center rounded-full bg-muted mk-caption font-semibold"
                                            >D3</span
                                        >
                                    </SidebarMenuButton>
                                </SidebarMenuItem>
                            </SidebarMenu>
                        </SidebarFooter>
                    </Sidebar>
                    <SidebarInset class="bg-background">
                        <div class="flex items-center gap-2 border-b border-border px-4 py-2">
                            <SidebarTrigger class="size-7" />
                            <span class="mk-caption text-muted-foreground"
                                >模块内导航在右侧，不在这一条里</span
                            >
                            <!-- ④a 可见切换键：与 SidebarTrigger 同一位置；图标指向「接下来变成什么」。 -->
                            <button
                                type="button"
                                data-testid="s4-toggle-collapsed"
                                class="ml-auto grid size-7 place-items-center rounded-md border border-border text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                :aria-label="collapsedOpen ? '展开全局条' : '折叠全局条'"
                                @click="toggleCollapsed"
                            >
                                <ChevronsRight v-if="collapsedOpen" class="size-4" />
                                <ChevronsLeft v-else class="size-4" />
                            </button>
                        </div>
                        <div class="space-y-3 p-4">
                            <div class="h-9 rounded border border-border bg-muted/30" />
                            <div class="h-9 rounded border border-border bg-muted/30" />
                            <div class="h-9 rounded border border-border bg-muted/30" />
                            <p class="pt-1 mk-caption leading-5 text-muted-foreground">
                                [裁定 PLAN-0762 T2.3 / DEV-010 §10.2] 全局条 MVP
                                <strong>只放两个模块</strong>：主体工作区 /
                                设置页，<strong>不加第三个</strong>；第三个模块何时进、进什么，[裁定]
                                待用户裁定（DEV-010 §10.6）。 [引用 M3] M3 建议 collapsed rail 放
                                3–7 个目的地 —— <strong>我们比它更严，取 2</strong>，不是 M3
                                让我们放 3。56px 见 DEV-010 §10 与 RAIL_WIDTH。
                            </p>
                        </div>
                    </SidebarInset>
                </SidebarProvider>
            </section>

            <!-- B：展开 -->
            <section class="flex min-w-0 flex-1">
                <SidebarProvider
                    v-model:open="expandedOpen"
                    class="h-full min-h-0"
                    :style="{ '--sidebar-width': '16rem', '--sidebar-width-icon': '3rem' }"
                >
                    <Sidebar collapsible="icon" class="relative h-full md:relative md:h-full">
                        <SidebarHeader class="gap-2 border-b border-sidebar-border px-3 py-3">
                            <div class="flex items-center gap-2">
                                <div
                                    class="flex size-8 items-center justify-center rounded-md bg-foreground mk-caption font-semibold text-background"
                                >
                                    XH
                                </div>
                                <div class="flex flex-col">
                                    <span class="mk-body font-semibold leading-4">Xihe</span>
                                    <span class="mk-caption text-muted-foreground">dev 环境</span>
                                </div>
                            </div>
                        </SidebarHeader>
                        <SidebarContent class="px-1">
                            <SidebarGroup>
                                <SidebarGroupLabel class="mk-caption uppercase tracking-wide"
                                    >模块</SidebarGroupLabel
                                >
                                <SidebarGroupContent>
                                    <SidebarMenu>
                                        <SidebarMenuItem v-for="m in modules" :key="m.id">
                                            <SidebarMenuButton
                                                :is-active="m.id === 'settings'"
                                                class="relative h-9"
                                            >
                                                <span
                                                    v-if="m.id === 'settings'"
                                                    class="absolute inset-y-1 left-0 w-0.5 rounded-full bg-foreground"
                                                    aria-hidden="true"
                                                />
                                                <component :is="m.icon" class="size-4" />
                                                <span>{{ m.label }}</span>
                                            </SidebarMenuButton>
                                        </SidebarMenuItem>
                                    </SidebarMenu>
                                </SidebarGroupContent>
                            </SidebarGroup>
                            <SidebarSeparator />
                            <SidebarGroup>
                                <SidebarGroupLabel class="mk-caption uppercase tracking-wide"
                                    >设置 · 实例层</SidebarGroupLabel
                                >
                                <SidebarGroupContent>
                                    <SidebarMenu>
                                        <SidebarMenuItem
                                            v-for="item in domains.slice(0, 6)"
                                            :key="item.id"
                                        >
                                            <SidebarMenuButton
                                                :is-active="item.id === activeDomain"
                                                size="sm"
                                                class="relative"
                                            >
                                                <span
                                                    v-if="item.id === activeDomain"
                                                    class="absolute inset-y-1 left-0 w-0.5 rounded-full bg-foreground"
                                                    aria-hidden="true"
                                                />
                                                <component :is="item.icon" class="size-4" />
                                                <span class="truncate">{{ item.label }}</span>
                                            </SidebarMenuButton>
                                        </SidebarMenuItem>
                                        <SidebarMenuItem>
                                            <SidebarMenuButton
                                                size="sm"
                                                class="text-muted-foreground"
                                            >
                                                <SidebarSeparator
                                                    class="!mx-0 !my-0 w-4 shrink-0 opacity-0"
                                                />
                                                <span class="truncate">其余 6 个域…</span>
                                            </SidebarMenuButton>
                                        </SidebarMenuItem>
                                    </SidebarMenu>
                                </SidebarGroupContent>
                            </SidebarGroup>
                            <SidebarSeparator />
                            <SidebarGroup>
                                <SidebarGroupLabel class="mk-caption uppercase tracking-wide"
                                    >实例运维</SidebarGroupLabel
                                >
                                <SidebarGroupContent>
                                    <SidebarMenu>
                                        <SidebarMenuItem v-for="item in opsItems" :key="item.id">
                                            <SidebarMenuButton size="sm">
                                                <component :is="item.icon" class="size-4" />
                                                <span class="truncate">{{ item.label }}</span>
                                            </SidebarMenuButton>
                                        </SidebarMenuItem>
                                    </SidebarMenu>
                                </SidebarGroupContent>
                            </SidebarGroup>
                        </SidebarContent>
                    </Sidebar>
                    <SidebarInset class="bg-background">
                        <div class="flex items-center gap-2 border-b border-border px-4 py-2">
                            <SidebarTrigger class="size-7" />
                            <span class="mk-caption text-muted-foreground"
                                >同一组件、同一 prop，open 状态切换即两态</span
                            >
                            <button
                                type="button"
                                data-testid="s4-toggle-expanded"
                                class="ml-auto grid size-7 place-items-center rounded-md border border-border text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                :aria-label="expandedOpen ? '展开全局条' : '折叠全局条'"
                                @click="toggleExpanded"
                            >
                                <ChevronsRight v-if="expandedOpen" class="size-4" />
                                <ChevronsLeft v-else class="size-4" />
                            </button>
                        </div>
                        <div class="space-y-3 p-4">
                            <div class="h-9 rounded border border-border bg-muted/30" />
                            <div class="h-9 rounded border border-border bg-muted/30" />
                            <div class="h-9 rounded border border-border bg-muted/30" />
                            <p class="pt-1 mk-caption leading-5 text-muted-foreground">
                                <strong>被否决候选（仅作对照，不采用）</strong>「一根 Sidebar
                                内分两组」：上组=模块，下组=模块内导航。 否决理由：PLAN-0762 design
                                已定 <strong>两根</strong>（GlobalRail + 设置页左导航）；「一层
                                Sidebar 全扛」属 webui-design-research §方案 B，<strong
                                    >需单独立 PLAN</strong
                                >
                                ⇒ mock 不画成结论，只摆在对照位。
                            </p>
                        </div>
                    </SidebarInset>
                </SidebarProvider>
            </section>
        </div>
    </div>
</template>
