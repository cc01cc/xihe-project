<script setup lang="ts">
import BackToChatButton from "./BackToChatButton.vue";
import SettingsNav from "./SettingsNav.vue";

/**
 * 设置区公共壳：**返回聊天 + 设置导航 + 页面容器**，三件套固定同序。
 *
 * <p>为什么要有它（task-36 ②）：设置区原本每个页面各自拼 `BackToChatButton` + `SettingsNav`，
 * 新加的 `RolesView` 漏了这两行 ⇒ 用户在 `/settings/roles` 里没有返回入口、也看不到设置导航，
 * 与 `ToolFacesView` / `AuditView` 行为不一致。抽成一个壳之后，「忘记加」这件事在结构上消失。</p>
 *
 * <p>容器类名可覆盖：角色页与配置页是 `max-w-6xl px-6`，工具分类/审计是 `max-w-5xl px-4`。
 * 传字符串而不是枚举，是为了让页面继续用仓库里已有的 Tailwind 写法，不引入第二套容器约定。</p>
 */
withDefaults(defineProps<{ containerClass?: string }>(), {
    containerClass: "mx-auto max-w-5xl px-4 py-6",
});
</script>

<template>
    <div data-testid="settings-page-shell">
        <BackToChatButton />
        <SettingsNav />
        <main :class="containerClass">
            <slot />
        </main>
    </div>
</template>
