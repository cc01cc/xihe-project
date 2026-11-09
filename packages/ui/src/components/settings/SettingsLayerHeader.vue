<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { SettingsLayer } from "../../lib/settingsIa";

/**
 * PLAN-0752 T1.1b：层标题 + 面包屑，三处（实例 / 用户 / 工作区）归一。
 *
 * <p>视觉重量是**可判定**的（design.md §5.2）：层标题 <code>text-2xl font-semibold</code>
 * （24px/600）、sticky 固定；域标题在域页是 18px，条目 14px——所以「层 > 域 > 条目」不靠
 * 审美判断，靠这三条阈值。改这里的字号前先读 V20。</p>
 */
const props = defineProps<{
    layer: SettingsLayer;
    /** 当前域显示名；空 = 层首页（面包屑只有两段）。 */
    domain?: string;
    summary?: string;
}>();

const { t } = useI18n();

const layerTitle = computed(() =>
    props.layer === "instance"
        ? t("settings.ia.layerInstance")
        : props.layer === "user"
          ? t("settings.ia.layerUser")
          : t("settings.ia.layerWorkspace"),
);

const layerCrumb = computed(() =>
    props.layer === "instance"
        ? t("settings.ia.layerInstanceShort")
        : props.layer === "user"
          ? t("settings.ia.layerUserShort")
          : t("settings.ia.layerWorkspaceShort"),
);

const crumbSeparator = " › ";
</script>

<template>
    <header
        data-testid="settings-layer-header"
        class="sticky top-0 z-10 border-b bg-background/95 backdrop-blur"
    >
        <div class="mx-auto w-full max-w-6xl px-6 pt-4 pb-3">
            <nav
                data-testid="settings-breadcrumb"
                aria-label="Breadcrumb"
                class="flex items-center gap-1 text-[11px] text-muted-foreground"
            >
                <router-link
                    to="/settings"
                    class="underline-offset-4 hover:text-foreground hover:underline"
                >
                    {{ t("settings.ia.breadcrumbRoot") }}
                </router-link>
                <span class="text-border" aria-hidden="true">{{ crumbSeparator }}</span>
                <span
                    :aria-current="domain ? undefined : 'page'"
                    class="font-medium text-foreground"
                >
                    {{ layerCrumb }}
                </span>
                <template v-if="domain">
                    <span class="text-border" aria-hidden="true">{{ crumbSeparator }}</span>
                    <span aria-current="page" class="font-medium text-foreground">{{
                        domain
                    }}</span>
                </template>
            </nav>
            <div class="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h1
                    data-testid="settings-layer-title"
                    class="text-2xl leading-tight font-semibold tracking-tight"
                >
                    {{ layerTitle }}
                </h1>
                <p v-if="summary" class="text-[11px] text-muted-foreground">{{ summary }}</p>
            </div>
            <slot />
        </div>
    </header>
</template>
