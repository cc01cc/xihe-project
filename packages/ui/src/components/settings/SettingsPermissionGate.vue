<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Info, ShieldAlert } from "@lucide/vue";
import { formatPermissionAtom } from "../../lib/permissionAtomLabels";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";

/**
 * PLAN-0752 T4.4：设置区两个**不同**的权限面，必须长得不一样。
 *
 * <p>用户裁定（2026-11-10）：**不许把「无 atom」当成「403」**。</p>
 * <ul>
 *   <li>`no-atom` —— 该页在 CP 侧根本没有权限原子（audit / monitoring / knowledge）：
 *       内容按归属自动收窄，空列表 ≠ 没权限，**不会** 403。用信息条（非阻断、可继续用页面）。</li>
 *   <li>`atom-denied` —— 该页有 atom 而这名账号没被授予（data 的 `WRITE_INSTANCE_CONTENT`、
 *       凭据的 `credential_manage` 等）：这是**授权**问题不是功能缺失，用 403 卡片并按需阻断请求。</li>
 * </ul>
 *
 * <p>两者用不同的 data-testid（`settings-no-atom-notice` / `settings-atom-denied`）与不同图标/配色，
 * 证据与断言都靠它区分；不允许一个组件「看起来像权限不足」地提示无 atom 的页面。</p>
 */
const props = defineProps<{
    variant: "no-atom" | "atom-denied";
    /** 缺失的 atom 名（仅 atom-denied 用），用于把「缺什么」写进界面。 */
    atom?: string;
}>();

const { t } = useI18n();

/**
 * task-22 / P2-4：正文给「中文权限名 + 机器码」——中文名给用户读，机器码留给支持排查
 * （与 `lib/errorMessages.ts#humanizeErrorCode` 同口径：未知原子回退原码，绝不吞掉）。
 */
const atomLabel = computed(() => formatPermissionAtom(props.atom, t) || "—");
</script>

<template>
    <!--
        PLAN-0762 T1.3：两个警示块改用 vendor `components/ui/alert` 组件族。
        **语义不合并**：`no-atom` 仍是「非阻断信息条」，`atom-denied` 仍是「阻断式 403 卡片」；
        三个 data-testid 原样保号，正文仍走 `atomDeniedBody` 的 `{atom}` + `{code}` 两个占位
        （中文权限名给用户读、机器码给支持排查 —— task-22/P2-4 的口径原样保留）。

        唯一在组件之外动的一处：信息条把 vendor 默认的 `role="alert"` 显式改成 `role="status"`
        （浏览器会读出 `role`：信息条不是紧急告警，`alert` 会在每次进页时抢占播报；
        403 卡片保持 `role="alert"`，那才是阻断态）。attr 走 fallthrough 覆盖，不改 vendor 文件。
    -->
    <Alert
        v-if="variant === 'no-atom'"
        data-testid="settings-no-atom-notice"
        role="status"
        class="mb-4 rounded-md border-border bg-muted/40 px-3 py-2 text-xs leading-5 text-muted-foreground"
    >
        <Info class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <AlertDescription class="text-pretty text-xs leading-5 text-muted-foreground">
            <strong class="font-medium text-foreground">{{ t("settings.ia.noAtomTitle") }}</strong>
            {{ t("settings.ia.noAtomBody") }}
        </AlertDescription>
    </Alert>

    <Alert v-else data-testid="settings-atom-denied" class="mx-auto max-w-xl rounded-lg border p-6">
        <ShieldAlert class="size-4 text-muted-foreground" aria-hidden="true" />
        <!-- 标题层级保持 h2（换组件族前就是 h2；`AlertTitle` 只渲染 div，不带 `as` ⇒ 里面留 h2，
             免得「换组件」顺手把标题语义降级成纯文本）。 -->
        <AlertTitle class="text-lg font-medium">
            <h2>{{ t("settings.ia.atomDeniedTitle") }}</h2>
        </AlertTitle>
        <AlertDescription class="mt-2 text-sm text-muted-foreground">
            {{ t("settings.ia.atomDeniedBody", { atom: atomLabel, code: atom ?? "—" }) }}
            <p
                data-testid="settings-atom-denied-not-gap"
                class="mt-2 text-xs text-muted-foreground text-pretty"
            >
                {{ t("settings.ia.atomDeniedNotGap") }}
            </p>
        </AlertDescription>
    </Alert>
</template>
