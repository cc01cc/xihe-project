import { describe, expect, it } from "vitest";
import { moveInList, orderIds, rankIn } from "../orderPure";

/**
 * task-152 / `D-1221` ④：独立会话顺序的四条纪律逐条钉住（判据 3/4 的纯函数侧）。
 *
 * <p>这些用例的价值不在覆盖率，而在**把形态写死**：一旦有人把「未知 id 落最前」
 * 改成「追加末尾」，或把「写回完整投影（顺带裁掉已删 id）」改成「逐点点改」，
 * 这里必须红。</p>
 */
describe("sessionOrder rank/投影", () => {
    it("rankIn：未知 id 返回 -1（= 排在所有已知之前），已知返回名次", () => {
        expect(rankIn(["a", "b", "c"], "b")).toBe(1);
        expect(rankIn(["a", "b", "c"], "z")).toBe(-1);
        expect(rankIn([], "a")).toBe(-1);
    });

    it("orderIds：空 order ⇒ 原样返回（等于没有自定义顺序）", () => {
        expect(orderIds(["c", "a", "b"], [])).toEqual(["c", "a", "b"]);
    });

    it("orderIds：未知 id 落最前，已知按持久名次；未知之间保持传入相对序", () => {
        expect(orderIds(["x", "b", "y", "a"], ["a", "b"])).toEqual(["x", "y", "a", "b"]);
    });

    it("orderIds：重复 id 取首次名次（同一会话不会占两个位置）", () => {
        expect(orderIds(["a", "b"], ["b", "a", "b"])).toEqual(["b", "a"]);
    });
});

describe("sessionOrder 桶内移动", () => {
    const order = ["a", "b", "c"];

    it("delta 下移一位", () => {
        expect(moveInList(order, ["a", "b", "c"], "a", { kind: "delta", delta: 1 })).toEqual([
            "b",
            "a",
            "c",
        ]);
    });

    it("delta 上移一位", () => {
        expect(moveInList(order, ["a", "b", "c"], "c", { kind: "delta", delta: -1 })).toEqual([
            "a",
            "c",
            "b",
        ]);
    });

    it("越过边界 ⇒ null（不改、不夹取成无意义写入）", () => {
        expect(moveInList(order, ["a", "b", "c"], "a", { kind: "delta", delta: -1 })).toBeNull();
        expect(moveInList(order, ["a", "b", "c"], "c", { kind: "delta", delta: 1 })).toBeNull();
    });

    it("home / end", () => {
        expect(moveInList(order, ["a", "b", "c"], "c", { kind: "home" })).toEqual(["c", "a", "b"]);
        expect(moveInList(order, ["a", "b", "c"], "a", { kind: "end" })).toEqual(["b", "c", "a"]);
        expect(moveInList(order, ["a", "b", "c"], "a", { kind: "home" })).toBeNull();
    });

    it("id 不在渲染列表里 ⇒ null（例如它属于别的分组）", () => {
        expect(moveInList(order, ["a", "b", "c"], "zz", { kind: "delta", delta: 1 })).toBeNull();
    });

    it("写回的是完整投影：已删/不在列表的 id 被顺带裁掉，不留垃圾", () => {
        // order 里 c 已不在渲染列表（被删会话）⇒ 写回结果只含当前可见 id。
        expect(moveInList(["b", "a", "c"], ["b", "a"], "b", { kind: "delta", delta: 1 })).toEqual([
            "a",
            "b",
        ]);
    });

    it("结果再喂回去是稳定的（幂等：不动就不会继续漂）", () => {
        const once = moveInList(order, order, "a", { kind: "delta", delta: 2 })!;
        expect(once).toEqual(["b", "c", "a"]);
        expect(orderIds(order, once)).toEqual(["b", "c", "a"]);
    });
});
