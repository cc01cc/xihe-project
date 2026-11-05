<script setup lang="ts">
import { useI18n } from "vue-i18n";
import Sheet from "../../../components/ui/sheet/Sheet.vue";
import SheetContent from "../../../components/ui/sheet/SheetContent.vue";
import SheetHeader from "../../../components/ui/sheet/SheetHeader.vue";
import SheetTitle from "../../../components/ui/sheet/SheetTitle.vue";
import SheetDescription from "../../../components/ui/sheet/SheetDescription.vue";
import WorkspaceChangesPanel from "./WorkspaceChangesPanel.vue";
import SessionParticipantsPanel from "./SessionParticipantsPanel.vue";
import SessionMonitorPanel from "../monitor/SessionMonitorPanel.vue";

/**
 * Mobile entry for the auxiliary panel (PLAN-0328 M3 T3.8, PLAN-0507):
 * a right-side sheet with the desktop dock's tabs — Monitor (Session aggregate),
 * the existing dual-diff panel, and (BL-317 / D-198) the session participants
 * panel. The Monitor view is snapshot-mode when no chat SSE channel is active
 * (never a false "stale").
 *
 * BL-317 只做"移动端也能用 members"，不重排布局：三枚 tab 与桌面 dock 同序，
 * 面板体直接复用 `SessionParticipantsPanel`（未读徽标/游标推进都来自同一份 store）。
 */
withDefaults(
    defineProps<{
        open: boolean;
        sessionId?: string | null;
        workspaceId: string;
        tab?: "monitor" | "changes" | "members";
    }>(),
    {
        open: false,
        sessionId: null,
        tab: "monitor",
    },
);

const emit = defineEmits<{
    close: [];
    "update:tab": [tab: "monitor" | "changes" | "members"];
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
                            : tab === "changes"
                              ? t("workspace.panelChanges")
                              : t("workspace.panelMembers")
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
                    class="rounded px-2 py-1 text-xs transition-colors max-md:min-h-[44px] max-md:min-w-[44px]"
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
                    class="rounded px-2 py-1 text-xs transition-colors max-md:min-h-[44px] max-md:min-w-[44px]"
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
                <!--
                    BL-317 / D-198：成员面板在移动端的最小入口（与桌面 dock 的 `members` 同源）。
                    tab 与面板体都复用桌面那份，不新建第二套实现。
                -->
                <button
                    type="button"
                    role="tab"
                    class="rounded px-2 py-1 text-xs transition-colors max-md:min-h-[44px] max-md:min-w-[44px]"
                    :class="
                        tab === 'members'
                            ? 'bg-accent text-foreground'
                            : 'text-muted-foreground hover:bg-accent'
                    "
                    :aria-selected="tab === 'members'"
                    data-testid="mobile-aux-tab-members"
                    @click="emit('update:tab', 'members')"
                >
                    {{ t("workspace.panelMembers") }}
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
                <SessionParticipantsPanel
                    v-else-if="tab === 'members'"
                    :session-id="sessionId ?? null"
                />
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
