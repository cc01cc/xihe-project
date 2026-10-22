---
title: DEV-025 - Agent 评测套件与 LLM 测试确定性
category: dev-guide
sidebar_order: 25
lang: zh-Hans
sidebar_group: "开发指南"
created: 2026-10-22
updated: 2026-10-22
tags: [evaluation, testing, llm, determinism, gate]
description: XH 评测套件的 dataset/report/gate 契约，以及 invariant/behavior 分层、N 次统计与命名规则。
---

# DEV-025: Agent 评测套件与 LLM 测试确定性

> 契约归属：`packages/agent/`（Python）。**v2 是当前契约**，已于 2026-10-22 完成两 lane 实测与 gate 校准；v1 冻结只读，仅用于历史报告复现。

## 1. 定位与归属

评测套件全部位于 `packages/agent/`：

| 组成 | 位置 |
|---|---|
| 代码 | `src/xihe_agent/evaluation/`（loader / evaluator / runner / report / gate / gate_v2 / compare / cp_http / trace） |
| 资产 | `evaluation/datasets/v1.jsonl`（只读）、`datasets/v2.jsonl`（当前）、`evaluation/gate-v1.json`（只读）、`gate-v2.json`（当前） |
| 夹具 | `evaluation/fixtures/`（Node `.mjs`：MCP fixture、假 LLM、lane setup/teardown） |
| 测试 | `tests/unit/test_evaluation_*.py` |

它**不是跨模块契约**。唯一的跨模块面是运行时对 CP HTTP API 的调用与 trace 反序列化，映射集中在 `cp_http.py` 与 `trace.py`。v1 读取路径保留 camelCase alias（`schema.py`/`loader.py`/`gate.py`）；v2 新增字段一律 snake_case，不再新增 alias。

## 2. 命令

```bash
uv run python -m xihe_agent.evaluation validate            # 校验 dataset（默认 v2）并打印 hash
uv run python -m xihe_agent.evaluation run --lane invariant --output-dir .local/evaluation/<evalRunId>
uv run python -m xihe_agent.evaluation run --lane behavior --attempts 5 --min-valid-attempts 3 --output-dir .local/evaluation/<evalRunId>
uv run python -m xihe_agent.evaluation compare --baseline a.json --candidate b.json
uv run python -m xihe_agent.evaluation gate --report invariant.json --report behavior.json --baseline baseline.json
```

`run` 必填 `--lane invariant|behavior`（一次只跑一层，避免一份报告混两类任务）与 `--token`（或 `XIHE_EVAL_TOKEN`）；`--dataset` 缺省时用 `datasets/v2.jsonl`，`--cp-url` 缺省 `http://127.0.0.1:12631`（多栈用 `XIHE_EVAL_CP_URL` 覆盖）。`--attempts` 只对 behavior lane 生效，对 invariant lane 传入会直接报错。`gate` 缺省读 `evaluation/gate-v2.json`，`--report` 可重复（每个 lane 一次），`--baseline` 只接受单份报告。`mise run gate:agent-quality` 是 `gate` 的封装，退出码 `0/1/2/3` = `PASS/FAIL/NOT_EVALUATED/GATE_ERROR`，仅 PASS 为 0。gate 目前**未接 CI**，本地 lane 运行。

凭据与原始数据：token 只从参数/env 读入内存，不写入报告与日志；`--output-dir` 的 raw 响应落 `.local`（gitignored），报告只保留 content-free facts；确定性 lane 的假 LLM 不需要真实凭据（setup 创建 connection 时不写 apiKey），真实 lane 的 provider key 只从 env 读取，禁止写入报告、日志或 argv。

## 3. 契约一：dataset

### 3.1 版本与风格

| 版本 | 风格 | 状态 |
|---|---|---|
| v1（`datasets/v1.jsonl`） | camelCase | 冻结只读，仅用于历史报告复现 |
| v2（`datasets/v2.jsonl`） | snake_case | 新建文件；未变任务保留原 `task_id` |

