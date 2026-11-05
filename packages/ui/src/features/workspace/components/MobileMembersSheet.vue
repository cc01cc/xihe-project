<script setup lang="ts">
import { computed, nextTick, watch } from "vue";
import { useI18n } from "vue-i18n";
import { X } from "@lucide/vue";
import Sheet from "../../../components/ui/sheet/Sheet.vue";
import SheetContent from "../../../components/ui/sheet/SheetContent.vue";
import SheetTitle from "../../../components/ui/sheet/SheetTitle.vue";
import SheetDescription from "../../../components/ui/sheet/SheetDescription.vue";
import SessionParticipantsPanel from "./SessionParticipantsPanel.vue";
import { useSessionParticipantsStore } from "../stores/sessionParticipants";

/**
 * BL-317b（IM 调研 §3 推荐基线 A）：移动端**独立**成员面板。
 *
 * 为什么拆出来：BL-317 把成员塞进了 `MobileChangesSheet` 的第三个 aux tab —— 但 roster 是
 * 发送 / @ / 代发 的核心对象，它跟 monitor/changes 不是同一层需求；主流 IM（Telegram / Slack /
 * Discord / WhatsApp）都是「点会话标题 → 会话详情」的独立层。所以：
 * - 成员有**自己的** sheet（高 sheet，覆盖聊天），`MobileChangesSheet` 继续只服务 monitor/changes；
 * - 正文**复用** `SessionParticipantsPanel`（`density="summary"`），不新建第二套列表实现；
 * - 溢出菜单入口保留（BL-317 的兜底，不删）。
 *
 * 交互（Lead 验收口径）：`role="dialog"` + `aria-modal`（由 Sheet/Reka 提供）、focus trap（同上）、
 * Escape 关闭（同上）、**下滑/右滑关闭**（本组件）、**关闭后焦点回触发器**（本组件：打开时记住
 * `document.activeElement`，关闭后 `focus()` 回去 —— 否则键盘用户会掉进 `<body>`，就是 BL-328 那类洞）。
 */
const props = withDefaults(
    defineProps<{
        open: boolean;
        sessionId?: string | null;
    }>(),
    { open: false, sessionId: null },
);

const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const store = useSessionParticipantsStore();

/** 打开前的焦点落点（触发按钮）；关闭时归还。 */
let returnFocusTo: HTMLElement | null = null;

watch(
    () => props.open,
    async (open) => {
        if (open) {
            const active = document.activeElement;
            returnFocusTo = active instanceof HTMLElement ? active : null;
            if (props.sessionId) void store.ensureLoaded(props.sessionId);
            return;
        }
        await nextTick();
        returnFocusTo?.focus();
        returnFocusTo = null;
    },
);

const memberCount = computed(() => store.participants?.length ?? 0);

// 下滑 / 右滑关闭：记录起点，`touchend` 判位移；只认「明显」的滑动（≥72px），避免误触。
const SWIPE_CLOSE_PX = 72;
let touchStartX = 0;
let touchStartY = 0;

function onTouchStart(event: TouchEvent) {
    const touch = event.touches[0];
    if (!touch) return;
    touchStartX = touch.clientX;
    touchStartY = touch.clientY;
}

function onTouchEnd(event: TouchEvent) {
    const touch = event.changedTouches[0];
    if (!touch) return;
    const dx = touch.clientX - touchStartX;
    const dy = touch.clientY - touchStartY;
    if (dx >= SWIPE_CLOSE_PX || dy >= SWIPE_CLOSE_PX) emit("close");
}

function handleOpenChange(open: boolean) {
    if (!open) emit("close");
}
</script>

<template>
    <Sheet :open="open" @update:open="handleOpenChange">
        <SheetContent
            side="right"
            class="flex w-[88vw] max-w-sm flex-col gap-0 p-0 md:hidden"
            data-testid="mobile-members-sheet"
            role="dialog"
            aria-modal="true"
            :aria-label="t('workspace.panelMembers')"
            @touchstart.passive="onTouchStart"
            @touchend.passive="onTouchEnd"
        >
            <div class="flex shrink-0 items-start justify-between gap-2 border-b px-4 py-3">
                <div class="min-w-0">
                    <SheetTitle class="text-sm font-medium">
                        {{ t("workspace.panelMembers") }}
                        <span
                            class="ml-1 tabular-nums text-muted-foreground"
                            data-testid="mobile-members-sheet-count"
                            >{{ memberCount }}</span
                        >
                    </SheetTitle>
                    <SheetDescription class="text-xs text-muted-foreground">
                        {{ t("workspace.mobileMembersHint") }}
                    </SheetDescription>
                </div>
                <button
                    type="button"
                    class="shrink-0 rounded p-2 text-muted-foreground transition-colors hover:bg-accent max-md:min-h-[44px] max-md:min-w-[44px]"
                    data-testid="mobile-members-sheet-close"
                    :aria-label="t('common.close')"
                    @click="emit('close')"
                >
                    <X class="size-4" aria-hidden="true" />
                </button>
            </div>
            <div class="min-h-0 flex-1 overflow-y-auto">
                <!-- 复用桌面那份面板与 store：不新建第二套列表/加载/权限逻辑。 -->
                <SessionParticipantsPanel :session-id="sessionId" density="summary" />
            </div>
        </SheetContent>
    </Sheet>
</template>
