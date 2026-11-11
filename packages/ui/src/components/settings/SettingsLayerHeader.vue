<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { SettingsLayer } from "../../lib/settingsIa";
import {
    Breadcrumb,
    BreadcrumbItem,
    BreadcrumbLink,
    BreadcrumbList,
    BreadcrumbPage,
    BreadcrumbSeparator,
} from "../ui/breadcrumb";

/**
 * PLAN-0752 T1.1b：层标题 + 面包屑，实例 / 用户两层归一。
 *
 * task-253：**工作区层不再是设置区的一层**（全局设置只有实例/用户，工作区设置在各工作区内、
 * 且不再复用本组件）—— 所以这里只认两层，第三分支随该口径一起删除，不留死代码。
 *
 * <p>视觉重量是**可判定**的（design.md §5.2）：层标题 <code>text-2xl font-semibold</code>
 * （24px/600）、sticky 固定；域标题在域页是 18px，条目 14px——所以「层 > 域 > 条目」不靠
 * 审美判断，靠这三条阈值。改这里的字号前先读 V20。</p>
 *
 * <p>PLAN-0762 T1.2 + T3.3：面包屑从 `" › "` 文本拼接换成 vendor 的 `Breadcrumb` 组件族
 * （`src/components/ui/breadcrumb`，分隔符由 `BreadcrumbSeparator` 的 `ChevronRight` 提供，
 * 不再保留第二套文本分隔）。**可寻址性与文字不变**：`settings-breadcrumb` /
 * `settings-layer-title` 两个 testid、`aria-label`、末段 `aria-current="page"`、以及
 * 「根 → 层 →（可选）域」三段文案与根链接都按原样保留；层文案映射见 `LAYER_CRUMB_KEYS`
 * （实例 / 用户 / workspace-default 三层都在册，故也是 T3.3 的落地处）。</p>
 */
const props = defineProps<{
    layer: SettingsLayer;
    /** 当前域显示名；空 = 层首页（面包屑只有两段）。 */
    domain?: string;
    summary?: string;
}>();

const { t } = useI18n();

/**
 * PLAN-0766（task-160）：层标题/面包屑必须认第三层。用映射表而不是三元链 ——
 * 上一版写成 instance ? ... : user，新增层时会安安静静地显示成「用户配置」
 * （第一次截图实测就是这么错的：/settings/workspace-default/rag 顶着「用户配置」）。
 */
const LAYER_TITLE_KEYS: Record<SettingsLayer, string> = {
    instance: "settings.ia.layerInstance",
    "workspace-default": "settings.ia.layerWorkspaceDefault",
    user: "settings.ia.layerUser",
};
const LAYER_CRUMB_KEYS: Record<SettingsLayer, string> = {
    instance: "settings.ia.layerInstanceShort",
    "workspace-default": "settings.ia.layerWorkspaceDefault",
    user: "settings.ia.layerUserShort",
};

const layerTitle = computed(() => t(LAYER_TITLE_KEYS[props.layer]));
const layerCrumb = computed(() => t(LAYER_CRUMB_KEYS[props.layer]));
</script>

<template>
    <header
        data-testid="settings-layer-header"
        class="sticky top-0 z-10 border-b bg-background/95 backdrop-blur"
    >
        <div class="mx-auto w-full max-w-6xl px-6 pt-4 pb-3">
            <Breadcrumb
                data-testid="settings-breadcrumb"
                :aria-label="t('settings.ia.breadcrumbLabel')"
                class="text-muted-foreground"
            >
                <BreadcrumbList class="gap-1 text-[11px]">
                    <BreadcrumbItem>
                        <BreadcrumbLink
                            as-child
                            class="underline-offset-4 hover:text-foreground hover:underline"
                        >
                            <router-link to="/settings">{{
                                t("settings.ia.breadcrumbRoot")
                            }}</router-link>
                        </BreadcrumbLink>
                    </BreadcrumbItem>
                    <BreadcrumbSeparator class="text-border [&>svg]:size-3" />
                    <!-- 层首页：层段即当前页（aria-current 由 BreadcrumbPage 提供）。 -->
                    <BreadcrumbItem v-if="!domain">
                        <BreadcrumbPage class="font-medium">{{ layerCrumb }}</BreadcrumbPage>
                    </BreadcrumbItem>
                    <!-- 域页：层段是可回溯的父级（不带 aria-current），域段才是当前页。 -->
                    <template v-else>
                        <BreadcrumbItem>
                            <span class="font-medium text-foreground">{{ layerCrumb }}</span>
                        </BreadcrumbItem>
                        <BreadcrumbSeparator class="text-border [&>svg]:size-3" />
                        <BreadcrumbItem>
                            <BreadcrumbPage class="font-medium">{{ domain }}</BreadcrumbPage>
                        </BreadcrumbItem>
                    </template>
                </BreadcrumbList>
            </Breadcrumb>
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