同一文件内**禁止混写两种风格**；loader 按文件级 `schema_version` 分派（v1 用 camel alias，v2 严格 snake），未知版本报错。

### 3.2 任务字段（v2）

| 字段 | 说明 |
|---|---|
| `schema_version` | 文件级，固定 `2`（v1 为 `1`） |
| `task_id` | `<category>.<semantic>.<version>`；未变任务沿用 v1 ID |
| `task_version` | 任务自身修订号；新建/修订任务为 `"v2"`，未变任务保留原值 |
| `assertion_class` | `invariant` \| `behavior`；一个任务只属一层 |
| `attempts` | invariant 固定 1；behavior 默认 5 |
| `category` / `input` / `context_fixture_id` / `context_fixture` / `allowed_tools` / `denied_tools` / `hard_assertions` / `judge_rubric_id` / `data_class` | 同 v1 语义，键名改 snake |

`hard_assertions[]` 子字段同样全 snake：`assertion_id`、`kind`、`expected`、`observation`、`description`。

v2 任务清单与分层：

| task_id | assertion_class | attempts | 备注 |
|---|---|---|---|
| `instruction_following.format_and_scope.v1` | behavior | 5 | 模型输出质量 |
| `grounded_citation.synthetic_source.v1` | behavior | 5 | 模型输出质量 |
| `tool_authorization.denied_mutation.v1` | invariant | 1 | 机制断言；当前 expected `not_evaluated(no_denial_observability)` |
| `failure_budget.no_repeat.v2` | invariant | 1 | 脚本 provider 强制触发刹车 |
| `failure_budget.attempt_rate.v2` | behavior | 5 | 真实模型；统计「至少一次工具调用」率 |

### 3.3 failure_budget 的拆分

v1 的 `failure_budget.no_repeat.v1` 把两件事压在同一条断言里，v2 拆为：

| 任务 | 类别 | 断言 | provider |
|---|---|---|---|
| `failure_budget.no_repeat.v2` | invariant | A1 及时终止、A2 刹车码、A3 无重复 mutation | 脚本化假 LLM |
| `failure_budget.attempt_rate.v2` | behavior | B1 `tool_invocation_count >= 1`（`at_least`） | 真实模型 |

A2 留在 invariant：脚本 provider 下「先调工具、再失败、再调」是确定序列，刹车码必然出现。0532 的波动来自真实模型是否开口，由 behavior 的调用率表达，不再借用 A2。

assertion `expected` 键映射（evaluator 同时接受两种）：

| v1 键 | v2 键 |
|---|---|
| `sourceId` | `source_id` |
| `allowedSourceIds` | `allowed_source_ids` |
| `repeatedCompletedMutations` | `repeated_completed_mutations` |

其余 expected 键（`enum`、`max_seconds`、`must_include`、`equals`、`required`、`allowed`、`types`、`dimensions`）本就是 snake，不变。

## 4. 契约二：report

报告字段从 0511 起即为 snake_case；v1→v2 只增加 `lane` 与 N 次尝试字段，不回写历史报告。camelCase 仅存在于 v1 dataset 与 v1 gate 配置/机器输出。

### 4.1 身份字段

报告记录：`schema_version`、`eval_run_id`、`created_at`、`commit`、`dataset_version`、`dataset_hash`、`scorer_version`、`mode`、`provider`、`model`、`prompt_version`、`lane`（v2 新增）。

gate 对**每份**报告实际校验：`schema_version`、`dataset_version`、`dataset_hash`、`scorer_version`、`mode`、`lane` 合法性、时间戳可解析与新鲜度（`max_age`）；所有候选报告的 `commit` 必须一致且等于 `--target-commit`（缺省当前 git HEAD）。基线报告执行同一套身份校验，错误码加 `baseline_` 前缀（如 `baseline_dataset_hash_mismatch`）。`provider`/`model`/`prompt_version` 是追溯字段，不参与身份判定——两个 lane 的 provider 本就不同。报告 `lane` 必须与其任务类别一致（invariant lane 只含 invariant 任务），否则 `GATE_ERROR(lane_class_mismatch:<task_id>)`。

