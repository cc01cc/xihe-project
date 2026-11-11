<!--
  DEPRECATED(task-137-rev2)：D-914 ① 交付改为「真产品页面 + 网络层 mock」，本文件属更早的「静态设计稿单页」路线，已不再渲染也不再产出交付图；**保留不删**（Lead 口径：零删除，退役由 PLAN-0764 M1 合并时统一处理）。指标：task-137 rev2 的真实入口是 preview-real.html + src/preview/mock/api-server.ts。
-->
<script setup lang="ts">
import { useI18n } from "vue-i18n";
import type { MockSchemaField } from "../data/schema-catalog";
import { MOCK_VALUES } from "../data/mockValues";
import { FIELD_LABELS, type FieldLabelEntry } from "../data/fieldLabels";

/**
 * task-127 / task-137：单页稿的**配置域卡片** —— 把「域标题 + 字段行」抽出来，
 * 让实例层（全量字段）与用户层展开态（覆盖项）共用同一套渲染与中文 label 逻辑。
 *
 * override 模式（D-911 用户层展开态）：显示「覆盖值 + 覆盖徽标」，并把实例默认值作为 caption。
 */
const props = defineProps<{
    domain: string;
    label: string;
    fields: MockSchemaField[];
    override?: boolean;
    overrides?: Record<string, string>;
}>();

const { t } = useI18n();

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

function valueOf(key: string): unknown {
    return MOCK_VALUES[props.domain]?.[key];
}

function scalarText(field: MockSchemaField): string {
    const v = valueOf(field.key);
    return v === undefined || v === null ? "" : String(v);
}

function jsonText(field: MockSchemaField): string {
    return JSON.stringify(valueOf(field.key) ?? null, null, 2);
}

function hasValue(key: string): boolean {
    const v = valueOf(key);
    return v !== undefined && v !== null && v !== "";
}

const CJK = /[\u4e00-\u9fff]/;

function entryOf(field: MockSchemaField): FieldLabelEntry | undefined {
    return FIELD_LABELS[props.domain]?.[field.key];
}

/** 有键用键；产品 zh 文案仍是英文的键回退 curated zh（100% 中文）。 */
function labelOf(field: MockSchemaField): string {
    const entry = entryOf(field);
    const viaKey = entry?.key ? t(entry.key) : undefined;
    if (viaKey && CJK.test(viaKey)) return viaKey;
    return entry?.zh ?? viaKey ?? field.key;
}

function descOf(field: MockSchemaField): string {
    return entryOf(field)?.desc ?? field.description ?? "";
}

function optLabel(field: MockSchemaField, opt: string): string {
    return entryOf(field)?.options?.[opt] ?? opt;
}

/** 展开态：显示覆盖值；非展开态显示存储值。 */
function shownText(field: MockSchemaField): string {
    const ov = props.overrides?.[field.key];
    if (props.override && ov !== undefined) {
        return field.type === "enum" ? optLabel(field, ov) : ov;
    }
    return scalarText(field);
}

function isOverridden(field: MockSchemaField): boolean {
    return props.override === true && props.overrides?.[field.key] !== undefined;
}

function inheritedText(field: MockSchemaField): string {
    return field.type === "enum" ? optLabel(field, scalarText(field)) : scalarText(field);
}
</script>

<template>
    <article class="mb-8 rounded-lg border bg-card p-6" :data-mock-domain="domain">
        <header class="mb-4 flex items-baseline gap-3">
            <h3 class="mk-subtitle">{{ label }}</h3>
            <code class="mk-caption text-muted-foreground">{{ domain }}</code>
            <span
                v-if="override"
                class="mk-caption rounded border px-1.5 py-0.5 text-muted-foreground"
                >按人覆盖（示例）</span
            >
        </header>

        <!-- api-request-templates：无 schema，专用面板内容 -->
        <div v-if="domain === 'api-request-templates'">
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
                            <span class="rounded border px-1.5 py-0.5 mk-caption font-medium">{{
                                row.method
                            }}</span>
                        </td>
                        <td class="py-2 pr-4 font-mono text-[13px]">{{ row.urlTemplate }}</td>
                        <td class="py-2 pr-4">{{ row.headers }} 个</td>
                        <td class="mk-caption py-2 text-muted-foreground">{{ row.note }}</td>
                    </tr>
                </tbody>
            </table>
        </div>

        <!-- 常规域：schema-catalog 字段行 -->
        <div v-else class="divide-y">
            <div
                v-for="field in fields"
                :key="field.key"
                class="grid grid-cols-[240px_1fr] gap-4 py-3"
                :data-mock-field="domain + ':' + field.key"
            >
                <div>
                    <div class="mk-body flex items-center gap-1.5">
                        <span class="font-medium" data-mock-label>{{ labelOf(field) }}</span>
                        <span
                            v-if="isOverridden(field)"
                            class="mk-caption rounded border px-1 py-0.5 text-muted-foreground"
                            >覆盖</span
                        >
                        <span
                            v-if="field.required"
                            class="mk-caption text-muted-foreground"
                            title="schema required"
                            >*</span
                        >
                    </div>
                    <p
                        v-if="descOf(field)"
                        class="mk-caption mt-0.5 line-clamp-2 text-muted-foreground"
                    >
                        {{ descOf(field) }}
                    </p>
                </div>
                <div>
                    <!-- enum：分段控件，选中项高亮（option 值走 data-mock-option，label 走中文） -->
                    <div
                        v-if="field.type === 'enum' && field.options"
                        class="inline-flex rounded-md border p-0.5"
                    >
                        <span
                            v-for="opt in field.options"
                            :key="opt"
                            :data-mock-option="opt"
                            class="mk-body rounded px-2.5 py-1"
                            :class="
                                (props.override && props.overrides?.[field.key] === opt) ||
                                (!props.override && scalarText(field) === opt)
                                    ? 'bg-accent font-medium'
                                    : 'text-muted-foreground'
                            "
                            >{{ optLabel(field, opt) }}</span
                        >
                    </div>
                    <!-- boolean：静态开关 -->
                    <span
                        v-else-if="field.type === 'boolean'"
                        class="inline-flex h-5 w-9 items-center rounded-full p-0.5"
                        :class="
                            scalarText(field) === 'true'
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
                        >{{ jsonText(field) }}</pre>
                    <!-- string / integer / number：输入框样 -->
                    <div
                        v-else
                        class="mk-body flex h-8 max-w-md items-center rounded-md border bg-background px-3"
                    >
                        <span class="truncate font-mono text-[13px]">{{ shownText(field) }}</span>
                    </div>
                    <p
                        v-if="override && isOverridden(field)"
                        class="mk-caption mt-1 text-muted-foreground"
                    >
                        实例默认：{{ inheritedText(field) }}
                    </p>
                    <p v-if="!hasValue(field.key)" class="mk-caption mt-1 text-destructive">
                        值缺失（MOCK_VALUES 未覆盖）
                    </p>
                </div>
            </div>
        </div>
    </article>
</template>
