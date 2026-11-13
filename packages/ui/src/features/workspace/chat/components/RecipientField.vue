<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { SessionParticipantView } from "../../../../types/participant";

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
    }>(),
    { multiple: false, placeholder: "" },
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
    <div class="flex flex-wrap items-center gap-1.5 px-2" :data-testid="testid">
        <span class="shrink-0 text-xs text-muted-foreground">{{ label }}</span>
        <span
            v-for="entry in selected"
            :key="entry.id"
            class="inline-flex items-center gap-1 rounded-full border bg-muted/40 px-2 py-0.5 text-xs"
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
                class="w-full min-w-0 rounded-sm bg-transparent py-0.5 text-xs outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring/60 focus-visible:ring-offset-0"
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
