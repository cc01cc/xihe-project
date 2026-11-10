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
} from "@/components/ui/sidebar";
import { domains, resourceItems } from "../data";

/**
 * One rail in a given folding state. Local refs (not props) so the toggle still works when the
 * reader clicks — the sheet is a live component tree, not a frozen snapshot.
 */
const props = defineProps<{ domainsOpen: boolean; resourcesOpen: boolean }>();

const domainsOpen = ref(props.domainsOpen);
const resourcesOpen = ref(props.resourcesOpen);
</script>

<template>
    <SidebarProvider class="w-[330px] shrink-0">
        <Sidebar collapsible="none" class="h-full w-[330px] rounded-lg border">
            <SidebarHeader class="border-b border-sidebar-border px-3 py-3">
                <span class="text-sm font-semibold">设置 · 实例层</span>
            </SidebarHeader>
            <SidebarContent class="px-1">
                <Collapsible v-model:open="domainsOpen">
                    <SidebarGroup>
                        <SidebarGroupLabel as-child>
                            <CollapsibleTrigger
                                class="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] uppercase tracking-wide hover:bg-sidebar-accent"
                            >
                                <ChevronRight
                                    class="size-3 transition-transform"
                                    :class="domainsOpen ? 'rotate-90' : ''"
                                />
                                <span>域</span>
                                <span class="font-mono text-[10px] text-muted-foreground">12</span>
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
                        </CollapsibleContent>
                    </SidebarGroup>
                </Collapsible>

                <Collapsible v-model:open="resourcesOpen">
                    <SidebarGroup>
                        <SidebarGroupLabel as-child>
                            <CollapsibleTrigger
                                class="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] uppercase tracking-wide hover:bg-sidebar-accent"
                            >
                                <ChevronRight
                                    class="size-3 transition-transform"
                                    :class="resourcesOpen ? 'rotate-90' : ''"
                                />
                                <span>我的资源</span>
                                <span class="font-mono text-[10px] text-muted-foreground">3</span>
                            </CollapsibleTrigger>
                        </SidebarGroupLabel>
                        <CollapsibleContent>
                            <SidebarGroupContent>
                                <SidebarMenu>
                                    <SidebarMenuItem v-for="item in resourceItems" :key="item.id">
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
            </SidebarContent>
        </Sidebar>
    </SidebarProvider>
</template>
