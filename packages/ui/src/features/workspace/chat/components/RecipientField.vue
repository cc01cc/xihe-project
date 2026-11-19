<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Info } from "@lucide/vue";
import type { SessionParticipantView } from "../../../../types/participant";
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "../../../../components/ui/tooltip";

/**
 * Composer recipient field (2026-11-04 用户裁定): **input + typeahead popover** instead of a
 * native select control.
 *
 * - 打字即过滤候选；↑↓ 选择、Enter 确认、Tab 补全、Esc 关闭（键盘与 aria 合同与输入框内的
 *   `@`/`/` 候选面一致：同一个 `role="listbox"` + `aria-activedescendant` 形态）。
 * - **空格即结束一个名字**，可连续输入多个名字而不必点候选；名字按「完全相同 → 唯一前缀 →
 *   唯一子串」解析到参与者，解析不到的名字留在输入框里并给出提示（绝不静默丢弃）。
 * - 已选中的以 chip 呈现、点 × 移除；单选用在「发送」栏，多选用在「抄送」栏。
 */
const props = withDefaults(
    defineProps<{
        label: string;
        modelValue: string[];
        candidates: SessionParticipantView[];
        multiple?: boolean;
        placeholder?: string;
        testid: string;
        /**
         * task-38 C2（DEV-011 §13.4「提示语不得整幅占行」）：字段说明改为**焦点即显示的 tooltip**，
         * 不再长期占一整行。文案仍由调用方从 src/i18n/index.ts 取（单一来源），本组件不硬编码。
         */
        hint?: string;
        /** 说明文本落点（sr-only 常驻 DOM，读屏与单测都读得到）；默认 testid + "-field-hint"。 */
        hintTestid?: string;
    }>(),
    { multiple: false, placeholder: "", hint: "", hintTestid: "" },
);

const emit = defineEmits<{
    "update:modelValue": [ids: string[]];
}>();

const { t } = useI18n();

const query = ref("");
const open = ref(false);
const activeIndex = ref(0);
const inputRef = ref<HTMLInputElement | null>(null);
const unknownHint = ref(false);

const listId = computed(() => `${props.testid}-listbox`);
const optionId = (participantId: string) => `${props.testid}-option-${participantId}`;

/** 说明文本的 testid：调用方不给就退到本字段自己的命名空间，避免与 ${testid}-hint（键盘提示）撞名。 */
const fieldHintTestid = computed(() => props.hintTestid || `${props.testid}-field-hint`);

const displayNameOf = (participantId: string) =>
    props.candidates.find((item) => item.participantId === participantId)?.displayName ??
    t("workspace.participantUnknownName");

const selected = computed(() => props.modelValue.map((id) => ({ id, name: displayNameOf(id) })));

/** Candidates for the popover: enabled, named, not already selected. */
const filtered = computed(() => {
    const needle = query.value.trim().toLowerCase();
    const chosen = new Set(props.modelValue);
    return props.candidates.filter(
        (item) =>
            !item.disabledAt &&
            Boolean(item.displayName) &&
            !chosen.has(item.participantId) &&
            (!needle || (item.displayName ?? "").toLowerCase().includes(needle)),
    );
});

const activeCandidate = computed(() => filtered.value[activeIndex.value]);
const activeOptionId = computed(() =>
    open.value && activeCandidate.value ? optionId(activeCandidate.value.participantId) : undefined,
);

watch(filtered, () => {
    activeIndex.value = 0;
});

watch(query, (value) => {
    unknownHint.value = false;
    open.value = value.trim().length > 0;
});

function commit(participantId: string): void {
    if (!participantId) return;
    const next = props.multiple ? [...props.modelValue, participantId] : [participantId];
    emit("update:modelValue", next);
    query.value = "";
    open.value = false;
    activeIndex.value = 0;
}

function remove(participantId: string): void {
    emit(
        "update:modelValue",
        props.modelValue.filter((id) => id !== participantId),
    );
}

/** Resolve one typed token to a participant id (same rule as the popover's sort order). */
function resolve(token: string): string | null {
    const needle = token.trim().toLowerCase();
    if (!needle) return null;
    const roster = props.candidates.filter((item) => !item.disabledAt && Boolean(item.displayName));
    const name = (item: SessionParticipantView) => (item.displayName ?? "").toLowerCase();
    const exact = roster.find((item) => name(item) === needle);
    if (exact) return exact.participantId;
    const prefix = roster.filter((item) => name(item).startsWith(needle));
    if (prefix.length === 1) return prefix[0]!.participantId;
    const contains = roster.filter((item) => name(item).includes(needle));
    return contains.length === 1 ? contains[0]!.participantId : null;
}

