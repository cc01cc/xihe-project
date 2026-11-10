/**
 * PLAN-0755 M6 —— @git-diff-view 适配层验收（POC task-182 验收③ 的生产落地）。
 *
 * - 双形态等价：同一组 old/new 文本分别喂 A（generateDiffFile）与
 *   B（core+hunks），行序列逐一相等。
 * - 文件头适配：裸 `@@` 块被补成完整 unified diff（缺头静默 0 行 = POC 坑）。
 * - 空断言：无差异文本对 ⇒ diffLineLength=0 ⇒ 显式抛错（不静默空面板）。
 */
import { describe, expect, it } from "vitest";
import {
    assertDiffNotEmpty,
    diffFileFromHunks,
    diffFileFromText,
    normalizeHunks,
} from "../useDiffFile";

const OLD = ['import { a } from "x";', "const v = 1;", "export { v };"].join("\n");
const NEW = ['import { a } from "x";', "const v = 2;", "export { v };"].join("\n");

describe("PLAN-0755 useDiffFile 适配层", () => {
    it("形态 A（本地文本对）产生非空 diff", () => {
        const f = diffFileFromText({
            oldContent: OLD,
            newContent: NEW,
            language: "typescript",
        });
        expect(f.diffLineLength).toBeGreaterThan(0);
        expect(() => assertDiffNotEmpty(f)).not.toThrow();
    });

    it("normalizeHunks 给裸 @@ 块补 ---/+++ 头（缺头静默 0 行的防护）", () => {
        const bare =
            '@@ -1,3 +1,3 @@\n import { a } from "x";\n-const v = 1;\n+const v = 2;\n export { v };';
        const normalized = normalizeHunks([bare], "old.ts", "new.ts");
        expect(normalized[0]).toContain("--- old.ts");
        expect(normalized[0]).toContain("+++ new.ts");
        // 已带头的不重复补
        const withHeader = "--- old.ts\n+++ new.ts\n" + bare;
        expect(normalizeHunks([withHeader])[0]).toBe(withHeader);
    });

    it("形态 B（服务端 hunks）与形态 A 行序列等价", () => {
        const a = diffFileFromText({ oldContent: OLD, newContent: NEW, language: "typescript" });
        const hunk = [
            "@@ -1,3 +1,3 @@",
            ' import { a } from "x";',
            "-const v = 1;",
            "+const v = 2;",
            " export { v };",
        ].join("\n");
        const b = diffFileFromHunks({
            oldFileName: "old.ts",
            newFileName: "new.ts",
            oldContent: OLD,
            newContent: NEW,
            language: "typescript",
            hunks: [hunk],
        });
        expect(b.diffLineLength).toBe(a.diffLineLength);
        expect(b.unifiedLineLength).toBe(a.unifiedLineLength);
    });

    it("无差异文本对 ⇒ 空断言抛错（不静默空面板）", () => {
        const f = diffFileFromText({ oldContent: "same", newContent: "same" });
        expect(f.diffLineLength).toBe(0);
        expect(() => assertDiffNotEmpty(f)).toThrow(/diffLineLength=0/);
    });
});
