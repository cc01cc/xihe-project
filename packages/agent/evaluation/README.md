# Agent 离线评测资产（PLAN-0511）

本目录存放版本化的固定评测任务数据；执行代码在 `src/xihe_agent/evaluation/`。

## 布局

```text
evaluation/
  datasets/v1.jsonl     # 固定任务集（schemaVersion=1；camelCase 字段）
```

## 用法

```bash
# 校验数据集并打印 task/assertions/hash（M1）
uv run python -m xihe_agent.evaluation

# 目标运行器（M2，尚未实现）
#   uv run python -m xihe_agent.evaluation run --dataset evaluation/datasets/v1.jsonl --mode cp-real --output-dir .local/evaluation/<evalRunId>
# 目标对比（M3，尚未实现）
#   uv run python -m xihe_agent.evaluation compare --baseline <a.json> --candidate <b.json>
```

## 边界

- 全部 fixture 为合成/脱敏数据；不引用真实用户历史、生产 Workspace 或真实 Trace 正文。
- 原始输入/输出只落 Git-ignored `.local/evaluation/<evalRunId>/raw/`；报告不含正文/工具参数结果。
- `failure_budget.no_repeat.v1` 的 error code 判据钉到 `RUN_BUDGET_EXHAUSTED` / `RUN_NO_PROGRESS`。

见 `plans/PLAN-0511-XH-agent-evaluation-suite/spec/evaluation-contract.md`。
