<script setup lang="ts">
import { computed, ref } from "vue";
import { Archive, BookOpen, Brain, Clock, Pin, PinOff, Plus, Sparkles } from "@lucide/vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import SectionShell from "../SectionShell.vue";
import { mockMemories } from "../mockData";

/**
 * Memory panel target shape. Row fields are the real `WorkspaceAgentMemoryView` set
 * (`type` / `pinned` / `updatedAt` / `content`) — the current DTO has no `source` column,
 * so the "来源" slot renders `type` (profile / fact) instead of inventing a field.
 */
const enabled = ref(true);
const showArchived = ref(false);
const archived = ref(1);

const visible = computed(() => mockMemories);
const pinnedCount = computed(() => visible.value.filter((row) => row.pinned).length);

const relative = (iso: string) => {
    const then = new Date(iso).getTime();
    const hours = Math.max(1, Math.round((Date.now() - then) / 3_600_000));
    return hours < 24 ? `${hours} 小时前` : `${Math.round(hours / 24)} 天前`;
};
</script>

<template>
    <SectionShell
        id="memory-panel"
        index="04"
        title="记忆面板"
        description="启用记忆的 Switch、条目列表（置顶 / 时间 / 类型）、「＋ 新增记忆」、归档与「显示已归档」，以及未启用与空态两种 CTA。字段取自 WorkspaceAgentMemoryView，UI 不重排、不补默认值。"
    >
        <div class="grid grid-cols-[1.35fr_1fr] gap-6">
            <Card class="flex h-[700px] flex-col overflow-hidden">
                <CardHeader class="border-b border-border/70">
                    <CardTitle class="flex items-center gap-2">
                        <Brain class="size-4 text-muted-foreground" />
                        记忆
                        <Badge variant="secondary">{{ visible.length }} 条</Badge>
                        <Badge variant="outline">{{ pinnedCount }} 条置顶</Badge>
                    </CardTitle>
                    <CardAction class="flex items-center gap-2">
                        <span class="text-xs text-muted-foreground">启用记忆</span>
                        <Switch v-model="enabled" />
                    </CardAction>
                </CardHeader>

                <CardContent class="min-h-0 flex-1 space-y-2 overflow-y-auto py-4">
                    <div
                        v-for="memory in visible"
                        :key="memory.id"
                        class="rounded-lg border border-border p-3"
                        :class="memory.pinned && 'bg-muted/30'"
                    >
                        <div class="flex items-center gap-2">
                            <Pin
                                v-if="memory.pinned"
                                class="size-3.5 text-muted-foreground"
                                aria-label="已置顶"
                            />
                            <PinOff v-else class="size-3.5 text-muted-foreground/50" />
                            <Badge
                                v-if="memory.origin"
                                variant="outline"
                                class="font-mono text-[10px]"
                            >
                                {{ memory.origin === "manual" ? "manual · 手动" : "run · 运行" }}
                            </Badge>
                            <span
                                class="ml-auto flex items-center gap-1 text-xs text-muted-foreground"
                            >
                                <Clock class="size-3" />
                                {{ relative(memory.updatedAt) }}
                            </span>
                        </div>
                        <p class="mt-1.5 text-sm leading-relaxed">{{ memory.content }}</p>
                        <div class="mt-2 flex items-center gap-1">
                            <Button variant="ghost" size="sm" class="h-7 px-2 text-xs">
                                {{ memory.pinned ? "取消置顶" : "置顶" }}
                            </Button>
                            <Button variant="ghost" size="sm" class="h-7 px-2 text-xs">
                                <Archive class="size-3.5" />
                                归档
                            </Button>
                        </div>
                    </div>

                    <div
                        v-if="!visible.length"
                        class="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border py-12 text-center"
                    >
                        <Sparkles class="size-6 text-muted-foreground" />
                        <p class="text-sm font-medium">还没有记忆</p>
                        <p class="max-w-sm text-xs text-muted-foreground">
                            记忆由 CP 在会话中沉淀；也可以手动补一条长期有效的偏好。
                        </p>
                        <Button size="sm" class="mt-1">
                            <Plus class="size-3.5" />
                            新增第一条记忆
                        </Button>
                    </div>
                </CardContent>

                <div class="flex items-center gap-2 border-t border-border/70 px-4 py-2.5">
                    <Button variant="outline" size="sm">
                        <Plus class="size-3.5" />
                        新增记忆
                    </Button>
                    <Button variant="ghost" size="sm">
                        <Archive class="size-3.5" />
                        归档（{{ archived }}）
                    </Button>
                    <label class="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Switch
                            :model-value="showArchived"
                            @update:model-value="(value) => (showArchived = value === true)"
                        />
                        显示已归档
                    </label>
                </div>
            </Card>

            <div class="space-y-4">
                <Card>
                    <CardHeader>
                        <CardTitle class="flex items-center gap-2 text-sm">
                            <BookOpen class="size-4 text-muted-foreground" />
                            未启用记忆
                        </CardTitle>
                    </CardHeader>
                    <CardContent class="space-y-2">
                        <div class="flex items-center gap-2 rounded-md border border-border p-2.5">
                            <span class="text-sm text-muted-foreground">启用记忆</span>
                            <Switch class="ml-auto" :model-value="false" />
                        </div>
                        <p class="text-xs leading-relaxed text-muted-foreground">
                            关闭后不再写入新记忆，已有条目保留；面板显示空态 CTA，而不是隐藏入口。
                        </p>
                        <Button size="sm" class="w-full">
                            <Sparkles class="size-3.5" />
                            启用记忆并开始沉淀
                        </Button>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <CardTitle class="text-sm">加载 / 错误</CardTitle>
                    </CardHeader>
                    <CardContent class="space-y-2 text-xs text-muted-foreground">
                        <div
                            class="flex items-center gap-2 rounded-md border border-border p-2.5 text-sm text-foreground"
                        >
                            <span class="size-3.5 animate-pulse rounded-full bg-muted" />
                            正在加载记忆…
                        </div>
                        <div
                            class="flex items-center justify-between rounded-md border border-border p-2.5"
                        >
                            <span>读取失败（可重试）</span>
                            <Button variant="outline" size="sm" class="h-7">重试</Button>
                        </div>
                    </CardContent>
                </Card>
            </div>
        </div>
    </SectionShell>
</template>
