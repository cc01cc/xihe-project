<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { ApiError } from "../../composables/api";
import {
    AlertDialog,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

/**
 * task-168（F-18）：设置区统一错误面，替换四页（roles/monitoring/config-locks/audit）
 * 把 `API error 404` / `MOCK_ENDPOINT_MISSING` / `Error: ...` 原始负载直渲页面的写法。
 *
 * 两类形态：
 * ① **后端缺口**（404 或 MOCK_ENDPOINT_MISSING）⇒ 中性虚线卡 + 「标缺口」解释弹窗 ——
 *   与 SettingsResourceNav 缺口条目同源（backendGapBadgeGeneric 徽标 + 说明弹窗），
 *   不重试、不渲染 code/detail/endpoint。
 * ② **一般错误** ⇒ 本地化文案（problem.code 命中映射时用映射，否则通用句；调用方也可传
 *   预本地化的 `message` 覆盖）+ 可选重试/刷新出口。绝不渲染 problem.detail 原文。
 */
const props = defineProps<{
    /** 捕获的原始异常；null/undefined ⇒ 不渲染。 */
    cause: unknown;
    /** 非缺口态时优先展示的预本地化文案（如 rolesError.* 的精细映射）。 */
    message?: string;
    /** 重试/刷新回调；缺省不渲染重试按钮。 */
    retry?: () => void;
    /** 重试按钮文案键（settings.errorSurface.retry / .refresh）。 */
    retryKey?: string;
}>();

const { t } = useI18n(),
    gapDialogOpen = ref(false),
    isGap = computed(() => {
        if (!(props.cause instanceof ApiError)) return false;
        return (
            props.cause.problem.status === 404 ||
            props.cause.problem.code === "MOCK_ENDPOINT_MISSING"
        );
    }),
    errorCopy = computed(() => {
        if (props.message) return props.message;
        const cause = props.cause;
        if (cause instanceof ApiError) {
            const code = cause.problem.code;
            if (code === "FORBIDDEN" || code === "AUTHORIZATION_REQUIRED") {
                return t("settings.errorSurface.forbidden");
            }
        }
        return t("settings.errorSurface.generic");
    });
</script>

<template>
    <!-- ① 后端缺口：中性虚线卡 + 解释弹窗（标缺口模式），不是错误红条。 -->
    <div
        v-if="cause && isGap"
        data-testid="settings-error-gap"
        role="status"
        class="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-dashed border-muted-foreground/40 bg-muted/30 px-3 py-2.5"
    >
        <span
            class="inline-flex items-center rounded-md border border-dashed px-1.5 py-0.5 text-xs font-medium text-muted-foreground"
        >
            {{ t("settings.ia.backendGapBadgeGeneric") }}
        </span>
        <div class="min-w-0 flex-1">
            <p class="text-sm font-medium">{{ t("settings.errorSurface.gapTitle") }}</p>
            <p class="mt-0.5 text-xs text-muted-foreground">
                {{ t("settings.errorSurface.gapBody") }}
            </p>
        </div>
        <Button
            variant="outline"
            size="sm"
            data-testid="settings-error-gap-more"
            class="shrink-0"
            @click="gapDialogOpen = true"
        >
            {{ t("settings.errorSurface.gapMore") }}
        </Button>
        <AlertDialog :open="gapDialogOpen" @update:open="gapDialogOpen = $event">
            <AlertDialogContent data-testid="settings-error-gap-dialog">
                <AlertDialogHeader>
                    <AlertDialogTitle>{{
                        t("settings.errorSurface.gapDialogTitle")
                    }}</AlertDialogTitle>
                    <AlertDialogDescription>
                        {{ t("settings.errorSurface.gapDialogBody") }}
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <Button
                        variant="outline"
                        data-testid="settings-error-gap-dismiss"
                        @click="gapDialogOpen = false"
                    >
                        {{ t("settings.errorSurface.dialogDismiss") }}
                    </Button>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    </div>

    <!-- ② 一般错误：本地化文案 + 可选重试出口；绝不渲染原始 detail / code。 -->
    <div
        v-else-if="cause"
        data-testid="settings-error-panel"
        role="alert"
        class="mb-4 flex items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
    >
        <span class="min-w-0">{{ errorCopy }}</span>
        <Button
            v-if="retry"
            variant="outline"
            size="sm"
            data-testid="settings-error-retry"
            class="shrink-0"
            @click="retry()"
        >
            {{ t(retryKey ?? "settings.errorSurface.retry") }}
        </Button>
    </div>
</template>
