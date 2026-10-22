# Agent 离线评测资产（PLAN-0511 / PLAN-0540）

本目录存放版本化的固定评测任务数据与 gate 配置；执行代码在 `src/xihe_agent/evaluation/`。

## 布局

```text
evaluation/
  datasets/v1.jsonl     # 冻结只读（schemaVersion=1；camelCase 字段），仅用于历史报告复现
  datasets/v2.jsonl     # 当前数据集（schema_version=2；snake_case；assertion_class/attempts）
  gate-v1.json          # 冻结只读的 v1 gate 配置（只接受 report schema 1）
  gate-v2.json          # 当前 gate 配置（report schema 2；含 behavior_rate_min）
  fixtures/             # 评测夹具（MCP fixture、假 LLM、lane setup/teardown）
```

## 用法

```bash
# 校验数据集并打印 task/assertions/hash（默认 v2）
uv run python -m xihe_agent.evaluation validate

# 两个 lane 分开跑；一次只跑一层（真实 CP ChatRun；需本地栈与 Bearer token）
uv run python -m xihe_agent.evaluation run --lane invariant --output-dir .local/evaluation/<evalRunId>
uv run python -m xihe_agent.evaluation run --lane behavior --attempts 5 --min-valid-attempts 3 \
  --provider xiaomi --model mimo-v2.6-flash --output-dir .local/evaluation/<evalRunId>

# 对比两份报告
uv run python -m xihe_agent.evaluation compare --baseline <a.json> --candidate <b.json>

# 质量回归门（gate v2，合并两 lane 报告）
uv run python -m xihe_agent.evaluation gate \
  --report <invariant.json> --report <behavior.json> --baseline <baseline.json>
```

lane 生命周期由 `fixtures/lane-setup.mjs`（`setup | behavior-setup | status | run | teardown`）管理：确定性 lane 用脚本化假 LLM，behavior lane 用真实 provider。dataset/report/gate 契约、阈值模型与错误码见 `docs/i18n/zh-Hans/DEV-025-agent-evaluation.md`。

## 已知边界

- `tool_authorization.denied_mutation.v1` 记 `not_evaluated(no_denial_observability)`：拒绝事实目前只在审计日志，A1（invocation=0）与 A2（结构化拒绝）在现行契约下互斥（PLAN-0532 D1-C1）；该任务列在 gate-v2 的 expected 名单。
- `failure_budget` 已拆为两层：`failure_budget.no_repeat.v2`（invariant，脚本 provider 强制触发刹车）与 `failure_budget.attempt_rate.v2`（behavior，真实模型的工具尝试率），不再用单条二值断言混合确定性与随机性（PLAN-0540）。
- gate 目前未接 CI，本地 lane 运行；`--baseline` 只接受单份报告（当前以 invariant 报告作为覆盖基线）。

## 边界

- 全部 fixture 为合成/脱敏数据；不引用真实用户历史、生产 Workspace 或真实 Trace 正文。
- 原始输入/输出只落 Git-ignored `.local/evaluation/<evalRunId>/raw/`；报告不含正文/工具参数结果。
- invariant 的 error code 判据钉到 `RUN_BUDGET_EXHAUSTED` / `RUN_NO_PROGRESS`。

见 `plans/archive/PLAN-0511-XH-agent-evaluation-suite/spec/evaluation-contract.md`、`plans/archive/PLAN-0512-XH-agent-quality-regression-gate/spec/gate-contract.md`、`plans/archive/PLAN-0532-XH-agent-eval-tool-surface/` 与 `plans/PLAN-0540-XH-llm-test-determinism/`。
