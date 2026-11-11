<!--
  DEPRECATED(task-137-rev2)：D-914 ① 交付改为「真产品页面 + 网络层 mock」，本文件属更早的「静态设计稿单页」路线，已不再渲染也不再产出交付图；**保留不删**（Lead 口径：零删除，退役由 PLAN-0764 M1 合并时统一处理）。指标：task-137 rev2 的真实入口是 preview-real.html + src/preview/mock/api-server.ts。
-->
<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { BookOpen, MessageSquare, Search, Settings as SettingsIcon } from "@lucide/vue";
import { LAYER_DOMAINS } from "../../../stores/config";
import { DOMAIN_LABEL_KEY } from "../../../lib/settingsIa";

/**
 * task-137（B）：**整窗构图** —— 设置稿放进真窗口，而不是「内容列 + 页底参考条」。
 *
 * Lead 2026-11-11 裁定（③ 批准，一点不改）：rail 56 + 设置左栏 256 + 内容列 + 主列底部聊天条 +
 * 右 dock 360；页底三条语义并入真实位置，不再另排参考区（同屏两个 rail 是错的）。
 *
 * 两种取景（同一个页面，靠 query 切换，SHOTS 各取一条）：
 *   · 默认 = 窗口固定 1920×1080（内容列内部滚动）→ 整窗视口图；
 *   · ?winlong=1 = 窗口高度随内容撑开（min-h 1080）→ 单页长图（保留 task-127 的交付口径）。
 */
const props = defineProps<{ tall?: boolean }>();

const { t } = useI18n();

const RAIL_ITEMS = [
    { key: "workspace", label: "工作区", icon: MessageSquare },
    { key: "library", label: "知识库", icon: BookOpen },
    { key: "settings", label: "设置", icon: SettingsIcon },
] as const;

/** 右 dock（库）：工作区里 dock 的默认页签之一，按真实位置贴右。 */
const LIB_ROWS = [
    { name: "product-manual.md", meta: "工作区库 · 128 行" },
    { name: "API 契约清单.md", meta: "工作区库 · 64 行" },
    { name: "评审记录-2026-11.md", meta: "用户库 · 42 行" },
];

const instanceDomains = LAYER_DOMAINS.instance;
const userDomains = LAYER_DOMAINS.user;
</script>

<template>
    <div
        data-mock-window
        class="mx-auto flex w-[1920px] overflow-hidden rounded-xl border bg-background"
        :class="props.tall ? 'min-h-[1080px]' : 'h-[1080px]'"
    >
        <!-- 全局 rail 56（D-899 后无语言控件） -->
        <aside class="flex w-[56px] shrink-0 flex-col items-center gap-1 border-r bg-muted/30 py-3">
            <span class="mk-caption mb-1 text-muted-foreground">Xihe</span>
            <button
                v-for="item in RAIL_ITEMS"
                :key="item.key"
                type="button"
                class="flex size-9 items-center justify-center rounded-md"
                :class="
                    item.key === 'settings'
                        ? 'bg-accent text-accent-foreground'
                        : 'text-muted-foreground'
                "
                :title="item.label"
            >
                <component :is="item.icon" class="size-4" />
            </button>
            <span
                class="mt-auto flex size-8 items-center justify-center rounded-full bg-muted mk-caption"
                >ZA</span
            >
        </aside>

        <!-- 设置左栏 256 -->
        <aside class="flex w-[256px] shrink-0 flex-col gap-4 border-r px-4 py-4">
            <h2 class="mk-subtitle">设置</h2>
            <nav class="flex min-h-0 flex-col gap-4 overflow-y-auto">
                <div>
                    <p class="mk-caption mb-1.5 text-muted-foreground">全局默认（实例层）</p>
                    <ul class="flex flex-col">
                        <li
                            v-for="(domain, index) in instanceDomains"
                            :key="domain"
                            class="mk-body rounded px-2 py-1"
                            :class="index === 0 ? 'bg-accent font-medium' : 'text-muted-foreground'"
                        >
                            {{ t(DOMAIN_LABEL_KEY[domain] ?? domain) }}
                        </li>
                    </ul>
                </div>
                <div>
                    <p class="mk-caption mb-1.5 text-muted-foreground">
                        用户偏好（用户层 · 默认折叠）
                    </p>
                    <ul class="flex flex-col">
                        <li
                            v-for="domain in userDomains"
                            :key="domain"
                            class="mk-body flex items-center gap-1.5 px-2 py-1 text-muted-foreground"
                        >
                            <span class="mk-caption">▸</span>
                            {{ t(DOMAIN_LABEL_KEY[domain] ?? domain) }}
                        </li>
                    </ul>
                </div>
            </nav>
        </aside>

        <!-- 内容列：顶部条 + 滚动区 + 主列底部聊天条 -->
        <main class="flex min-w-0 flex-1 flex-col">
            <header class="flex h-12 shrink-0 items-center gap-3 border-b px-6">
                <span class="mk-body font-medium">设置 · 全局默认</span>
                <span class="mk-caption text-muted-foreground">/ LLM 提供商</span>
                <span
                    class="ml-auto flex items-center gap-1.5 rounded-md border px-2 py-1 mk-caption text-muted-foreground"
                >
                    <Search class="size-3.5" /> 搜索设置
                </span>
            </header>

            <div
                class="min-h-0 flex-1 overflow-y-auto px-8 py-8"
                :class="props.tall ? 'overflow-visible' : ''"
            >
                <slot />
            </div>

            <footer class="flex h-14 shrink-0 items-center gap-3 border-t px-6">
                <div
                    class="mk-body flex h-9 flex-1 items-center rounded-md border bg-background px-3 text-muted-foreground"
                >
                    输入消息…（聊天在主列底部，同工作区布局）
                </div>
                <button type="button" class="mk-body rounded-md border px-3 py-1.5 font-medium">
                    发送
                </button>
            </footer>
        </main>

        <!-- 右 dock 360（库） -->
        <aside class="flex w-[360px] shrink-0 flex-col gap-3 border-l px-4 py-4">
            <div class="flex items-center justify-between">
                <span class="mk-body font-medium">库</span>
                <span class="mk-caption text-muted-foreground">工作区 / 用户</span>
            </div>
            <div
                class="mk-caption flex items-center gap-1.5 rounded-md border px-2 py-1 text-muted-foreground"
            >
                <Search class="size-3.5" /> 搜索库内容
            </div>
            <ul class="flex flex-col gap-2 overflow-y-auto">
                <li v-for="row in LIB_ROWS" :key="row.name" class="rounded-md border px-3 py-2">
                    <p class="mk-body font-medium">{{ row.name }}</p>
                    <p class="mk-caption text-muted-foreground">{{ row.meta }}</p>
                </li>
            </ul>
        </aside>
    </div>
</template>