/**
 * Commit every whitespace-separated token in the field. Unresolved tokens stay in the input
 * and raise the "no such member" hint — a typo must never look like it was sent.
 */
function commitTokens(): void {
    const tokens = query.value.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return;
    const resolvedIds: string[] = [];
    const unresolved: string[] = [];
    for (const token of tokens) {
        const id =
            resolve(token) ?? (open.value ? activeCandidate.value?.participantId : undefined);
        if (id && !props.modelValue.includes(id) && !resolvedIds.includes(id)) resolvedIds.push(id);
        else if (!id) unresolved.push(token);
    }
    if (resolvedIds.length > 0) {
        emit(
            "update:modelValue",
            props.multiple
                ? [...props.modelValue, ...resolvedIds]
                : [resolvedIds[resolvedIds.length - 1]!],
        );
    }
    unknownHint.value = unresolved.length > 0;
    query.value = unresolved.join(" ");
    open.value = query.value.length > 0;
    activeIndex.value = 0;
}

function onKeydown(event: KeyboardEvent): void {
    if (event.key === " ") {
        event.preventDefault();
        commitTokens();
        return;
    }
    if (event.key === "ArrowDown") {
        event.preventDefault();
        open.value = true;
        if (filtered.value.length > 0) {
            activeIndex.value = (activeIndex.value + 1) % filtered.value.length;
        }
        return;
    }
    if (event.key === "ArrowUp") {
        event.preventDefault();
        open.value = true;
        if (filtered.value.length > 0) {
            activeIndex.value =
                (activeIndex.value - 1 + filtered.value.length) % filtered.value.length;
        }
        return;
    }
    if (event.key === "Enter") {
        event.preventDefault();
        if (open.value && activeCandidate.value) commit(activeCandidate.value.participantId);
        else commitTokens();
        return;
    }
    if (event.key === "Tab") {
        if (open.value && activeCandidate.value) {
            event.preventDefault();
            query.value = activeCandidate.value.displayName ?? "";
        }
        return;
    }
    if (event.key === "Escape") {
        if (open.value) {
            event.preventDefault();
            open.value = false;
        } else if (query.value) {
            event.preventDefault();
            query.value = "";
        }
        return;
    }
    if (event.key === "Backspace" && !query.value && props.modelValue.length > 0) {
        const last = props.modelValue[props.modelValue.length - 1];
        if (last) remove(last);
    }
}

function focusInput(): void {
    void nextTick(() => inputRef.value?.focus());
}
</script>