### 4.2 任务结果（v2）

| 字段 | 说明 |
|---|---|
| `assertion_class` | 从 dataset 复制，用于 gate 归因 |
| `status` | `passed` \| `failed` \| `not_evaluated`，三值不变 |
| `attempts_planned` | 本次实际计划尝试数：默认取 dataset 的 `attempts`，`--attempts` 覆盖时取覆盖值 |
| `attempts[]` | 每次尝试一条：`run_id`、`status`（`passed`/`failed`/`not_evaluated`）、`error_code`、`assertions`、`usage`、`duration_ms` |
| `behavior_stats` | 仅 behavior 任务：`attempts`（计划数）、`met`、`rate`、`infra_failures`（计数） |
| `infra_attempts[]` | 无法判定的尝试（`attempts[]` 的子集）：`run_id`、`reason`（取自该 attempt 的 `error_code`）、`error_code` |

- invariant 任务：计划尝试数固定 1，`--attempts` 只作用于 behavior 任务；任一 attempt 失败 → 任务 `failed`，全部有效 → `passed`，仅 infra → `not_evaluated`。
- behavior 任务：`met` = 有效尝试中全部断言通过的次数；`behavior_stats.attempts` = 计划尝试数（等于 `attempts_planned`）；`valid = attempts - infra_failures`；`rate = met / valid`（`valid = 0` → `rate=null`）。任务 `status` 为「全部有效尝试满足」（`passed`）或存在未满足尝试（`failed`）；有效尝试低于运行期 `--min-valid-attempts` → `not_evaluated(infra_insufficient)`。
- **behavior 的门禁以 gate 阈值为准**：报告不内嵌 `behavior_rate_min`，gate 用 `behavior_stats.rate` + 配置 `value`/`min_valid` 判定；报告 `status` 仅供诊断。
- rate 派生为 `failed` 的任务即使 `assertions` 为空，gate 也必须按 behavior 阈值判定（不得因「没有失败断言」而假 PASS）。
- 任务判定为 `not_evaluated` 时，`attempts[]` 条数可少于 `attempts_planned`（尝试未跑满即中止）；其余状态必须逐条对齐。
- 判定顺序：先判 `timeout`（`failed`），再看 trace 缺失（`not_evaluated(missing_trace)`）；超时且 trace 缺失仍记 `failed`（0511 round-15 B1）。
- 旧报告（`schema_version: 1`）继续可解析，不产生 `attempts`/`behavior_stats`。

## 5. 契约三：gate

### 5.1 状态与退出码

| 状态 | 退出码 |
|---|---|
| `PASS` | 0 |
| `FAIL` | 1 |
| `NOT_EVALUATED` | 2 |
| `GATE_ERROR` | 3 |

候选（合并后）同时存在失败与覆盖缺口时，输出 `NOT_EVALUATED`（沿用 0512 裁定）。

### 5.2 阈值模型

每条阈值必须携带：

| 字段 | 说明 |
|---|---|
| `metric_id` | snake_case 指标 ID，全局唯一；出现在 `failures[]` 中用于归因 |
| `type` | `zero_failure` \| `behavior_rate_min` \| `not_evaluated_le_baseline`；每种类型最多出现一次 |
| `scope` | `invariant` \| `behavior` \| `all`。`zero_failure` 必须 `invariant`，`behavior_rate_min` 必须 `behavior`，`not_evaluated_le_baseline` 必须 `all` |
| `value` | `zero_failure` 只允许 `0`/省略；`behavior_rate_min` 必填，范围 `[0,1]`；baseline 型不使用 |
| `min_valid` | 仅 rate 型：最小有效尝试（必填，≥1） |
| `expected_attempts` | rate 型必填；zero_failure 型可选。设置后必须与报告 `attempts_planned` 一致 |
| `owner` / `rationale` / `source` / `repeat_window` | 0512 契约要求的元数据（全部必填） |

