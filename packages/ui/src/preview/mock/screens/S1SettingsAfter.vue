<script setup lang="ts">
import { ref } from "vue";
import { ArrowLeft, ChevronRight, Search, ShieldCheck } from "@lucide/vue";
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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
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
import { domains, modules, opsItems, securityItems, userItems } from "../data";

/**
 * Sheet 01 — settings shell after the switch to the vendored `Sidebar`.
 *
 * Everything below is a real vendored component; the only page-local thing is the active-item
 * state (`active`). Four things the reader should be able to check without reading code:
 * 1. the **global rail stays resident** at 56px on the settings page too (it was missing in the
 *    first cut — the user caught that, 2026-11-10);
 * 2. there is **no layer switcher**: the layer comes from the URL (`/settings/instance/**`), and the
 *    rail only groups entries by layer;
 * 3. 「实例」「用户」are **collapsible groups** (`Collapsible`, already vendored). The current layer
 *    is open by default; the other one can be opened to look, and its rows are links that navigate
 *    to that layer's route;
 * 4. every row carries a lucide icon (16px) and the active row shows a **2px left indicator bar** +
 *    tinted row (DEV-011 §10) instead of a full-row fill.
 *
 * 全局设置只有两层：工作区设置在各工作区内部（本轮不设计），所以左栏不出现「工作区层」。
 */
const active = ref("rag");

/** URL 决定层：这是 `/settings/instance/rag`，所以实例组默认展开、用户组默认收起。 */
const instanceOpen = ref(true);
const userOpen = ref(false);
/** `SidebarProvider` 只对可写状态反映 one-way `:open`，所以折叠态用 `v-model` 驱动。 */
const railOpen = ref(false);

function instanceTotal(): number {
    return domains.length + opsItems.length + securityItems.length;
}
function userTotal(): number {
    return userItems.length;
}
</script>

