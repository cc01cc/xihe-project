<script setup lang="ts">
import { ref } from "vue";
import SettingsSidebar from "@/components/settings/SettingsSidebar.vue";
import SettingsLayerHeader from "@/components/settings/SettingsLayerHeader.vue";
import {
    Sidebar,
    SidebarContent,
    SidebarGroup,
    SidebarGroupContent,
    SidebarGroupLabel,
    SidebarHeader,
    SidebarMenu,
    SidebarMenuBadge,
    SidebarMenuButton,
    SidebarMenuItem,
    SidebarProvider,
    SidebarSeparator,
} from "@/components/ui/sidebar";
import { domains, opsItems, securityItems } from "../data";

/**
 * Sheet 02 — before / after, side by side.
 *
 * The left half is **not** a drawing: it mounts the shipping `SettingsSidebar` and
 * `SettingsLayerHeader` components unchanged (only the pinia auth seed differs, see
 * `src/preview/mock/stores.ts`). Whatever is wrong with them is visible here rather than described
 * in prose:
 * 1. the current rail has **no icons** and no left indicator bar;
 * 2. its breadcrumb is a hand-concatenated string (`" › "`), not `<nav><ol>`;
 * 3. every row is a full-width block, so 17 rows read as an undifferentiated list.
 */
const active = ref("rag");
</script>

<template>
    <div class="flex h-full min-h-0">
        <!-- 左：改造前（现网真实组件） -->
        <section class="flex min-w-0 flex-1 flex-col border-r border-border">
            <div
                class="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-muted/40 px-5"
            >
                <span class="text-xs font-semibold">改造前</span>
                <span class="text-[11px] text-muted-foreground"
                    >SettingsSidebar.vue + SettingsLayerHeader.vue（产品原组件，未改一行）</span
                >
            </div>
            <div class="flex min-h-0 flex-1">
                <aside class="w-[264px] shrink-0 overflow-hidden border-r border-border">
                    <SettingsSidebar />
                </aside>
                <div class="min-h-0 flex-1 overflow-hidden">
                    <SettingsLayerHeader layer="instance" domain="RAG 检索" />
                    <div class="space-y-3 px-6 py-5">
                        <div class="h-9 rounded-md border border-dashed border-border" />
                        <div class="h-9 rounded-md border border-dashed border-border" />
                        <div class="h-9 rounded-md border border-dashed border-border" />
                        <p class="pt-2 text-xs leading-5 text-muted-foreground">
                            内容区无宽度上限：文本框随视口拉满，行长超过可读区间（1200px+）。
                        </p>
                    </div>
                </div>
            </div>
        </section>

        <!-- 右：改造后 -->
        <section class="flex min-w-0 flex-1 flex-col">
            <div
                class="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-muted/40 px-5"
            >
                <span class="text-xs font-semibold">改造后</span>
                <span class="text-[11px] text-muted-foreground"
                    >components/ui/sidebar（vendor 官方件）+ lucide 图标 + 2px 选中条 +
                    Breadcrumb</span
                >
            </div>
            <SidebarProvider class="h-full min-h-0">
                <Sidebar collapsible="none" class="h-full w-[280px]">
                    <SidebarHeader class="border-b border-sidebar-border px-3 py-3">
                        <span class="text-sm font-semibold">设置 · 实例层</span>
                    </SidebarHeader>
                    <SidebarContent class="px-1">
                        <SidebarGroup>
                            <SidebarGroupLabel class="gap-2 text-[11px] uppercase tracking-wide"
                                >域 <span class="font-mono text-[10px]">12</span></SidebarGroupLabel
                            >
                            <SidebarGroupContent>
                                <SidebarMenu>
                                    <SidebarMenuItem v-for="item in domains" :key="item.id">
                                        <SidebarMenuButton
                                            :is-active="active === item.id"
                                            class="relative h-8"
                                            @click="active = item.id"
                                        >
                                            <span
                                                v-if="active === item.id"
                                                class="absolute inset-y-1 left-0 w-0.5 rounded-full bg-foreground"
                                                aria-hidden="true"
                                            />
                                            <component :is="item.icon" class="size-4 shrink-0" />
                                            <span class="truncate">{{ item.label }}</span>
                                            <SidebarMenuBadge v-if="item.badge">{{
                                                item.badge
                                            }}</SidebarMenuBadge>
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
                                        <SidebarMenuButton class="h-8">
                                            <component :is="item.icon" class="size-4 shrink-0" />
                                            <span class="truncate">{{ item.label }}</span>
                                        </SidebarMenuButton>
                                    </SidebarMenuItem>
                                </SidebarMenu>
                            </SidebarGroupContent>
                        </SidebarGroup>
                        <SidebarSeparator />
                        <SidebarGroup>
                            <SidebarGroupLabel class="text-[11px] uppercase tracking-wide"
                                >安全与权限</SidebarGroupLabel
                            >
                            <SidebarGroupContent>
                                <SidebarMenu>
                                    <SidebarMenuItem v-for="item in securityItems" :key="item.id">
                                        <SidebarMenuButton class="h-8">
                                            <component :is="item.icon" class="size-4 shrink-0" />
                                            <span class="truncate">{{ item.label }}</span>
                                        </SidebarMenuButton>
                                    </SidebarMenuItem>
                                </SidebarMenu>
                            </SidebarGroupContent>
                        </SidebarGroup>
                    </SidebarContent>
                </Sidebar>
                <div class="min-h-0 flex-1 overflow-hidden bg-background">
                    <div class="border-b border-border px-8 py-3">
                        <nav aria-label="面包屑" class="text-xs text-muted-foreground">
                            <ol class="flex items-center gap-2">
                                <li>设置</li>
                                <li aria-hidden="true">›</li>
                                <li>实例配置</li>
                                <li aria-hidden="true">›</li>
                                <li><span class="font-medium text-foreground">RAG 检索</span></li>
                            </ol>
                        </nav>
                    </div>
                    <div class="px-8 py-5">
                        <div class="max-w-[560px] space-y-3">
                            <div class="h-9 rounded-md border border-border bg-muted/30" />
                            <div class="h-9 rounded-md border border-border bg-muted/30" />
                            <div class="h-9 rounded-md border border-border bg-muted/30" />
                            <p class="pt-2 text-xs leading-5 text-muted-foreground">
                                内容列封顶 920px：行长回到可读区间，右侧留白而不是被拉满。
                            </p>
                        </div>
                    </div>
                </div>
            </SidebarProvider>
        </section>
    </div>
</template>
