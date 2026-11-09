<script setup lang="ts">
import { computed, ref } from "vue";
import { Bot, ChevronDown, Link2, Plus, ShieldCheck, Unlink } from "@lucide/vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { usePreviewCopy } from "./copy";
import { agentRows, type AgentRow, type WorkspaceRole } from "./mock";
import LayerHeader from "./LayerHeader.vue";

/**
 * Screen 3 — proposed workspace agent bindings (/workspace/:id/settings/agents), v2 (task-56).
 *
 * The permission column is **not** a new axis: it is the workspace role the binding grants, and
 * there are only two — WS_VIEWER (read) and WS_EDITOR (read/write/delete/exec), per
 * `V87__dynamic_access_roles.sql:131-134`; agents have gone through `role_bindings` since V108.
 * The help line deliberately says what 「读写」 does **not** include (network access, credential
 * use) — drawing those into WS_EDITOR would silently widen it to WS_OWNER.
 *
 * Columns: agent / source (instance vs my credentials) / workspace role / bind-unbind. The right
 * column carries the empty state with an actionable pointer, because the common failure is
 * "list is empty and the user does not know where agents come from".
 */
const copy = usePreviewCopy();
const rows = ref<AgentRow[]>(agentRows.map((row) => ({ ...row })));

const agentBindingLabel = computed(
    () => (copy.value.shell.navLabels as Record<string, string>).agents ?? "agents",
);

function roleLabel(role: WorkspaceRole) {
    return role === "viewer" ? copy.value.agents.roleViewer : copy.value.agents.roleEditor;
}

function toggle(row: AgentRow) {
    row.bound = !row.bound;
}
</script>

<template>
    <div class="preview-screen h-[860px] w-full overflow-hidden rounded-xl border bg-background">
        <div class="grid h-full grid-cols-[minmax(0,1fr)_360px]">
            <div class="min-h-0 overflow-y-auto">
                <LayerHeader
                    layer="workspace"
                    :domain="agentBindingLabel"
                    :summary="copy.agents.summary"
                >
                    <p class="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                        {{ copy.agents.roleHelp }}
                    </p>
                </LayerHeader>

                <div class="px-8 pt-4 pb-6">
                    <div class="flex items-baseline gap-2">
                        <h2
                            data-testid="settings-domain-title"
                            class="text-lg font-medium tracking-tight"
                        >
                            {{ agentBindingLabel }}
                        </h2>
                        <code class="font-mono text-[11px] text-muted-foreground">
                            /workspace/xihe-dev/settings/agents
                        </code>
                        <span
                            class="ml-auto max-w-[320px] text-right text-[10px] leading-relaxed text-muted-foreground"
                        >
                            {{ copy.agents.roleHint }}
                        </span>
                    </div>

                    <div class="mt-2 overflow-hidden rounded-md border border-border/70">
                        <div
                            data-testid="agents-table-head"
                            class="grid grid-cols-[minmax(0,1fr)_140px_170px_110px] items-center gap-3 border-b bg-muted/30 px-4 py-2 text-[11px] font-medium text-muted-foreground"
                        >
                            <span>{{ copy.agents.colName }}</span>
                            <span>{{ copy.agents.colSource }}</span>
                            <span>{{ copy.agents.colWsRole }}</span>
                            <span class="text-right">{{ copy.agents.colAction }}</span>
                        </div>
                        <div
                            v-for="row in rows"
                            :key="row.id"
                            data-testid="settings-entry-row"
                            class="grid min-h-[44px] grid-cols-[minmax(0,1fr)_140px_170px_110px] items-center gap-3 border-b px-4 py-2 last:border-b-0"
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
                                <p
                                    class="mt-0.5 truncate font-mono text-[11px] text-muted-foreground"
                                >
                                    {{ row.model }}
                                </p>
                            </div>
                            <div>
                                <Badge
                                    :variant="row.source === 'instance' ? 'outline' : 'secondary'"
                                    class="gap-1 text-[10px] font-normal"
                                >
                                    <ShieldCheck
                                        v-if="row.source === 'instance'"
                                        class="size-2.5"
                                    />
                                    <Link2 v-else class="size-2.5" />
                                    {{
                                        row.source === "instance"
                                            ? copy.agents.sourceInstance
                                            : copy.agents.sourceMine
                                    }}
                                </Badge>
                            </div>
                            <div class="flex items-center gap-1 text-[12px]">
                                <span>{{ roleLabel(row.wsRole) }}</span>
                                <ChevronDown
                                    class="size-3.5 text-muted-foreground"
                                    :class="row.wsRoleOptions.length < 2 ? 'opacity-40' : ''"
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

                    <p class="mt-3 text-[11px] text-muted-foreground">
                        {{ copy.agents.pendingHint }}
                    </p>

                    <div class="mt-auto pt-6">
                        <p class="mb-2 text-[11px] font-medium text-muted-foreground">
                            {{ copy.agents.notesTitle }}
                        </p>
                        <div class="grid grid-cols-3 gap-3">
                            <div class="rounded-md border border-border/70 bg-muted/20 p-3">
                                <p class="text-[12px] font-medium">
                                    {{ copy.agents.noteSourceTitle }}
                                </p>
                                <p class="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                                    {{ copy.agents.noteSourceBody }}
                                </p>
                            </div>
                            <div class="rounded-md border border-border/70 bg-muted/20 p-3">
                                <p class="text-[12px] font-medium">
                                    {{ copy.agents.noteRoleTitle }}
                                </p>
                                <p class="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                                    {{ copy.agents.noteRoleBody }}
                                </p>
                            </div>
                            <div class="rounded-md border border-border/70 bg-muted/20 p-3">
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
            </div>

            <aside
                class="flex min-h-0 flex-col gap-3 overflow-y-auto border-l bg-muted/10 px-5 py-4"
            >
                <Card class="gap-2 border-dashed bg-transparent py-4">
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
