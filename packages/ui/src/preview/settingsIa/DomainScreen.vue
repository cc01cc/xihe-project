<script setup lang="ts">
import { computed, ref } from "vue";
import { ArrowUpRight, ChevronDown, Link2, Lock, Save, Undo2 } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { usePreviewCopy } from "./copy";
import { domainRows, type ConfigKeyRow, type LayerValue } from "./mock";
import LayerBadge from "./LayerBadge.vue";
import LayerHeader from "./LayerHeader.vue";

/**
 * Screen 2 — proposed domain page (rag), v2 (task-56, PLAN-0752 §5.2).
 *
 * Hierarchy is measured, not asserted: the sticky layer title is 24px (largest), the domain
 * heading right below it is 18px (strictly smaller), and every entry row is ≥ 44px tall at 14px.
 * The breadcrumb ends with 检索增强（RAG） carrying `aria-current="page"`.
 *
 * Every row shows its **effective layer** on the right; overridden keys render the inheritance
 * chain underneath (instance 64k / user 96k) and that line is a **jump link**: clicking it
 * highlights the same key at the referenced layer (the highlight is what the screenshot must
 * show — otherwise the "clickable chain" claim is unverifiable).
 *
 * Locked rows use two visually distinct badges: instance lock (lock icon, muted) vs env lock
 * (terminal icon + mono chip) — PLAN-0556 requires them not to look the same.
 */
const copy = usePreviewCopy();
const highlighted = ref<{ key: string; layer: ConfigKeyRow["layer"] | "env" } | null>(null);

const ragLabel = computed(
    () => (copy.value.shell.domainLabels as Record<string, string>).rag ?? "rag",
);

const located = computed(() => {
    if (!highlighted.value) return "";
    const row = domainRows.find((r) => r.key === highlighted.value?.key);
    const layerName = layerLabel(highlighted.value.layer);
    return copy.value.domain.located
        .replace("{key}", row?.key ?? "")
        .replace("{layer}", layerName)
        .replace("{value}", shortValue(row, highlighted.value.layer));
});

/** 继承链里用短标签（实例 / 用户 / 工作区）——徽标上的长文案在链里会读成一句话 */
function shortLayer(layer: string) {
    if (layer === "workspace") return copy.value.domain.shortWorkspace;
    if (layer === "user") return copy.value.domain.shortUser;
    return copy.value.domain.shortInstance;
}

function layerLabel(layer: string) {
    if (layer === "workspace") return copy.value.domain.layerWorkspace;
    if (layer === "user") return copy.value.domain.layerUser;
    if (layer === "env") return copy.value.domain.lockedByEnv;
    return copy.value.domain.layerInstance;
}

function shortValue(row: ConfigKeyRow | undefined, layer: string) {
    if (!row) return "";
    if (layer === row.layer) return row.effective;
    const hit = row.chain.find((c: LayerValue) => c.layer === layer);
    return hit?.value ?? "—";
}

function badgeKind(row: ConfigKeyRow) {
    if (row.locked === "instance") return "locked-instance" as const;
    if (row.locked === "env") return "env" as const;
    return row.layer;
}

function jump(row: ConfigKeyRow, layer: ConfigKeyRow["layer"]) {
    highlighted.value = { key: row.key, layer };
}
</script>

