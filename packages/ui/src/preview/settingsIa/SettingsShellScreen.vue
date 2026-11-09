<script setup lang="ts">
import { computed, ref } from "vue";
import {
    Bot,
    BookOpenText,
    Database,
    Gauge,
    KeyRound,
    Info,
    Languages,
    LayoutTemplate,
    LockKeyhole,
    MessageSquare,
    ScrollText,
    ScrollText as ScrollTextIcon,
    ShieldCheck,
    SlidersHorizontal,
    Sparkles,
    UserCog,
    Wrench,
} from "@lucide/vue";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { usePreviewCopy } from "./copy";
import {
    domainsFor,
    opsNav,
    resourceNav,
    securityNav,
    workspaceResourceNav,
    type SettingsLayer,
} from "./mock";
import LayerHeader from "./LayerHeader.vue";

/**
 * Screen 1 — proposed settings shell, v2 (task-56, PLAN-0752 §3.1/§5.2).
 *
 * The user's two complaints on v1 are the acceptance criteria here:
 * 1. 「域看起来比层高」 ⇒ the **layer** is now the outer frame: sticky 24px page title plus a fixed
 *    breadcrumb, and domain cards lost both the shadow and the big white surface (border only,
 *    page-coloured background) so the type scale 24 > 18 > 14 is visually obvious.
 * 2. 「用户配置只有 3 项、与实例 12 域不对称」 ⇒ the user layer now carries its **9 CP-matrix
 *    domains** (logging / approval-policy / job-policy are instance-only) plus the 「我的资源」
 *    group of 3, making the two layers structurally identical (domains + resources).
 *
 * Layer switching keeps the rail honest: only one layer is expanded at a time; the frame
 * (title + breadcrumb) stays put while the rail body and the grid change.
 */
const copy = usePreviewCopy();
const activeLayer = ref<SettingsLayer>("instance");
const active = ref("rag");
/** 跨层拦截提示：实例独占域被要求「切到用户层」时给出提示，不跳转、不 404（PLAN-0752 §6.1 反向保护） */
const blocked = ref<string | null>(null);

const domainIcon: Record<string, typeof Wrench> = {
    "llm-provider": Sparkles,
    "context-policy": MessageSquare,
    embedding: Database,
    rag: BookOpenText,
    "agent-runtime": Bot,
    "agent-profile": UserCog,
    "user-preference": Languages,
    logging: ScrollText,
    "approval-policy": ShieldCheck,
    "agent-templates": LayoutTemplate,
    "api-request-templates": SlidersHorizontal,
    "job-policy": Gauge,
};

const navIcon: Record<string, typeof Wrench> = {
    monitoring: Gauge,
    data: Database,
    "config-locks": LockKeyhole,
    roles: ShieldCheck,
    audit: ScrollTextIcon,
    "my-agents": Bot,
    "my-credentials": KeyRound,
    "knowledge-mcp": Database,
};

const domains = computed(() => domainsFor(activeLayer.value));

const summary = computed(() => {
    if (activeLayer.value === "instance") return copy.value.shell.instanceSummary;
    if (activeLayer.value === "user") return copy.value.shell.userSummary;
    return copy.value.shell.workspaceSummary;
});