```json
{
  "metric_id": "behavior_rate_min",
  "type": "behavior_rate_min",
  "scope": "behavior",
  "value": 0.8,
  "min_valid": 3,
  "expected_attempts": 5,
  "owner": "XH agent owner",
  "rationale": "固定 5 次尝试，允许 1 次模型波动（4/5=0.8）；有效样本少于 3 次时比率不可信",
  "source": "plans/PLAN-0540-XH-llm-test-determinism/design.md",
  "repeat_window": "M4 3–5 轮 behavior baseline 校准（2026-10-22）"
}
```

分派与归因：

| 条件 | 结果 |
|---|---|
| 存在 required invariant 任务但没有 `zero_failure` 阈值 | GATE_ERROR（`zero_failure_threshold_missing`） |
| required invariant 任务任一 attempt failed | FAIL，`metric_id` 取 `zero_failure` 阈值；`assertion_id` 取首个失败断言，`error_code` 取该 attempt 的终止码（可能为空） |
| 存在 required behavior 任务但没有 `behavior_rate_min` 阈值 | GATE_ERROR（`missing_threshold_for_class:behavior`） |
| behavior 任务 `rate < value` | FAIL（`behavior_rate_below_min`），`metric_id` 取该 rate 阈值 |
| behavior 有效尝试 < `min_valid`，或 `rate` 为空 | NOT_EVALUATED（`infra_insufficient`） |
| 候选 not_evaluated 任务总数 > 基线 | FAIL（`coverage_shrunk`），`metric_id` 取 `not_evaluated_le_baseline` 阈值 |
| 配置了 `not_evaluated_le_baseline` 但未提供 `--baseline` | GATE_ERROR（`baseline_required_for_threshold`） |
| expected 任务实际 failed 但未配置 `not_evaluated_le_baseline` 阈值 | GATE_ERROR（`expected_task_threshold_missing`） |
| expected 任务实际 failed | FAIL（`expected_task_failed`），`metric_id` 取 `not_evaluated_le_baseline` 阈值 |
| expected 任务未出现 | NOT_EVALUATED（`missing_expected_task`） |
| expected 任务未评估但原因不在白名单 | NOT_EVALUATED（原因取报告原值） |
| 未知 type / scope 不匹配 / 重复 type 或 `metric_id` | GATE_ERROR |

状态优先级：`NOT_EVALUATED` > `FAIL` > `PASS`。**未知 type 一律 `GATE_ERROR`**：配置反序列化失败也必须映射为退出码 3，不得当作 PASS 或静默跳过。

### 5.3 指标 ID 与报告校验

- metric ID 一律 snake_case，由配置声明；仓库默认配置使用 `hard_assertion_zero_failure`（zero_failure）、`behavior_rate_min`（rate）、`expected_task_status`（baseline 覆盖）。gate 从阈值读取 `metric_id`，不硬编码字面量。
- gate v2 的 `--report` 可重复。多份报告按 `task_id` 合并后判定；同一 `task_id` 出现在多份报告 → `GATE_ERROR(duplicate_task_id:<id>)`。同一报告内重复 `task_id` 同样报错，不得靠字典覆盖去重。
- 每份报告分别执行身份校验；任一不通过即 `GATE_ERROR`。
- 报告 `attempts_planned` 与该任务阈值的 `expected_attempts` 不一致 → `GATE_ERROR(attempts_planned_mismatch:<task_id>)`（smoke 用 `--attempts 3` 产出的报告因此不可过门）；非 `not_evaluated` 任务的 `attempts[]` 条数必须等于 `attempts_planned`，`not_evaluated` 任务允许少于计划数但不得超出。
- behavior 任务的 `behavior_stats` 必须存在：`attempts` 等于 `attempts_planned`，`0 ≤ infra_failures ≤ attempts`，`rate` 为数值或 `null`；否则 `GATE_ERROR`。
- 报告 `lane` 与任务 `assertion_class` 不符 → `GATE_ERROR(lane_class_mismatch:<task_id>)`。
- 候选（合并后）同时存在失败与覆盖缺口时，输出 `NOT_EVALUATED`（沿用 0512 裁定）。
- expected 名单只接受机制性 `not_evaluated` 原因；`infra_insufficient`、`missing_trace`、`non_terminal_run` 等 infra 原因不得列入（配置校验期报 `GATE_ERROR(expected_reason_is_infra:<reason>)`）。expected 任务 failed → FAIL；未出现 → NOT_EVALUATED；原因不符 → NOT_EVALUATED。

