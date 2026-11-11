<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Badge } from "../ui/badge";
import type { ResourceNavItem } from "../../lib/settingsIa";

const { t } = useI18n();

const props = defineProps<{
    /** 分组标签 i18n key（实例层「实例资源」/ 用户层「我的资源」）。 */
    groupLabelKey: string;
    items: ResourceNavItem[];
}>();

/**
 * D7（PLAN-0752，用户 2026-11-10）：后端没实现的资源**留位、不隐藏**；
 * P0-N-09（settings-ui-issue-inventory）：缺口项**不得与真链接同形**。
 *
 * <p>本卡（task-156）把两者合起来的形态定为「不可点的一行 + 说明」：缺口项不再是
 * button（D7 早期「点击弹说明」会让它看起来可点），说明改为**组级可见 hint** +
 * 条目 title 携带缺口细节；真入口才渲染 router-link。外观用「无 hover + 禁用光标 +
 * 虚线徽标」与真链接区分（灰度截图下也能分辨，N-09 判据）。</p>
 */
const gapItems = computed(() => props.items.filter((item) => !item.path));

function gapTitle(item: ResourceNavItem): string {
    const badge = item.gaps?.length
        ? t("settings.ia.backendGapBadge", { code: (item.gaps ?? []).join(" / ") })
        : t("settings.ia.backendGapBadgeGeneric");
    const note = item.gapNoteKey ? t(item.gapNoteKey) : "";
    return note ? badge + " · " + note : badge;
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
                    :data-testid="'settings-nav-resource-' + item.id"
                    class="block min-h-[32px] truncate rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                >
                    {{ t(item.labelKey) }}
                </router-link>
                <!-- 缺口项：不可点（无 click、aria-disabled），说明分别在组级 hint 与 title。 -->
                <div
                    v-else
                    :data-testid="'settings-nav-resource-gap-' + item.id"
                    :data-gap-codes="(item.gaps ?? []).join(',')"
                    :title="gapTitle(item)"
                    aria-disabled="true"
                    class="flex min-h-[32px] w-full cursor-not-allowed select-none items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground/60"
                >
                    <span class="min-w-0 flex-1 truncate">{{ t(item.labelKey) }}</span>
                    <Badge variant="outline" class="shrink-0 border-dashed text-[11px]">
                        {{
                            (item.gaps ?? []).length
                                ? t("settings.ia.backendGapBadge", {
                                      code: (item.gaps ?? []).join(" / "),
                                  })
                                : t("settings.ia.backendGapBadgeGeneric")
                        }}
                    </Badge>
                </div>
            </template>
        </div>
        <p
            v-if="gapItems.length"
            data-testid="settings-nav-gap-hint"
            class="mt-1 px-2 text-[11px] leading-relaxed text-muted-foreground"
        >
            {{ t("settings.ia.backendGapHint") }}
        </p>
    </div>
</template>
