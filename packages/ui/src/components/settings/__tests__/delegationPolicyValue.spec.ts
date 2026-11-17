import { describe, expect, it } from "vitest";
import {
    buildDelegationPolicy,
    delegationPolicyDirty,
    delegationPolicyValid,
    emptyDelegationPolicy,
    parseDelegationPolicy,
} from "../delegationPolicyValue";

/**
 * task-191：委派预算值模型（纯函数）。
 *
 * <p>三条会翻车的口径各用一组断言咬住：</p>
 * <ol>
 *   <li><b>fail-closed</b>：缺文档 / 畸形字段 → 未设置（不回落到「8/3」这类本地默认值，
 *       否则用户看到的是平台默认却以为是自己的配置）；</li>
 *   <li><b>成对规则</b>：两半同填同清；半填 ⇒ 非法，保存按钮必须挡住（不发半截请求）；</li>
 *   <li><b>0 与「未设置」是两件事</b>：`maxCount = 0` 是「禁止委派」，不能当成空值清掉。</li>
 * </ol>
 */
describe("delegationPolicyValue", () => {
    it("parse：缺文档/畸形字段一律按未设置（fail-closed，不发明默认值）", () => {
        expect(parseDelegationPolicy(null)).toEqual(emptyDelegationPolicy());
        expect(parseDelegationPolicy({ maxCount: "8", maxDepth: 3 })).toEqual({
            maxCount: null,
            maxDepth: 3,
        });
        expect(parseDelegationPolicy({ maxCount: 8, maxDepth: 0 })).toEqual({
            maxCount: 8,
            maxDepth: null,
        });
        expect(parseDelegationPolicy({ maxCount: 1.5, maxDepth: -2 })).toEqual({
            maxCount: null,
            maxDepth: null,
        });
    });

    it("build：两半都空 ⇒ null（清空文档）；都填 ⇒ 文档对象", () => {
        expect(buildDelegationPolicy(emptyDelegationPolicy())).toBeNull();
        expect(buildDelegationPolicy({ maxCount: 0, maxDepth: 1 })).toEqual({
            maxCount: 0,
            maxDepth: 1,
        });
    });

    it("valid：成对规则 + 取值范围（count ≥ 0 整数、depth ≥ 1 整数）", () => {
        expect(delegationPolicyValid(emptyDelegationPolicy())).toBe(true);
        expect(delegationPolicyValid({ maxCount: 0, maxDepth: 1 })).toBe(true);
        expect(delegationPolicyValid({ maxCount: 8, maxDepth: 3 })).toBe(true);
        // 半填：非法。
        expect(delegationPolicyValid({ maxCount: 8, maxDepth: null })).toBe(false);
        expect(delegationPolicyValid({ maxCount: null, maxDepth: 3 })).toBe(false);
        // 越界 / 非整数：非法。
        expect(delegationPolicyValid({ maxCount: -1, maxDepth: 1 })).toBe(false);
        expect(delegationPolicyValid({ maxCount: 8, maxDepth: 0 })).toBe(false);
        expect(delegationPolicyValid({ maxCount: 1.5, maxDepth: 2 })).toBe(false);
    });

    it("dirty：只比两半，0 ≠ null（0 是「禁止委派」，不是空）", () => {
        expect(delegationPolicyDirty(emptyDelegationPolicy(), emptyDelegationPolicy())).toBe(false);
        expect(delegationPolicyDirty(emptyDelegationPolicy(), { maxCount: 0, maxDepth: 1 })).toBe(
            true,
        );
        expect(
            delegationPolicyDirty({ maxCount: 8, maxDepth: 3 }, { maxCount: 8, maxDepth: 3 }),
        ).toBe(false);
        expect(
            delegationPolicyDirty({ maxCount: 8, maxDepth: 3 }, { maxCount: 8, maxDepth: 4 }),
        ).toBe(true);
    });
});