### 5.4 错误码

| 类别 | 稳定码 |
|---|---|
| 读取 | `report_unreadable`、`baseline_unreadable` |
| 身份/版本 | `report_schema_incompatible`、`dataset_version_mismatch`、`dataset_hash_mismatch`、`scorer_version_mismatch`、`mode_mismatch`、`lane_invalid`、`report_timestamp_invalid`、`report_stale`（基线侧同名加 `baseline_` 前缀） |
| 提交 | `target_commit_unavailable`、`candidate_commit_mismatch` |
| 配置加载 | `gate config not found: …`、`gate config invalid: …`（加载器消息，非稳定短码） |
| 配置校验 | `duplicate_required_task_id`、`duplicate_expected_task_id`、`task_status_conflict:<task_id>`、`expected_reason_is_infra:<reason>`、`duplicate_metric_id:<id>`、`unknown_threshold_type:<type>`、`duplicate_threshold_type:<type>`、`unknown_threshold_scope:<scope>`、`threshold_scope_mismatch:<metric_id>`、`threshold_config_invalid:<metric_id>` |
| 报告内容 | `report_tasks_missing`、`report_task_invalid`、`duplicate_task_id:<id>`、`lane_class_mismatch:<id>`、`unknown_task_status:<id>`、`attempts_planned_mismatch:<id>`、`missing_behavior_stats:<id>`、`behavior_stats_invalid:<id>` |
| 阈值/基线缺失 | `zero_failure_threshold_missing`、`missing_threshold_for_class:behavior`、`expected_task_threshold_missing`、`baseline_required_for_threshold` |
| 命令行 | `multiple_reports_require_gate_schema_2`（v1 配置配多份报告） |
| 判定失败（FAIL，非 GATE_ERROR） | `behavior_rate_below_min`、`coverage_shrunk`、`expected_task_failed`；invariant 断言失败的 `error_code` 取该 attempt 的终止码，可能为空 |
| 未评估原因 | `missing_required_task`、`missing_expected_task`、`infra_insufficient`、`missing_trace`、`non_terminal_run`、`no_tool_surface`、`no_denial_observability` |

失败项（`failures[]`）同时带 `metric_id` 与 `error_code`：invariant 任务失败 → `metric_id` 取 zero_failure 阈值（默认 `hard_assertion_zero_failure`），`error_code` 为 attempt 终止码；behavior 低于阈值 → `behavior_rate_min` / `behavior_rate_below_min`；覆盖收缩 → 取 baseline 阈值 `metric_id`（默认 `expected_task_status`）/ `coverage_shrunk`；expected 任务 failed → 取 baseline 阈值 `metric_id` / `expected_task_failed`。

## 6. LLM 测试确定性分层

| 层 | 被测对象 | 输入 | 判定 | lane |
|---|---|---|---|---|
| `invariant` | 刹车/预算/循环/去重机制、评测链路接线 | 脚本化模型或固定事件序列 | 100% | 本地确定性 lane（需活 CP/Agent/Runtime） |
| `behavior` | 真实模型在提示下的表现 | 真实 Provider/model | N 次统计 + 最小样本门 | 真实 lane（本地/定时） |

强制规则：

