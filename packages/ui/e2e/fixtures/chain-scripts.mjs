// PLAN-0648 (T1.1 fixture): mode=chain script table for the fake LLM server.
//
// A chain is an ordered list of EXISTING single-request mode names; the fake
// server advances one step per new turn of a conversation (see
// `resolveChainMode` in fake-llm-server.mjs). Per-step parameters are NOT kept
// here — each mode keeps its own marker convention, which the spec embeds in
// that turn's user message:
//   read_file    → XIHE-E2E-READ <path>            (fake-llm-server.mjs read_file branch)
//   write_file   → XIHE-E2E-WRITE <path> <content> (:253 sendWriteFileCompletion, 内建审批面)
//   exec_command → XIHE-E2E-EXEC <cmd> [--timeout] (:666 sendExecCommandCompletion)
// The special step "text" is plain success-mode prose; it is also the
// exhaustion fallback, so a chain always ends with "text" by convention.
//
// Scripts are frozen: the server only reads this table. A spec selects a
// script by starting the fake LLM with XIHE_FAKE_LLM_MODE=chain:<name>.

/** @type {Readonly<Record<string, readonly string[]>>} */
export const CHAIN_SCRIPTS = Object.freeze({
    // DSH 工作流 1（PLAN-0648 T1.1）：编码会话 = 读文件 → 写文件(走审批面) → 跑命令 → 模型自由收尾。
    "wf1-coding": Object.freeze(["read_file", "write_file", "exec_command", "text"]),
});
