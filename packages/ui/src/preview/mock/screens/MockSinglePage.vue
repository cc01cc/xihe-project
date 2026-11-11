<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { SCHEMA_CATALOG, type MockSchemaField } from "../data/schema-catalog";
import { MOCK_VALUES } from "../data/mockValues";
import { LAYER_DOMAINS } from "../../../stores/config";
import { DOMAIN_LABEL_KEY, SETTINGS_LAYERS } from "../../../lib/settingsIa";
import MockBottomStrips from "./MockBottomStrips.vue";

/**
 * task-127（D-903）：**单页合一设计稿** —— 用户三批评（内容没进稿 / 一个页面就够 / 全部放一起）。
 *
 * 结构：稿头（字阶表 + 来源对账）→ 设置区主体（实例层 12 域 + 用户层 9 域，字段级真实内容，
 * 键/类型/枚举来自 SCHEMA_CATALOG（CP config-schemas 生成物），值来自 MOCK_VALUES）→
 * 页底 rail/chat/库 三条同体系 strip（D-899 后 rail 无语言控件）。
 *
 * 纪律：字阶只用 mk-* 四档；每个渲染字段带 `data-mock-field="{domain}:{key}"`，
 * check-mock-domains.mjs 用它做「schema 键 ⊆ 渲染键」逐域对账。
 */

const { t } = useI18n();

const LAYER_TITLES: Record<string, string> = {
    instance: "全局默认（实例层）",
    user: "用户偏好（用户层）",
};

const layers = computed(() =>
    SETTINGS_LAYERS.map((layer) => ({
        layer,
        title: LAYER_TITLES[layer] ?? layer,
        domains: LAYER_DOMAINS[layer].map((domain) => ({
            domain,
            label: t(DOMAIN_LABEL_KEY[domain] ?? domain),
            fields: SCHEMA_CATALOG[domain] ?? [],
        })),
    })),
);

/** api-request-templates 无 config-schema（CP 专用面板），字段级内容由本表给出。 */
const API_TEMPLATE_ROWS = [
    {
        name: "chat-completion",
        method: "POST",
        urlTemplate: "/v1/chat/completions",
        headers: 3,
        note: "OpenAI 兼容聊天端点（PLAN-0414）",
    },
    {
        name: "responses-api",
        method: "POST",
        urlTemplate: "/v1/responses",
        headers: 3,
        note: "Responses API 端点（vendor=openai）",
    },
] as const;

function valueOf(domain: string, key: string): unknown {
    return MOCK_VALUES[domain]?.[key];
}

function scalarText(field: MockSchemaField, domain: string): string {
    const v = valueOf(domain, field.key);
    return v === undefined || v === null ? "" : String(v);
}

function jsonText(field: MockSchemaField, domain: string): string {
    const v = valueOf(domain, field.key);
    return JSON.stringify(v ?? null, null, 2);
}

/** 占位哨兵：值缺失时不渲染空控件（对账脚本会把它报成缺键）。 */
function hasValue(domain: string, key: string): boolean {
    const v = valueOf(domain, key);
    return v !== undefined && v !== null && v !== "";
}
</script>

