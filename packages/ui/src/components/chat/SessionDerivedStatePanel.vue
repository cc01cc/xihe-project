<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { SessionDerivedActiveChild, SessionDerivedTerminalNotice } from "../../types";

const props = defineProps<{
    activeChildren: SessionDerivedActiveChild[];
    terminalNotices: SessionDerivedTerminalNotice[];
    loading?: boolean;
    error?: boolean;
}>();

const { t } = useI18n();
const visible = computed(
    () =>
        props.loading ||
        props.error ||
        props.activeChildren.length > 0 ||
        props.terminalNotices.length > 0,
);

function formatTime(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
        ? value
        : new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" }).format(
              date,
          );
}
</script>

<template>
    <section
        v-if="visible"
        data-testid="session-derived-state"
        :aria-label="t('chat.derivedStateTitle')"
        aria-live="polite"
        class="mx-4 my-2 rounded-lg border border-border bg-muted/20 p-3"
    >
        <div class="flex items-center justify-between gap-3">
            <h2 class="text-sm font-medium text-foreground">{{ t("chat.derivedStateTitle") }}</h2>
            <span
                v-if="loading"
                class="text-xs text-muted-foreground"
                data-testid="derived-state-loading"
            >
                {{ t("chat.derivedStateLoading") }}
            </span>
        </div>

        <p
            v-if="error"
            class="mt-2 text-xs text-destructive"
            role="status"
            data-testid="derived-state-error"
        >
            {{ t("chat.derivedStateRefreshError") }}
        </p>

        <section v-if="activeChildren.length" class="mt-3" aria-labelledby="derived-active-heading">
            <h3 id="derived-active-heading" class="text-xs font-medium text-muted-foreground">
                {{ t("chat.derivedStateActive") }}
            </h3>
            <ul class="mt-1 space-y-1" data-testid="derived-active-children">
                <li
                    v-for="child in activeChildren"
                    :key="child.runId"
                    class="flex min-w-0 items-center justify-between gap-3 rounded-md bg-background/60 px-2.5 py-2 text-sm"
                    data-testid="derived-active-child"
                >
                    <span class="min-w-0 truncate text-foreground">
                        {{ child.name ?? t("chat.derivedStateUnnamedChild") }}
                    </span>
                    <span
                        class="shrink-0 text-xs text-muted-foreground"
                        data-testid="derived-child-status"
                    >
                        {{ t(`chat.derivedStateStatus.${child.status}`) }}
                    </span>
                </li>
            </ul>
        </section>

        <section
            v-if="terminalNotices.length"
            class="mt-3"
            aria-labelledby="derived-terminal-heading"
        >
            <h3 id="derived-terminal-heading" class="text-xs font-medium text-muted-foreground">
                {{ t("chat.derivedStateTerminal") }}
            </h3>
            <ul class="mt-1 space-y-1" data-testid="derived-terminal-notices">
                <li
                    v-for="notice in terminalNotices"
                    :key="notice.runId"
                    class="flex min-w-0 items-center justify-between gap-3 rounded-md bg-background/60 px-2.5 py-2 text-sm"
                    data-testid="derived-terminal-notice"
                >
                    <span class="min-w-0 truncate text-foreground">
                        {{ notice.name ?? t("chat.derivedStateUnnamedChild") }}
                    </span>
                    <span class="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                        <span data-testid="derived-terminal-state">{{
                            t(`chat.derivedStateOutcome.${notice.state}`)
                        }}</span>
                        <time :datetime="notice.terminalAt">{{
                            formatTime(notice.terminalAt)
                        }}</time>
                    </span>
                </li>
            </ul>
        </section>
    </section>
</template>
