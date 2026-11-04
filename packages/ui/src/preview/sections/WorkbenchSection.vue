<script setup lang="ts">
import { computed } from "vue";
import { useWindowSize } from "@vueuse/core";
import {
    Bot,
    Boxes,
    FileText,
    Folder,
    FolderTree,
    GitBranch,
    LayoutGrid,
    MessageSquarePlus,
    PanelLeftClose,
    Plus,
    Search,
    Settings,
    Sparkles,
    Terminal,
    Users,
} from "@lucide/vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import InputArea from "@/features/workspace/chat/components/InputArea.vue";
import MessageItem from "@/features/workspace/chat/components/MessageItem.vue";
import SessionItem from "@/features/workspace/chat/components/SessionItem.vue";
import SectionShell from "../SectionShell.vue";
import { PREVIEW_SESSION_ID, mockConversation, mockSessions } from "../mockData";

/**
 * Pinned dock shape (viewport ≥1800 ⇒ `deriveDockMode()` returns `pinned`): the dock is a
 * flex sibling that takes 360px, the file tree keeps its 240px column and the primary
 * column yields. Nothing here is absolutely positioned — that is the `floating` mode the
 * 1440 check renders.
 */
const treeRows = [
    { name: "src", depth: 0, kind: "dir" as const },
    { name: "preview", depth: 1, kind: "dir" as const },
    { name: "main.ts", depth: 2, kind: "file" as const },
    { name: "mockData.ts", depth: 2, kind: "file" as const },
    { name: "checkpoint.rs", depth: 1, kind: "file" as const },
    { name: "AGENTS.md", depth: 0, kind: "file" as const },
];

const railItems = [
    { icon: LayoutGrid, label: "工作区", active: true },
    { icon: GitBranch, label: "分支" },
    { icon: Boxes, label: "智能体" },
    { icon: Sparkles, label: "记忆" },
    { icon: Terminal, label: "任务" },
];

const { width } = useWindowSize();
/** Same breakpoint as `useWorkspaceLayout.deriveDockMode`: >=1800 pins the dock. */
const pinned = computed(() => width.value >= 1800);

const memorySwitch = { enabled: true };
const send = () => {};
const stop = () => {};
</script>

