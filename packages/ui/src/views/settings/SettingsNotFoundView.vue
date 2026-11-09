<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import { Button } from "../../components/ui/button";
import { defaultLayerPath } from "../../lib/settingsIa";

/**
 * PLAN-0752 T1.5 / V3：层×域矩阵里不存在的组合 ⇒ 404 视图（不是 403、更不是空页）。
 * 入口分层（verify.md）：直链/书签走这里；UI 内可预见动作走 V26 拦截，两者不互替。
 */
const { t } = useI18n();
const route = useRoute();

/** 找不到页面时给一条**存在的**出口：按 URL 段判断原来想去哪一层。 */
const backPath =
    route?.path?.startsWith("/settings/user/") === true
        ? defaultLayerPath("user")
        : defaultLayerPath("instance");
</script>

<template>
    <section data-testid="settings-not-found" class="mx-auto max-w-xl rounded-lg border p-6">
        <h2 class="text-lg font-medium">{{ t("settings.ia.notFoundTitle") }}</h2>
        <p class="mt-2 text-sm text-muted-foreground">{{ t("settings.ia.notFoundBody") }}</p>
        <Button class="mt-4" variant="outline" as-child>
            <router-link :to="backPath">{{ t("settings.ia.backToDefault") }}</router-link>
        </Button>
    </section>
</template>
