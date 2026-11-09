<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { ShieldAlert } from "@lucide/vue";
import { Button } from "../../components/ui/button";
import { defaultLayerPath } from "../../lib/settingsIa";

/**
 * PLAN-0752 T1.5 / V4：层存在但当前账号无权（实例层需要 cap:instance:admin）⇒ 403 视图。
 * 复用既有设置页的卡片模式，不白屏；本视图**不发起**任何 /config 请求（V4 的断言）。
 */
const { t } = useI18n();
const backPath = defaultLayerPath("user");
</script>

<template>
    <section data-testid="settings-forbidden" class="mx-auto max-w-xl rounded-lg border p-6">
        <div class="flex items-center gap-2">
            <ShieldAlert class="size-4 text-muted-foreground" />
            <h2 class="text-lg font-medium">{{ t("settings.ia.forbiddenTitle") }}</h2>
        </div>
        <p class="mt-2 text-sm text-muted-foreground">{{ t("settings.ia.forbiddenBody") }}</p>
        <Button class="mt-4" variant="outline" as-child>
            <router-link :to="backPath">{{ t("settings.ia.backToUserLayer") }}</router-link>
        </Button>
    </section>
</template>
