<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, provide, ref } from "vue";
import { ExternalLink } from "@lucide/vue";
import { Badge } from "@/components/ui/badge";

/**
 * Mock shell for one 1920x1080 sheet.
 *
 * **外壳与画布分离**：切屏条、对照条、「这屏要回答什么」都在画布 *外面*，用深色中性底
 * （`zinc-800`），与产品 token（`background`/`muted`）明确不同色系 —— 审阅者一眼能分出
 * 「这是稿的外壳」而不是「产品的第三层栏」。画布内零 mock 痕迹。
 *
 * **自适应缩放**：画布固定 1920x1080（交付尺寸），但审阅者的浏览器窗口通常只有 1400–1700px。
 * 页面级按可用宽度等比 `transform: scale()` 缩小并显示当前比例，1280px 宽打开时无横向滚动条、
 * 整张画布完整可见。缩放只影响显示；截图脚本仍用 viewport 1920x1080 直接截 `[data-mock-canvas]`。
 *
 * **注记可关**：`?notes=0`（或右上角开关）关掉审阅辅助注记（如内容列 1152 的边线），
 * 因为注记是审阅辅助、不是产品形态。
 */
const props = defineProps<{
    index: string;
    title: string;
    question: string;
    note: string;
    sheets: { n: number; label: string }[];
    active: number;
}>();

const BEFORE_URL = "http://localhost:12630/settings/instance/llm-provider";
const selfUrl = computed(() => window.location.origin + "/preview-mock.html#" + props.active);

const showNotes = ref(new URLSearchParams(window.location.search).get("notes") !== "0");
provide("mockNotes", showNotes);

function toggleNotes(): void {
    showNotes.value = !showNotes.value;
    const url = new URL(window.location.href);
    if (showNotes.value) url.searchParams.delete("notes");
    else url.searchParams.set("notes", "0");
    window.history.replaceState(null, "", url);
}

/** 画布缩放：按可用宽度（留 48px 边距）与可用高度取小者，最大 1。 */
const CANVAS_W = 1920;
const CANVAS_H = 1080;
const scale = ref(1);

function recomputeScale(): void {
    const availW = window.innerWidth - 48;
    const availH = window.innerHeight - 176;
    scale.value = Math.min(1, availW / CANVAS_W, availH / CANVAS_H);
}
onMounted(() => {
    recomputeScale();
    window.addEventListener("resize", recomputeScale);
});
onBeforeUnmount(() => window.removeEventListener("resize", recomputeScale));

const scaleLabel = computed(() => Math.round(scale.value * 100) + "%");
</script>

<template>
    <div class="flex min-h-screen flex-col bg-zinc-800 text-zinc-100">
        <!-- ① 对照条（画布外，mock 外壳） -->
        <div
            data-mock-chrome
            class="flex h-8 shrink-0 items-center gap-2 border-b border-zinc-700 bg-zinc-900 px-6 mk-caption"
        >
            <span class="font-semibold text-zinc-100">对照</span>
            <span class="text-zinc-400">改造前 →</span>
            <a
                class="font-mono text-zinc-100 underline underline-offset-2"
                :href="BEFORE_URL"
                target="_blank"
                rel="noreferrer"
                >{{ BEFORE_URL }}<ExternalLink class="ml-0.5 inline size-3"
            /></a>
            <span class="text-zinc-400">（主栈产品 UI，dev 管理员登录）</span>
            <span class="ml-3 text-zinc-400">改造后 → 就是本页</span>
            <span class="ml-auto font-mono text-zinc-400">{{ selfUrl }}</span>
        </div>

        <!-- ② 切换条 + 这屏要回答什么（画布外） -->
        <header
            data-mock-chrome
            class="flex h-16 shrink-0 items-center gap-4 border-b border-zinc-700 bg-zinc-900 px-6"
        >
            <span
                class="flex size-7 items-center justify-center rounded-md bg-zinc-100 font-mono mk-caption font-semibold text-zinc-900"
            >
                {{ index }}
            </span>
            <div class="flex min-w-0 flex-col">
                <span class="truncate mk-body font-semibold leading-5 text-zinc-100">
                    {{ title }} · 这屏要回答：{{ question }}
                </span>
                <span class="truncate mk-caption leading-4 text-zinc-400">{{ note }}</span>
            </div>
            <nav class="ml-4 flex items-center gap-1">
                <a
                    v-for="s in sheets"
                    :key="s.n"
                    :href="'#' + s.n"
                    class="rounded-md px-2 py-1 mk-caption transition-colors"
                    :class="
                        s.n === active
                            ? 'bg-zinc-100 text-zinc-900'
                            : 'text-zinc-400 hover:bg-zinc-700 hover:text-zinc-100'
                    "
                >
                    {{ s.n }} · {{ s.label }}
                </a>
            </nav>
            <Badge variant="outline" class="ml-auto shrink-0 border-zinc-600 text-zinc-300"
                >真组件 + mock · 无 API 请求</Badge
            >
            <button
                type="button"
                class="shrink-0 rounded-md border border-zinc-600 px-2 py-1 mk-caption text-zinc-300 hover:bg-zinc-700"
                @click="toggleNotes"
            >
                注记：{{ showNotes ? "开" : "关" }}
            </button>
            <span class="w-16 shrink-0 text-right font-mono mk-caption text-zinc-400">{{
                scaleLabel
            }}</span>
        </header>

        <!-- ③ 画布（固定 1920x1080，按窗口等比缩放显示） -->
        <div class="flex flex-1 items-start justify-center overflow-hidden p-6">
            <div
                :style="{
                    width: CANVAS_W * scale + 'px',
                    height: CANVAS_H * scale + 'px',
                }"
                class="shrink-0"
            >
                <div
                    data-mock-canvas
                    class="flex h-[1080px] w-[1920px] flex-col overflow-hidden bg-background text-foreground"
                    :style="{ transform: 'scale(' + scale + ')', transformOrigin: 'top left' }"
                >
                    <slot />
                </div>
            </div>
        </div>
    </div>
</template>
