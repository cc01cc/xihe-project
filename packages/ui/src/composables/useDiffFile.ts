/**
 * PLAN-0755 M6 —— @git-diff-view 适配层（POC task-182 验收③ 的生产落地）。
 *
 * 两种数据源形态（POC 实测的静默坑）：
 * - **A 本地文本对**：`generateDiffFile(old, new, lang)`（`@git-diff-view/file`）——库内
 *   fast-diff 计算 unified diff。core 的 `createInstance` 从文本对**算不出** diff
 *   （`diffLineLength=0`、全行 `isHidden=true`、tbody 空）⇒ 文件对比必须走 `file` 包。
 * - **B 服务端 hunks**：`DiffFile.createInstance({ oldFile, newFile, hunks })`（core）。
 *   hunks 必须是**完整 unified diff 文本**；裸 `@@ -1,5 +1,6 @@` 块静默解析成 0 行
 *   ⇒ 适配层必须拼 `--- old` / `+++ new` 文件头，并断言解析后行数 > 0。
 *
 * 双形态等价性（POC 硬断言）：同一组 old/new 文本分别喂 A、B，行序列逐一相等。
 */
import { DiffFile } from "@git-diff-view/core";
import { generateDiffFile } from "@git-diff-view/file";

export interface DiffSource {
    oldFileName?: string | null;
    oldContent?: string | null;
    newFileName?: string | null;
    newContent?: string | null;
    language?: string | null;
    /** 服务端预计算 hunks（完整 unified diff 文本数组）。 */
    hunks?: string[];
}

/** 把裸 hunk 块补成完整 unified diff（`---`/`+++` 文件头）。POC 坑：缺头静默 0 行。 */
export function normalizeHunks(hunks: string[], oldName = "a", newName = "b"): string[] {
    return hunks.map((hunk) => {
        const hasHeader = /^(---|\+\+\+)\s/m.test(hunk);
        if (hasHeader) return hunk;
        return [`--- ${oldName}`, `+++ ${newName}`, hunk].join("\n");
    });
}

/** 形态 A：本地文本对 → DiffFile（库内计算 diff）。 */
export function diffFileFromText(source: DiffSource): DiffFile {
    const lang = source.language ?? "plaintext";
    const f = generateDiffFile(
        source.oldFileName ?? "old",
        source.oldContent ?? "",
        source.newFileName ?? "new",
        source.newContent ?? "",
        lang,
        lang,
    );
    f.initTheme("light");
    f.init();
    f.buildSplitDiffLines();
    f.buildUnifiedDiffLines();
    return f;
}

/** 形态 B：服务端 hunks → DiffFile（只消费预计算 diff）。 */
export function diffFileFromHunks(source: DiffSource): DiffFile {
    const oldName = source.oldFileName ?? "old";
    const newName = source.newFileName ?? "new";
    const hunks = normalizeHunks(source.hunks ?? [], oldName, newName);
    const f = DiffFile.createInstance({
        oldFile: {
            fileName: oldName,
            fileLang: source.language ?? "plaintext",
            content: source.oldContent ?? "",
        },
        newFile: {
            fileName: newName,
            fileLang: source.language ?? "plaintext",
            content: source.newContent ?? "",
        },
        hunks,
    });
    f.initTheme("light");
    f.init();
    f.buildSplitDiffLines();
    f.buildUnifiedDiffLines();
    return f;
}

/** 解析后行数断言（静默 0 行防护）。 */
export function assertDiffNotEmpty(f: DiffFile): void {
    if (f.diffLineLength === 0) {
        throw new Error(
            `[git-diff-view] diffLineLength=0：hunks 缺 ---/+++ 头或文本对无差异（静默失败）`,
        );
    }
}
