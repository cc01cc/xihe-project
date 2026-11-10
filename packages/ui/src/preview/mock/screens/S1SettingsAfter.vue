<script setup lang="ts">
import { ref } from "vue";
import { ArrowLeft, ChevronsUpDown, Search, ShieldCheck } from "@lucide/vue";
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
    SidebarMenuBadge,
    SidebarMenuButton,
    SidebarMenuItem,
    SidebarProvider,
    SidebarSeparator,
} from "@/components/ui/sidebar";
import {
    Breadcrumb,
    BreadcrumbItem,
    BreadcrumbLink,
    BreadcrumbList,
    BreadcrumbPage,
    BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
    Field,
    FieldDescription,
    FieldGroup,
    FieldLabel,
    FieldSet,
    FieldLegend,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { domains, opsItems, resourceItems, securityItems, type NavItem } from "../data";

/**
 * Sheet 01 — settings shell after the switch to the vendored `Sidebar`.
 *
 * Everything below is a real vendored component; the only page-local thing is the active-item
 * state (`active`). Three things the reader should be able to check without reading code:
 * 1. every row carries a lucide icon (16px) — the current product sidebar has none;
 * 2. the active row shows a **2px left indicator bar** + tinted row (DEV-011 §10 rule);
 * 3. the content column stops at `max-w-[920px]` (the dashed edge marks the cap).
 */
const active = ref("rag");

function groups(): { label: string; count: string; items: NavItem[] }[] {
    return [
        { label: "域", count: "12", items: domains },
        { label: "实例运维", count: "2", items: opsItems },
        { label: "安全与权限", count: "3", items: securityItems },
        { label: "我的资源", count: "3", items: resourceItems },
    ];
}
</script>

<template>
    <SidebarProvider class="h-full min-h-0">
        <Sidebar collapsible="none" class="h-full">
            <SidebarHeader class="gap-3 border-b border-sidebar-border px-3 py-3">
                <div class="flex items-center gap-2">
                    <span class="text-sm font-semibold">设置</span>
                    <Badge variant="secondary" class="h-5 px-1.5 text-[10px]">实例层</Badge>
                </div>
                <button
                    type="button"
                    class="flex h-8 w-full items-center gap-2 rounded-md border border-sidebar-border bg-background px-2 text-xs text-muted-foreground"
                >
                    <Search class="size-3.5" aria-hidden="true" />
                    <span>搜索设置项</span>
                    <kbd
                        class="ml-auto rounded border border-border bg-muted px-1 font-mono text-[10px]"
                        >⌘K</kbd
                    >
                </button>
                <button
                    type="button"
                    class="flex h-8 w-full items-center gap-2 rounded-md px-2 text-xs font-medium hover:bg-sidebar-accent"
                >
                    <ChevronsUpDown class="size-3.5" aria-hidden="true" />
                    <span>切换层：实例 / 用户 / 工作区</span>
                </button>
            </SidebarHeader>

            <SidebarContent class="px-1">
                <template v-for="(group, gi) in groups()" :key="group.label">
                    <SidebarSeparator v-if="gi > 0" />
                    <SidebarGroup>
                        <SidebarGroupLabel class="gap-2 text-[11px] uppercase tracking-wide">
                            {{ group.label }}
                            <span class="font-mono text-[10px] text-muted-foreground">{{
                                group.count
                            }}</span>
                        </SidebarGroupLabel>
                        <SidebarGroupContent>
                            <SidebarMenu>
                                <SidebarMenuItem v-for="item in group.items" :key="item.id">
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
                                        <SidebarMenuBadge v-if="item.badge">
                                            {{ item.badge }}
                                        </SidebarMenuBadge>
                                    </SidebarMenuButton>
                                </SidebarMenuItem>
                            </SidebarMenu>
                        </SidebarGroupContent>
                    </SidebarGroup>
                </template>
            </SidebarContent>

            <SidebarFooter class="border-t border-sidebar-border p-2">
                <SidebarMenu>
                    <SidebarMenuItem>
                        <SidebarMenuButton size="sm">
                            <ArrowLeft class="size-4" />
                            <span>返回对话</span>
                        </SidebarMenuButton>
                    </SidebarMenuItem>
                </SidebarMenu>
            </SidebarFooter>
        </Sidebar>

        <SidebarInset class="h-full min-h-0 overflow-hidden bg-background">
            <div class="flex h-full min-h-0 flex-col">
                <div class="border-b border-border px-10 py-3">
                    <Breadcrumb>
                        <BreadcrumbList>
                            <BreadcrumbItem>
                                <BreadcrumbLink href="#">设置</BreadcrumbLink>
                            </BreadcrumbItem>
                            <BreadcrumbSeparator />
                            <BreadcrumbItem>
                                <BreadcrumbLink href="#">实例配置</BreadcrumbLink>
                            </BreadcrumbItem>
                            <BreadcrumbSeparator />
                            <BreadcrumbItem>
                                <BreadcrumbPage>RAG 检索</BreadcrumbPage>
                            </BreadcrumbItem>
                        </BreadcrumbList>
                    </Breadcrumb>
                </div>

                <div class="min-h-0 flex-1 overflow-hidden px-10 py-6">
                    <div class="relative max-w-[920px]">
                        <div class="flex items-baseline gap-3">
                            <h1 class="text-2xl font-semibold tracking-tight">RAG 检索</h1>
                            <Badge variant="outline">9 项配置</Badge>
                            <Badge variant="secondary">3 项被下层覆盖</Badge>
                        </div>
                        <p class="mt-2 text-sm leading-6 text-muted-foreground">
                            检索参数：分块、召回、重排与相似度阈值。数值越大召回越粗、调用越少。
                        </p>

                        <Alert class="mt-5">
                            <ShieldCheck class="size-4" />
                            <AlertTitle>继承自实例层</AlertTitle>
                            <AlertDescription>
                                <span class="font-mono">embeddingModel</span> 与
                                <span class="font-mono">indexerEndpoint</span>
                                由实例统一指定，本层只读（换模型会使既有索引失效）。
                            </AlertDescription>
                        </Alert>

                        <div class="mt-6 rounded-lg border border-border p-6">
                            <FieldGroup>
                                <FieldSet>
                                    <FieldLegend>分块与召回</FieldLegend>
                                    <FieldGroup>
                                        <Field>
                                            <FieldLabel for="chunk">分块大小</FieldLabel>
                                            <Input id="chunk" model-value="128k" class="h-9" />
                                            <FieldDescription
                                                >单文档切块上限；越大召回越粗、embedding
                                                调用越少</FieldDescription
                                            >
                                        </Field>
                                        <Field>
                                            <FieldLabel for="topk">召回条数</FieldLabel>
                                            <Input id="topk" model-value="8" class="h-9" />
                                            <FieldDescription
                                                >每次检索回填给模型的片段数</FieldDescription
                                            >
                                        </Field>
                                        <Field>
                                            <FieldLabel for="score">最低相关度</FieldLabel>
                                            <Input id="score" model-value="0.35" class="h-9" />
                                            <FieldDescription
                                                >低于该分数的片段直接丢弃</FieldDescription
                                            >
                                        </Field>
                                    </FieldGroup>
                                </FieldSet>
                            </FieldGroup>
                        </div>
                    </div>
                    <!-- 内容列宽上限的可视边界：920px -->
                    <div
                        class="pointer-events-none absolute inset-y-0 left-[1010px] top-0 w-px border-l border-dashed border-border"
                        aria-hidden="true"
                    />
                    <span
                        class="pointer-events-none absolute left-[1018px] top-0 font-mono text-[10px] text-muted-foreground"
                        >内容列上限 920px</span
                    >
                </div>
            </div>
        </SidebarInset>
    </SidebarProvider>
</template>