<template>
    <div class="flex h-full min-h-0">
        <!-- 全局 rail：所有页面常驻，设置态高亮。折叠 56px（覆盖 --sidebar-width-icon = 3.5rem；
             shadcn 默认 3rem = 48px，不采用，见 S4 注释与 DEV-010 §10）。 -->
        <SidebarProvider
            v-model:open="railOpen"
            class="h-full min-h-0 w-14 shrink-0"
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
                                    >Z</span
                                >
                            </SidebarMenuButton>
                        </SidebarMenuItem>
                    </SidebarMenu>
                </SidebarFooter>
            </Sidebar>
        </SidebarProvider>

        <SidebarProvider class="min-w-0 flex-1">
            <Sidebar collapsible="none" class="h-full">
                <SidebarHeader class="gap-3 border-b border-sidebar-border px-3 py-3">
                    <div class="flex items-center gap-2">
                        <span class="text-sm font-semibold">设置</span>
                        <Badge variant="secondary" class="h-5 px-1.5 text-[10px]">实例层</Badge>
                        <span class="ml-auto font-mono text-[10px] text-muted-foreground"
                            >/settings/instance</span
                        >
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
                </SidebarHeader>

                <SidebarContent class="px-1">
                    <!-- 组 1：实例层（当前层，默认展开） -->
                    <Collapsible v-model:open="instanceOpen">
                        <SidebarGroup>
                            <SidebarGroupLabel as-child>
                                <CollapsibleTrigger
                                    class="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] uppercase tracking-wide hover:bg-sidebar-accent"
                                >
                                    <ChevronRight
                                        class="size-3 transition-transform"
                                        :class="instanceOpen ? 'rotate-90' : ''"
                                        aria-hidden="true"
                                    />
                                    <span>实例</span>
                                    <span class="font-mono text-[10px] text-muted-foreground">{{
                                        instanceTotal()
                                    }}</span>
                                    <span
                                        class="ml-auto text-[10px] normal-case text-muted-foreground"
                                        >当前层</span
                                    >
                                </CollapsibleTrigger>
                            </SidebarGroupLabel>
                            <CollapsibleContent>
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
                                                <component
                                                    :is="item.icon"
                                                    class="size-4 shrink-0"
                                                />
                                                <span class="truncate">{{ item.label }}</span>
                                                <SidebarMenuBadge v-if="item.badge">
                                                    {{ item.badge }}
                                                </SidebarMenuBadge>
                                            </SidebarMenuButton>
                                        </SidebarMenuItem>
                                    </SidebarMenu>
                                </SidebarGroupContent>

                                <SidebarSeparator class="my-1" />
                                <p
                                    class="px-2 pb-1 text-[10px] uppercase tracking-wide text-muted-foreground"
                                >
                                    实例运维 <span class="font-mono">2</span>
                                </p>
                                <SidebarGroupContent>
                                    <SidebarMenu>
                                        <SidebarMenuItem v-for="item in opsItems" :key="item.id">
                                            <SidebarMenuButton class="h-8">
                                                <component
                                                    :is="item.icon"
                                                    class="size-4 shrink-0"
                                                />
                                                <span class="truncate">{{ item.label }}</span>
                                            </SidebarMenuButton>
                                        </SidebarMenuItem>
                                    </SidebarMenu>
                                </SidebarGroupContent>

                                <SidebarSeparator class="my-1" />
                                <p
                                    class="px-2 pb-1 text-[10px] uppercase tracking-wide text-muted-foreground"
                                >
                                    安全与权限 <span class="font-mono">3</span>
                                </p>
                                <SidebarGroupContent>
                                    <SidebarMenu>
                                        <SidebarMenuItem
                                            v-for="item in securityItems"
                                            :key="item.id"
                                        >
                                            <SidebarMenuButton class="h-8">
                                                <component
                                                    :is="item.icon"
                                                    class="size-4 shrink-0"
                                                />
                                                <span class="truncate">{{ item.label }}</span>
                                            </SidebarMenuButton>
                                        </SidebarMenuItem>
                                    </SidebarMenu>
                                </SidebarGroupContent>
                            </CollapsibleContent>
                        </SidebarGroup>
                    </Collapsible>

                    <!-- 组 2：用户层（非当前层，默认收起；展开是「看一眼」，点条目跳该层路由） -->
                    <Collapsible v-model:open="userOpen">
                        <SidebarGroup>
                            <SidebarGroupLabel as-child>
                                <CollapsibleTrigger
                                    class="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] uppercase tracking-wide hover:bg-sidebar-accent"
                                >
                                    <ChevronRight
                                        class="size-3 transition-transform"
                                        :class="userOpen ? 'rotate-90' : ''"
                                        aria-hidden="true"
                                    />
                                    <span>用户</span>
                                    <span class="font-mono text-[10px] text-muted-foreground">{{
                                        userTotal()
                                    }}</span>
                                </CollapsibleTrigger>
                            </SidebarGroupLabel>
                            <CollapsibleContent>
                                <SidebarGroupContent>
                                    <SidebarMenu>
                                        <SidebarMenuItem
                                            v-for="item in userItems"
                                            :key="'user-' + item.id"
                                        >
                                            <SidebarMenuButton
                                                class="h-8"
                                                :href="'/settings/user/' + item.id"
                                            >
                                                <component
                                                    :is="item.icon"
                                                    class="size-4 shrink-0"
                                                />
                                                <span class="truncate">{{ item.label }}</span>
                                                <SidebarMenuBadge v-if="item.badge">
                                                    {{ item.badge }}
                                                </SidebarMenuBadge>
                                            </SidebarMenuButton>
                                        </SidebarMenuItem>
                                    </SidebarMenu>
                                    <p
                                        class="px-2 pt-1 text-[10px] leading-4 text-muted-foreground"
                                    >
                                        点条目跳
                                        /settings/user/*：偏好设置在此层是「我自己的偏好」，
                                        实例层同名域是默认值。
                                    </p>
                                </SidebarGroupContent>
                            </CollapsibleContent>
                        </SidebarGroup>
                    </Collapsible>
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
    </div>
</template>
