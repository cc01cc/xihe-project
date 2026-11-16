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

/**
 * task-56（D-1752 / WCAG 2.4.3）：本抽屉的三个入口都在工具条的 **溢出菜单**里
 * （`workspace-toolbar-more-changes` / `-monitor` / `-members`），而 `overflowNav()`
 * 选中即关菜单 ⇒ **触发元素被卸载**。reka 默认「关闭时把焦点还给触发器」
 * （`dist/Dialog/DialogContentModal.js`：`triggerElement.value?.focus()`）对已卸载元素是空操作
 * ⇒ 焦点落到 `body`，键盘用户失去位置（390×844 light/dark 各复现一次，task-55 batch-4）。
 *
 * 修法走**原语自己的钩子** `close-auto-focus`（reka `DialogContentEmits` 成员，
 * 经 `SheetContent` 的 `useForwardPropsEmits` 透传），不自己造焦点管理：
 * - `event.preventDefault()` 让 reka 不再抢回焦点 —— 它只在 `!event.defaultPrevented`
 *   时接管（同文件 `onCloseAutoFocus`），而我们的 handler 在 mergeProps 里排在它前面；
 * - 焦点显式还给**常驻**的 `workspace-toolbar-more-mobile`（`WorkspaceToolbar.vue:124`，
 *   抽屉开着时它一直在 DOM 里）。
 *
 * 找不到那颗常驻按钮时（桌面视口 / 别的入口）**不 preventDefault**，保留 reka 默认回位 ——
 * 对照组 `mobile-files-sheet` / `mobile-chat-sheet` 的触发器常驻，本来就回位正确，不能被这条改动带坏。
 * 禁用 `setTimeout` 抢焦点与 `onUnmounted` 兜底：那是绕过原语语义。
 */
function handleCloseAutoFocus(event: Event) {
    const trigger = document.querySelector<HTMLElement>(
        '[data-testid="workspace-toolbar-more-mobile"]',
    );
    if (!trigger) return;
    event.preventDefault();
    trigger.focus();
}
</script>

<template>
    <Sheet :open="open" @update:open="handleOpenChange">
        <SheetContent
            side="right"
            class="p-0 gap-0 md:hidden"
            data-testid="mobile-changes-sheet"
            @close-auto-focus="handleCloseAutoFocus"
        >
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
