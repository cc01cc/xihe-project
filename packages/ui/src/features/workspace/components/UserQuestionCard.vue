<script setup lang="ts">
/**
 * PLAN-0660 T5.20（M5-D）：一条 `user_question` 的卡片。
 *
 * 契约来源：`docs/api/openapi.yaml` 的 `UserQuestionView`、`spec/session/user-channel.md` §5/§6。
 *
 * 三条硬约束：
 * 1. **四态视觉分开**：`pending` / `answered` / `expired` / `cancelled` 各有独立的状态文案 +
 *    `data-state`，不靠"看不出来就是已完成"糊过去。只有 `pending` 可输入。
 * 2. **`prompt` / `answer` 是不可信文本**（问题由 Agent 生成、答案由人填写），一律纯插值渲染，
 *    **禁止 `v-html`**；换行靠 `whitespace-pre-wrap` 而不是渲染 HTML。
 * 3. **不新增色值**：只用既有 token（`border-border` / `bg-muted` / `text-foreground` /
 *    `text-muted-foreground` / `text-destructive`）与既有圆角 `rounded-md`；正文口径 `text-sm`
 *    （14px）。DEV-011 §10 注意力预算：本卡是 L2 可操作面，**只有提交按钮**用强调色，其余中性；
 *    危险红仅用于"提交失败"这一处。
 *
 * 错误文案由**调用方**按 `ApiError.problem.code` 映射后传入（`errorText`）：CP 的英文 `detail`
 * 永不上屏，也不在本组件里猜错误码 —— 组件只负责显示。
 */
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Check, CircleSlash, Clock, XCircle } from "@lucide/vue";
import type { Component } from "vue";
import type { UserQuestionView } from "../../../types/userQuestion";

const props = defineProps<{
    question: UserQuestionView;
    /** 提交中（外部持有，用于禁用重复提交）。 */
    submitting?: boolean;
    /** 已映射成本地化文案的失败原因；空 = 无错误。 */
    errorText?: string;
}>();

const emit = defineEmits<{ answer: [text: string] }>();

const { t } = useI18n();

const draft = ref("");

const isPending = computed(() => props.question.state === "pending");
const canSubmit = computed(
    () => isPending.value && !props.submitting && draft.value.trim().length > 0,
);

/** 四态 → 状态文案 / 图标 / 色调。颜色只用既有 token 语义（中性 → 成功 → 失效）。 */
const STATES: Record<
    UserQuestionView["state"],
    { label: () => string; icon: Component; iconClass: string; cardClass: string }
> = {
    pending: {
        label: () => t("userQuestions.statePending"),
        icon: Clock,
        iconClass: "text-foreground",
        cardClass: "border-border/60 bg-muted/20",
    },
    answered: {
        label: () => t("userQuestions.stateAnswered"),
        icon: Check,
        iconClass: "text-muted-foreground",
        cardClass: "border-border/40 bg-muted/10",
    },
    expired: {
        label: () => t("userQuestions.stateExpired"),
        icon: XCircle,
        iconClass: "text-muted-foreground",
        cardClass: "border-dashed border-border/40 bg-transparent",
    },
    cancelled: {
        label: () => t("userQuestions.stateCancelled"),
        icon: CircleSlash,
        iconClass: "text-muted-foreground",
        cardClass: "border-dashed border-border/40 bg-transparent",
    },
};

const state = computed(() => STATES[props.question.state]);

/** `expires_at` 非 null 才是限时提问（`askTimed`）；阻塞式 `ask` 没有截止时间，不显示这一行。 */
const deadlineText = computed(() => {
    const raw = props.question.expiresAt;
    if (!raw) return "";
    const at = new Date(raw);
    if (Number.isNaN(at.getTime())) return "";
    return t("userQuestions.deadline", { time: at.toLocaleString() });
});

function submit(): void {
    if (!canSubmit.value) return;
    emit("answer", draft.value.trim());
}
</script>

<template>
    <div
        class="rounded-md border px-3 py-2.5 text-sm"
        :class="state.cardClass"
        data-testid="user-question-card"
        :data-state="question.state"
        :data-question-id="question.id"
        :data-submittable="isPending ? 'true' : undefined"
    >
        <div class="flex items-start gap-2">
            <component
                :is="state.icon"
                class="mt-0.5 size-4 shrink-0"
                :class="state.iconClass"
                aria-hidden="true"
            />
            <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span
                        class="text-xs font-medium text-muted-foreground"
                        data-testid="user-question-state"
                        >{{ state.label() }}</span
                    >
                    <span
                        v-if="deadlineText"
                        class="text-xs tabular-nums text-muted-foreground"
                        data-testid="user-question-deadline"
                        >{{ deadlineText }}</span
                    >
                </div>

                <!-- 不可信文本：纯插值 + pre-wrap，绝不 v-html。 -->
                <p
                    class="mt-1 break-words whitespace-pre-wrap text-foreground"
                    data-testid="user-question-prompt"
                >
                    {{ question.prompt }}
                </p>

                <template v-if="isPending">
                    <label
                        class="mt-2 block text-xs text-muted-foreground"
                        for="user-question-answer"
                    >
                        {{ t("userQuestions.answerLabel") }}
                    </label>
                    <textarea
                        id="user-question-answer"
                        v-model="draft"
                        class="mt-1 w-full resize-y rounded-md border border-border/60 bg-background px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                        rows="2"
                        :placeholder="t('userQuestions.answerPlaceholder')"
                        :disabled="submitting"
                        data-testid="user-question-input"
                    />
                    <div class="mt-2 flex items-center gap-2">
                        <button
                            type="button"
                            class="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                            :disabled="!canSubmit"
                            data-testid="user-question-submit"
                            @click="submit"
                        >
                            {{
                                submitting
                                    ? t("userQuestions.submitting")
                                    : t("userQuestions.submit")
                            }}
                        </button>
                    </div>
                </template>

                <!-- 结案后只读展示答案：`answer` 仅在 `answered` 时非空（§5 的封闭语义）。 -->
                <p
                    v-if="question.state === 'answered' && question.answer"
                    class="mt-2 break-words whitespace-pre-wrap text-muted-foreground"
                    data-testid="user-question-answer"
                >
                    {{ question.answer }}
                </p>

                <p
                    v-if="errorText"
                    class="mt-2 text-xs text-destructive"
                    role="alert"
                    data-testid="user-question-error"
                >
                    {{ errorText }}
                </p>
            </div>
        </div>
    </div>
</template>
