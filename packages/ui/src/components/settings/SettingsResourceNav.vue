<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Badge } from "../ui/badge";
import AlertDialog from "../ui/alert-dialog/AlertDialog.vue";
import AlertDialogContent from "../ui/alert-dialog/AlertDialogContent.vue";
import AlertDialogHeader from "../ui/alert-dialog/AlertDialogHeader.vue";
import AlertDialogTitle from "../ui/alert-dialog/AlertDialogTitle.vue";
import AlertDialogDescription from "../ui/alert-dialog/AlertDialogDescription.vue";
import AlertDialogFooter from "../ui/alert-dialog/AlertDialogFooter.vue";
import AlertDialogCancel from "../ui/alert-dialog/AlertDialogCancel.vue";
import type { ResourceNavItem } from "../../lib/settingsIa";

const { t } = useI18n();

const props = defineProps<{
    /** 分组标签 i18n key（实例层「实例资源」/ 用户层「我的资源」）。 */
    groupLabelKey: string;
    items: ResourceNavItem[];
}>();

/**
 * PLAN-0752 T4.0/T4.1：左栏「资源」组。
 *
 * <p>**D7（用户 2026-11-10 裁定）：留位标缺口，不隐藏。** 后端没实现的资源（MCP 的实例/用户层、
 * 凭据的实例层、知识库）仍然出现在这里，只在右侧标「后端缺口 G1」这类代码；点击**不跳转**，
 * 弹出说明讲清缺什么——不给 404、也不静默无响应（mock v2 的 blockedNotice 同款做法）。</p>
 *
 * <p>缺口代码与说明文字都来自 i18n / audit §F，组件里不写死任何一句中文。</p>
 */
const gapItem = ref<ResourceNavItem | null>(null);

const gapDialogOpen = computed({
    get: () => gapItem.value !== null,
    set: (open: boolean) => {
        if (!open) gapItem.value = null;
    },
});

const gapCodes = computed(() => (gapItem.value?.gaps ?? []).join(" / "));

function openGap(item: ResourceNavItem) {
    gapItem.value = item;
}
</script>

<template>
    <div data-testid="settings-nav-resource-group" class="mt-3">
        <p
            data-testid="settings-nav-group-secondary"
            class="px-2 pb-1 text-[11px] text-muted-foreground"
        >
            {{ t(groupLabelKey) }}
        </p>
        <div class="space-y-0.5">
            <template v-for="item in items" :key="item.id">
                <router-link
                    v-if="item.path"
                    :to="item.path"
                    :data-testid="`settings-nav-resource-${item.id}`"
                    class="block min-h-[32px] truncate rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                >
                    {{ t(item.labelKey) }}
                </router-link>
                <button
                    v-else
                    type="button"
                    :data-testid="`settings-nav-resource-gap-${item.id}`"
                    :data-gap-codes="(item.gaps ?? []).join(',')"
                    class="flex min-h-[32px] w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                    @click="openGap(item)"
                >
                    <span class="min-w-0 flex-1 truncate">{{ t(item.labelKey) }}</span>
                    <Badge variant="outline" class="shrink-0 text-[10px]">
                        {{
                            (item.gaps ?? []).length
                                ? t("settings.ia.backendGapBadge", {
                                      code: (item.gaps ?? []).join(" / "),
                                  })
                                : t("settings.ia.backendGapBadgeGeneric")
                        }}
                    </Badge>
                </button>
            </template>
        </div>

        <AlertDialog v-model:open="gapDialogOpen">
            <AlertDialogContent v-if="gapItem" :data-testid="`settings-gap-dialog-${gapItem.id}`">
                <AlertDialogHeader>
                    <AlertDialogTitle>
                        {{ t("settings.ia.gapDialogTitle", { item: t(gapItem.labelKey) }) }}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                        <span v-if="gapCodes" class="mb-1 block font-mono text-[11px]">
                            {{ t("settings.ia.backendGapBadge", { code: gapCodes }) }}
                        </span>
                        {{ gapItem.gapNoteKey ? t(gapItem.gapNoteKey) : "" }}
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel data-testid="settings-gap-dialog-dismiss">
                        {{ t("settings.ia.gapDialogDismiss") }}
                    </AlertDialogCancel>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    </div>
</template>
