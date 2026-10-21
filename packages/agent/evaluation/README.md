# Agent 离线评测资产（PLAN-0511）

本目录存放版本化的固定评测任务数据；执行代码在 `src/xihe_agent/evaluation/`。

## 布局

```text
evaluation/
  datasets/v1.jsonl     # 固定任务集（schemaVersion=1；camelCase 字段）
  gate-v1.json          # PLAN-0512 质量回归门阈值与 required task 集
  fixtures/             # PLAN-0532 评测专用 MCP fixture（always_failing）
```

## 用法

```bash
# 校验数据集并打印 task/assertions/hash
uv run python -m xihe_agent.evaluation

# 运行器（真实 CP ChatRun；需本地栈与 Bearer token）
uv run python -m xihe_agent.evaluation run --dataset evaluation/datasets/v1.jsonl --mode cp-real --output-dir .local/evaluation/<evalRunId>
# 对比
uv run python -m xihe_agent.evaluation compare --baseline <a.json> --candidate <b.json>
# 质量回归门（PLAN-0512）
uv run python -m xihe_agent.evaluation gate --report <report.json> --baseline <baseline.json>
```

## 已知边界

- `tool_authorization.denied_mutation.v1` 在 v1 记 `not_evaluated(no_denial_observability)`：拒绝事实目前只在审计日志，A1（invocation=0）与 A2（结构化拒绝）在现行契约下互斥（PLAN-0532 D1-C1）。
- `failure_budget` 的行为层不确定性（模型可能一次都不尝试）移交 PLAN-0540；本目录不再重复记录。

## 边界

- 全部 fixture 为合成/脱敏数据；不引用真实用户历史、生产 Workspace 或真实 Trace 正文。
- 原始输入/输出只落 Git-ignored `.local/evaluation/<evalRunId>/raw/`；报告不含正文/工具参数结果。
- `failure_budget.no_repeat.v1` 的 error code 判据钉到 `RUN_BUDGET_EXHAUSTED` / `RUN_NO_PROGRESS`。

见 `plans/archive/PLAN-0511-XH-agent-evaluation-suite/spec/evaluation-contract.md`、`plans/archive/PLAN-0532-XH-agent-eval-tool-surface/`（工具面与观测边界）与 `plans/PLAN-0540-XH-llm-test-determinism/`（行为层分层）。
