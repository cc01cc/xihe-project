<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useMediaQuery } from "@vueuse/core";
import { useI18n } from "vue-i18n";
import Sheet from "../../../components/ui/sheet/Sheet.vue";
import SheetContent from "../../../components/ui/sheet/SheetContent.vue";
import SheetHeader from "../../../components/ui/sheet/SheetHeader.vue";
import SheetTitle from "../../../components/ui/sheet/SheetTitle.vue";
import SheetDescription from "../../../components/ui/sheet/SheetDescription.vue";
import ChatPanel from "../chat/components/ChatPanel.vue";
import MobileMembersSheet from "./MobileMembersSheet.vue";
import { MessageCircle } from "@lucide/vue";
import { useAgentStore } from "../../../stores/agent";
import { useSessionStore } from "../../../stores/session";
import { useSessionParticipantsStore } from "../stores/sessionParticipants";
import { participantInitials } from "./participantInitials";

/**
 * 注意 `withDefaults(..., { isMobile: undefined })` **不是摆设**：Vue 对运行时类型为 `Boolean` 的
 * props 有"缺省即 `false`"的类型转换（boolean casting）。若不显式声明 default，父组件**不传**
 * 这个 prop 时拿到的是 `false`（不是 `undefined`），"未表态"与"明确桌面"就再也区分不开，
 * 兜底逻辑会永远走进"桌面"分支。
 */
const props = withDefaults(
    defineProps<{
        sessionId: string;
        /**
         * 视口是否仍处于移动断点。**不设默认值**：`undefined` = 调用方未表态，由组件自取视口真值
         * （见下方 `isMobileNow`）。显式传值只作**覆盖**。
         *
         * task-116：本组件是 **dock 的移动替身**，不是第二套面板宿主 —— 它的 `ChatPanel`
         * 会再挂一份 `SessionContextPanel`，而正文节点的 `data-testid="session-settings-expanded"`
         * 与桌面 dock 里那份同名。桌面分支的 dock 与本组件同时在场 ⇒ 同名节点 2 个。
         *
         * task-124（D-979）：默认值曾经是 `true`，于是"桌面父组件漏传"= 静默失效（永远当作移动端，
         * 永远收不了口）。改成 `undefined` + 组件内 `useMediaQuery` 兜底后，**漏传不再是静默退化**：
         * 真栈浏览器里按真实视口判定，单测/jsdom 里退回 `true` 保持既有移动语义。
         */
        isMobile?: boolean;
    }>(),
    { isMobile: undefined },
);

const agentStore = useAgentStore(),
    sessionStore = useSessionStore(),
    membersStore = useSessionParticipantsStore();
const { t } = useI18n();
const open = ref(false);
/** BL-317b：独立的成员 sheet 开关（关闭后焦点由 `MobileMembersSheet` 还给触发按钮）。 */
const membersOpen = ref(false);
const memberRows = computed(() => membersStore.participants ?? []);
const memberCount = computed(() => memberRows.value.length);
const memberMentionTotal = computed(() =>
    memberRows.value.reduce((sum, row) => sum + (row.readCursor?.mentionCount ?? 0), 0),
);
/**
 * 前 3 位成员的首字（移动端成员入口的叠头像）。
 *
 * <p><b>task-292 / D-1142 ②</b>：这里原来自己写了一份
 * `.trim().slice(0, 1).toUpperCase() || "?"` —— 与共享的 `participantInitials` 是**两份
 * 实现**，且行为并不等价：自写版对「纯标点名 / 代理对 / 占位文案」都不处理。全仓本应
 * 只有一处产生缩写（这正是 `participantInitials.ts` 存在的理由），故改调共享函数。</p>
 *
 * <p>回退文案用 `t("workspace.participantUnknownName")`，与 `ParticipantRow.vue:136` /
 * `MessageItem.vue:140` / `actorView.ts:23` 全部同源 —— 自写版硬编码 `"?"` 是第二处隐藏
 * 差异：那意味着「无名字」在这块 UI 上显示 `?`、在成员面板上显示「未知用户」，同一个人
 * 两处不同样。</p>
 */
