<script setup lang="ts">
import SectionShell from "../SectionShell.vue";
import SettingsShellScreen from "../settingsIa/SettingsShellScreen.vue";
</script>

<template>
    <SectionShell
        id="settings-shell"
        index="10"
        title="设置主框架：左栏「实例配置 / 用户配置」"
        description="左栏不再复用工作区侧栏：实例配置（域 12 个入口 / 实例运维 / 安全与权限）与用户配置（我的智能体 / 个人凭据 / 偏好与语言）两块并列；右栏是「域」入口打开后的域宫格。真组件 + mock 数据，不请求后端。"
    >
        <SettingsShellScreen />
    </SectionShell>
</template>