1. invariant 不得依赖模型随机行为；必须用脚本化 provider 或固定回放。
2. behavior 不得用单次布尔当门禁；N 写在 dataset（`attempts`），阈值与最小样本门写在 gate 配置。
3. **infra 与行为分开计数**：跑起来但未终止（超时）判 `failed`（0511 round-15 B1）；无法判定（连不上/缺凭据/trace 缺失）记 infra，剔除分母。
4. 有效尝试低于最小样本门 → `not_evaluated(infra_insufficient)`，不得用 2 次结果冒充比率。
5. 重试只用于基础设施失败；behavior 用固定 N 次统计，**禁止「跑到过为止」**。
6. `temperature=0` 不等于确定性：服务端批处理与版本漂移仍会带来差异。

默认阈值：N=5、最小有效尝试=3、`behavior_rate_min`=0.8。该值经 2026-10-22 三轮真实 lane 校准（每任务 5 次 × 3 任务 × 3 轮，单次成功率 43/45 = 95.6%，最差任务轮 4/5 = 0.8），infra 0 次。

### 6.1 lane 与报告

- 确定性 lane（invariant）只跑 invariant 任务（脚本 provider），真实 lane（behavior）只跑 behavior 任务。
- 每个 lane 各产一份报告，报告带 `lane` 字段；gate 合并两份报告判定。
- 两个 lane 的 provider 不同，**不得**在一次运行里混合执行两类任务。

确定性 lane 的前置（0532 实测、0540 复验，缺一不可）：

| 前置 | 说明 |
|---|---|
| 活栈 | CP / Agent / Runtime / PG 已启动 |
| MCP fixture | 暴露 `always_failing`，`tool_faces` 分类为 `read` |
| 假 LLM | OpenAI 兼容 SSE，脚本「调 `always_failing` → isError → 再调」 |
| Provider Connection | WORKSPACE scope、`custom-openai-compatible` / `openai-chat-completions`、verify READY |
| instance profile | `llm-provider` 指向该 connection（`eval-fake-llm` / `eval-fake-model`；否则 Agent `llmReady=missing_credentials`） |
| workspace 预算 | `agent-runtime.runMaxTurns=2`（否则 180s 内跑不出刹车码） |
| token | `--token` 或 `XIHE_EVAL_TOKEN` |

真实 lane 的前置（0540 实测）：

| 前置 | 说明 |
|---|---|
| 真实 Provider Connection | WORKSPACE scope、`xiaomi` / `mimo-responses`、verify READY，`connectionKey=default` |
| instance profile | `llm-provider` 指向该 connection（`xiaomi` / `default` / `mimo-v2.6-flash`） |
| API key | `XIHE_XIAOMI_API_KEY` 仅在 `behavior-setup` 需要新建连接时从 env 读取 |

`gate` 读取的 Provider/model 仅作追溯；lane 的真实性由 setup 脚本与报告 `provider` 字段共同证明：确定性 lane 报告为 `custom-openai-compatible`，behavior lane 运行需显式传 `--provider xiaomi --model mimo-v2.6-flash`。

### 6.2 setup / teardown

`evaluation/fixtures/lane-setup.mjs` 负责 lane 生命周期，子命令为 `setup | behavior-setup | status | run | teardown`：

1. `setup`：创建/复用 eval workspace 与 principal，起假 LLM（`XIHE_EVAL_LLM_PORT`，默认 12762，避开 stack 段位 12630–12634/12640–12644）与 MCP fixture（默认 12761），创建假 Provider Connection 并 verify，把 instance `llm-provider` 切到假 provider，校验 workspace `runMaxTurns=2`，输出 session 绑定所需 id。
2. `behavior-setup`：复用上述 workspace/principal，若不存在同 `connectionKey` 的真实 connection 则用 `XIHE_XIAOMI_API_KEY` 新建并 verify，然后把 profile 切到真实 provider；记录该 connection 是否由本次 setup 创建。
3. `run`：按 `--lane` 跑指定轮次（`--rounds`）与尝试数（`--attempts`）；behavior lane 需显式传 `--provider xiaomi --model mimo-v2.6-flash`。
4. `status`：打印 lane 状态与 id（含 `realConnectionId`、`profileIsReal`）。
5. `teardown`：删除本 lane 创建的 eval session/run 与 connection（含真实 connection，若为 setup 创建）、清空 profile、恢复 `runMaxTurns` 原值、停 fixtures。

