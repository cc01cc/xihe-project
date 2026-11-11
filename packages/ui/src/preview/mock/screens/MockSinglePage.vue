<!--
  DEPRECATED(task-137-rev2)：D-914 ① 交付改为「真产品页面 + 网络层 mock」，本文件属更早的「静态设计稿单页」路线，已不再渲染也不再产出交付图；**保留不删**（Lead 口径：零删除，退役由 PLAN-0764 M1 合并时统一处理）。指标：task-137 rev2 的真实入口是 preview-real.html + src/preview/mock/api-server.ts。
-->
<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { SCHEMA_CATALOG } from "../data/schema-catalog";
import { LAYER_DOMAINS } from "../../../stores/config";
import { DOMAIN_LABEL_KEY } from "../../../lib/settingsIa";
import MockDomainCard from "./MockDomainCard.vue";

/**
 * task-127（D-903）：单页合一设计稿 —— 全部配置域字段级内容同页排布。
 * task-137（A）：字段中文 label 复用产品 i18n 键（settings.fieldXxx），无键走 fieldLabels 词典。
 * task-137（D-911）：用户层 9 域改为「实例默认 + 按人覆盖展开式」——默认折叠，展开才显示覆盖项。
 *
 * 结构：稿头 → 实例层 12 域（全量字段卡）→ 用户层 9 域（折叠清单 + 一个展开示例卡）。
 * 纪律：字阶只用 mk-* 四档；每个渲染字段带 `data-mock-field="{domain}:{key}"`，
 * check-mock-domains.mjs 据此做「schema 键 ⊆ 渲染键 + 无未译字段」对账。
 */

const { t } = useI18n();

const LAYER_TITLES: Record<string, string> = {
    instance: "全局默认（实例层）",
    user: "用户偏好（用户层）",
};

/** D-911 展开示例域：user-preference（theme / language 正是 D-899 后语言切换的落点）。 */
const USER_EXPANDED_DOMAIN = "user-preference";

/** 用户层按人覆盖的示例数据（覆盖值 → 稿面显示 + 「实例默认」对照）。 */
const USER_OVERRIDES: Record<string, Record<string, string>> = {
    "user-preference": { theme: "light", language: "en-US" },
};

const instanceBlocks = computed(() =>
    LAYER_DOMAINS.instance.map((domain) => ({
        domain,
        label: t(DOMAIN_LABEL_KEY[domain] ?? domain),
        fields: SCHEMA_CATALOG[domain] ?? [],
    })),
);

const userBlocks = computed(() =>
    LAYER_DOMAINS.user.map((domain) => ({
        domain,
        label: t(DOMAIN_LABEL_KEY[domain] ?? domain),
        fields: SCHEMA_CATALOG[domain] ?? [],
    })),
);

const expandedUserBlock = computed(() =>
    userBlocks.value.find((block) => block.domain === USER_EXPANDED_DOMAIN),
);

const expandedOverrides = USER_OVERRIDES[USER_EXPANDED_DOMAIN] ?? {};
</script>

<template>
    <div>
        <!-- 实例层：12 域全量字段 -->
        <section class="mb-14">
            <h2 class="mk-subtitle mb-1">{{ LAYER_TITLES.instance }}</h2>
            <p class="mk-caption mb-6 text-muted-foreground">
                {{ instanceBlocks.length }} 个配置域 · 字段级真实内容（全量）
            </p>
            <MockDomainCard
                v-for="block in instanceBlocks"
                :key="block.domain"
                :domain="block.domain"
                :label="block.label"
                :fields="block.fields"
            />
        </section>

        <!-- 用户层（D-911）：默认折叠清单 + 一个展开示例 -->
        <section class="mb-14">
            <h2 class="mk-subtitle mb-1">{{ LAYER_TITLES.user }}</h2>
            <p class="mk-caption mb-4 text-muted-foreground">
                {{ userBlocks.length }}
                个配置域默认折叠：全部继承实例默认，展开任一行才显示按人覆盖项（D-911）
            </p>

            <div class="rounded-lg border bg-card divide-y">
                <div
                    v-for="block in userBlocks"
                    :key="block.domain"
                    class="flex items-center gap-3 px-5 py-3"
                    :data-mock-domain="block.domain"
                >
                    <span class="mk-caption text-muted-foreground">
                        {{ block.domain === USER_EXPANDED_DOMAIN ? "▾" : "▸" }}
                    </span>
                    <span class="mk-body font-medium">{{ block.label }}</span>
                    <code class="mk-caption text-muted-foreground">{{ block.domain }}</code>
                    <span class="mk-caption text-muted-foreground">继承自实例默认</span>
                    <span class="mk-caption ml-auto text-muted-foreground">
                        {{ block.fields.length }} 项可覆盖
                    </span>
                </div>
            </div>

            <p class="mk-caption mt-4 text-muted-foreground">
                展开示例 · {{ expandedUserBlock?.label }} · 覆盖
                {{ Object.keys(expandedOverrides).length }} 项
            </p>
            <MockDomainCard
                v-if="expandedUserBlock"
                :domain="expandedUserBlock.domain"
                :label="expandedUserBlock.label"
                :fields="expandedUserBlock.fields"
                override
                :overrides="expandedOverrides"
            />
        </section>
    </div>
</template>
