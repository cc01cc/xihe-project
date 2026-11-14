<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { ShieldAlert } from "@lucide/vue";
import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { defaultLayerPath } from "../../lib/settingsIa";

/**
 * PLAN-0752 T1.5 / V4：层存在但当前账号无权（实例层需要 cap:instance:admin）⇒ 403 视图。
 * 复用既有设置页的卡片模式，不白屏；本视图**不发起**任何 /config 请求（V4 的断言）。
 *
 * <p>task-227 ⑨ 类 H-11：手搓 `<section class="mx-auto max-w-xl rounded-lg border p-6">` + h2 + p
 * 换成 vendor `Alert` 族。判据是**行为**不是外形：`Alert` 自带 `role="alert"`，而修前那块
 * section 没有任何 role/aria-live ⇒ 权限拒绝不会被屏幕阅读器播报。403 是**阻断态**，与
 * `SettingsPermissionGate` 的 `no-atom` 信息条（`role="status"`）语义相反，两者不许合并。
 * `AlertTitle` 只渲染 div（无 `as`）⇒ 标题语义仍由里层 h2 承担，别在换件时降级成纯文本。</p>
 */
const { t } = useI18n();
const backPath = defaultLayerPath("user");
</script>

<template>
    <Alert data-testid="settings-forbidden" class="mx-auto max-w-xl p-6">
        <ShieldAlert class="size-4 text-muted-foreground" aria-hidden="true" />
        <AlertTitle class="text-lg font-medium">
            <h2>{{ t("settings.ia.forbiddenTitle") }}</h2>
        </AlertTitle>
        <AlertDescription class="mt-2 text-sm text-muted-foreground">
            {{ t("settings.ia.forbiddenBody") }}
        </AlertDescription>
        <!-- Alert 是 grid（图标列 + 内容列）⇒ 出口按钮显式落内容列，否则会掉到图标下方独占一行。 -->
        <div class="col-start-2 mt-2">
            <Button variant="outline" as-child>
                <router-link :to="backPath">{{ t("settings.ia.backToUserLayer") }}</router-link>
            </Button>
        </div>
    </Alert>
</template>
