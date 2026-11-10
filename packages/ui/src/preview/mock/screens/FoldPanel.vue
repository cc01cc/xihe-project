<script setup lang="ts">
import { ref } from "vue";
import { ChevronRight } from "@lucide/vue";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
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
import { domains, opsItems, securityItems, userItems } from "../data";

/**
 * One rail in a given folding state. Local refs (not props) so the toggle still works when the
 * reader clicks — the sheet is a live component tree, not a frozen snapshot.
 *
 * 折叠的粒度是**层**，不是「域 / 我的资源」那种功能分块：用户 2026-11-10 指出「切换层」是错的
 * 交互，层由路由决定，所以左栏只剩折叠可见性这一件事可调。
 */
const props = defineProps<{ instanceOpen: boolean; userOpen: boolean }>();

const instanceOpen = ref(props.instanceOpen);
const userOpen = ref(props.userOpen);

function instanceTotal(): number {
    return domains.length + opsItems.length + securityItems.length;
}
</script>

<template>
    <SidebarProvider class="w-[330px] shrink-0">
        <Sidebar collapsible="none" class="h-full w-[330px] rounded-lg border">
            <SidebarHeader class="border-b border-sidebar-border px-3 py-3">
                <div class="flex items-center gap-2">
                    <span class="mk-body font-semibold">设置</span>
                    <span class="font-mono mk-caption text-muted-foreground"
                        >/settings/instance</span
                    >
                </div>
            </SidebarHeader>
            <SidebarContent class="px-1">
                <Collapsible v-model:open="instanceOpen">
                    <SidebarGroup>
                        <SidebarGroupLabel as-child>
                            <CollapsibleTrigger
                                class="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 mk-caption uppercase tracking-wide hover:bg-sidebar-accent"
                            >
                                <ChevronRight
                                    class="size-3 transition-transform"
                                    :class="instanceOpen ? 'rotate-90' : ''"
                                    aria-hidden="true"
                                />
                                <span>实例</span>
                                <span class="font-mono mk-caption text-muted-foreground">{{
                                    instanceTotal()
                                }}</span>
                                <span class="ml-auto mk-caption normal-case text-muted-foreground"
                                    >当前层</span
                                >
                            </CollapsibleTrigger>
                        </SidebarGroupLabel>
                        <CollapsibleContent>
                            <SidebarGroupContent>
                                <SidebarMenu>
                                    <SidebarMenuItem v-for="item in domains" :key="item.id">
                                        <SidebarMenuButton
                                            :is-active="item.id === 'rag'"
                                            class="relative h-8"
                                        >
                                            <span
                                                v-if="item.id === 'rag'"
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

                            <SidebarSeparator class="my-1" />
                            <p
                                class="px-2 pb-1 mk-caption uppercase tracking-wide text-muted-foreground"
                            >
                                实例运维 <span class="font-mono">2</span>
                            </p>
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

                            <SidebarSeparator class="my-1" />
                            <p
                                class="px-2 pb-1 mk-caption uppercase tracking-wide text-muted-foreground"
                            >
                                安全与权限 <span class="font-mono">3</span>
                            </p>
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
                        </CollapsibleContent>
                    </SidebarGroup>
                </Collapsible>

                <Collapsible v-model:open="userOpen">
                    <SidebarGroup>
                        <SidebarGroupLabel as-child>
                            <CollapsibleTrigger
                                class="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 mk-caption uppercase tracking-wide hover:bg-sidebar-accent"
                            >
                                <ChevronRight
                                    class="size-3 transition-transform"
                                    :class="userOpen ? 'rotate-90' : ''"
                                    aria-hidden="true"
                                />
                                <span>用户</span>
                                <span class="font-mono mk-caption text-muted-foreground">{{
                                    userItems.length
                                }}</span>
                            </CollapsibleTrigger>
                        </SidebarGroupLabel>
                        <CollapsibleContent>
                            <SidebarGroupContent>
                                <SidebarMenu>
                                    <SidebarMenuItem v-for="item in userItems" :key="item.id">
                                        <SidebarMenuButton
                                            class="h-8"
                                            :href="'/settings/user/' + item.id"
                                        >
                                            <component :is="item.icon" class="size-4 shrink-0" />
                                            <span class="truncate">{{ item.label }}</span>
                                            <SidebarMenuBadge v-if="item.badge">{{
                                                item.badge
                                            }}</SidebarMenuBadge>
                                        </SidebarMenuButton>
                                    </SidebarMenuItem>
                                </SidebarMenu>
                            </SidebarGroupContent>
                        </CollapsibleContent>
                    </SidebarGroup>
                </Collapsible>
            </SidebarContent>
        </Sidebar>
    </SidebarProvider>
</template>