<template>
    <div class="preview-screen h-[860px] w-full overflow-hidden rounded-xl border bg-background">
        <div class="grid h-full grid-cols-[minmax(0,1fr)_320px]">
            <div class="min-h-0 overflow-y-auto">
                <LayerHeader layer="instance" :domain="ragLabel" :summary="copy.domain.summary">
                    <p class="mt-1.5 text-[11px] text-muted-foreground">
                        {{ copy.domain.jumpHint }}
                        <span v-if="located" class="font-medium text-foreground"
                            >· {{ located }}</span
                        >
                    </p>
                </LayerHeader>

                <div class="px-8 pt-4 pb-6">
                    <div class="flex items-baseline gap-2">
                        <h2
                            data-testid="settings-domain-title"
                            class="text-lg font-medium tracking-tight"
                        >
                            {{ ragLabel }}
                        </h2>
                        <code class="font-mono text-[11px] text-muted-foreground">
                            /settings/instance/rag
                        </code>
                        <span class="ml-auto text-[10px] text-muted-foreground">{{
                            copy.domain.entryUnit
                        }}</span>
                    </div>

                    <div class="mt-2">
                        <div
                            v-for="row in domainRows"
                            :key="row.key"
                            data-testid="settings-entry-row"
                            class="flex min-h-[44px] items-center gap-4 border-b px-2 py-2 transition-colors"
                            :class="
                                highlighted?.key === row.key
                                    ? 'border-ring bg-muted/40 ring-1 ring-ring'
                                    : 'border-border/60 hover:bg-muted/20'
                            "
                        >
                            <div class="min-w-0 flex-1">
                                <div class="flex items-center gap-2">
                                    <span class="text-sm font-medium">{{ row.label }}</span>
                                    <code class="font-mono text-[11px] text-muted-foreground">
                                        {{ row.key }}
                                    </code>
                                </div>
                                <p class="mt-0.5 truncate text-[11px] text-muted-foreground">
                                    {{ row.description }}
                                </p>
                                <div
                                    v-if="row.chain.length"
                                    class="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground"
                                >
                                    <Link2 class="size-3" aria-hidden="true" />
                                    <span>↳</span>
                                    <template v-for="(c, i) in row.chain" :key="c.layer">
                                        <button
                                            type="button"
                                            class="rounded px-1 text-muted-foreground underline-offset-4 transition-colors hover:bg-muted hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                                            @click="jump(row, c.layer)"
                                        >
                                            <span class="font-medium">{{
                                                shortLayer(c.layer)
                                            }}</span>
                                            <span class="ml-1 font-mono">{{ c.value }}</span>
                                            <ArrowUpRight
                                                class="ml-0.5 inline size-3"
                                                aria-hidden="true"
                                            />
                                        </button>
                                        <span v-if="i < row.chain.length - 1" class="text-border"
                                            >/</span
                                        >
                                    </template>
                                    <span
                                        v-if="row.locked"
                                        class="ml-2 inline-flex items-center gap-1"
                                    >
                                        <Lock class="size-3" />{{
                                            row.locked === "env"
                                                ? copy.domain.lockedByEnv
                                                : copy.domain.lockedByInstance
                                        }}
                                    </span>
                                </div>
                            </div>

                            <div class="flex w-[190px] shrink-0 items-center gap-1.5">
                                <Input
                                    :model-value="row.effective"
                                    :disabled="!row.writable || Boolean(row.locked)"
                                    class="h-8 font-mono text-xs"
                                    readonly
                                />
                                <ChevronDown
                                    v-if="row.editor === 'select'"
                                    class="size-3.5 shrink-0 text-muted-foreground"
                                />
                            </div>

                            <div class="flex w-[168px] shrink-0 justify-end">
                                <LayerBadge :kind="badgeKind(row)" />
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <aside class="flex min-h-0 flex-col gap-3 overflow-y-auto border-l px-5 py-4">
                <Card class="gap-2 border-border/70 py-3">
                    <CardHeader class="px-3 py-0">
                        <CardTitle class="text-sm">{{ copy.domain.chainTitle }}</CardTitle>
                    </CardHeader>
                    <CardContent class="space-y-1.5 px-3 pt-2 text-[11px]">
                        <div class="flex items-center justify-between gap-2">
                            <span class="text-muted-foreground">{{
                                copy.domain.layerWorkspace
                            }}</span>
                            <code class="font-mono">128k</code>
                        </div>
                        <div class="flex items-center justify-between gap-2">
                            <span class="text-muted-foreground">{{ copy.domain.layerUser }}</span>
                            <code class="font-mono">96k</code>
                        </div>
                        <div class="flex items-center justify-between gap-2">
                            <span class="text-muted-foreground">{{
                                copy.domain.layerInstance
                            }}</span>
                            <code class="font-mono">64k</code>
                        </div>
                        <Separator class="my-1" />
                        <p class="text-muted-foreground">{{ copy.domain.chainNote }}</p>
                    </CardContent>
                </Card>

                <Card class="gap-2 border-border/70 py-3">
                    <CardHeader class="px-3 py-0">
                        <CardTitle class="text-sm">{{ copy.domain.coverageTitle }}</CardTitle>
                    </CardHeader>
                    <CardContent class="space-y-1 px-3 pt-2 text-[11px]">
                        <div class="flex items-center justify-between">
                            <span class="text-muted-foreground">{{
                                copy.domain.coverageWorkspaceLabel
                            }}</span>
                            <span class="font-mono">3</span>
                        </div>
                        <div class="flex items-center justify-between">
                            <span class="text-muted-foreground">{{
                                copy.domain.coverageUserLabel
                            }}</span>
                            <span class="font-mono">1</span>
                        </div>
                        <div class="flex items-center justify-between">
                            <span class="text-muted-foreground">{{
                                copy.domain.coverageLockedLabel
                            }}</span>
                            <span class="font-mono">1 / 1</span>
                        </div>
                        <p class="pt-1 text-[10px] leading-relaxed text-muted-foreground">
                            {{ copy.domain.coverageHint }}
                        </p>
                    </CardContent>
                </Card>

                <div class="mt-auto space-y-2">
                    <Button class="w-full" size="sm">
                        <Save class="size-3.5" />{{ copy.domain.save }}
                    </Button>
                    <Button variant="ghost" size="sm" class="w-full justify-start">
                        <Undo2 class="size-3.5" />{{ copy.domain.resetToInherit }}
                    </Button>
                    <p class="text-[10px] leading-relaxed text-muted-foreground">
                        {{ copy.domain.readonlyNote }}
                    </p>
                </div>
            </aside>
        </div>
    </div>
</template>
