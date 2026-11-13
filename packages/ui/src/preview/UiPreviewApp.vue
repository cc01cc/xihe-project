<script setup lang="ts">
import { computed } from "vue";
import { useWindowSize } from "@vueuse/core";
import { Moon, PanelRight, Sun } from "@lucide/vue";
import { Badge } from "@/components/ui/badge";
import AccessSection from "./sections/AccessSection.vue";
import AgentPanelSection from "./sections/AgentPanelSection.vue";
import ConfigSection from "./sections/ConfigSection.vue";
import MemoryPanelSection from "./sections/MemoryPanelSection.vue";
import MessagesSection from "./sections/MessagesSection.vue";
import ModalOverlaySection from "./sections/ModalOverlaySection.vue";
import ProviderFingerprintSection from "./sections/ProviderFingerprintSection.vue";
import StatesSection from "./sections/StatesSection.vue";
import WorkbenchSection from "./sections/WorkbenchSection.vue";
import MonitorPanelSection from "./sections/MonitorPanelSection.vue";
import TreeCapabilitiesSection from "./sections/TreeCapabilitiesSection.vue";

/**
 * Dev-only preview shell (`preview.html`): a sticky block index plus the anchored blocks. It is
 * **not** part of the product router and is not a build entry — Vite only builds `index.html`, so
 * this page cannot ship in a production bundle.
 */
const blocks = [
    { id: "workbench", index: "01", label: "工作台主面板" },
    { id: "messages", index: "02", label: "消息与工具卡" },
    { id: "agent-panel", index: "03", label: "智能体面板" },
    { id: "memory-panel", index: "04", label: "记忆面板" },
    { id: "config", index: "05", label: "配置页" },
    { id: "access", index: "06", label: "凭据 / 角色绑定" },
    { id: "states", index: "07", label: "四态样张" },
    { id: "provider-fingerprint", index: "08", label: "Provider 请求指纹" },
    { id: "modal-overlay", index: "09", label: "Modal 内 Popover" },
    { id: "tree-capabilities", index: "10", label: "reka-ui 树能力（M0-4）" },
];

const { width } = useWindowSize();
/** Mirrors `useWorkspaceLayout.deriveDockMode` (>=1800 pins the dock). */
const dockMode = computed(() => (width.value >= 1800 ? "pinned" : "floating"));
</script>

<template>
    <div class="min-h-screen bg-background text-foreground">
        <header class="sticky top-0 z-30 border-b border-border bg-background/95 backdrop-blur">
            <div class="mx-auto flex w-[1840px] max-w-full items-center gap-4 px-10 py-3">
                <div class="flex items-center gap-2">
                    <span class="text-sm font-semibold tracking-tight">xihe · UI preview</span>
                    <Badge variant="secondary">真实组件 + mock 数据</Badge>
                </div>
                <nav class="flex flex-wrap items-center gap-1 text-xs">
                    <a
                        v-for="block in blocks"
                        :key="block.id"
                        :href="'#' + block.id"
                        class="rounded-md px-2 py-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                        <span class="mr-1 font-mono text-xs">{{ block.index }}</span>
                        {{ block.label }}
                    </a>
                </nav>
                <div class="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                    <span class="font-mono">{{ width }}×{{ 1080 }}</span>
                    <Badge variant="outline" class="gap-1">
                        <PanelRight class="size-3" />
                        dock {{ dockMode }}
                    </Badge>
                    <Badge variant="outline" class="gap-1">
                        <Sun class="size-3" />
                        light
                    </Badge>
                    <Moon class="size-3" />
                </div>
            </div>
        </header>

        <main class="mx-auto w-[1840px] max-w-full space-y-14 px-10 pb-24 pt-8">
            <p class="max-w-4xl text-sm leading-relaxed text-muted-foreground">
                本页是**开发期预览**：全部数据为 mock，不请求
                <code class="font-mono">/api/v1/**</code>。 区块按锚点独立可截；桌面断点 ≥1800
                时工作区为 pinned dock（导航 280 / 文件树 240 / dock 360 与主列并排），&lt;1800 时
                dock 改为浮层覆盖。
            </p>

            <WorkbenchSection />
            <MessagesSection />
            <AgentPanelSection />
            <MemoryPanelSection />
            <ConfigSection />
            <AccessSection />
            <StatesSection />
            <ProviderFingerprintSection />
            <ModalOverlaySection />
            <MonitorPanelSection />
            <TreeCapabilitiesSection />
        </main>
    </div>
</template>