凭据：admin 密码只从 `XIHE_DEV_ADMIN_PASSWORD` 读入，token/password 不落盘；默认栈为 stack-3（`XIHE_STACK_ID` 只影响 state 文件标签），CP 地址默认 `http://127.0.0.1:12651`。teardown 必须零残留：connection、profile 改动、session/run、fixture 进程全部回收；二次 `setup` 不得因残留失败。

## 7. 命名规则

按**归属模块的语言规范**，不以个人偏好为准：

| 面 | 规则 | 例子 |
|---|---|---|
| Python 标识符、本模块拥有的 JSON 字段/枚举/ID | snake_case | `assertion_class`、`zero_failure`、`behavior_rate_min` |
| 类名 | PascalCase | `BehaviorStats` |
| 文件名、CLI 参数 | kebab-case | `gate-v2.json`、`--min-valid-attempts` |
| 跨边界：CP HTTP API | camelCase（对端 Java 契约） | `sessionId`、`runId`、`errorCode` |
| 跨边界：OpenAI 兼容 wire | 上游 schema（snake） | `tool_calls`、`finish_reason` |

判定要点：先看这份产物归属哪个模块，再用该模块的语言惯例；只有跨边界时才以对端契约为准，且映射必须集中在一个文件。

现有例外（只读 v1 路径）：`schema.py` 的 v1 任务 alias、`loader.py` 的 `schemaVersion` 判定、`gate.py` 的 v1 gate 配置 alias 与 `by_alias=True` 输出、`__main__.py` 的 gate 输出。v2 起新增字段、枚举、指标 ID 一律 snake_case，不再新增 camelCase alias；`gate-v2.json` 与 v2 输出使用字段名。

## 8. 版本迁移

dataset v2、report v2、gate v2 必须**同批**升级：

1. 新建 `datasets/v2.jsonl`，不改 v1；
2. `dataset_hash`、`scorer_version`、`threshold_set_version` 同步更新；
3. gate v2 配置 pin 新 hash；旧报告仍按 `schema_version: 1` 解析。

兼容矩阵：

| 产物 | v1 | v2 |
|---|---|---|
| dataset | `v1.jsonl` 只读，loader 走 camel alias | `v2.jsonl` 严格 snake，`assertion_class`/`attempts` 必填 |
| report | 可被 `compare` 读取 | `attempts[]`/`behavior_stats` 必填；`EvalReport`/`EvalReportV2` 按 `schema_version` 分派解析 |
| gate | `gate-v1.json` 只接受 report schema 1，`zero_failure` 已真正生效（存量 5 份报告回归结果不变） | `gate-v2.json` 只接受 report schema 2，走完整分派；schema 混用 → `GATE_ERROR`；v1 配置配多份报告 → `multiple_reports_require_gate_schema_2` |

否则 gate 报 `dataset_hash_mismatch` / `scorer_version_mismatch` / `report_schema_incompatible`，属预期 fail-closed。

## 9. 参考

本文是评测与 gate 契约的现行主档：v1 条款以归档 spec 为依据，**v2 起以本文为准**（归档 spec 只读，不再修订）。

- 评测契约（0511）：`plans/archive/PLAN-0511-XH-agent-evaluation-suite/spec/evaluation-contract.md`
- gate 契约（0512）：`plans/archive/PLAN-0512-XH-agent-quality-regression-gate/spec/gate-contract.md`
- 工具面与 baseline（0532）：`plans/archive/PLAN-0532-XH-agent-eval-tool-surface/`
- 确定性分层实施：`plans/PLAN-0540-XH-llm-test-determinism/`
