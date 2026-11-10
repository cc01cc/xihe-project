<script setup lang="ts">
import { computed } from "vue";
import { ExternalLink } from "@lucide/vue";
import { Badge } from "@/components/ui/badge";

/**
 * Fixed 1920x1080 canvas for one mock sheet.
 *
 * Two strips on purpose:
 * 1. a one-line **对照提示** — the reader keeps the shipping settings page open in another tab and
 *    needs both URLs in front of them;
 * 2. the sheet tabs — `#1`..`#6`, hash-driven so a reload lands on the same sheet.
 *
 * Colours are product tokens only (`muted`/`border`/`foreground`); no new colour ramp is introduced.
 */
const props = defineProps<{
    index: string;
    title: string;
    note: string;
    sheets: { n: number; label: string }[];
    active: number;
}>();

const BEFORE_URL = "http://localhost:12630/settings/instance/llm-provider";
const selfUrl = computed(() => window.location.origin + "/preview-mock.html#" + props.active);
</script>

<template>
    <div class="flex h-[1080px] w-[1920px] flex-col overflow-hidden bg-background text-foreground">
        <div
            class="flex h-8 shrink-0 items-center gap-2 border-b border-border bg-muted px-6 text-[11px]"
        >
            <span class="font-semibold">对照</span>
            <span class="text-muted-foreground">改造前 →</span>
            <a
                class="font-mono text-foreground underline underline-offset-2"
                :href="BEFORE_URL"
                target="_blank"
                rel="noreferrer"
                >{{ BEFORE_URL }}<ExternalLink class="ml-0.5 inline size-3"
            /></a>
            <span class="text-muted-foreground">（主栈产品 UI，dev 管理员登录）</span>
            <span class="ml-3 text-muted-foreground">改造后 → 就是本页</span>
            <span class="ml-auto font-mono text-muted-foreground">{{ selfUrl }}</span>
        </div>

        <header
            class="flex h-14 shrink-0 items-center gap-4 border-b border-border bg-muted/30 px-6"
        >
            <span
                class="flex size-7 items-center justify-center rounded-md bg-foreground font-mono text-xs font-semibold text-background"
            >
                {{ index }}
            </span>
            <div class="flex min-w-0 flex-col">
                <span class="truncate text-sm font-semibold leading-5">{{ title }}</span>
                <span class="truncate text-[11px] leading-4 text-muted-foreground">{{ note }}</span>
            </div>
            <nav class="ml-4 flex items-center gap-1">
                <a
                    v-for="s in sheets"
                    :key="s.n"
                    :href="'#' + s.n"
                    class="rounded-md px-2 py-1 text-[11px] transition-colors"
                    :class="
                        s.n === active
                            ? 'bg-foreground text-background'
                            : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                    "
                >
                    {{ s.n }} · {{ s.label }}
                </a>
            </nav>
            <Badge variant="outline" class="ml-auto shrink-0">真组件 + mock · 无 API 请求</Badge>
        </header>

        <div class="min-h-0 flex-1">
            <slot />
        </div>
    </div>
</template>
