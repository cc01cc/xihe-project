<script setup lang="ts">
import { computed, ref } from "vue";
import {
    BookOpenText,
    Terminal,
    Bot,
    Database,
    Gauge,
    KeyRound,
    Languages,
    LockKeyhole,
    ScrollText,
    ShieldCheck,
    SlidersHorizontal,
    Sparkles,
    Wrench,
} from "@lucide/vue";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { usePreviewCopy } from "./copy";
import { domains } from "./mock";

/**
 * Screen 1 — proposed settings shell (task-44).
 *
 * Two blocks in the left rail — 实例配置 (domains / operations / security) and 用户配置 —
 * instead of today's workspace sidebar. The right pane is the domain grid that the rail opens.
 * Everything here is rendered with the real `components/ui/*` primitives and product tokens;
 * no colour step is invented. Emphasis budget: the active-rail bar and the primary CTA are the
 * only two L3 accents on this screen (nothing is red — nothing destructive lives here).
 */
const copy = usePreviewCopy();
const active = ref("rag");

const domainIcon: Record<string, typeof Wrench> = {
    rag: BookOpenText,
    provider: Sparkles,
    embedding: Database,
    agent: Bot,
    memory: Gauge,
    tools: Wrench,
    mcp: Gauge,
    session: SlidersHorizontal,
    sandbox: ShieldCheck,
    telemetry: Gauge,
    ui: Languages,
    security: ShieldCheck,
};

const ops = computed(() => [
    { icon: Gauge, label: copy.value.shell.opsMonitoring },
    { icon: Database, label: copy.value.shell.opsData },
]);
const security = computed(() => [
    { icon: LockKeyhole, label: copy.value.shell.secLocks },
    { icon: ShieldCheck, label: copy.value.shell.secRoles },
    { icon: ScrollText, label: copy.value.shell.secAudit },
]);
const userNav = computed(() => [
    { icon: Bot, label: copy.value.shell.userAgents },
    { icon: KeyRound, label: copy.value.shell.userCredentials },
    { icon: Languages, label: copy.value.shell.userPrefs },
]);
</script>

