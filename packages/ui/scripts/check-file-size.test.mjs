import assert from "node:assert/strict";
import { test } from "node:test";
import {
    buildBaseline,
    countLines,
    evaluate,
    isExcluded,
    thresholdsFor,
    THRESHOLDS,
} from "./check-file-size.mjs";

const file = (path, lines, bytes) => ({ path, lines, bytes });
const baselineOf = (files, exempt = {}) => ({ files, $exempt: exempt });

test("① 不在基线且超 error 阈值 ⇒ error 并点名", () => {
    const result = evaluate({
        files: [file("src/huge.ts", 1000, 60_000)],
        baseline: baselineOf({}),
    });
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].kind, "new-over-error");
    assert.equal(result.errors[0].path, "src/huge.ts");
});

test("①b 行数达标但字节超 error ⇒ 一样拦（双阈值）", () => {
    const result = evaluate({
        files: [file("src/one-line.ts", 10, 50_000)],
        baseline: baselineOf({}),
    });
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].path, "src/one-line.ts");
});

test("② 基线内变小 ⇒ 放行，只提示可收缩", () => {
    const result = evaluate({
        files: [file("src/shrunk.ts", 650, 28_000)],
        baseline: baselineOf({ "src/shrunk.ts": { lines: 700, bytes: 30_000 } }),
    });
    assert.equal(result.errors.length, 0);
    assert.equal(result.shrinks.length, 1);
    assert.equal(result.shrinks[0].kind, "shrunk");
});

test("③ 基线内变大 ⇒ error 并点名（行数、字节各自都能触发）", () => {
    const grownLines = evaluate({
        files: [file("src/grew.ts", 701, 30_000)],
        baseline: baselineOf({ "src/grew.ts": { lines: 700, bytes: 30_000 } }),
    });
    assert.equal(grownLines.errors.length, 1);
    assert.equal(grownLines.errors[0].kind, "grown");
    assert.equal(grownLines.errors[0].path, "src/grew.ts");
    assert.equal(grownLines.errors[0].grewLines, true);

    const grownBytes = evaluate({
        files: [file("src/grew.ts", 700, 30_001)],
        baseline: baselineOf({ "src/grew.ts": { lines: 700, bytes: 30_000 } }),
    });
    assert.equal(grownBytes.errors.length, 1);
    assert.equal(grownBytes.errors[0].grewBytes, true);
});

test("④ i18n/messages 放宽到 1200 行：1000 行只 warn，1300 行才 error", () => {
    assert.equal(thresholdsFor("src/i18n/messages/chat.ts").errorLines, 1_200);
    assert.equal(thresholdsFor("src/i18n/messages/deep/x.ts").errorLines, 1_200);
    assert.equal(thresholdsFor("src/composables/api.ts").errorLines, 900);

    const relaxed = evaluate({
        files: [file("src/i18n/messages/chat.ts", 1_000, 80_000)],
        baseline: baselineOf({}),
    });
    assert.equal(relaxed.errors.length, 0);
    assert.equal(relaxed.warnings.length, 1);

    const tooBig = evaluate({
        files: [file("src/i18n/messages/chat.ts", 1_300, 80_000)],
        baseline: baselineOf({}),
    });
    assert.equal(tooBig.errors.length, 1);
    assert.equal(tooBig.errors[0].kind, "new-over-error");
});

test("⑤ 豁免项不报：*.d.ts 与基线 $exempt 列出的路径", () => {
    const result = evaluate({
        files: [
            file("src/types/big.d.ts", 5_000, 200_000),
            file("src/legacy/generated.ts", 5_000, 200_000),
        ],
        baseline: baselineOf({}),
        exemptions: { "src/legacy/generated.ts": "生成器产物，不手写" },
    });
    assert.equal(result.errors.length, 0);
    assert.equal(result.warnings.length, 0);
    assert.deepEqual(
        result.exempt.map((entry) => entry.path),
        ["src/types/big.d.ts", "src/legacy/generated.ts"],
    );
});

test("⑥ __tests__ / preview / e2e 整目录不参与判定", () => {
    for (const path of [
        "src/__tests__/huge.ts",
        "src/preview/huge.ts",
        "src/e2e/huge.ts",
        "src/features/preview/deep/huge.vue",
    ]) {
        assert.equal(isExcluded(path), true, path);
    }
    assert.equal(isExcluded("src/preview-dockview.html"), false);
    const result = evaluate({
        files: [
            file("src/__tests__/huge.ts", 9_000, 400_000),
            file("src/preview/huge.ts", 9_000, 400_000),
        ],
        baseline: baselineOf({}),
    });
    assert.equal(result.errors.length, 0);
    assert.equal(result.warnings.length, 0);
    assert.equal(result.exempt.length, 0);
});

test("⑦ --write-baseline：收 warn 以上存量；默认只增不删，--prune 才收缩", () => {
    const files = [
        file("src/big.ts", 600, 30_000),
        file("src/small.ts", 100, 4_000),
        file("src/types/big.d.ts", 5_000, 200_000),
    ];
    const previous = baselineOf({
        "src/now-small.ts": { lines: 620, bytes: 31_000 },
    });

    const kept = buildBaseline({ files, previous, prune: false });
    assert.deepEqual(Object.keys(kept.files).sort(), ["src/big.ts", "src/now-small.ts"]);
    assert.deepEqual(Object.keys(kept.exemptions), ["src/types/big.d.ts"]);
    assert.deepEqual(kept.kept, ["src/now-small.ts"]);

    const pruned = buildBaseline({ files, previous, prune: true });
    assert.deepEqual(Object.keys(pruned.files), ["src/big.ts"]);
    assert.deepEqual(pruned.dropped, ["src/now-small.ts"]);
});

test("⑧ 行数按 wc -l 口径（末尾换行不多算一行）", () => {
    assert.equal(countLines(""), 0);
    assert.equal(countLines("a"), 1);
    assert.equal(countLines("a\n"), 1);
    assert.equal(countLines("a\nb"), 2);
    assert.equal(countLines("a\nb\n"), 2);
});

test("⑨ 阈值首版取值与卡面一致", () => {
    assert.equal(THRESHOLDS.default.warnLines, 500);
    assert.equal(THRESHOLDS.default.errorLines, 900);
    assert.equal(THRESHOLDS.i18nMessages.errorLines, 1_200);
});