/** 左栏：两块 L1 分组（层），只有当前层展开——同一时刻只在一层内（PLAN-0752 §3.1 读法）。 */
const blocks = computed(() => [
    {
        layer: "instance" as SettingsLayer,
        title: copy.value.shell.layerInstance,
        count: copy.value.shell.countInstanceDomains,
        groups: [
            {
                id: "domains",
                label: copy.value.shell.groupDomains,
                count: copy.value.shell.countInstanceDomains,
                items: [] as string[],
                withDomains: true,
            },
            {
                id: "ops",
                label: copy.value.shell.groupOps,
                count: copy.value.shell.countOps,
                items: opsNav as unknown as string[],
                withDomains: false,
            },
            {
                id: "security",
                label: copy.value.shell.groupSecurity,
                count: copy.value.shell.countSecurity,
                items: securityNav as unknown as string[],
                withDomains: false,
            },
        ],
    },
    {
        layer: "user" as SettingsLayer,
        title: copy.value.shell.layerUser,
        count: copy.value.shell.countUserDomains,
        groups: [
            {
                id: "domains",
                label: copy.value.shell.groupDomains,
                count: copy.value.shell.countUserDomains,
                items: [] as string[],
                withDomains: true,
            },
            {
                id: "resources",
                label: copy.value.shell.groupResources,
                count: copy.value.shell.countResources,
                items: resourceNav as unknown as string[],
                withDomains: false,
            },
        ],
    },
    // 工作区层（task-61）：10 域 + 3 项工作区资源，第三块与实例/用户层同构
    {
        layer: "workspace" as SettingsLayer,
        title: copy.value.shell.layerWorkspace,
        count: copy.value.shell.countWorkspaceDomains,
        groups: [
            {
                id: "domains",
                label: copy.value.shell.groupDomains,
                count: copy.value.shell.countWorkspaceDomains,
                items: [] as string[],
                withDomains: true,
            },
            {
                id: "resources",
                label: copy.value.shell.groupWorkspaceResources,
                count: copy.value.shell.countWorkspaceResources,
                items: workspaceResourceNav as unknown as string[],
                withDomains: false,
            },
        ],
    },
]);

function navLabel(id: string) {
    return (copy.value.shell.navLabels as Record<string, string>)[id] ?? id;
}

function isGap(id: string) {
    return (copy.value.shell.navGapIds as string[]).includes(id);
}

function domainLabel(id: string) {
    return (copy.value.shell.domainLabels as Record<string, string>)[id] ?? id;
}

/** 用户层不可写的域：logging（仅实例）+ approval-policy / job-policy（实例+工作区）——CP 矩阵事实 */
function instanceOnlyForUser(d: { layers: SettingsLayer[] }) {
    return activeLayer.value === "instance" && !d.layers.includes("user");
}
</script>