<template>
    <div class="preview-screen h-[860px] w-full overflow-hidden rounded-xl border bg-background">
        <div class="grid h-full grid-cols-[300px_minmax(0,1fr)]">
            <aside class="flex min-h-0 flex-col border-r">
                <div class="flex items-center gap-2 px-4 pt-4">
                    <span class="text-sm font-semibold tracking-tight">设置</span>
                    <Badge variant="secondary" class="ml-auto text-[10px]">
                        {{ copy.shell.previewBadge }}
                    </Badge>
                </div>

                <div class="min-h-0 flex-1 overflow-y-auto px-2 py-3">
                    <p
                        class="px-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase"
                    >
                        {{ copy.shell.instanceBlock }}
                    </p>

                    <div
                        class="flex items-center gap-2 rounded-md bg-muted/60 px-2 py-1.5 text-sm font-medium"
                    >
                        <SlidersHorizontal class="size-4 text-muted-foreground" />
                        {{ copy.shell.domains }}
                        <span class="ml-auto font-mono text-[11px] text-muted-foreground">12</span>
                    </div>
                    <div class="mt-0.5 space-y-0.5 pl-2">
                        <button
                            v-for="d in domains"
                            :key="d.id"
                            type="button"
                            class="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] transition-colors"
                            :class="
                                d.id === active
                                    ? 'bg-muted text-foreground'
                                    : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                            "
                            @click="active = d.id"
                        >
                            <span
                                v-if="d.id === active"
                                class="h-4 w-0.5 rounded-full bg-brand"
                                aria-hidden="true"
                            />
                            <component
                                :is="domainIcon[d.id] ?? Wrench"
                                class="size-3.5 shrink-0 text-muted-foreground"
                            />
                            <span class="truncate">{{ d.label }}</span>
                            <LockKeyhole
                                v-if="d.locked"
                                class="ml-auto size-3 shrink-0 text-muted-foreground"
                            />
                        </button>
                    </div>

                    <Separator class="my-2" />
                    <p class="px-2 pb-1 text-[11px] text-muted-foreground">
                        {{ copy.shell.ops }}
                    </p>
                    <div class="space-y-0.5">
                        <div
                            v-for="item in ops"
                            :key="item.label"
                            class="flex items-center gap-2 rounded-md px-2 py-1 text-[13px]"
                        >
                            <component :is="item.icon" class="size-3.5 text-muted-foreground" />
                            {{ item.label }}
                        </div>
                    </div>

                    <Separator class="my-2" />
                    <p class="px-2 pb-1 text-[11px] text-muted-foreground">
                        {{ copy.shell.security }}
                    </p>
                    <div class="space-y-0.5 pb-2">
                        <div
                            v-for="item in security"
                            :key="item.label"
                            class="flex items-center gap-2 rounded-md px-2 py-1 text-[13px]"
                        >
                            <component :is="item.icon" class="size-3.5 text-muted-foreground" />
                            {{ item.label }}
                        </div>
                    </div>

                    <Separator class="my-2" />
                    <p
                        class="px-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase"
                    >
                        {{ copy.shell.userBlock }}
                    </p>
                    <div class="space-y-0.5 pb-2">
                        <div
                            v-for="item in userNav"
                            :key="item.label"
                            class="flex items-center gap-2 rounded-md px-2 py-1 text-[13px]"
                        >
                            <component :is="item.icon" class="size-3.5 text-muted-foreground" />
                            {{ item.label }}
                        </div>
                    </div>
                </div>

                <p class="border-t px-4 py-2 text-[11px] leading-relaxed text-muted-foreground">
                    {{ copy.shell.coverageNote }}
                </p>
            </aside>

            <section class="flex min-h-0 flex-col">
                <header class="border-b px-8 pt-5 pb-4">
                    <h3 class="text-lg font-semibold tracking-tight">
                        {{ copy.shell.contentTitle }}
                    </h3>
                    <p class="mt-1 text-[13px] text-muted-foreground">
                        {{ copy.shell.contentSummary }}
                    </p>
                    <p class="mt-2 text-[11px] text-muted-foreground">
                        {{ copy.shell.switchLayerHint }}
                    </p>
                </header>
                <div
                    class="grid min-h-0 flex-1 grid-cols-3 content-start gap-3 overflow-y-auto p-6"
                >
                    <button
                        v-for="d in domains"
                        :key="d.id"
                        type="button"
                        class="rounded-lg border bg-card p-3 text-left transition-colors hover:bg-muted/40"
                        :class="d.id === active ? 'border-brand' : ''"
                    >
                        <div class="flex items-center gap-2">
                            <component
                                :is="domainIcon[d.id] ?? Wrench"
                                class="size-4 text-muted-foreground"
                            />
                            <span class="text-sm font-medium">{{ d.label }}</span>
                            <Badge
                                v-if="d.locked"
                                variant="outline"
                                class="ml-auto gap-1 text-[10px] font-normal"
                            >
                                <LockKeyhole class="size-2.5" />
                                {{
                                    d.locked === "env"
                                        ? copy.domain.lockedByEnv
                                        : copy.domain.lockedByInstance
                                }}
                            </Badge>
                        </div>
                        <div class="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
                            <span class="font-mono">{{ d.keys }} {{ copy.shell.keysUnit }}</span>
                            <span class="text-border">·</span>
                            <span>{{ d.overridden }} {{ copy.shell.overriddenUnit }}</span>
                        </div>
                    </button>
                </div>

                <div
                    class="grid shrink-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-4 border-t px-6 py-4"
                >
                    <div>
                        <p class="mb-1.5 text-[11px] font-medium text-muted-foreground">
                            {{ copy.shell.legendTitle }}
                        </p>
                        <ul class="space-y-1 text-[11px] text-muted-foreground">
                            <li class="flex items-center gap-1.5">
                                <span class="size-1.5 rounded-full bg-brand" aria-hidden="true" />
                                {{ copy.shell.legendWorkspace }}
                            </li>
                            <li class="flex items-center gap-1.5">
                                <span
                                    class="size-1.5 rounded-full bg-foreground/60"
                                    aria-hidden="true"
                                />
                                {{ copy.shell.legendUser }}
                            </li>
                            <li class="flex items-center gap-1.5">
                                <LockKeyhole class="size-3 shrink-0" />
                                {{ copy.shell.legendInstance }}
                            </li>
                            <li class="flex items-center gap-1.5">
                                <Terminal class="size-3 shrink-0" />
                                {{ copy.shell.legendEnv }}
                            </li>
                        </ul>
                    </div>
                    <div>
                        <p class="mb-1.5 text-[11px] font-medium text-muted-foreground">
                            {{ copy.shell.recentTitle }}
                        </p>
                        <p class="mb-1.5 text-[10px] leading-relaxed text-muted-foreground">
                            {{ copy.shell.recentHint }}
                        </p>
                        <ul class="space-y-1 text-[11px]">
                            <li class="flex items-center gap-2">
                                <span class="rounded border px-1 font-mono text-[10px]">rag</span>
                                <span class="truncate">{{ copy.shell.recentItem1 }}</span>
                            </li>
                            <li class="flex items-center gap-2">
                                <span class="rounded border px-1 font-mono text-[10px]">rag</span>
                                <span class="truncate">{{ copy.shell.recentItem2 }}</span>
                            </li>
                            <li class="flex items-center gap-2">
                                <span class="rounded border px-1 font-mono text-[10px]">mcp</span>
                                <span class="truncate text-muted-foreground">{{
                                    copy.shell.recentItem3
                                }}</span>
                            </li>
                        </ul>
                    </div>
                </div>
            </section>
        </div>
    </div>
</template>
