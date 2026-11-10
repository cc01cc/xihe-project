<script setup lang="ts">
import { ref } from "vue";
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
const collapsedOpen = ref(false);
const expandedOpen = ref(true);
</script>

<template>
    <div class="flex h-full min-h-0 flex-col">
        <div class="flex h-10 shrink-0 border-b border-border bg-muted/40 text-xs">
            <div class="flex flex-1 items-center gap-2 border-r border-border px-5">
                <span class="font-semibold">A · 折叠态</span>
                <span class="text-[11px] text-muted-foreground"
                    >折叠 56px（覆盖 --sidebar-width-icon = 3.5rem；shadcn 默认 3rem =
                    48px，不采用）</span
                >
            </div>
            <div class="flex flex-1 items-center gap-2 px-5">
                <span class="font-semibold">B · 展开态</span>
                <span class="text-[11px] text-muted-foreground"
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
                                class="flex size-8 items-center justify-center rounded-md bg-foreground text-[11px] font-semibold text-background"
                            >
                                XH
                            </div>
                        </SidebarHeader>
                        <SidebarContent class="px-0.5">
                            <SidebarGroup class="p-1">
                                <SidebarGroupContent>
                                    <SidebarMenu>
                                        <SidebarMenuItem v-for="m in modules" :key="m.id">
                                            <SidebarMenuButton
                                                :is-active="m.id === 'settings'"
                                                :tooltip="m.label"
                                                class="justify-center"
                                            >
                                                <component :is="m.icon" class="size-5" />
                                            </SidebarMenuButton>
                                        </SidebarMenuItem>
                                    </SidebarMenu>
                                </SidebarGroupContent>
                            </SidebarGroup>
                        </SidebarContent>
                        <SidebarFooter class="px-0.5 pb-2">
                            <SidebarMenu>
                                <SidebarMenuItem>
                                    <SidebarMenuButton tooltip="账号" class="justify-center">
                                        <span
                                            class="flex size-5 items-center justify-center rounded-full bg-muted text-[9px] font-semibold"
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
                            <span class="text-xs text-muted-foreground"
                                >模块内导航在右侧，不在这一条里</span
                            >
                        </div>
                        <div class="space-y-3 p-4">
                            <div class="h-9 rounded border border-border bg-muted/30" />
                            <div class="h-9 rounded border border-border bg-muted/30" />
                            <div class="h-9 rounded border border-border bg-muted/30" />
                            <p class="pt-1 text-[11px] leading-5 text-muted-foreground">
                                图标条只放 3 个顶层模块 + 账号：M3「collapsed rail 只放 3–7
                                个目的地」。56px 见 DEV-010 §10 与 RAIL_WIDTH。
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
                                    class="flex size-8 items-center justify-center rounded-md bg-foreground text-[11px] font-semibold text-background"
                                >
                                    XH
                                </div>
                                <div class="flex flex-col">
                                    <span class="text-sm font-semibold leading-4">Xihe</span>
                                    <span class="text-[10px] text-muted-foreground">dev 环境</span>
                                </div>
                            </div>
                        </SidebarHeader>
                        <SidebarContent class="px-1">
                            <SidebarGroup>
                                <SidebarGroupLabel class="text-[11px] uppercase tracking-wide"
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
                                <SidebarGroupLabel class="text-[11px] uppercase tracking-wide"
                                    >设置 · 实例层</SidebarGroupLabel
                                >
                                <SidebarGroupContent>
                                    <SidebarMenu>
                                        <SidebarMenuItem
                                            v-for="item in domains.slice(0, 6)"
                                            :key="item.id"
                                        >
                                            <SidebarMenuButton
                                                :is-active="item.id === 'rag'"
                                                size="sm"
                                                class="relative"
                                            >
                                                <span
                                                    v-if="item.id === 'rag'"
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
                                <SidebarGroupLabel class="text-[11px] uppercase tracking-wide"
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
                            <span class="text-xs text-muted-foreground"
                                >同一组件、同一 prop，open 状态切换即两态</span
                            >
                        </div>
                        <div class="space-y-3 p-4">
                            <div class="h-9 rounded border border-border bg-muted/30" />
                            <div class="h-9 rounded border border-border bg-muted/30" />
                            <div class="h-9 rounded border border-border bg-muted/30" />
                            <p class="pt-1 text-[11px] leading-5 text-muted-foreground">
                                这一段演示的是 schema 2「一个 Sidebar
                                内分两组」：上组=模块，下组=模块内导航， 不是两根独立侧栏。
                            </p>
                        </div>
                    </SidebarInset>
                </SidebarProvider>
            </section>
        </div>
    </div>
</template>