const memberAvatarInitials = computed(() =>
    memberRows.value
        .slice(0, 3)
        .map((row) => participantInitials(row.displayName, t("workspace.participantUnknownName"))),
);
const membersEntryLabel = computed(() =>
    memberMentionTotal.value > 0
        ? t("workspace.membersEntryLabelWithMentions", {
              count: memberCount.value,
              mentions: memberMentionTotal.value,
          })
        : t("workspace.membersEntryLabel", { count: memberCount.value }),
);
watch(
    () => props.sessionId,
    (id) => {
        if (id) void membersStore.ensureLoaded(id);
    },
    { immediate: true },
);
/**
 * task-116 / task-124 收口：跨断点必须把替身撤掉 —— 而且必须是**结构性**的。
 *
 * 第 3 种「看着互斥其实不互斥」：`md:hidden` 只隐藏**触发器**（本组件模板根 `div` 与浮动按钮），
 * 不收回**已经打开的内容** —— reka 的 `SheetContent` 在 `open` 为真时照常渲染（且被 teleport 到
 * body）。于是「移动端打开会话设置 → 视口拉宽到 ≥768」会同时留下：① 本 sheet 内的
 * `ChatPanel(isMobile=true)` → `SessionContextPanel`；② 桌面分支 `WorkspaceWorkbench` 的 dock
 * `#context` 槽 → 另一份 `SessionContextPanel`。两份正文都带 `session-settings-expanded`。
 *
 * **两层，职责分开**（task-124）：
 * 1. **渲染层 = 结构性互斥**：模板里 `SheetContent` 由 `isMobileNow` 门控 ⇒ 桌面视口下正文
 *    **结构上不存在**，与"有没有人记得写 watch"无关。这是**不变量**。（`open` 不参与这道闸门，
 *    开关仍由 reka `Sheet` 自己管 —— 见模板注释。）
 * 2. **状态层 = 副作用收口**（下面这个 watch）：跨断点时把 `open`/`membersOpen` 归位，让焦点归还
 *    与关闭动画按原逻辑走。
 *
 * ⚠️ 残留（不是漏，是刻意）：**桌面视口下 `open` 仍可能为 `true`**（例如 `toggle()` 被程序调用）。
 * 它不再渲染正文，只表示"这个替身的内部开关状态"。判断重复时看 DOM 里的
 * `session-settings-expanded` 个数，不要拿 `open` 当真值。
 *
 * 机器判据：`__tests__/sessionSettingsExpandedSameScreen.spec.ts`（同屏计数，真挂正文）。
 */
/**
 * 自取视口的**能力探测**：光看 `typeof window.matchMedia === "function"` 会被 jsdom 骗 ——
 * jsdom 提供 `matchMedia` 桩，但**任何查询都恒返回 `matches: false`**（不评估查询）。所以探一条
 * 恒真查询 `(min-width: 0px)`：
 * - 真浏览器 ⇒ `true` ⇒ 视口可自取；
 * - jsdom 桩 / 项目里那种"只回答特定查询"的假实现 ⇒ `false` ⇒ **不采信**，退回移动语义。
 *
 * 这条探测是 task-124 的关键：没有它，"jsdom 里 `useMediaQuery` 恒 false（永远桌面）"会让所有
 * **直接挂载本组件、不传 `isMobile`** 的既有 spec 静默变成桌面语义 —— 那是拿默认值换一批假绿。
 */
const mediaQueriesEvaluate = (() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    try {
        return window.matchMedia("(min-width: 0px)").matches === true;
    } catch {
        return false;
    }
})();
const viewportIsMobile = mediaQueriesEvaluate ? useMediaQuery("(max-width: 767px)") : null;
/**
 * 生效中的"是否移动断点"：prop 显式给了就用 prop（应用内的权威来源，`WorkspaceView` 一直传）；
 * 没给才自取视口，视口也取不到（jsdom/假 matchMedia）就按**移动端**——保持本组件的历史语义。
 */
const isMobileNow = computed(
    () => props.isMobile ?? (viewportIsMobile ? viewportIsMobile.value : true),
);
watch(isMobileNow, (mobile) => {
    if (mobile) return;
    open.value = false;
    membersOpen.value = false;
});
const agentPrincipalId = computed(
    () =>
        sessionStore.sessions.find((session) => session.id === props.sessionId)?.agentPrincipalId ??
        null,
);

/**
 * PLAN-0342 审查修复: mirror ChatPanel's session-scoped filter. A pending
 * approval from another session must not disable this sheet's outside-click
 * dismissal — the approval modal only renders for this sheet's session.
 */
const approvalPending = computed(() =>
    agentStore.agentState.pendingApprovals.some(
        (approval) =>
            approval.sessionId === props.sessionId &&
            (approval.state === undefined ||
                approval.state === "pending" ||
                approval.state === "dispatch_unknown"),
    ),
);

function toggle() {
    open.value = !open.value;
}

/**
 * PLAN-0342 decision #14: while an approval is pending the sheet must not be
 * dismissed by the approval modal's pointer-down. reka treats the teleported
 * modal as "outside" and would otherwise close the sheet, unmounting the
 * ChatPanel (and the modal) between mousedown and mouseup so the click never
 * fires — the approval could never be submitted on mobile.
 */
function onPointerDownOutside(event: Event) {
    if (approvalPending.value) event.preventDefault();
}

defineExpose({ toggle });
</script>

