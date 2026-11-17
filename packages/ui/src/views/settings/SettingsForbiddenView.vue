<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { ShieldAlert } from "@lucide/vue";
import { formatPermissionAtom } from "../../lib/permissionAtomLabels";
import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { defaultLayerPath } from "../../lib/settingsIa";

/**
 * PLAN-0752 T1.5 / V4：层存在但当前账号无权 ⇒ 403 视图。
 * 复用既有设置页的卡片模式，不白屏；本视图**不发起**任何 /config 请求（V4 的断言）。
 *
 * <p>task-69：判据**是动作原子**，文案就必须按动作原子措辞。这一层拒绝的是
 * `READ_INSTANCE_CONTENT`（`stores/auth.ts:136` 镜像 CP `ConfigController.java:89-90` 的
 * `canReadInstanceContent()`；整域读 `:207-220`、meta 读 `:319` 同源），**不是**能力位
 * 「实例管理员能力」—— 两者互不蕴含（`SettingsDomainView.vue:77-86` 的①②）。按能力位措辞会
 * 对「持能力位、无原子」的账号说假话，而那一格正是 UI 必须拒绝的格。<b>判据不动</b>（原子口径是
 * `D-1521 M-1=B` 的裁定结果），本视图只把**缺的是哪个原子**写进界面。</p>
 *
 * <p>口径与 `components/settings/SettingsPermissionGate.vue:34` 的 `atom-denied` 对齐，不另造第二套：
 * `atomLabel` 走 `lib/permissionAtomLabels#formatPermissionAtom`（登记过给中文名、未登记**回退原码**，
 * 诚实优先），机器码另处原样印出（支持排查要「中文名 + 机器码」同时在屏）。</p>
 *
 * <p>task-227 ⑨ 类 H-11：手搓 `<section class="mx-auto max-w-xl rounded-lg border p-6">` + h2 + p
 * 换成 vendor `Alert` 族。判据是**行为**不是外形：`Alert` 自带 `role="alert"`，而修前那块
 * section 没有任何 role/aria-live ⇒ 权限拒绝不会被屏幕阅读器播报。403 是**阻断态**，与
 * `SettingsPermissionGate` 的 `no-atom` 信息条（`role="status"`）语义相反，两者不许合并。
 * `AlertTitle` 只渲染 div（无 `as`）⇒ 标题语义仍由里层 h2 承担，别在换件时降级成纯文本。</p>
 */
const props = withDefaults(
    defineProps<{
        /**
         * 缺失的动作原子机器码（与 CP `@PreAuthorize` / `holdsActionAtom` 原文一致，便于对账）。
         *
         * <p>缺省 = 实例层**读面**原子：本视图当前的**唯一**生产调用方（`SettingsDomainView` /
         * `SettingsGroupView`）用的都是它。留 prop 是因为视图本身不该替调用方断言判据 ——
         * 哪天出现第二条 403 面（写面/别的原子），调用方直接传，不必先改这份壳。</p>
         */
        atom?: string;
    }>(),
    { atom: "READ_INSTANCE_CONTENT" },
);

const { t } = useI18n();
const backPath = defaultLayerPath("user");
const atomLabel = computed(() => formatPermissionAtom(props.atom, t) || "—");
</script>

<template>
    <Alert data-testid="settings-forbidden" class="mx-auto max-w-xl p-6">
        <ShieldAlert class="size-4 text-muted-foreground" aria-hidden="true" />
        <AlertTitle class="text-lg font-medium">
            <h2>{{ t("settings.ia.forbiddenTitle", { atom: atomLabel }) }}</h2>
        </AlertTitle>
        <AlertDescription class="mt-2 text-sm text-muted-foreground">
            {{ t("settings.ia.forbiddenBody", { atom: atomLabel, code: props.atom }) }}
        </AlertDescription>
        <!-- Alert 是 grid（图标列 + 内容列）⇒ 出口按钮显式落内容列，否则会掉到图标下方独占一行。 -->
        <div class="col-start-2 mt-2">
            <Button variant="outline" as-child>
                <router-link :to="backPath">{{ t("settings.ia.backToUserLayer") }}</router-link>
            </Button>
        </div>
    </Alert>
</template>