<template>
    <SectionShell
        id="workbench"
        index="01"
        title="工作台主面板"
        description="真实组件装配：会话项（SessionItem）、消息（MessageItem）、工具卡（ToolCallCard）与输入区（InputArea）。输入区含「发送」栏（输入 + 候选浮层，单选）、「抄送」chips（输入 + 候选浮层，多选，点 × 移除）；模型选择已按 2026-11-04 裁定从 composer 移除（模型由主体/连接配置决定）。视口 ≥1800 为 pinned dock（导航 280 + 文件树 240 + 主列 + dock 360 并排）；<1800 自动转 floating 覆盖（见右下 1440 样张）。"
    >
        <div class="overflow-hidden rounded-xl border border-border bg-background shadow-sm">
            <div class="relative flex h-[820px] min-h-0">
                <!-- icon rail -->
                <aside
                    class="flex w-14 shrink-0 flex-col items-center gap-1 border-r border-border bg-muted/30 py-3"
                >
                    <div
                        class="mb-2 flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground"
                    >
                        <Sparkles class="size-4" />
                    </div>
                    <button
                        v-for="item in railItems"
                        :key="item.label"
                        type="button"
                        class="flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        :class="item.active && 'bg-muted text-foreground'"
                        :title="item.label"
                    >
                        <component :is="item.icon" class="size-4" />
                    </button>
                    <div class="mt-auto flex flex-col items-center gap-1">
                        <button
                            type="button"
                            class="flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
                            title="设置"
                        >
                            <Settings class="size-4" />
                        </button>
                    </div>
                </aside>

                <!-- navigation panel (280) -->
                <aside class="flex w-[280px] shrink-0 flex-col border-r border-border">
                    <header class="flex items-center justify-between px-3 py-3">
                        <div class="flex items-center gap-2">
                            <PanelLeftClose class="size-4 text-muted-foreground" />
                            <span class="text-sm font-medium">会话</span>
                        </div>
                        <Button variant="ghost" size="icon" class="size-7" title="新建会话">
                            <Plus class="size-4" />
                        </Button>
                    </header>
                    <div class="px-2 pb-2">
                        <div
                            class="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-2 py-1.5 text-xs text-muted-foreground"
                        >
                            <Search class="size-3.5" />
                            <span>搜索会话</span>
                            <span class="ml-auto font-mono text-[10px]">⌘K</span>
                        </div>
                    </div>
                    <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
                        <SessionItem
                            v-for="(session, i) in mockSessions"
                            :key="session.id"
                            :session="session"
                            :is-active="i === 0"
                            :pending-count="i === 0 ? 0 : i"
                        />
                    </div>
                    <div class="border-t border-border px-3 py-2 text-xs text-muted-foreground">
                        <div class="flex items-center gap-2">
                            <Users class="size-3.5" />
                            <span>4 位参与者</span>
                            <Badge variant="secondary" class="ml-auto">workspace</Badge>
                        </div>
                    </div>
                </aside>

                <!-- primary column -->
                <main class="flex min-w-0 flex-1 flex-col">
                    <header
                        class="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4"
                    >
                        <MessageSquarePlus class="size-4 text-muted-foreground" />
                        <h3 class="truncate text-sm font-medium">{{ mockSessions[0]?.title }}</h3>
                        <Badge variant="outline" class="ml-1">主根 1 · 附加根 1</Badge>
                        <div
                            class="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground"
                        >
                            <Bot class="size-3.5" />
                            <span>Atlas</span>
                            <span class="text-border">·</span>
                            <span>claude-sonnet-4.5</span>
                        </div>
                    </header>

                    <div class="min-h-0 flex-1 space-y-6 overflow-y-auto px-6 py-5">
                        <MessageItem
                            v-for="message in mockConversation"
                            :key="message.id"
                            :message="message"
                        />
                    </div>

                    <div class="shrink-0 border-t border-border p-3">
                        <InputArea
                            :session-id="PREVIEW_SESSION_ID"
                            :is-streaming="false"
                            :queue-mode="false"
                            @send="send"
                            @stop="stop"
                        />
                    </div>
                </main>

                <!-- file tree (240) -->
                <aside class="flex w-[240px] shrink-0 flex-col border-l border-border">
                    <header class="flex items-center gap-2 px-3 py-3">
                        <FolderTree class="size-4 text-muted-foreground" />
                        <span class="text-sm font-medium">文件</span>
                    </header>
                    <div class="min-h-0 flex-1 overflow-y-auto px-1 pb-2 text-sm">
                        <div
                            v-for="row in treeRows"
                            :key="row.name"
                            class="flex items-center gap-1.5 rounded px-2 py-1 text-muted-foreground hover:bg-muted"
                            :style="{ paddingLeft: 8 + row.depth * 12 + 'px' }"
                        >
                            <Folder v-if="row.kind === 'dir'" class="size-3.5" />
                            <FileText v-else class="size-3.5" />
                            <span class="truncate">{{ row.name }}</span>
                        </div>
                    </div>
                </aside>

                <!-- dock (360, pinned) -->
                <aside
                    v-if="pinned"
                    class="flex w-[360px] shrink-0 flex-col gap-3 border-l border-border p-3"
                >
                    <div class="rounded-lg border border-border p-3">
                        <div class="mb-2 flex items-center gap-2">
                            <Bot class="size-4 text-muted-foreground" />
                            <span class="text-sm font-medium">智能体</span>
                            <Badge variant="secondary" class="ml-auto">3 位</Badge>
                        </div>
                        <div class="space-y-1.5 text-xs">
                            <div class="flex items-center justify-between">
                                <span class="font-medium text-foreground">Atlas · 架构</span>
                                <Badge variant="outline">PRIMARY</Badge>
                            </div>
                            <div class="flex items-center justify-between text-muted-foreground">
                                <span>Nova · 实现</span>
                                <Badge variant="outline">MEMBER</Badge>
                            </div>
                            <div class="flex items-center justify-between text-muted-foreground">
                                <span>Scribe · 归档</span>
                                <Badge variant="secondary">已停用</Badge>
                            </div>
                        </div>
                    </div>

                    <div class="rounded-lg border border-border p-3">
                        <div class="mb-2 flex items-center gap-2">
                            <Sparkles class="size-4 text-muted-foreground" />
                            <span class="text-sm font-medium">记忆</span>
                            <Switch :model-value="memorySwitch.enabled" class="ml-auto" />
                        </div>
                        <p class="text-xs leading-relaxed text-muted-foreground">
                            已启用 · 3 条（1 条置顶）。新记忆由 CP 写入，UI 只展示。
                        </p>
                    </div>

                    <div class="mt-auto rounded-lg bg-muted/40 p-3 text-xs text-muted-foreground">
                        <div class="flex items-center gap-1.5">
                            <FileText class="size-3.5" />
                            <span class="font-mono">run_checkpoints: 2 rows / run</span>
                        </div>
                        <div class="mt-1 flex items-center gap-1.5">
                            <Folder class="size-3.5" />
                            <span class="font-mono">.xihe-shadow/*.git × 2</span>
                        </div>
                    </div>
                </aside>

                <!-- dock (360, floating): overlay on the primary column, no modal scrim -->
                <aside
                    v-else
                    class="absolute inset-y-0 right-0 z-20 flex w-[360px] flex-col gap-3 border-l border-border bg-background p-3 shadow-xl"
                >
                    <div class="flex items-center gap-2 text-xs text-muted-foreground">
                        <span class="font-medium text-foreground">浮层 dock</span>
                        <span>视口 {{ width }} &lt; 1800 ⇒ floating（Esc 或点主列关闭）</span>
                    </div>
                    <div class="rounded-lg border border-border p-3">
                        <div class="mb-2 flex items-center gap-2">
                            <Sparkles class="size-4 text-muted-foreground" />
                            <span class="text-sm font-medium">记忆</span>
                            <Switch :model-value="memorySwitch.enabled" class="ml-auto" />
                        </div>
                        <p class="text-xs leading-relaxed text-muted-foreground">
                            浮层态不复用 pinned 的卡片内容，只占主列右侧 360px，不遮导航与文件树。
                        </p>
                    </div>
                </aside>
            </div>
        </div>
    </SectionShell>
</template>
