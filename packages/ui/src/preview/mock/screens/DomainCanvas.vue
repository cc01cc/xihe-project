<script setup lang="ts">
import { computed } from "vue";
import {
    Field,
    FieldDescription,
    FieldGroup,
    FieldLabel,
    FieldLegend,
    FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ShieldCheck } from "@lucide/vue";
import type { MockDomain, MockLayer } from "../data/types";

/**
 * 域内容区（task-77 参数化骨架）：**只渲染数据，不硬编码域**。
 * 外壳（NavRail + Sidebar + 面包屑 + 字阶）由 `S1SettingsAfter.vue` 提供，本组件只占内容列。
 *
 * 层语义（裁定 C）：`writableAt` 由 `writableAtOf()` 推导；**当前层可写 ⇒ 控件可用**，
 * 不可写 ⇒ 只读 + 「继承自<上层>」标记（复用 S1 里「继承自实例层」这个既有模式）。
 */
const props = defineProps<{ domain: MockDomain; currentLayer?: MockLayer }>();

const layer = computed<MockLayer>(() => props.currentLayer ?? "instance");

const isDetail = computed(() => props.domain.id.endsWith("-detail"));
/** 「N 项配置」只对表单域成立；详情态数的是**可编辑字段**，不是配置项（ui-2 看图缺陷 2）。 */
const countLabel = computed(() =>
    isDetail.value ? `${fieldCount.value} 个可编辑字段` : `${fieldCount.value} 项配置`,
);
const fieldCount = computed(() =>
    props.domain.groups.reduce((n, group) => n + group.fields.length, 0),
);

/** 当前层是否可写；不可写时给出它应该从哪一层继承（取比当前层更宽的第一层）。 */
const ORDER: MockLayer[] = ["instance", "workspace", "user"];
function writableHere(field: { writableAt: MockLayer[]; state?: string }): boolean {
    // [ui-2 看图缺陷 5] gap 字段后端没有编辑面 ⇒ 不许再宣称「本层可改」
    if (field.state === "gap") return false;
    return field.writableAt.includes(layer.value);
}
function inheritedFrom(field: { writableAt: MockLayer[]; state?: string }): string | null {
    // 裁定 ④：层可写性只有 Set 推导时，**不显示「继承自上层」** —— 继承关系本身是猜的
    if (props.domain.layerDerivedOnly) return null;
    // [task-81 ⑧] gap = 后端根本没有这个键，不是「在别的层有」。少这一行时 explicit-only 域会给
    // 用户陈述一个不存在的关系（「部分配置继承自上层」），与 writableHere() 的 gap 分支对齐。
    if (field.state === "gap") return null;
    if (writableHere(field)) return null;
    const here = ORDER.indexOf(layer.value);
    const source = field.writableAt.find((item) => ORDER.indexOf(item) < here);
    return source ?? null;
}

/**
 * help 的来源标注（[应改 ④]）：屏上只保留**类别标签**（灰色小号），
 * `文件:行号` 收进 `title` tooltip —— 读者要能分辨「这句是哪类结论」，不需要在屏上看到 java 行号。
 */
function helpTag(help: string): string {
    const m = help.match(/^\[([^\]\s]+)[^\]]*\]/);
    return m ? m[1] : "";
}
function helpBody(help: string): string {
    return help.replace(/^\[[^\]]*\]\s*/, "");
}
const LAYER_LABEL: Record<MockLayer, string> = {
    instance: "实例层",
    workspace: "工作区层",
    user: "用户层",
};
</script>

