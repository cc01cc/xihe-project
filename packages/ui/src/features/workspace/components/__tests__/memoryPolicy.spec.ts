import { describe, expect, it } from "vitest";
import { mergeMemoryEnabled, readMemoryEnabled, readMemoryTypesMissing } from "../memoryPolicy";

/**
 * task-58：记忆开关的**契约口径**（纯函数层）。
 *
 * <p>这组用例的作用不是"多测几个分支"，而是把 `readMemoryEnabled` 做成一条**能被变异咬住**的
 * 判据：把实现改回旧写法 `enabled !== false`，第一条与第二条立刻红。旧的判定是内联在面板
 * `computed` 里的，只能在集成用例里间接看到，而那时"画成开"看起来完全正常（缺陷就是这么活下来的）。</p>
 */
describe("memoryPolicy#readMemoryEnabled（缺省 = 关）", () => {
    it("contextPolicy 为 null ⇒ 关（契约明写 null = memory off）", () => {
        expect(readMemoryEnabled(null)).toBe(false);
    });

    it("没有 memory 段 / memory 为空对象 ⇒ 关（缺省 false，不是 true）", () => {
        expect(readMemoryEnabled({})).toBe(false);
        expect(readMemoryEnabled({ memory: {} })).toBe(false);
        expect(readMemoryEnabled({ memory: { writeMode: "tool" } })).toBe(false);
    });

    it("显式 enabled:false ⇒ 关；显式 enabled:true ⇒ 开", () => {
        expect(readMemoryEnabled({ memory: { enabled: false } })).toBe(false);
        expect(readMemoryEnabled({ memory: { enabled: true, writeMode: "tool" } })).toBe(true);
    });

    it("非布尔值不算开（CP 只写布尔；字符串「true」不是开）", () => {
        expect(readMemoryEnabled({ memory: { enabled: "true" } })).toBe(false);
        expect(readMemoryEnabled({ memory: { enabled: 1 } })).toBe(false);
    });
});

describe("memoryPolicy#readMemoryTypesMissing（开但无类型 ⇒ 实际不写入）", () => {
    it("enabled:true 且 types 为空数组 ⇒ 提示该开但不生效", () => {
        expect(readMemoryTypesMissing({ memory: { enabled: true, types: [] } })).toBe(true);
    });

    it("选了类型 ⇒ 不提示", () => {
        expect(readMemoryTypesMissing({ memory: { enabled: true, types: ["fact"] } })).toBe(false);
    });

    it("开关是关 ⇒ 不提示（这时该说的是「关」，不是「无类型」）", () => {
        expect(readMemoryTypesMissing({ memory: { enabled: false, types: [] } })).toBe(false);
        expect(readMemoryTypesMissing(null)).toBe(false);
    });

    it("types 缺失 ⇒ 不提示（缺省类型语义另有规定，不在这里替 CP 判定）", () => {
        expect(readMemoryTypesMissing({ memory: { enabled: true } })).toBe(false);
    });
});

describe("memoryPolicy#mergeMemoryEnabled（整对象替换 ⇒ 必须合并）", () => {
    it("只改 memory.enabled，writeMode / passive / types 与顶层键原样保留", () => {
        const policy = {
            window: 5,
            memory: { enabled: true, writeMode: "tool", passive: "summary", types: ["fact"] },
        };

        expect(mergeMemoryEnabled(policy, false)).toEqual({
            window: 5,
            memory: { enabled: false, writeMode: "tool", passive: "summary", types: ["fact"] },
        });
    });

    it("contextPolicy 为 null ⇒ 发最小对象，不凭空造别的键", () => {
        expect(mergeMemoryEnabled(null, true)).toEqual({ memory: { enabled: true } });
    });

    it("memory 缺失但有其它顶层键 ⇒ 保留顶层键", () => {
        expect(mergeMemoryEnabled({ hooks: { advisors: [] } }, true)).toEqual({
            hooks: { advisors: [] },
            memory: { enabled: true },
        });
    });

    it("不就地改写入参（BL-364/365：父层 / store 共享同一引用的对象不能被污染）", () => {
        const policy = { memory: { enabled: true, writeMode: "tool" } };
        mergeMemoryEnabled(policy, false);
        expect(policy.memory.enabled).toBe(true);
    });
});
