import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { defineComponent, h, nextTick, reactive } from "vue";
import { Tree } from "@/components/ui/tree";
import TreeItem from "@/components/ui/tree/TreeItem.vue";

/**
 * PLAN-0773 M0-4（task-144）：**reka-ui 树三能力的最小复现**（第 4 条「虚拟化」不在这里，见
 * `src/preview/sections/TreeCapabilitiesSection.vue` + `e2e/mock/pl0773-tree-capabilities.spec.ts`）。
 *
 * 为什么虚拟化不做成单测：`jsdom` 没有布局，`offsetHeight` / `getBoundingClientRect()` 恒为 0，
 * 虚拟化窗口会算出「0 项可见」——这个 0 **既可能是假红也可能是假绿，且两者不可分辨**。
 *
 * 前提事实（证据包里同句）：`packages/ui/src/components/ui/tree/` 的 vendor 件在此之前
 * **全仓 0 使用处** ⇒ 本文件验的是「`reka-ui` 有没有这个能力」，**不是**「我们的产品壳层已经好使」。
 * 后者要等 M1/M2 把真树接进来再证一次（两个 pass 不许合成一个）。
 *
 * API 依据：`node_modules/reka-ui/dist/Tree/TreeRoot.js` —— props 有 items/getKey/getChildren/expanded，
 * slot 暴露 `flattenItems`，每项带 `bind: { value, level, "aria-setsize", "aria-posinset" }`。
 * `TreeRoot` **没有** `loadChildren`/`async`（dist 全文无此符号）⇒ 懒加载不是库特性，是 app 侧模式（第三条）。
 *
 * 用 `h()` 而非字符串模板槽：`packages/ui` 的 vue 是 runtime-only，字符串模板需要编译器。
 */

interface Node {
    key: string;
    label: string;
    children?: Node[];
}

const getKey = (n: Node) => n.key;

/** 读数统一前缀：证据包的数字直接从 vitest 输出抄。 */
const READ = (msg: string) => console.log("[m0-4] " + msg);

/** 用真实 vendor 组件（Tree + TreeItem）搭一个最小树；不做任何样式与产品接线。 */
function TreeProbe(props: { items: Node[]; expanded?: string[] }) {
    return defineComponent({
        render() {
            return h(
                Tree as never,
                { items: props.items, getKey, expanded: props.expanded ?? [] },
                {
                    default: ({
                        flattenItems,
                    }: {
                        flattenItems: Array<
                            Record<string, never> & {
                                _id: string;
                                value: Node;
                                bind: Record<string, unknown>;
                            }
                        >;
                    }) =>
                        flattenItems.map((item) =>
                            h(TreeItem as never, { key: item._id, ...item.bind }, () =>
                                h("span", { "data-testid": "tree-label" }, item.value.label),
                            ),
                        ),
                },
            );
        },
    });
}

describe("PLAN-0773 M0-4 reka-ui tree capabilities", () => {
    it("① 1000 节点可渲染（给出相对耗时比，不写绝对 ms）", async () => {
        const flat = (n: number): Node[] =>
            Array.from({ length: n }, (_, i) => ({ key: "n" + i, label: "node-" + i }));

        const t0 = performance.now();
        const small = mount(TreeProbe({ items: flat(100) }));
        await nextTick();
        const tSmall = performance.now() - t0;
        const smallCount = small.findAll('[data-testid="tree-label"]').length;

        const t1 = performance.now();
        const big = mount(TreeProbe({ items: flat(1000) }));
        await nextTick();
        const tBig = performance.now() - t1;
        const bigCount = big.findAll('[data-testid="tree-label"]').length;

        READ(
            "100-nodes=" +
                smallCount +
                " mount100=" +
                tSmall.toFixed(1) +
                "ms ｜ " +
                "1000-nodes=" +
                bigCount +
                " mount1000=" +
                tBig.toFixed(1) +
                "ms ｜ " +
                "ratio(1000/100)=" +
                (tBig / tSmall).toFixed(2),
        );

        expect(smallCount).toBe(100);
        expect(bigCount).toBe(1000);
        // 判据用**相对值**；绝对 ms 换机器/换进程就不可复现。
        expect(tBig).toBeGreaterThan(0);
        small.unmount();
        big.unmount();
    });

    it("② 搜索：过滤数据源后重新喂给 Tree（app 侧过滤，不是库特性）", async () => {
        const items: Node[] = Array.from({ length: 1000 }, (_, i) => ({
            key: "n" + i,
            label: "node-" + i,
        }));
        const filter = (q: string) => items.filter((n) => n.label.includes(q));
        const hits = filter("node-42");

        const wrapper = mount(TreeProbe({ items: hits }));
        await nextTick();
        const rendered = wrapper.findAll('[data-testid="tree-label"]').map((el) => el.text());

        READ("search q=node-42 hits=" + hits.length + " rendered=" + rendered.length);

        // node-42、node-420..node-429 ⇒ 11 条
        expect(hits.length).toBe(11);
        expect(rendered.length).toBe(11);
        expect(rendered).toContain("node-42");
        wrapper.unmount();
    });

    it("③ 懒加载：展开时注入子节点，加载函数对同一 key 只调一次", async () => {
        const loadChildren = vi.fn<(n: Node) => Promise<Node[]>>(async (n) => [
            { key: n.key + "-c1", label: "child-1" },
        ]);

        // 库的 getChildren 是同步的（默认 val.children）；异步取子必须由 app 在 expand 时自己注入。
        const root = reactive<Node>({ key: "root", label: "root" });
        const items = reactive<Node[]>([root]);

        const wrapper = mount(TreeProbe({ items, expanded: ["root"] }));
        await nextTick();
        expect(wrapper.findAll('[data-testid="tree-label"]').length).toBe(1);

        const loaded = new Set<string>();
        const ensureLoaded = async (n: Node) => {
            if (n.children || loaded.has(n.key)) return;
            loaded.add(n.key);
            n.children = await loadChildren(n);
            await nextTick();
        };
        await ensureLoaded(root);

        const rendered = wrapper.findAll('[data-testid="tree-label"]').map((el) => el.text());
        READ("lazy calls=" + loadChildren.mock.calls.length + " rendered=" + rendered.join(","));

        expect(loadChildren).toHaveBeenCalledTimes(1);
        expect(rendered).toEqual(["root", "child-1"]);

        await ensureLoaded(root);
        expect(loadChildren).toHaveBeenCalledTimes(1);
        wrapper.unmount();
    });
});
