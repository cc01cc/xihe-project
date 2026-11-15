<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { Info } from "@lucide/vue";

/**
 * task-5（D-1521 M-2=B）：实例层「能读、不能写」的信息条。
 *
 * <p>**为什么不复用 `settings-ws-default-readonly-notice`**：那个 testid 表达的是
 * 「缺 `MANAGE_WORKSPACE_DEFAULT_CONFIG`」（工作区默认层）。一个 testid 只能表达一种语义
 * （见 `SettingsDomainView` 里 task-31 的注释）—— 复用会让 e2e 的 `getByTestId` 命中相反含义。</p>
 *
 * <p>**为什么点名字母原子而不是笼统说「只读」**：CP 的写面门就是
 * `ConfigController.java:384/:392`（PUT/DELETE）与 `:572`（import）上的
 * `holdsActionAtom('WRITE_INSTANCE_CONTENT')`；用户拿着这句可以直接去找管理员授予，
 * 与 403 卡片点名原子的做法同源。</p>
 *
 * <p>**不是 403**：读面由另一个原子 `READ_INSTANCE_CONTENT`（`:89-90`）守，
 * 缺少写原子只降级为只读，页面照常取数。</p>
 */
defineProps<{
    /** 缺失的动作原子机器码（与 CP `@PreAuthorize` 原文一致，便于对账）。 */
    atom: string;
    /** 该原子的可读名（`settings.permissionAtom.*` 的求值结果）。 */
    label: string;
}>();

const { t } = useI18n();
</script>

<template>
    <div
        data-testid="settings-instance-readonly-notice"
        class="mt-3 flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs"
    >
        <Info class="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <div class="min-w-0 flex-1">
            <p class="font-medium">{{ t("settings.ia.instanceReadonlyTitle", { atom }) }}</p>
            <p class="mt-0.5 leading-relaxed text-muted-foreground">
                {{ t("settings.ia.instanceReadonlyDetail", { atom, label }) }}
            </p>
        </div>
    </div>
</template>
