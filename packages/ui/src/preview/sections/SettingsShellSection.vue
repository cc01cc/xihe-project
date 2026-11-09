<script setup lang="ts">
import SectionShell from "../SectionShell.vue";
import SettingsShellScreen from "../settingsIa/SettingsShellScreen.vue";
</script>

<template>
    <SectionShell
        id="settings-shell"
        index="10"
        title="设置主框架：层是外框（sticky 标题 + 面包屑），域是第二层"
        description="v2 按用户反馈重排：页面标题「实例配置 / 用户配置」24px、sticky，面包屑「设置 › 实例层」固定在上方；域卡片去掉阴影与大白底，只留边框，所以「层 > 域 > 条目」肉眼可判。左栏两块——实例（域 12 / 实例运维 2 / 安全与权限 3）与用户（域 9 / 我的资源 3，logging / approval-policy / job-policy 是 CP 矩阵不写用户层）；点击层标题切换层，标题与面包屑留在原位。真组件 + mock 数据，不请求后端。"
    >
        <SettingsShellScreen />
    </SectionShell>
</template>
