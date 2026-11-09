<script setup lang="ts">
import { ref } from "vue";
import { Bot, ChevronDown, Link2, Plus, ShieldCheck, Unlink } from "@lucide/vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { usePreviewCopy } from "./copy";
import { agentRows, type AgentRow, type AgentCap } from "./mock";

/**
 * Screen 3 — proposed workspace agent bindings (/workspace/:id/settings/agents).
 *
 * Columns: agent / source (instance vs my credentials) / permission cap (≤ the grant you hold) /
 * bind-unbind. The right column carries the empty state with an actionable pointer, because the
 * common failure is "list is empty and the user does not know where agents come from".
 */
const copy = usePreviewCopy();
const rows = ref<AgentRow[]>(agentRows.map((row) => ({ ...row })));

function capLabel(cap: AgentCap) {
    if (cap === "read") return copy.value.agents.capRead;
    if (cap === "write") return copy.value.agents.capWrite;
    return copy.value.agents.capAdmin;
}

function toggle(row: AgentRow) {
    row.bound = !row.bound;
}
</script>

<template>
    <div class="preview-screen h-[860px] w-full overflow-hidden rounded-xl border bg-background">
        <header class="flex items-start gap-6 border-b px-8 pt-5 pb-4">
            <div>
                <div class="flex items-center gap-2">
                    <h3 class="text-lg font-semibold tracking-tight">{{ copy.agents.title }}</h3>
                    <span
                        class="rounded border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                    >
                        /workspace/xihe-dev/settings/agents
                    </span>
                </div>
                <p class="mt-1 text-[13px] text-muted-foreground">{{ copy.agents.summary }}</p>
            </div>
            <p
                class="ml-auto max-w-[300px] text-right text-[11px] leading-relaxed text-muted-foreground"
            >
                {{ copy.agents.capHint }}
            </p>
        </header>

        <div class="grid grid-cols-[minmax(0,1fr)_360px] gap-0">
            <div class="flex min-h-0 flex-col px-8 py-4">
                <div class="overflow-hidden rounded-lg border">
                    <div
                        class="grid grid-cols-[minmax(0,1fr)_150px_150px_120px] items-center gap-3 border-b bg-muted/40 px-4 py-2 text-[11px] font-medium text-muted-foreground"
                    >
                        <span>{{ copy.agents.colName }}</span>
                        <span>{{ copy.agents.colSource }}</span>
                        <span>{{ copy.agents.colCap }}</span>
                        <span class="text-right">{{ copy.agents.colAction }}</span>
                    </div>
                    <div
                        v-for="row in rows"
                        :key="row.id"
                        class="grid grid-cols-[minmax(0,1fr)_150px_150px_120px] items-center gap-3 border-b px-4 py-3 last:border-b-0"
                    >
                        <div class="min-w-0">
                            <div class="flex items-center gap-2">
                                <Bot class="size-3.5 shrink-0 text-muted-foreground" />
                                <span class="truncate text-sm font-medium">{{ row.name }}</span>
                                <Badge
                                    v-if="row.bound"
                                    variant="secondary"
                                    class="shrink-0 text-[10px]"
                                >
                                    {{ copy.agents.bound }}
                                </Badge>
                            </div>
                            <p class="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                                {{ row.model }}
                            </p>
                        </div>
                        <div>
                            <Badge
                                :variant="row.source === 'instance' ? 'outline' : 'secondary'"
                                class="gap-1 text-[10px] font-normal"
                            >
                                <ShieldCheck v-if="row.source === 'instance'" class="size-2.5" />
                                <Link2 v-else class="size-2.5" />
                                {{
                                    row.source === "instance"
                                        ? copy.agents.sourceInstance
                                        : copy.agents.sourceMine
                                }}
                            </Badge>
                        </div>
                        <div class="flex items-center gap-1 text-[12px]">
                            <span>{{ capLabel(row.cap) }}</span>
                            <ChevronDown
                                class="size-3.5 text-muted-foreground"
                                :class="row.capOptions.length < 2 ? 'opacity-40' : ''"
                            />
                        </div>
                        <div class="text-right">
                            <Button
                                :variant="row.bound ? 'outline' : 'default'"
                                size="sm"
                                @click="toggle(row)"
                            >
                                <Unlink v-if="row.bound" class="size-3.5" />
                                <Plus v-else class="size-3.5" />
                                {{ row.bound ? copy.agents.unbind : copy.agents.bind }}
                            </Button>
                        </div>
                    </div>
                </div>

                <p class="mt-3 text-[11px] text-muted-foreground">{{ copy.agents.pendingHint }}</p>

                <div class="mt-auto pt-6">
                    <p class="mb-2 text-[11px] font-medium text-muted-foreground">
                        {{ copy.agents.notesTitle }}
                    </p>
                    <div class="grid grid-cols-3 gap-3">
                        <div class="rounded-lg border bg-card p-3">
                            <p class="text-[12px] font-medium">{{ copy.agents.noteSourceTitle }}</p>
                            <p class="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                                {{ copy.agents.noteSourceBody }}
                            </p>
                        </div>
                        <div class="rounded-lg border bg-card p-3">
                            <p class="text-[12px] font-medium">{{ copy.agents.noteCapTitle }}</p>
                            <p class="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                                {{ copy.agents.noteCapBody }}
                            </p>
                        </div>
                        <div class="rounded-lg border bg-card p-3">
                            <p class="flex items-center gap-1.5 text-[12px] font-medium">
                                <ShieldCheck class="size-3.5 text-muted-foreground" />
                                {{ copy.agents.noteDeniedTitle }}
                            </p>
                            <p class="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                                {{ copy.agents.noteDeniedBody }}
                            </p>
                        </div>
                    </div>
                </div>
            </div>

            <aside class="flex min-h-0 flex-col gap-3 border-l bg-muted/20 px-5 py-4">
                <Card class="gap-2 border-dashed bg-background py-4">
                    <CardHeader class="px-4 py-0">
                        <CardTitle class="text-sm">{{ copy.agents.emptyTitle }}</CardTitle>
                    </CardHeader>
                    <CardContent class="space-y-3 px-4 pt-1 text-[12px] text-muted-foreground">
                        <p class="leading-relaxed">{{ copy.agents.emptyBody }}</p>
                        <Button size="sm" class="w-full">
                            <Plus class="size-3.5" />{{ copy.agents.emptyCta }}
                        </Button>
                        <Separator />
                        <p class="text-[11px] leading-relaxed">{{ copy.agents.emptyNote }}</p>
                    </CardContent>
                </Card>
            </aside>
        </div>
    </div>
</template>
