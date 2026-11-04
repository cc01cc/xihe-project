<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import BaseModal from "../../../../components/shared/BaseModal.vue";
import type { ProviderBindingGuideReason } from "../composables/ensureProviderBinding";

/**
 * C1（2026-11-04 用户裁定）：裸会话发送前的引导弹窗。
 *
 * 不静默失败：守卫（`ensureProviderBinding`）在发送前拦下，这里给两条出路 ——
 * 「自动绑定」重试 CP 的 `bind-defaults`（方案 A：只覆盖有模型身份的情形），
 * 「去设置」跳配置页手动绑定。`profile_conflict` 时自动绑必然再失败，按钮仍可点
 * （重试一次给出同样引导），但正文说明原因，避免用户以为按钮坏了。
 */
const props = withDefaults(
    defineProps<{
        show: boolean;
        reason?: ProviderBindingGuideReason;
        detail?: string | null;
    }>(),
    {
        reason: "provider_required",
        detail: null,
    },
);

const emit = defineEmits<{
    close: [];
    retry: [];
    settings: [];
}>();

const { t } = useI18n();

const body = computed(() =>
    props.reason === "profile_conflict"
        ? t("chat.providerBindingGuideProfileConflict")
        : t("chat.providerBindingGuideProviderRequired"),
);
</script>

<template>
    <BaseModal :show="show" :title="t('chat.providerBindingGuideTitle')" @close="emit('close')">
        <p
            data-testid="provider-binding-guide-body"
            class="text-sm leading-relaxed text-muted-foreground"
        >
            {{ body }}
        </p>
        <p
            v-if="detail"
            data-testid="provider-binding-guide-detail"
            class="mt-2 break-all text-xs text-muted-foreground/80"
        >
            {{ detail }}
        </p>
        <div class="mt-5 flex justify-end gap-2">
            <Button
                variant="outline"
                data-testid="provider-binding-guide-settings"
                @click="emit('settings')"
            >
                {{ t("chat.providerBindingGuideSettings") }}
            </Button>
            <Button data-testid="provider-binding-guide-retry" @click="emit('retry')">
                {{ t("chat.providerBindingGuideRetry") }}
            </Button>
        </div>
    </BaseModal>
</template>