<template>
    <div class="mx-auto max-w-6xl px-8 py-10">
        <!-- 稿头：标题 + 判据注 -->
        <header class="mb-10">
            <h1 class="mk-title">Xihe 设置区 · 单页设计稿</h1>
            <p class="mk-caption mt-2 text-muted-foreground">
                全部配置域字段级真实内容同页排布 · 键/类型/枚举来源 = CP config-schemas（生成物
                schema-catalog.ts）· 字阶四档（24/16/14/12）· task-127 / D-903
            </p>
        </header>

        <!-- 设置区主体：层 → 域 → 字段 -->
        <section v-for="group in layers" :key="group.layer" class="mb-12">
            <h2 class="mk-subtitle mb-1">{{ group.title }}</h2>
            <p class="mk-caption mb-6 text-muted-foreground">{{ group.domains.length }} 个配置域</p>

            <article
                v-for="block in group.domains"
                :key="block.domain"
                class="mb-8 rounded-lg border bg-card p-6"
                :data-mock-domain="block.domain"
            >
                <header class="mb-4 flex items-baseline gap-3">
                    <h3 class="mk-subtitle">{{ block.label }}</h3>
                    <code class="mk-caption text-muted-foreground">{{ block.domain }}</code>
                </header>

                <!-- api-request-templates：无 schema，专用面板内容 -->
                <div v-if="block.domain === 'api-request-templates'">
                    <table class="w-full text-left">
                        <thead>
                            <tr class="mk-caption border-b text-muted-foreground">
                                <th class="py-2 pr-4 font-medium">模板名</th>
                                <th class="py-2 pr-4 font-medium">方法</th>
                                <th class="py-2 pr-4 font-medium">URL 模板</th>
                                <th class="py-2 pr-4 font-medium">请求头</th>
                                <th class="py-2 font-medium">说明</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr
                                v-for="row in API_TEMPLATE_ROWS"
                                :key="row.name"
                                class="mk-body border-b last:border-0"
                            >
                                <td class="py-2 pr-4 font-mono text-[13px]">{{ row.name }}</td>
                                <td class="py-2 pr-4">
                                    <span
                                        class="rounded border px-1.5 py-0.5 mk-caption font-medium"
                                        >{{ row.method }}</span
                                    >
                                </td>
                                <td class="py-2 pr-4 font-mono text-[13px]">
                                    {{ row.urlTemplate }}
                                </td>
                                <td class="py-2 pr-4">{{ row.headers }} 个</td>
                                <td class="mk-caption py-2 text-muted-foreground">
                                    {{ row.note }}
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>

                <!-- 常规域：schema-catalog 字段行 -->
                <div v-else class="divide-y">
                    <div
                        v-for="field in block.fields"
                        :key="field.key"
                        class="grid grid-cols-[220px_1fr] gap-4 py-3"
                        :data-mock-field="block.domain + ':' + field.key"
                    >
                        <div>
                            <div class="mk-body flex items-center gap-1.5">
                                <code class="text-[13px]">{{ field.key }}</code>
                                <span
                                    v-if="field.required"
                                    class="mk-caption text-muted-foreground"
                                    title="schema required"
                                    >*</span
                                >
                            </div>
                            <p
                                v-if="field.description"
                                class="mk-caption mt-0.5 line-clamp-2 text-muted-foreground"
                            >
                                {{ field.description }}
                            </p>
                        </div>
                        <div>
                            <!-- enum：分段控件，选中项高亮 -->
                            <div
                                v-if="field.type === 'enum' && field.options"
                                class="inline-flex rounded-md border p-0.5"
                            >
                                <span
                                    v-for="opt in field.options"
                                    :key="opt"
                                    class="mk-body rounded px-2.5 py-1"
                                    :class="
                                        scalarText(field, block.domain) === opt
                                            ? 'bg-accent font-medium'
                                            : 'text-muted-foreground'
                                    "
                                    >{{ opt }}</span
                                >
                            </div>
                            <!-- boolean：静态开关 -->
                            <span
                                v-else-if="field.type === 'boolean'"
                                class="inline-flex h-5 w-9 items-center rounded-full p-0.5"
                                :class="
                                    scalarText(field, block.domain) === 'true'
                                        ? 'justify-end bg-primary'
                                        : 'justify-start bg-muted'
                                "
                            >
                                <span class="size-4 rounded-full bg-background shadow" />
                            </span>
                            <!-- map/json：JSON 块 -->
                            <pre
                                v-else-if="field.type === 'map' || field.type === 'json'"
                                class="mk-body overflow-x-auto rounded-md border bg-muted/40 p-3 font-mono text-[13px] leading-5"
                                >{{ jsonText(field, block.domain) }}</pre>
                            <!-- string / integer / number：输入框样 -->
                            <div
                                v-else
                                class="mk-body flex h-8 max-w-md items-center rounded-md border bg-background px-3"
                            >
                                <span class="truncate font-mono text-[13px]">{{
                                    scalarText(field, block.domain)
                                }}</span>
                            </div>
                            <p
                                v-if="!hasValue(block.domain, field.key)"
                                class="mk-caption mt-1 text-destructive"
                            >
                                值缺失（MOCK_VALUES 未覆盖）
                            </p>
                        </div>
                    </div>
                </div>
            </article>
        </section>

        <MockBottomStrips />
    </div>
</template>
