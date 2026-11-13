import { describe, expect, it } from "vitest";

/**
 * task-431：白名单**三态归一**的纯函数判据（cp-1 task-423 / c7ace6f42 给的契约基线）。
 *
 * <p>契约事实：`AgentPrincipalView.allowedModels` 是 required、`array|null`，键恒在；
 * `null` = 不限制。`[]` 在语义上同样等于不限制（CP 不会用空数组表达「禁止一切模型」）。
 * 编辑面 dirty-check 必须比**语义**：同一份白名单换个顺序、或 null 与 [] 互换，都不算改动，
 * 否则预填原样保存会白写一次 PATCH（还多一条审计）——这正是 423 的真因。</p>
 *
 * <p>为什么放服务层而不是组件里：这是契约派生的规则，列表行与 PATCH 回读视图**共用同一套归一**，
 * 组件内联一份就没法单测、也会与另一处漂移（膨胀门：否决「组件里内联比较」）。</p>
 */
import { normalizeModelWhitelist, sameModelWhitelist } from "../instanceResources";

const A = { provider: "anthropic", model: "claude-sonnet-4-5" };
const B = { provider: "openai", model: "gpt-5.1" };

describe("normalizeModelWhitelist（task-431 三态归一）", () => {
    it("null / undefined / [] / 非数组 一律归一为 null（不限制）", () => {
        expect(normalizeModelWhitelist(null)).toBeNull();
        expect(normalizeModelWhitelist(undefined)).toBeNull();
        expect(normalizeModelWhitelist([])).toBeNull();
        expect(normalizeModelWhitelist("anthropic")).toBeNull();
        expect(normalizeModelWhitelist({ provider: "anthropic" })).toBeNull();
    });

    it("条目去空：provider 或 model 为空的项不算白名单成员", () => {
        expect(
            normalizeModelWhitelist([
                A,
                { provider: "", model: "x" },
                { provider: "p", model: " " },
            ]),
        ).toEqual([A]);
        expect(normalizeModelWhitelist([{ provider: "", model: "" }])).toBeNull();
    });

    it("去重 + 按 provider/model 排序（顺序不是语义）", () => {
        expect(normalizeModelWhitelist([B, A, B])).toEqual([A, B]);
        expect(normalizeModelWhitelist([A, B])).toEqual(normalizeModelWhitelist([B, A]));
    });

    it("有项 = 白名单：原样承载 provider/model（不改大小写、不猜别名）", () => {
        expect(normalizeModelWhitelist([{ provider: "Anthropic", model: "Claude" }])).toEqual([
            { provider: "Anthropic", model: "Claude" },
        ]);
    });
});

describe("sameModelWhitelist（task-431 dirty-check 判据）", () => {
    it("null 与 [] 相等（都表示不限制）", () => {
        expect(sameModelWhitelist(null, [])).toBe(true);
        expect(sameModelWhitelist([], null)).toBe(true);
        expect(sameModelWhitelist(null, null)).toBe(true);
    });

    it("不限制 vs 有项：不相等（勾选/取消勾选都是真改动）", () => {
        expect(sameModelWhitelist(null, [A])).toBe(false);
        expect(sameModelWhitelist([A], null)).toBe(false);
        expect(sameModelWhitelist([], [A])).toBe(false);
    });

    it("同一份白名单换顺序 / 带重复项：相等（不白写 PATCH）", () => {
        expect(sameModelWhitelist([A, B], [B, A])).toBe(true);
        expect(sameModelWhitelist([A, B], [B, A, B])).toBe(true);
    });

    it("成员不同或数量不同：不相等", () => {
        expect(sameModelWhitelist([A], [B])).toBe(false);
        expect(sameModelWhitelist([A], [A, B])).toBe(false);
        expect(
            sameModelWhitelist([A], [{ provider: "anthropic", model: "claude-haiku-4-5" }]),
        ).toBe(false);
    });
});
