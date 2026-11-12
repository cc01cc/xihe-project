<script setup lang="ts">
/**
 * PLAN-0773 M0-4（task-144）：第 4 条能力 = **虚拟化**，只在这里验（不进 jsdom）。
 *
 * 为什么不在单测里：`jsdom` 没有布局 ⇒ `offsetHeight` / `getBoundingClientRect()` 恒 0 ⇒ 虚拟化窗口
 * 算出「0 项可见」，这个 0 **假红与假绿不可分辨**。本页跑在真浏览器里，读数从 **DOM 实测**得出。
 *
 * 左块 = 1000 行直挂（对照），右块 = 同一份数据走 `TreeVirtualizer`。两块的 `data-testid="m0-4-readings"`
 * 给出 `{ total, rendered, engaged }`；`engaged = rendered < total` 才是「虚拟化真的生效」。
 *
 * ⚠ 第一次跑（窗口后 09:10）要先确认两件事，**不要把「页面能开」当「虚拟化生效」**：
 *  1. 滚动容器必须是有高度且 `position: relative` 的祖先（`TreeVirtualizer` 内部 `useParentElement` 取它当 scrollElement）；
 *  2. 虚拟项由 `TreeVirtualizer` 注入 `position: absolute` + `translateY` 样式，**槽里只能出一个根节点**。
 * 若 `engaged=false`，说明是接线问题而不是「库不支持」——读数会当场显示出来（rendered === total）。
 */
import { computed, nextTick, onMounted, reactive, ref } from "vue";
import SectionShell from "../SectionShell.vue";
import { Tree } from "@/components/ui/tree";
import TreeItem from "@/components/ui/tree/TreeItem.vue";
import TreeVirtualizer from "@/components/ui/tree/TreeVirtualizer.vue";

interface Node {
    key: string;
    label: string;
}

/** 1000 个同级节点（同一根下全部展开）；真实组织树是 10 根 × 100 子，量级一致。 */
const N = 1000;
const items = reactive<Node[]>(
    Array.from({ length: N }, (_, i) => ({ key: "n" + i, label: "org-unit-" + i })),
);
const getKey = (n: Node) => n.key;
const expanded = ref<string[]>(items.map((n) => n.key));

interface Readings {
    total: number;
    rendered: number;
    engaged: boolean;
    scrollHeight?: number;
    viewportHeight?: number;
}

const plain = reactive<Readings>({ total: N, rendered: 0, engaged: false });
const virtual = reactive<Readings>({ total: N, rendered: 0, engaged: false });
const plainEl = ref<HTMLElement | null>(null);
const virtualEl = ref<HTMLElement | null>(null);

function measure(root: HTMLElement | null, box: Readings) {
    if (!root) return;
    const rendered = root.querySelectorAll("[data-tree-row]").length;
    box.rendered = rendered;
    box.engaged = rendered < box.total;
    box.scrollHeight = root.scrollHeight;
    box.viewportHeight = root.clientHeight;
}

onMounted(async () => {
    await nextTick();
    // 等一帧再量：虚拟化在布局完成后才算窗口。
    requestAnimationFrame(() => {
        measure(plainEl.value, plain);
        measure(virtualEl.value, virtual);
    });
});

const summary = computed(() => ({ plain, virtual }));
</script>

<template>
    <SectionShell id="tree-capabilities" index="10" label="reka-ui 树能力（M0-4）">
        <div class="space-y-4">
            <p class="max-w-4xl text-sm leading-relaxed text-muted-foreground">
                <strong>前提事实</strong>：`src/components/ui/tree/` 这组 vendor 件在本卡之前
                <strong>全仓 0 使用处</strong> —— 本页验的是「<code class="font-mono">reka-ui</code>
                有没有这个能力」， 不是「我们的产品壳层已经好使」；后者要等 M1/M2 接真树再证一次。
            </p>

            <div class="grid gap-4 lg:grid-cols-2">
                <div class="rounded-lg border border-border p-3">
                    <div class="mb-2 text-xs font-semibold">对照：1000 行直挂（无虚拟化）</div>
                    <div ref="plainEl" class="h-[320px] overflow-auto" data-testid="m0-4-plain">
                        <Tree :items="items" :get-key="getKey" :expanded="expanded">
                            <TreeItem
                                v-for="item in items"
                                :key="item.key"
                                :value="item"
                                :level="1"
                                data-tree-row
                            >
                                <span class="font-mono text-xs">{{ item.label }}</span>
                            </TreeItem>
                        </Tree>
                    </div>
                    <pre
                        class="mt-2 text-[11px] text-muted-foreground"
                        data-testid="m0-4-readings-plain"
                        >{{ JSON.stringify(plain) }}</pre>
                </div>

                <div class="rounded-lg border border-border p-3">
                    <div class="mb-2 text-xs font-semibold">
                        虚拟化：<code class="font-mono">TreeVirtualizer</code>
                    </div>
                    <div
                        ref="virtualEl"
                        class="relative h-[320px] overflow-auto"
                        data-testid="m0-4-virtual"
                    >
                        <Tree :items="items" :get-key="getKey" :expanded="expanded">
                            <TreeVirtualizer :estimate-size="28" v-slot="{ item }">
                                <TreeItem
                                    v-bind="item.bind"
                                    :key="item._id"
                                    class="w-full"
                                    data-tree-row
                                >
                                    <span class="font-mono text-xs">{{ item.value.label }}</span>
                                </TreeItem>
                            </TreeVirtualizer>
                        </Tree>
                    </div>
                    <pre
                        class="mt-2 text-[11px] text-muted-foreground"
                        data-testid="m0-4-readings-virtual"
                        >{{ JSON.stringify(virtual) }}</pre>
                </div>
            </div>

            <pre class="rounded-md bg-muted p-3 text-[11px]" data-testid="m0-4-readings">{{
                JSON.stringify(summary)
            }}</pre>
            <p class="text-xs text-muted-foreground">
                判据：<code class="font-mono">virtual.engaged === true</code>（DOM 行数显著小于
                1000）且 <code class="font-mono">plain.rendered === 1000</code>（对照组确实全挂）。
                <strong>只开页不算通过</strong>。
            </p>
        </div>
    </SectionShell>
</template>