<template>
    <div>
        <div class="flex items-baseline gap-3">
            <h1 class="mk-title" data-single-line>{{ domain.label }}</h1>
            <span class="mk-caption text-muted-foreground" data-single-line>{{ countLabel }}</span>
            <!-- [task-81 ⑦-1] 元信息之间要有可见分隔，否则读成一句话（「8 个可编辑字段 当前层：用户层」） -->
            <span class="mk-caption text-muted-foreground/60" aria-hidden="true">·</span>
            <span class="mk-caption text-muted-foreground" data-single-line
                >当前层：{{ LAYER_LABEL[layer] }}</span
            >
            <!-- 裁定 ④ 改动 2：该域层可写性只有 Set 推导、没有解析链出处 ⇒ 屏上必须看得见 -->
            <span
                v-if="domain.layerDerivedOnly"
                class="rounded border border-dashed border-border px-1 mk-caption text-muted-foreground"
                data-single-line
                title="该域的层可写性由可写集合推导，未找到解析链出处"
                >[推导] 层可写性</span
            >
        </div>
        <p class="mt-1 mk-body text-muted-foreground">{{ domain.summary }}</p>

        <Alert
            v-if="domain.groups.some((group) => group.fields.some((field) => inheritedFrom(field)))"
            class="mt-5"
        >
            <ShieldCheck class="size-4" />
            <AlertTitle>部分配置继承自上层</AlertTitle>
            <AlertDescription> 标「继承自…」的项在本层不可改，要改请切到对应层。 </AlertDescription>
        </Alert>

        <div class="mt-6 space-y-6">
            <FieldSet v-for="group in domain.groups" :key="group.label">
                <FieldLegend class="mk-subtitle">{{ group.label }}</FieldLegend>
                <FieldGroup class="mt-3 gap-5">
                    <Field v-for="field in group.fields" :key="field.key">
                        <div class="flex items-center gap-2">
                            <FieldLabel :for="'f-' + field.key" class="mk-body" data-single-line>
                                {{ field.label }}
                            </FieldLabel>
                            <span class="font-mono mk-caption text-muted-foreground">{{
                                field.key
                            }}</span>
                            <span
                                v-if="field.state !== 'gap' && !writableHere(field)"
                                class="ml-auto shrink-0 rounded border border-border px-1 mk-caption text-muted-foreground"
                                data-single-line
                                >继承自{{ LAYER_LABEL[inheritedFrom(field) as MockLayer] }}</span
                            >
                            <span
                                v-else-if="field.state !== 'gap'"
                                class="ml-auto shrink-0 rounded border border-border px-1 mk-caption text-muted-foreground"
                                data-single-line
                                >本层可改</span
                            >
                            <span
                                v-if="field.state === 'gap'"
                                class="shrink-0 rounded border border-border px-1 mk-caption text-muted-foreground"
                                data-single-line
                                >后端缺口</span
                            >
                            <span
                                v-else-if="field.state === 'unconfigured'"
                                class="shrink-0 rounded border border-dashed border-border px-1 mk-caption text-muted-foreground"
                                data-single-line
                                >未配置</span
                            >
                        </div>

                        <Switch
                            v-if="field.control === 'switch'"
                            :model-value="Boolean(field.value)"
                            :disabled="!writableHere(field)"
                        />
                        <Textarea
                            v-else-if="field.control === 'textarea'"
                            :id="'f-' + field.key"
                            :model-value="String(field.value)"
                            :disabled="!writableHere(field)"
                            rows="3"
                        />
                        <Select
                            v-else-if="field.control === 'select'"
                            :model-value="String(field.value)"
                        >
                            <SelectTrigger
                                :id="'f-' + field.key"
                                class="max-w-xs"
                                :disabled="!writableHere(field)"
                            >
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem
                                    v-for="option in field.options ?? []"
                                    :key="option"
                                    :value="option"
                                    >{{ field.optionLabels?.[option] ?? option }}</SelectItem
                                >
                            </SelectContent>
                        </Select>
                        <Input
                            v-else
                            :id="'f-' + field.key"
                            type="text"
                            :model-value="String(field.value)"
                            :disabled="!writableHere(field)"
                            class="max-w-xs"
                        />

                        <FieldDescription v-if="field.help" class="mk-caption" :title="field.help">
                            <span
                                v-if="helpTag(field.help)"
                                class="mr-1 rounded border border-border px-1 text-muted-foreground"
                                >{{ helpTag(field.help) }}</span
                            >{{ helpBody(field.help) }}</FieldDescription
                        >
                    </Field>
                </FieldGroup>
            </FieldSet>
        </div>
    </div>
</template>