<template>
    <!--
        task-38 C5（DEV-011 §13.2）：辅助字段 = **二级 · 仅淡下边框** —— 无侧/上边框、无圆角框，
        与一级全包的主输入区拉开权重（依据是信息层级，不是「看起来更轻」）。
        task-38 C4（§13.3）：焦点指示由**这一层**画（has-[input:focus-visible] ⇒ 只有内层输入真的拿到
        键盘焦点时才亮），内层不再自绘环 ⇒ 同一时刻只有一套焦点视觉。
    -->
    <div
        class="flex flex-wrap items-center gap-1.5 border-b border-border/60 px-2 py-0.5 transition-[box-shadow,border-color] has-[input:focus-visible]:border-ring has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-ring/50"
        :data-testid="testid"
    >
        <span class="shrink-0 text-xs text-muted-foreground">{{ label }}</span>
        <!--
            task-38 C2（DEV-011 §13.4）：说明收进**栈内 tooltip 原语**（reka-ui，经 components/ui/tooltip），
            不手搓浮层。四条判据的落点：
            ① 键盘可达 = TooltipTrigger 落在真 button 上，焦点即显示（不是只 hover）；
            ② 文案单一来源 = hint 由调用方传 t("chat.input.*Hint")，本组件不硬编码；
            ③ 动效 = vendor TooltipProvider 默认 delayDuration 0（T0 即时，§12.4），不新增时长；
            ④ AT 可读 = 文本以 sr-only 常驻 DOM（fieldHintTestid），不依赖浮层打开才存在。
            为什么必须自带 TooltipProvider：reka-ui 的 TooltipRoot 注入没有 fallback，不包直接抛错
            （实测记录见 components/settings/SettingsSidebar.vue:308-316）。
        -->
        <TooltipProvider v-if="hint">
            <Tooltip>
                <TooltipTrigger as-child>
                    <button
                        type="button"
                        :data-testid="fieldHintTestid + '-trigger'"
                        class="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
                    >
                        <Info class="size-3" aria-hidden="true" />
                        <span class="sr-only" :data-testid="fieldHintTestid">{{ hint }}</span>
                    </button>
                </TooltipTrigger>
                <TooltipContent side="top">{{ hint }}</TooltipContent>
            </Tooltip>
        </TooltipProvider>
        <!-- task-38 C5（DEV-011 §13.2 三级 · 仅阴影）：chip 去掉 border，靠 shadow-xs 建立可点面 -->
        <span
            v-for="entry in selected"
            :key="entry.id"
            class="inline-flex items-center gap-1 rounded-full bg-muted/40 px-2 py-0.5 text-xs shadow-xs"
            :data-testid="`${testid}-chip`"
            :data-participant-id="entry.id"
        >
            {{ entry.name }}
            <button
                type="button"
                class="text-muted-foreground hover:text-foreground"
                :data-testid="`${testid}-chip-remove`"
                :aria-label="t('chat.input.recipientRemove')"
                @click="remove(entry.id)"
            >
                ×
            </button>
        </span>
        <div class="relative min-w-[9rem] flex-1">
            <!--
                task-38 C4（DEV-011 §13.3）：内层**不再自绘**焦点环（原 ring-1 / ring-ring/60 已删），
                只保留 outline-none 压掉 UA 与全局规则 ⇒ 一套焦点视觉由外层行容器承担。
            -->
            <input
                ref="inputRef"
                v-model="query"
                type="text"
                role="combobox"
                :aria-expanded="open"
                :aria-controls="listId"
                :aria-activedescendant="activeOptionId"
                aria-autocomplete="list"
                :aria-label="label"
                :placeholder="placeholder"
                class="w-full min-w-0 rounded-sm bg-transparent py-0.5 text-xs outline-none placeholder:text-muted-foreground"
                :data-testid="`${testid}-input`"
                @keydown="onKeydown"
                @focus="open = query.trim().length > 0"
            />
            <!--
                2026-11-04 用户裁定（composer 打磨）：候选列表是 **elevation overlay** —— 绝对定位
                盖在输入区上方（z-30 + 独立 popover 背景 + 阴影），不占文档流，因此不会把下方
                「抄送」行挤走；`relative` 定位锚在字段容器上。
                候选行美化（DEV-011 §10）：紧凑行高；hover 只加浅底；键盘高亮 = 左侧 2px 指示条 +
                浅底（与 hover 可区分）；role 收成右侧小 chip。
            -->
            <div
                v-if="open && filtered.length > 0"
                :id="listId"
                class="absolute left-0 top-full z-30 mt-1 max-h-56 w-72 overflow-y-auto rounded-lg border bg-popover py-1 shadow-lg"
                role="listbox"
                :aria-label="label"
                :data-testid="`${testid}-menu`"
            >
                <button
                    v-for="(candidate, index) in filtered"
                    :id="optionId(candidate.participantId)"
                    :key="candidate.participantId"
                    type="button"
                    role="option"
                    :aria-selected="index === activeIndex"
                    class="relative flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:rounded-full before:bg-ring before:content-[''] hover:bg-accent/60"
                    :class="
                        index === activeIndex ? 'bg-accent before:opacity-100' : 'before:opacity-0'
                    "
                    :data-testid="`${testid}-option`"
                    :data-participant-id="candidate.participantId"
                    @mousedown.prevent
                    @click="commit(candidate.participantId)"
                >
                    <span class="truncate text-sm font-medium">{{ candidate.displayName }}</span>
                    <span
                        class="ml-auto shrink-0 rounded-full border px-1.5 py-px font-mono text-xs tracking-wide text-muted-foreground"
                        >{{ candidate.role }}</span
                    >
                </button>
            </div>
            <!-- 空态：打字后没有匹配候选时也要有反馈（不是"什么都没发生"）。 -->
            <div
                v-else-if="open"
                class="absolute left-0 top-full z-30 mt-1 w-72 rounded-lg border bg-popover px-2.5 py-2 text-xs text-muted-foreground shadow-lg"
                role="status"
                :data-testid="`${testid}-empty`"
            >
                {{ t("chat.input.recipientEmpty") }}
            </div>
        </div>
        <span
            v-if="unknownHint"
            class="text-xs text-destructive"
            role="status"
            :data-testid="`${testid}-unknown`"
            >{{ t("chat.input.recipientUnknown") }}</span
        >
        <button
            v-else-if="!query && !selected.length"
            type="button"
            class="shrink-0 text-xs text-muted-foreground hover:text-foreground"
            :data-testid="`${testid}-hint`"
            @click="focusInput"
        >
            {{ t("chat.input.recipientHint") }}
        </button>
    </div>
</template>
