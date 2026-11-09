<script setup lang="ts">
import { computed } from "vue";
import { usePreviewCopy } from "./copy";
import type { SettingsLayer } from "./mock";

/**
 * Shared outer frame for one settings layer (PLAN-0752 §5.2「层是外框」). Rendered as the first
 * child of each screen's scroll pane so `sticky top-0` keeps it glued while the entries scroll.
 *
 * Contract (measured by `scripts/verify-settings-ia-mock.mjs`):
 * - `data-testid="settings-layer-title"` — 24px / weight 600, stays at top: 0 after scrolling
 * - `data-testid="settings-breadcrumb"` — 设置 › {层}层( › {域}), last segment `aria-current="page"`
 */
const props = defineProps<{
    layer: SettingsLayer;
    /** 域显示名；缺省时面包屑只到层（层页/主框架） */
    domain?: string;
    summary: string;
}>();

const copy = usePreviewCopy();

const layerTitle = computed(
    () =>
        ({
            instance: copy.value.shell.layerInstance,
            user: copy.value.shell.layerUser,
            workspace: copy.value.shell.layerWorkspace,
        })[props.layer],
);

const layerName = computed(
    () =>
        ({
            instance: copy.value.shell.layerNameInstance,
            user: copy.value.shell.layerNameUser,
            workspace: copy.value.shell.layerNameWorkspace,
        })[props.layer],
);
</script>

<template>
    <header
        class="sticky top-0 z-10 border-b bg-background/95 px-8 pt-4 pb-3 backdrop-blur supports-[backdrop-filter]:bg-background/80"
    >
        <nav
            class="flex items-center gap-1 text-[11px] text-muted-foreground"
            aria-label="面包屑"
            data-testid="settings-breadcrumb"
        >
            <button
                type="button"
                class="rounded px-1 underline-offset-4 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
                {{ copy.shell.breadcrumbRoot }}
            </button>
            <span class="text-border" aria-hidden="true">{{ " › " }}</span>
            <span
                :aria-current="domain ? undefined : 'page'"
                :class="domain ? '' : 'font-medium text-foreground'"
            >
                {{ layerName }}
            </span>
            <template v-if="domain">
                <span class="text-border" aria-hidden="true">{{ " › " }}</span>
                <span aria-current="page" class="font-medium text-foreground">{{ domain }}</span>
            </template>
        </nav>
        <div class="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1
                data-testid="settings-layer-title"
                class="text-2xl leading-tight font-semibold tracking-tight"
            >
                {{ layerTitle }}
            </h1>
            <span class="text-[11px] text-muted-foreground">{{ summary }}</span>
        </div>
        <slot />
    </header>
</template>
