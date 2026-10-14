<script setup lang="ts">
import { useI18n } from "vue-i18n";
import Sheet from "../../../components/ui/sheet/Sheet.vue";
import SheetContent from "../../../components/ui/sheet/SheetContent.vue";
import SheetHeader from "../../../components/ui/sheet/SheetHeader.vue";
import SheetTitle from "../../../components/ui/sheet/SheetTitle.vue";
import SheetDescription from "../../../components/ui/sheet/SheetDescription.vue";
import WorkspaceChangesPanel from "./WorkspaceChangesPanel.vue";
import SessionMonitorPanel from "../monitor/SessionMonitorPanel.vue";

/**
 * Mobile entry for the auxiliary panel (PLAN-0328 M3 T3.8, PLAN-0507):
 * a right-side sheet with two views — Monitor (Session aggregate) and the
 * existing dual-diff panel. The Monitor view is snapshot-mode when no chat
 * SSE channel is active (never a false "stale").
 */
withDefaults(
    defineProps<{
        open: boolean;
        sessionId?: string | null;
        workspaceId: string;
        tab?: "monitor" | "changes";
    }>(),
    {
        open: false,
        sessionId: null,
        tab: "monitor",
    },
);

const emit = defineEmits<{
    close: [];
    "update:tab": [tab: "monitor" | "changes"];
}>();

const { t } = useI18n();

function handleOpenChange(open: boolean) {
    if (!open) emit("close");
}
</script>

<template>
    <Sheet :open="open" @update:open="handleOpenChange">
        <SheetContent side="right" class="p-0 gap-0 md:hidden" data-testid="mobile-changes-sheet">
            <SheetHeader class="px-4 pt-4 pb-2 text-left">
                <SheetTitle>
                    {{
                        tab === "monitor"
                            ? t("workspace.panelMonitor")
                            : t("workspace.panelChanges")
                    }}
                </SheetTitle>
                <SheetDescription v-if="tab === 'changes'">
                    {{ t("workspace.diffDifferenceNote") }}
                </SheetDescription>
            </SheetHeader>
            <div class="flex shrink-0 items-center gap-1 px-4 pb-2" role="tablist">
                <button
                    type="button"
                    role="tab"
                    class="rounded px-2 py-1 text-xs transition-colors"
                    :class="
                        tab === 'monitor'
                            ? 'bg-accent text-foreground'
                            : 'text-muted-foreground hover:bg-accent'
                    "
                    :aria-selected="tab === 'monitor'"
                    data-testid="mobile-aux-tab-monitor"
                    @click="emit('update:tab', 'monitor')"
                >
                    {{ t("workspace.panelMonitor") }}
                </button>
                <button
                    type="button"
                    role="tab"
                    class="rounded px-2 py-1 text-xs transition-colors"
                    :class="
                        tab === 'changes'
                            ? 'bg-accent text-foreground'
                            : 'text-muted-foreground hover:bg-accent'
                    "
                    :aria-selected="tab === 'changes'"
                    data-testid="mobile-aux-tab-changes"
                    @click="emit('update:tab', 'changes')"
                >
                    {{ t("workspace.panelChanges") }}
                </button>
            </div>
            <div class="flex-1 min-h-0 overflow-hidden">
                <SessionMonitorPanel
                    v-if="tab === 'monitor' && sessionId"
                    :session-id="sessionId"
                />
                <div v-else-if="tab === 'monitor'" class="p-4 text-xs text-muted-foreground">
                    {{ t("workspace.noSession") }}
                </div>
                <WorkspaceChangesPanel
                    v-else
                    :session-id="sessionId"
                    :workspace-id="workspaceId"
                    @close="emit('close')"
                />
            </div>
        </SheetContent>
    </Sheet>
</template>
