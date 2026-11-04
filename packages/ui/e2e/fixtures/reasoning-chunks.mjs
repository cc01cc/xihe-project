// PLAN-0658 (R9 fixture): reasoning 段落的确定性生成器（fake LLM `mode=reasoning` / 提示词 marker）。
//
// 载体为什么是 `<think>…</think>` 内联文本，而不是 provider 原生 reasoning 字段：
//   1. 本车道 fake LLM 只实现 openai/deepseek 风格 `chat/completions` SSE；
//   2. Agent 的 chat-completions 流式解析**只**读 `delta.content` / `delta.tool_calls`
//      （packages/agent/src/xihe_agent/llm/api_sender.py:254-288），不抽 reasoning 字段；
//      原生 `hint=reasoning` 只出现在 anthropic-messages / responses 风格（同文件 :317-320、
//      :346-349）——本车道没有这两类连接；
//   3. `<think>` 是 UI `useStreamParser` 已识别的同一语法（ChatStreamIntegration.spec.ts:69），
//      且它随 `delta.content` 一路入库 ⇒ 唯一能验 R9 "durable 段"的载体。
//
// 段落表是冻结数据：server 只读，测试直接断言（同 chain-scripts.mjs 的约定）。
// 默认行为零变化：没有 marker / 没有 mode=reasoning 时 `composeReasoningStream` 返回 null，
// 调用方走原有成功路径（见 fake-llm-server.mjs 的调用点）。

export const REASONING_MODE = "reasoning";
export const REASONING_MARKER = "XIHE-E2E-REASONING";
export const REASONING_OPEN = "<think>";
export const REASONING_CLOSE = "</think>";

/** 提示词是否要求 reasoning 段落（marker 门控）。 */
export function wantsReasoning(prompt) {
    return typeof prompt === "string" && prompt.includes(REASONING_MARKER);
}

/**
 * 冻结段落表：先 reasoning（拆成多段、**两行**以证明确实在流式且折叠行只显首行摘要），
 * 最后正文。`force=true` 时忽略 marker（`--llm-mode=reasoning` 整机通道用）。
 *
 * 两行不是排版偏好：UI `ProcessRow` 的折叠行只渲染 `summary`（推理内容第一行），
 * R9 的"默认折叠"判据必须能区分「摘要行」与「展开后的全文」，否则折叠断言无法证伪。
 *
 * @param {unknown} prompt 最后一条 user 消息的文本
 * @param {{ force?: boolean }} [options]
 * @returns {ReadonlyArray<{ kind: "reasoning" | "text", content: string }> | null}
 */
export function composeReasoningStream(prompt, { force = false } = {}) {
    if (!force && !wantsReasoning(prompt)) return null;
    return Object.freeze([
        { kind: "reasoning", content: REASONING_OPEN },
        { kind: "reasoning", content: `${REASONING_MARKER} 第一步：先拆问题。\n` },
        { kind: "reasoning", content: `${REASONING_MARKER} 第二步：再收口。` },
        { kind: "reasoning", content: REASONING_CLOSE },
        { kind: "text", content: `${REASONING_MARKER} 结论：可按两步核对。` },
    ]);
}
