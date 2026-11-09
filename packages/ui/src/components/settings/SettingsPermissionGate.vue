<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { Info, ShieldAlert } from "@lucide/vue";

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
defineProps<{
    variant: "no-atom" | "atom-denied";
    /** 缺失的 atom 名（仅 atom-denied 用），用于把「缺什么」写进界面。 */
    atom?: string;
}>();

const { t } = useI18n();
</script>

<template>
    <div
        v-if="variant === 'no-atom'"
        data-testid="settings-no-atom-notice"
        class="mb-4 flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs leading-5 text-muted-foreground"
    >
        <Info class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <span>
            <strong class="font-medium text-foreground">{{ t("settings.ia.noAtomTitle") }}</strong>
            {{ t("settings.ia.noAtomBody") }}
        </span>
    </div>

    <section
        v-else
        data-testid="settings-atom-denied"
        class="mx-auto max-w-xl rounded-lg border p-6"
    >
        <div class="flex items-center gap-2">
            <ShieldAlert class="size-4 text-muted-foreground" aria-hidden="true" />
            <h2 class="text-lg font-medium">{{ t("settings.ia.atomDeniedTitle") }}</h2>
        </div>
        <p class="mt-2 text-sm text-muted-foreground">
            {{ t("settings.ia.atomDeniedBody", { atom: atom ?? "—" }) }}
        </p>
        <p data-testid="settings-atom-denied-not-gap" class="mt-2 text-xs text-muted-foreground">
            {{ t("settings.ia.atomDeniedNotGap") }}
        </p>
    </section>
</template>
