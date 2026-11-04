// PLAN-0658 R9 fixture 自测：reasoning 段落生成器（`--llm-mode=reasoning` /
// `XIHE-E2E-REASONING` marker）。
//
// 门禁：`mise run test:e2e:fixtures`（等价 `node --test "e2e/fixtures/__tests__/*.test.mjs"`），
// 改 `e2e/fixtures/` 后必跑（packages/ui AGENTS.md / 根 AGENTS.md 硬要求）。
import assert from "node:assert/strict";
import test from "node:test";

import {
    REASONING_CLOSE,
    REASONING_MARKER,
    REASONING_MODE,
    REASONING_OPEN,
    composeReasoningStream,
    wantsReasoning,
} from "../reasoning-chunks.mjs";

test("marker 门控：只有带 XIHE-E2E-REASONING 的提示词才要求 reasoning", () => {
    assert.equal(wantsReasoning(`${REASONING_MARKER} 请回答`), true);
    assert.equal(wantsReasoning("普通问题"), false);
    assert.equal(wantsReasoning(""), false);
    assert.equal(wantsReasoning(undefined), false);
    assert.equal(wantsReasoning({ content: REASONING_MARKER }), false);
});

test("默认行为零变化：无 marker 且未 force 时返回 null（调用方走原成功路径）", () => {
    assert.equal(composeReasoningStream("普通问题"), null);
    assert.equal(composeReasoningStream("XIHE-E2E-SLOW 8000 的问题"), null);
    assert.equal(composeReasoningStream("普通问题", { force: false }), null);
});

test("force=true 时忽略 marker（--llm-mode=reasoning 整机通道）", () => {
    const segments = composeReasoningStream("任意提示词", { force: true });
    assert.ok(segments, "force 必须产出段落");
    assert.equal(segments.length, 5);
});

test("段落表：先 reasoning（多段、含 `<think>`/`</think>`），最后正文", () => {
    const segments = composeReasoningStream(`${REASONING_MARKER} 请给出两步结论`);
    assert.ok(segments);
    assert.deepEqual(
        segments.map((segment) => segment.kind),
        ["reasoning", "reasoning", "reasoning", "reasoning", "text"],
    );
    assert.equal(segments[0].content, REASONING_OPEN);
    assert.equal(segments.at(-2).content, REASONING_CLOSE);
    assert.equal(segments.at(-1).kind, "text");
    assert.ok(segments.at(-1).content.includes(REASONING_MARKER));
});

test("reasoning 正文段带 marker（spec 可 grep），且标签在拼接后成对且有序", () => {
    const segments = composeReasoningStream(`${REASONING_MARKER} 请给出两步结论`);
    assert.ok(segments);
    const reasoningText = segments
        .filter((segment) => segment.kind === "reasoning")
        .map((segment) => segment.content)
        .join("");
    assert.equal(reasoningText.split(REASONING_OPEN).length, 2, "一个开标签");
    assert.equal(reasoningText.split(REASONING_CLOSE).length, 2, "一个闭标签");
    assert.ok(
        reasoningText.indexOf(REASONING_OPEN) < reasoningText.indexOf(REASONING_CLOSE),
        "闭标签在开标签之后",
    );
    assert.ok(
        reasoningText.includes(`${REASONING_MARKER} 第一步`) &&
            reasoningText.includes(`${REASONING_MARKER} 第二步`),
        "reasoning 正文被拆成多段（证明流式）且都带 marker",
    );
    // 折叠行只渲染第一行摘要 ⇒ 段落表必须是两行，折叠/展开判据才有区别。
    const inner = reasoningText
        .slice(
            reasoningText.indexOf(REASONING_OPEN) + REASONING_OPEN.length,
            reasoningText.indexOf(REASONING_CLOSE),
        )
        .trim();
    assert.equal(inner.split("\n").length, 2, "reasoning 正文两行（第一步 / 第二步）");
    assert.ok(inner.split("\n")[0].includes(`${REASONING_MARKER} 第一步`), "第一行 = 第一步");
    const text = segments
        .filter((segment) => segment.kind === "text")
        .map((segment) => segment.content)
        .join("");
    assert.ok(!text.includes(REASONING_OPEN) && !text.includes(REASONING_CLOSE), "正文不含标签");
});

test("段落表冻结：调用方不能改写共享数据", () => {
    const segments = composeReasoningStream(`${REASONING_MARKER} x`);
    assert.ok(segments);
    assert.equal(Object.isFrozen(segments), true);
});

test("mode 名固定为 reasoning（runner --llm-mode 与 batch 配置都按此字符串）", () => {
    assert.equal(REASONING_MODE, "reasoning");
});
