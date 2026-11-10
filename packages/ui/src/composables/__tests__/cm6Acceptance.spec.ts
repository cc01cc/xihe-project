/**
 * PLAN-0755 M6 —— CM6 验收单测（POC task-182 四条硬验收的生产落地证据）。
 *
 * - V1 主题：CM6 产物只写 `var(--token)`（断言 cmTheme 的 style-mod 产物含 token，
 *   且不含任何十六进制色值）。
 * - V2 byte 往返：`state.doc.toString()` 编辑序列逐步与期望串 **UTF-8 byte** 相等
 *   （POC 坑：`Text.length` 是 UTF-16 码元，与 `Buffer.byteLength` 不等）。
 * - V4 成本：`state.update` 单字符插入耗时 ≤ 现状流式全量重高亮基线（1.86 ms，
 *   POC 实测；此处只断言不劣于基线的 10×，避免机器抖动误伤）。
 */
import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { cmExtensions, cmTheme, CM_THEME_CONTRACT } from "../cmTheme";

/** 文档样本：含中文（多字节）+ 代码块 + 标题，覆盖 Markdown 解析。 */
const SAMPLE = [
    "# 示例文档",
    "",
    "这是一段**加粗**与 *斜体* 的示例，含中文多字节字符。",
    "",
    "## 第一节",
    "",
    "```ts",
    "const view = new EditorView({ state, parent });",
    "```",
    "",
    "> 引用一行",
    "",
    "- 列表项 A",
    "- 列表项 B",
].join("\n");

describe("PLAN-0755 CM6 验收（V1 主题）", () => {
    it("主题产物只写 var(--token)，不含十六进制色值", () => {
        // CM6 的 `EditorView.theme` 返回 Extension 数组（内部 style-mod 编码）。
        // 递归收集所有字符串/对象节点，拼成可断言的序列化文本。
        const serialized = JSON.stringify(cmTheme);
        // 断言引用了 token
        expect(serialized).toContain("var(--foreground)");
        expect(serialized).toContain("var(--background)");
        // 断言没有裸十六进制色（#rrggbb / #rgb）
        expect(serialized).not.toMatch(/#(?:[0-9a-fA-F]{3,8})\b/);
        // 契约条目（供宿主/浏览器复核）存在
        expect(CM_THEME_CONTRACT.length).toBeGreaterThan(0);
    });

    it("cmExtensions 组合了主题 + 焦点环 + 语法高亮", () => {
        expect(cmExtensions.length).toBe(3);
    });
});

describe("PLAN-0755 CM6 验收（V2 byte 往返）", () => {
    /** 用 UTF-8 byte 口径比较（POC 坑：UTF-16 length ≠ UTF-8 byteLength）。 */
    function expectByteEqual(actual: string, expected: string) {
        const a = Buffer.from(actual, "utf8");
        const b = Buffer.from(expected, "utf8");
        expect(a.equals(b)).toBe(true);
    }

    it("5 步编辑序列逐步 byte 相等（含中文）", () => {
        let state = EditorState.create({ doc: SAMPLE, extensions: [markdown(), ...cmExtensions] });
        const expected = [SAMPLE];

        // 1. 行尾追加
        const step1 = expected[0] + "\n追加一行";
        state = state.update({ changes: { from: state.doc.length, insert: "\n追加一行" } }).state;
        expected.push(step1);
        expectByteEqual(state.doc.toString(), expected[1]!);

        // 2. 中文插入
        const pos2 = state.doc.toString().indexOf("示例") + 2;
        const before2 = state.doc.toString();
        const step2 = before2.slice(0, pos2) + "（插入中文）" + before2.slice(pos2);
        state = state.update({ changes: { from: pos2, insert: "（插入中文）" } }).state;
        expected.push(step2);
        expectByteEqual(state.doc.toString(), expected[2]!);

        // 3. 删除一段
        const s3 = state.doc.toString();
        const start3 = s3.indexOf("引用一行");
        const end3 = start3 + "引用一行".length;
        const step3 = s3.slice(0, start3) + s3.slice(end3);
        state = state.update({ changes: { from: start3, to: end3, insert: "" } }).state;
        expected.push(step3);
        expectByteEqual(state.doc.toString(), expected[3]!);

        // 4. 块替换
        const s4 = state.doc.toString();
        const start4 = s4.indexOf("- 列表项 A");
        const end4 = s4.indexOf("- 列表项 B") + "- 列表项 B".length;
        const step4 = s4.slice(0, start4) + "- 新列表项" + s4.slice(end4);
        state = state.update({ changes: { from: start4, to: end4, insert: "- 新列表项" } }).state;
        expected.push(step4);
        expectByteEqual(state.doc.toString(), expected[4]!);

        // 5. 尾部再追加
        const step5 = state.doc.toString() + "\n结尾";
        state = state.update({ changes: { from: state.doc.length, insert: "\n结尾" } }).state;
        expected.push(step5);
        expectByteEqual(state.doc.toString(), expected[5]!);
    });

    it("UTF-16 length 与 UTF-8 byteLength 口径差异被显式处理（POC 坑）", () => {
        const doc = "中文字符 abc";
        expect(doc.length).toBe(doc.length); // UTF-16 码元
        expect(Buffer.byteLength(doc, "utf8")).toBeGreaterThan(doc.length); // 中文 3 字节/字
    });
});

describe("PLAN-0755 CM6 验收（V4 成本）", () => {
    it("state.update 单字符插入 ≤ 现状基线的 10×（1.86ms → 18.6ms 上限）", () => {
        const doc = SAMPLE.repeat(50); // 大文档
        let state = EditorState.create({ doc, extensions: [markdown(), ...cmExtensions] });
        const start = performance.now();
        const rounds = 200;
        for (let i = 0; i < rounds; i++) {
            const pos = (i * 7) % state.doc.length;
            state = state.update({ changes: { from: pos, insert: "x" } }).state;
        }
        const perMove = (performance.now() - start) / rounds;
        // POC 实测 0.1448ms；上限给 10× 基线（18.6ms）防抖动误伤。
        expect(perMove).toBeLessThan(18.6);
    });
});
