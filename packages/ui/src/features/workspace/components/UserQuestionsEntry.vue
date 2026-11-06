<script setup lang="ts">
/**
 * PLAN-0660 T5.21（M5-D）—— 待答问题的**入口**：B-7 裁定的「全局导航入口」落在侧边栏。
 *
 * 为什么是侧边栏（而不是某个 workspace 面板）：`user_questions` 是**用户级**的
 * （`spec/session/user-channel.md` §4：只按 Bearer 认证、**不带 workspace 上下文**），而侧边栏
 * 是登录后唯一跨 workspace 常驻的壳，且用户通道本就挂在 `AppLayout` —— 入口与数据源同生命周期，
 * 切 workspace 不会让"待答"凭空消失或错位。
 *
 * 为什么零态不占位（`v-if="hasPending"`）：注意力预算（DEV-011 §10）里这是 L2 可操作面、低频；
 * 常驻一个空入口既抢视觉权重，又会让壳多一行无信息的占位。有欠答时才出现，且带服务端
 * `pendingCount` 徽标（不本地累加，见 T5.19）。
 *
 * TODO(container)：B-7 的另一半「workspace 面板内嵌」**未接**——现有 workspace 侧容器
 * （dock tabs 经 `DockTabId` 封闭集持久化、会话 monitor、设置页 tab）全部是 session/workspace
 * 作用域，把用户级投影塞进任一处都会谎报范围。缺的是「一个 workspace 作用域内、语义上允许
 * 呈现跨会话用户级待办的容器」这一决策，不在本 lane 自行发明。
 *
 * 列表**内联展开**在侧边栏里（不新开顶层导航、不弹模态）：从入口到作答到行消失是一条闭环，
 * 中途不跳页。
 */
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { ChevronDown, MessageCircleQuestion } from "@lucide/vue";
import { storeToRefs } from "pinia";
import { useUserQuestionsStore } from "../stores/userQuestions";
import { questionErrorKey } from "../composables/userQuestionError";
import UserQuestionCard from "./UserQuestionCard.vue";
import type { UserQuestionView } from "../../../types/userQuestion";

const { t } = useI18n();
const store = useUserQuestionsStore();
const { items, pendingCount, loading, error, forbidden, hasPending } = storeToRefs(store);

const expanded = ref(false);
const submittingId = ref<string | null>(null);
/** 逐条提交失败：按问题 id 存已本地化的文案（一张卡失败不该把整列都标红）。 */
const errorById = ref<Record<string, string>>({});

const rows = computed(() => items.value ?? []);

async function submit(question: UserQuestionView, text: string): Promise<void> {
    submittingId.value = question.id;
    const { [question.id]: _cleared, ...rest } = errorById.value;
    errorById.value = rest;
    try {
        await store.answer(question.id, text);
    } catch (cause) {
        // 只映射成我们自己的文案：CP 的英文 detail 不上屏（T5.20）。
        errorById.value = { ...errorById.value, [question.id]: t(questionErrorKey(cause)) };
    } finally {
        submittingId.value = null;
    }
}
</script>

<template>
    <div v-if="hasPending" class="rounded-md border border-border/60 bg-muted/20">
        <button
            type="button"
            class="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm text-sidebar-foreground transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            data-testid="sidebar-user-questions"
            :aria-expanded="expanded"
            @click="expanded = !expanded"
        >
            <MessageCircleQuestion class="size-4 shrink-0" aria-hidden="true" />
            <span class="min-w-0 flex-1 truncate">{{ t("userQuestions.title") }}</span>
            <!-- 徽标取服务端 pendingCount（T5.19：不在本地累加，重连/多标签页才对得上）。 -->
            <span
                class="shrink-0 rounded-full bg-muted px-1.5 text-xs tabular-nums text-muted-foreground"
                data-testid="user-questions-badge"
                >{{ pendingCount }}</span
            >
            <ChevronDown
                class="size-3.5 shrink-0 transition-transform"
                :class="expanded ? 'rotate-180' : ''"
                aria-hidden="true"
            />
        </button>

        <div
            v-if="expanded"
            class="space-y-2 border-t border-border/60 p-2"
            data-testid="user-questions-list"
        >
            <p
                v-if="loading && rows.length === 0"
                class="text-xs text-muted-foreground"
                data-testid="user-questions-loading"
            >
                {{ t("userQuestions.loading") }}
            </p>
            <p
                v-else-if="error"
                class="text-xs text-destructive"
                role="alert"
                data-testid="user-questions-load-error"
            >
                {{ forbidden ? t("userQuestions.errorForbidden") : t("userQuestions.loadFailed") }}
            </p>
            <UserQuestionCard
                v-for="row in rows"
                :key="row.id"
                :question="row"
                :submitting="submittingId === row.id"
                :error-text="errorById[row.id]"
                @answer="submit(row, $event)"
            />
        </div>
    </div>
</template>
