import { describe, expect, it } from "vitest";
import { participantInitials } from "../participantInitials";

/**
 * `D-1142` ①（Lead 2026-11-13 裁定）：**缩写契约 = 恰好 1 个字符**。
 *
 * <p><b>为什么这个文件必须存在</b>：本函数此前没有专门用例 —— 它被
 * `SessionParticipantsPanel.spec.ts` 顺带断言过，而那里只断言了「长度 > 0」和
 * 「不含数字」两条。**这两条加起来对「2 个字符」完全免疫**：`"A架"` 长度 2 > 0、也不含
 * 数字 ⇒ 旧实现下全绿。于是「缩写是几个字」这条契约一直是**没人测的口头约定**，
 * 直到 `task-292` 量出两个字符在 12.25px / 14px 的圆里都装不下才暴露。</p>
 *
 * <p><b>这条判据的形态</b>：断言**精确等于**（`toBe("A")`），不是 `length <= 1`。
 * 理由：`length <= 1` 对空串也成立，而空串会在圆里渲染出一个纯色空块 —— 那是另一种缺陷。
 * 精确值同时钉住「取哪个字」，而长度上限只钉住「不多于」。</p>
 */
const UNKNOWN = "未知用户";

describe("participantInitials —— 恰好 1 个字符（D-1142 ①）", () => {
    it("两条既有不变量保持不变：只取 displayName、永不用 UUID", () => {
        // 回退值来自本地化占位文案的首字，而不是 UUID 的任何片段（DEV-032）。
        expect(participantInitials(null, UNKNOWN)).toBe("未");
        expect(participantInitials(undefined, UNKNOWN)).toBe("未");
        expect(participantInitials("   ", UNKNOWN)).toBe("未");
        // 即便传进来像 UUID 的串，也只当名字处理（取首字符），不会截 8 位前缀。
        expect(participantInitials("0f8fad5b-d9cb-469f-a165-70867728950e", UNKNOWN)).toBe("0");
    });

    // ---- 边界 ① 多词名：只取首个词的首字（旧实现会拼出 "A架"）----
    it("边界① 多词名取首词首字，不拼接第二个词", () => {
        expect(participantInitials("Atlas 架构", UNKNOWN)).toBe("A");
        expect(participantInitials("ada lovelace", UNKNOWN)).toBe("A");
        // 这条是旧实现的失败点：它返回 "A架"（长度 2），徽标装不下。
        expect(participantInitials("Atlas · 架构", UNKNOWN)).toBe("A");
    });

    // ---- 边界 ② 标点词被跳过：分隔符不得成为缩写 ----
    it("边界② 分隔词/标点词不参与，跳过它们取下一个有效词", () => {
        // "·" 是独立的标点词 ⇒ 跳过，取 "Atlas" 的 A（不是 "·"）
        expect(participantInitials("· Atlas", UNKNOWN)).toBe("A");
        expect(participantInitials("«» Atlas", UNKNOWN)).toBe("A");
        // 首词本身就是标点串时也不能返回标点字符
        expect(participantInitials("--- Zeta", UNKNOWN)).toBe("Z");
    });

    // ---- 边界 ③ 整个名字都是标点：必须回退，不能返回空串 ----
    it("边界③ 名字全是标点时走无名回退，不返回空串", () => {
        // 旧实现：words 过滤后为空数组 ⇒ join("") ⇒ ""（圆里一个纯色空块）。
        const punctOnly = ["···", "—", "«»", "()"];
        for (const name of punctOnly) {
            const initials = participantInitials(name, UNKNOWN);
            expect(initials).toBe("未");
            expect(initials).not.toBe("");
            expect(initials).toHaveLength(1);
        }
    });

    // ---- 边界 ④ 占位文案本身为空：兜底成 "?"，仍然 1 个字符 ----
    it('边界④ 占位文案为空时兜底 "?"，长度仍为 1', () => {
        expect(participantInitials(null, "")).toBe("?");
        expect(participantInitials("   ", "")).toBe("?");
        expect(participantInitials("···", "")).toBe("?");
    });

    it("所有分支的结果长度恒为 1（含 CJK 与大小写规范化）", () => {
        const cases: Array<[string | null | undefined, string]> = [
            ["Atlas 架构", UNKNOWN],
            ["ada", UNKNOWN],
            ["张三", UNKNOWN],
            ["···", UNKNOWN],
            [null, UNKNOWN],
            [null, ""],
            ["🚀 launch", UNKNOWN],
        ];
        for (const [name, unknown] of cases) {
            const initials = participantInitials(name, unknown);
            // 用 Array.from 量「字符数」而不是 .length（后者量码元：emoji 会被算成 2）。
            expect(Array.from(initials)).toHaveLength(1);
        }
    });

    it("取首字按 code point 切，不把代理对劈成半个（CJK 扩展 B）", () => {
        // "𠮷" 是 U+20BB7，UTF-16 里占两个码元（代理对）。
        // Array.from("𠮷野")[0] === "𠮷"；若用 word[0] 只会拿到高位代理 \uD842（半个字符）。
        const initials = participantInitials("𠮷野 家", UNKNOWN);
        expect(initials).toBe("𠮷");
        expect(Array.from(initials)).toHaveLength(1);
        // 反证：半个代理对会让 .length 仍是 1 但 Array.from 长度也变 1 而字符不完整，
        // 所以额外断言它不是孤立代理。
        expect(/^[\uD800-\uDFFF]$/.test(initials)).toBe(false);
    });

    it("emoji 属 \\p{S} 符号，被既有「跳过纯符号词」规则过滤（不是本卡改的语义）", () => {
        // "🚀" 是 So（Symbol, other）⇒ 命中 /^[\p{P}\p{S}]+$/u 的过滤，跳过它取下一个词。
        // 这条钉住「本卡没有顺手改掉旧的跳过规则」——否则 emoji 会变成缩写。
        expect(participantInitials("🚀 launch", UNKNOWN)).toBe("L");
    });

    it("拉丁字母统一大写（CJK 不受影响）", () => {
        expect(participantInitials("ada", UNKNOWN)).toBe("A");
        expect(participantInitials("张 三", UNKNOWN)).toBe("张");
    });
});
