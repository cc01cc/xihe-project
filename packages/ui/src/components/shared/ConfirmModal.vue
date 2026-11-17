<script setup lang="ts">
import { ref, watch } from "vue";
import { AlertCircle, CheckCircle, LoaderCircle } from "@lucide/vue";
import BaseModal from "./BaseModal.vue";

/**
 * task-150（D-1782 同族：UI 报告了它并不知道的结果）——为什么不能在点击时立刻置 succeeded：
 * 旧 `onConfirm` 把「用户点了确认」无条件当成「操作成功了」——异步删除失败也会先亮
 * "Operation completed"、1.5s 后自动关窗，真实错误落在窗外（KnowledgeBaseView.vue 的
 * `deleteError` 渲染在弹窗外面）。`succeeded` 这个命名本身就是歧义源：它读起来像「操作成功」。
 *
 * 现行契约（卡面形态①：confirm 返回 Promise，成功才置真）：
 * - `@confirm="fn"` 的 fn **返回 Promise**：resolve ⇒ 才置 `succeeded` + 1.5s 自动关窗；
 *   reject ⇒ **窗保持打开**、原因留在窗内（优先 `:error`，否则 reject 值兜底）、不自动关。
 * - fn 同步 / 不返回 Promise / 没绑 @confirm ⇒ 退回旧的「点击即成功」：组件无从得知异步
 *   结果时不谎报新语义，也不炸存量调用方。新调用方要拿到诚实语义，handler 必须在失败时 reject
 *   （或把文案传给 :error 后 reject）。
 * - 实现注记：Vue 的 `emit()` 不返回 handler 的返回值（vue 3.5.44 runtime-core `emit`
 *   只 `callWithAsyncErrorHandling` 不带回传），所以 `onConfirm` 要显式声明成 prop 才能
 *   拿到那个 Promise；模板 `@confirm="fn"` 的编译产物就是 `onConfirm` prop，两个现有
 *   调用方（KnowledgeBaseView / FileContextMenu）的绑定方式不变。
 */
const props = defineProps<{
    title: string;
    description?: string;
    show: boolean;
    loading?: boolean;
    confirmLabel?: string;
    cancelLabel?: string;
    destructive?: boolean;
    /**
     * 失败原因（留在窗内、关闭前可见）。confirm 的 Promise reject 时优先展示它 ——
     * 调用方在 catch 里把错误写到这个 prop，组件就不必从 reject 值猜文案。
     */
    error?: string | null;
    /**
     * confirm 处理函数。声明成 prop 才能拿到 `@confirm="fn"` 返回的 Promise：
     * resolve ⇒ 成功；reject ⇒ 失败留窗。可选项 —— 不传则维持旧的点击即成功行为。
     */
    onConfirm?: () => Promise<void> | void;
}>();

const emit = defineEmits<{
    confirm: [];
    cancel: [];
    close: [];
}>();

const autoCloseTimer = ref<ReturnType<typeof setTimeout> | null>(null),
    succeeded = ref(false),
    /**
     * 成功后的视觉保持位。调用方通常在 resolve 之前就把 `:show` 置 false 了
     * （如 `pendingDeleteId = null`），没有这一位，"Operation completed" 会被立刻隐藏；
     * `holdOpen` 让这扇窗撑到自己的定时关窗（BaseModal 吃 `show || holdOpen`）。
     */
    holdOpen = ref(false),
    busy = ref(false),
    lastError = ref<string | null>(null);

/** 代次守卫：等待期间用户关窗 / 取消 / 重开 ⇒ 迟到的 resolve / reject 不再属于这扇窗。 */
let confirmGeneration = 0;

function clearHold() {
    if (autoCloseTimer.value) clearTimeout(autoCloseTimer.value);
    autoCloseTimer.value = null;
    succeeded.value = false;
    holdOpen.value = false;
}

function succeed() {
    succeeded.value = true;
    holdOpen.value = true;
    autoCloseTimer.value = setTimeout(() => {
        autoCloseTimer.value = null;
        succeeded.value = false;
        holdOpen.value = false;
        emit("close");
    }, 1500);
}

async function handleConfirm() {
    if (busy.value) return;
    lastError.value = null;
    const handler = props.onConfirm;
    if (!handler) {
        // 没有可等的异步结果：维持旧行为（向后兼容），不谎报新语义。
        emit("confirm");
        succeed();
        return;
    }
    const gen = ++confirmGeneration;
    busy.value = true;
    try {
        await handler();
    } catch (e) {
        if (gen !== confirmGeneration) return;
        // 失败：不关窗、不置 succeeded；原因留在窗内（卡面边界：不许「留在窗外」）。
        lastError.value = props.error ?? (e instanceof Error ? e.message : String(e));
        return;
    } finally {
        if (gen === confirmGeneration) busy.value = false;
    }
    if (gen !== confirmGeneration) return;
    succeed();
}

function onCancel() {
    confirmGeneration += 1;
    busy.value = false;
    clearHold();
    emit("cancel");
    emit("close");
}

function onClose() {
    confirmGeneration += 1;
    busy.value = false;
    clearHold();
    emit("close");
}

/**
 * 重新打开（false → true）总是开新代次：上一扇窗的迟到结果、成功态、错误态全部作废。
 * 这里清掉挂着的自动关窗定时器是**承重**的 —— 若旧定时器在新窗口打开后才响，
 * 它 emit 的 close 会落到调用方的 @close 上（KnowledgeBaseView 是 cancelRemoveDoc），
 * 把刚打开的新确认面误关。
 */
watch(
    () => props.show,
    (v) => {
        if (v) {
            confirmGeneration += 1;
            busy.value = false;
            lastError.value = null;
            clearHold();
        }
    },
);
</script>

<template>
    <BaseModal :show="show || holdOpen" @close="onClose">
        <h3 class="text-base font-semibold mb-2">{{ title }}</h3>
        <p v-if="description" class="text-sm text-muted-foreground mb-4">{{ description }}</p>

        <!-- task-150：失败原因留在窗内（关闭前可见），不再等 1.5s 定时器把它盖到窗外 -->
        <div
            v-if="lastError"
            data-testid="confirm-error"
            role="alert"
            class="flex items-center gap-2 text-sm text-destructive mb-4"
        >
            <AlertCircle class="size-4 shrink-0" aria-hidden="true" />
            <span>{{ lastError }}</span>
        </div>

        <div
            v-if="succeeded"
            class="flex items-center gap-2 text-sm text-green-600 dark:text-green-400 mb-4"
        >
            <CheckCircle class="size-4" aria-hidden="true" />
            <span>Operation completed</span>
        </div>

        <div class="flex justify-end gap-2 pt-2">
            <button
                v-if="!succeeded"
                class="px-3 py-1.5 text-sm rounded border hover:bg-accent transition-colors"
                @click="onCancel"
            >
                {{ cancelLabel || "Cancel" }}
            </button>
            <button
                v-if="!succeeded"
                class="px-3 py-1.5 text-sm rounded transition-colors"
                :class="
                    destructive
                        ? 'bg-destructive text-destructive-foreground hover:opacity-90'
                        : 'bg-primary text-primary-foreground hover:opacity-90'
                "
                :disabled="loading || busy"
                @click="handleConfirm"
            >
                <LoaderCircle
                    v-if="loading || busy"
                    class="mr-1 inline-block size-3 animate-spin"
                    aria-hidden="true"
                />
                {{ confirmLabel || "Confirm" }}
            </button>
        </div>
    </BaseModal>
</template>
