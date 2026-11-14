import { describe, expect, it, vi } from "vitest";
import { nextTick, ref } from "vue";
import { useSplitterPanelWidthSync } from "../useSplitterPanelWidthSync";

/**
 * task-2 / 原 task-613：store → 面板宽度通道的三条判据。
 *
 * 都是「不该发生的事」型判据（D-1423 同族），所以每条都要**数调用次数**，不能只看最终宽度：
 * 只看宽度时，「通道根本没接」与「通道接了但被拖拽挡住」会得出同一个读数。
 */
function setup(initial: { width?: number; groupSize?: number }) {
    const width = ref(initial.width ?? 240);
    const groupSize = ref(initial.groupSize ?? 1160);
    const isDragging = ref(false);
    const collapsed = ref(false);
    const apply = vi.fn<(widthPx: number) => void>();
    useSplitterPanelWidthSync({
        width,
        groupSize,
        isDragging,
        isCollapsed: () => collapsed.value,
        apply,
    });
    return { width, groupSize, isDragging, collapsed, apply };
}

describe("useSplitterPanelWidthSync（task-2）", () => {
    it("① store 宽度变化 ⇒ 应用一次（新通道不是装饰）", async () => {
        const ctx = setup({});
        ctx.width.value = 300;
        await nextTick();
        expect(ctx.apply).toHaveBeenCalledTimes(1);
        expect(ctx.apply).toHaveBeenCalledWith(300);
    });

    it("② 组宽变化 ⇒ 按存储 px 重算一次（%↔px 基数变了，宽度不能跟着缩）", async () => {
        const ctx = setup({ width: 240, groupSize: 1160 });
        ctx.groupSize.value = 940;
        await nextTick();
        expect(ctx.apply).toHaveBeenCalledTimes(1);
        expect(ctx.apply).toHaveBeenCalledWith(240);
    });

    it("③ 拖拽期应用次数 = 0（结构判据：拖拽期间 store 根本不写）", async () => {
        const ctx = setup({});
        ctx.isDragging.value = true;
        await nextTick();
        ctx.apply.mockClear();
        // 拖拽 5 点：store 不变 ⇒ 通道不该被触发
        for (let i = 0; i < 5; i += 1) await nextTick();
        expect(ctx.apply, "拖拽期 store 不写 ⇒ 本通道 0 次").toHaveBeenCalledTimes(0);
    });

    it("④ 注入反例：拖拽中被强行写 store ⇒ 仍 0 次，且不产生递归", async () => {
        const ctx = setup({});
        ctx.isDragging.value = true;
        await nextTick();
        ctx.apply.mockClear();
        // 人为在拖拽中写 store（模拟「将来有人在拖拽期写」）
        for (const injected of [200, 210, 220, 230, 240]) {
            ctx.apply.mockClear();
            ctx.width.value = injected;
            await nextTick();
            await nextTick();
            expect(ctx.apply, `注入 '${injected}' 后不得回灌`).toHaveBeenCalledTimes(0);
        }
        // 递归判据：若 guard 失效，apply 每帧再触发 watch 就会滚成雪崩
        expect(ctx.apply).toHaveBeenCalledTimes(0);
    });

    it("⑤ 折叠态 ⇒ 不应用（展开宽会顶掉 rail）", async () => {
        const ctx = setup({});
        ctx.collapsed.value = true;
        await nextTick();
        ctx.apply.mockClear();
        ctx.width.value = 320;
        ctx.groupSize.value = 1000;
        await nextTick();
        expect(ctx.apply).toHaveBeenCalledTimes(0);
    });

    it("⑥ apply 内部又写 store（最坏情形）⇒ 收敛，不无限递归", async () => {
        const width = ref(290);
        const groupSize = ref(1160);
        const calls: number[] = [];
        const apply = (px: number) => {
            calls.push(px);
            // 模拟「应用值被夹取后再写回 store」：300 → 260 → 260（稳定）
            width.value = Math.min(px, 260);
        };
        useSplitterPanelWidthSync({
            width,
            groupSize,
            isDragging: ref(false),
            isCollapsed: () => false,
            apply,
        });
        width.value = 300;
        await nextTick();
        await nextTick();
        await nextTick();
        expect(calls.length, "300→260 收敛，不滚成雪崩").toBeLessThanOrEqual(2);
        expect(calls.at(-1)).toBe(260);
    });
});