<template>
    <div class="preview-screen h-[860px] w-full overflow-hidden rounded-xl border bg-background">
        <div class="grid h-full grid-cols-[300px_minmax(0,1fr)]">
            <aside class="flex min-h-0 flex-col border-r">
                <div class="flex items-center gap-2 px-4 pt-4">
                    <span class="text-sm font-semibold tracking-tight">{{
                        copy.shell.breadcrumbRoot
                    }}</span>
                    <Badge variant="secondary" class="ml-auto text-[10px]">
                        {{ copy.shell.previewBadge }}
                    </Badge>
                </div>

                <div class="min-h-0 flex-1 overflow-y-auto px-2 py-3">
                    <div v-for="(block, i) in blocks" :key="block.layer">
                        <Separator v-if="i > 0" class="my-2" />
                        <button
                            type="button"
                            data-testid="settings-nav-group-primary"
                            class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] font-medium tracking-wide uppercase transition-colors"
                            :class="
                                block.layer === activeLayer
                                    ? 'bg-muted/60 text-foreground'
                                    : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground'
                            "
                            :aria-expanded="block.layer === activeLayer"
                            @click="activeLayer = block.layer"
                        >
                            {{ block.title }}
                            <span class="ml-auto font-mono text-[11px] tracking-normal normal-case">
                                {{ block.count }}
                            </span>
                        </button>

                        <div v-if="block.layer === activeLayer" class="mt-1 space-y-2 pb-1">
                            <section v-for="group in block.groups" :key="group.id">
                                <p
                                    data-testid="settings-nav-group-secondary"
                                    class="flex items-center gap-1 px-2 pb-1 text-[11px] text-muted-foreground"
                                >
                                    {{ group.label }}
                                    <span class="font-mono text-[10px]">{{ group.count }}</span>
                                </p>

                                <div
                                    v-if="group.withDomains"
                                    data-testid="settings-nav-group-items"
                                    class="space-y-0.5 pl-2"
                                >
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
                                        <span class="truncate">{{ domainLabel(d.id) }}</span>
                                        <LockKeyhole
                                            v-if="d.locked"
                                            class="ml-auto size-3 shrink-0 text-muted-foreground"
                                        />
                                    </button>
                                </div>

                                <div
                                    v-else
                                    data-testid="settings-nav-group-items"
                                    class="space-y-0.5 pl-2"
                                >
                                    <div
                                        v-for="id in group.items"
                                        :key="id"
                                        class="flex items-center gap-2 rounded-md px-2 py-1 text-[13px] text-muted-foreground"
                                    >
                                        <component
                                            :is="navIcon[id] ?? Wrench"
                                            class="size-3.5 shrink-0 text-muted-foreground"
                                        />
                                        <span class="truncate">{{ navLabel(id) }}</span>
                                        <span
                                            v-if="isGap(id)"
                                            class="ml-auto rounded border px-1 text-[10px]"
                                            >{{ copy.shell.gap }}</span
                                        >
                                    </div>
                                </div>
                            </section>
                        </div>
                    </div>
                </div>

                <p class="border-t px-4 py-2 text-[11px] leading-relaxed text-muted-foreground">
                    {{ copy.shell.layerNote }}
                </p>
            </aside>

            <section class="min-h-0 overflow-y-auto">
                <LayerHeader :layer="activeLayer" :summary="summary">
                    <p class="mt-1.5 text-[11px] text-muted-foreground">
                        {{ copy.shell.weightRule }}
                    </p>
                </LayerHeader>

                <!-- 跨层拦截（PLAN-0752 §6.1 反向保护）：不跳转、不 404，先给一句人话 -->
                <div
                    v-if="blocked"
                    data-testid="settings-layer-block-notice"
                    class="mx-6 mt-4 flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-[11px]"
                >
                    <Info class="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                    <div class="min-w-0 flex-1">
                        <p class="font-medium">{{ copy.shell.blockedNoticeTitle }}</p>
                        <p class="mt-0.5 leading-relaxed text-muted-foreground">
                            {{
                                copy.shell.blockedNoticeBody.replace(
                                    "{domain}",
                                    domainLabel(blocked),
                                )
                            }}
                        </p>
                    </div>
                    <button
                        type="button"
                        class="rounded px-1 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                        @click="blocked = null"
                    >
                        {{ copy.shell.blockedDismiss }}
                    </button>
                </div>

                <div class="grid grid-cols-3 content-start gap-3 px-6 py-5">
                    <div
                        v-for="d in domains"
                        :key="d.id"
                        data-testid="settings-domain-card"
                        class="rounded-md border border-border/70 bg-transparent p-3 transition-colors hover:border-border hover:bg-muted/30"
                        :class="d.id === active ? 'border-brand' : ''"
                    >
                        <button
                            type="button"
                            class="flex w-full items-center gap-2 text-left"
                            @click="active = d.id"
                        >
                            <component
                                :is="domainIcon[d.id] ?? Wrench"
                                class="size-4 shrink-0 text-muted-foreground"
                            />
                            <span class="truncate text-sm font-medium">{{
                                domainLabel(d.id)
                            }}</span>
                            <LockKeyhole
                                v-if="d.locked"
                                class="ml-auto size-3 shrink-0 text-muted-foreground"
                            />
                        </button>
                        <div class="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
                            <span class="font-mono">{{ d.keys }} {{ copy.shell.keysUnit }}</span>
                            <span class="text-border">·</span>
                            <span>{{ d.overridden }} {{ copy.shell.overriddenUnit }}</span>
                            <button
                                v-if="instanceOnlyForUser(d)"
                                type="button"
                                data-testid="settings-domain-switch-layer"
                                class="ml-auto rounded px-1 underline-offset-4 hover:bg-muted hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                                @click="blocked = d.id"
                            >
                                {{ copy.shell.switchToUserLayer }}
                            </button>
                        </div>
                    </div>
                </div>

                <p
                    v-if="activeLayer === 'user'"
                    class="mx-6 mb-4 rounded-md border border-dashed px-3 py-2 text-[11px] leading-relaxed text-muted-foreground"
                >
                    {{ copy.shell.userLayerFact }}
                    {{ copy.shell.gapNote }}
                </p>

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
                                <ScrollText class="size-3 shrink-0" />
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