<template>
    <div class="md:hidden">
        <button
            class="fixed bottom-4 right-4 z-30 size-12 rounded-full bg-primary text-primary-foreground shadow-lg flex items-center justify-center"
            :title="t('chat.titleChat')"
            :aria-label="t('common.openChat')"
            data-testid="mobile-chat-open"
            @click="toggle"
        >
            <MessageCircle class="size-5" aria-hidden="true" />
        </button>
        <Sheet :open="open" @update:open="(v) => (open = v)">
            <!--
            BL-405（W9 390px 走查）：`SheetContent` 基础串里有 `data-[side=bottom]:h-auto`，
            arbitrary variant 带来的 `[data-side="bottom"]` 属性选择器让它比裸 `h-[75vh]`
            多一层特异性（0,2,0 > 0,1,0），于是 75vh 一直被 auto 覆盖、内容把 sheet 撑到
            1.61× 视口（实测 1360.56px / 844px）。修法：用**同 variant** 的
            `data-[side=bottom]:h-[75vh]` 让 tailwind-merge 顶掉基础串的 `h-auto`（同组冲突、
            后者胜），再补 `max-h-[75vh]` 作无对抗类的硬兜底。
        -->
            <!--
                task-124：**结构性互斥**的唯一闸门 —— 只看"这个视口还需不需要移动替身"。
                `open` 的开关仍由 reka `Sheet` 自己管（真 `SheetContent` 只在 open 为真时挂载并
                teleport；这里不再叠一层 `open`，否则 `SheetContent` 会晚一个 tick 才出现，
                把"打开后才有人 emit pointerDownOutside"的既有调用方变成时序陷阱）。
                桌面视口下这个替身**结构上不存在** ⇒ 不可能再挂一份 `SessionContextPanel`，
                与"父组件有没有记得传 `isMobile`"无关（漏传由 `isMobileNow` 自取视口兜底）。
            -->
            <SheetContent
                v-if="isMobileNow"
                side="bottom"
                class="h-[min(75dvh,calc(100dvh-2rem))] max-h-[min(75dvh,calc(100dvh-2rem))] p-0 gap-0 data-[side=bottom]:h-[min(75dvh,calc(100dvh-2rem))]"
                data-testid="mobile-chat-sheet"
                @pointer-down-outside="onPointerDownOutside"
            >
                <SheetHeader class="px-4 pt-3 pb-2 text-left border-b">
                    <div class="flex min-w-0 items-center gap-2">
                        <SheetTitle>对话</SheetTitle>
                        <!--
                            BL-317b（IM 调研 §1）：移动端会话标题区就是这份 sheet 的头 —— 成员入口
                            放在这里（头像堆叠 + 人数 + 聚合 @N），而不是隐藏的桌面会话列。
                            溢出菜单入口保留作兜底（BL-317）。
                        -->
                        <button
                            type="button"
                            class="flex min-h-[44px] min-w-[44px] items-center gap-1.5 rounded px-1 text-xs text-muted-foreground transition-colors hover:bg-accent"
                            data-testid="members-entry-mobile"
                            :aria-label="membersEntryLabel"
                            :title="membersEntryLabel"
                            aria-haspopup="dialog"
                            :aria-expanded="membersOpen"
                            @click="membersOpen = true"
                        >
                            <span class="flex -space-x-1.5" aria-hidden="true">
                                <span
                                    v-for="(initial, index) in memberAvatarInitials"
                                    :key="`avatar-${index}`"
                                    data-testid="members-entry-avatar"
                                    class="flex size-5 items-center justify-center rounded-full border bg-muted text-xs leading-none font-medium text-foreground/70"
                                    >{{ initial }}</span
                                >
                            </span>
                            <span
                                v-if="memberCount > 0"
                                class="tabular-nums"
                                data-testid="members-entry-count"
                                >{{ memberCount }}</span
                            >
                            <span
                                v-if="memberMentionTotal > 0"
                                class="rounded-full bg-primary px-1.5 py-0.5 text-xs leading-none text-primary-foreground"
                                data-testid="members-entry-mentions"
                                >@{{ memberMentionTotal }}</span
                            >
                        </button>
                        <span
                            data-testid="mobile-session-agent"
                            class="max-w-44 truncate rounded border px-1.5 py-0.5 text-xs text-muted-foreground"
                            :title="agentPrincipalId ?? t('workspace.agentUnbound')"
                        >
                            {{
                                agentPrincipalId
                                    ? `${t("workspace.activeAgent")} · ${agentPrincipalId.slice(0, 8)}`
                                    : t("workspace.agentUnbound")
                            }}
                        </span>
                    </div>
                    <SheetDescription
                        >在当前 workspace 中与 Agent 对话。工具绑定当前
                        workspace。</SheetDescription
                    >
                </SheetHeader>
                <!-- BL-317b：独立成员 sheet（覆盖式），正文复用 SessionParticipantsPanel。 -->
                <MobileMembersSheet
                    :open="membersOpen"
                    :session-id="sessionId"
                    @close="membersOpen = false"
                />
                <div class="flex-1 min-h-0 flex flex-col">
                    <!-- PLAN-0626 M2: mobile has no dock, so the session settings keep
                         expanding in place inside this sheet. -->
                    <ChatPanel
                        v-if="open"
                        :session-id="sessionId"
                        tool-mode="workspace"
                        :is-mobile="true"
                    />
                </div>
            </SheetContent>
        </Sheet>
    </div>
</template>
