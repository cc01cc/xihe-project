# XH SPEC

> 契约状态：`active`  
> 实现状态：`implemented`（本文件只代表 SPEC 治理入口，不代表所有领域契约已经完成）  
> Profile：`governance`  
> Owner：XH 项目维护者  
> 消费者：XH Agent、后续 PLAN、跨模块实现者、审查者  
> 来源：PLAN-0383

## 1. 目录角色

`spec/` 保存 XH 跨 PLAN、可长期复用、可以逐项核对的目标态契约：状态、不变式、边界、失败/降级语义、跨模块通信和消费者映射。

本目录不是：

- PLAN 任务状态、审查记录或原始 evidence；
- 开发者教程和运行命令集合；
- 完整 OpenAPI、Flyway/SQL schema 或测试正文；
- Roadmap 和未来方向清单。

具体领域规范必须由独立子 PLAN 冻结后再晋升。当前根目录先登记领域和治理规则，不创建未冻结的空白 active 契约。

## 2. 领域目录

```text
spec/
|-- README.md
|-- writing-guide.md
|-- architecture/       # 模块边界、通信、运行拓扑
|-- ui/                  # 交互状态、设计系统、可访问性
|-- agent/               # 执行模型、Context/工具、Agent 绑定
|-- session/             # Chat Session、ChatRun/Operation、MCP session
|-- security/            # 认证、授权、审批、能力策略、审计
|-- workspace/           # 生命周期、Sandbox、Checkpoint、导入、事件
|-- configuration/       # env/config 生效链和凭证
|-- protocol/            # HTTP、事件流、MCP、内部消息
`-- data/                # 领域对象、事件、Projection、账本边界
```

目录清单不等于领域契约已经实现。状态轴必须分开：

| 状态 | 允许值 | 含义 |
|---|---|---|
| 契约状态 | `proposed` / `active` / `superseded` | 规范是否已经接受 |
| 实现状态 | `implemented` / `partial` / `unimplemented` | 当前代码和运行态完成度 |
| 目录状态 | `not-started` | 该领域尚未开始实施，不是契约状态 |

## 3. 当前领域登记

| 领域 | 契约状态 | 实现状态 | Canonical owner | 承接关系 |
|---|---|---|---|---|
| architecture / communication | proposed | partial | 跨边界 owner | PLAN-0385 |
| ui interaction | proposed | partial | UI + 跨边界 owner | PLAN-0388；PLAN-0384 仅负责 feature flow |
| agent execution / Context | proposed | partial | Agent owner | PLAN-0387；0381/0382 仍为局部规范 |
| session boundaries | proposed | partial | CP/Session owner | PLAN-0387；Chat Session、ChatRun/Operation、MCP session 分开 |
| authentication / authorization | proposed | partial | Security owner | PLAN-0386；principal/role/scope 归 Security |
| agent role/scope binding | proposed | partial | Agent owner | PLAN-0387；只写绑定、传播和消费，不复制授权模型 |
| capability / approval / audit | proposed | partial | Runtime/Security/CP owners | PLAN-0386/0389；能力策略、审批、审计分别建模 |
| workspace / sandbox / checkpoint | proposed | partial | Workspace/Runtime owners | PLAN-0389 |
| configuration / env | proposed | implemented | CP ConfigService owner | PLAN-0389；以现行配置模型整合历史来源 |
| protocol / data | proposed | partial | 对应协议和 durable-record owners | PLAN-0385；OpenAPI/inventory/schema 保持各自事实源 |

## 4. Agent 读取规则

Agent 处理 XH 任务时：

1. 先读取本文件，确认任务对应的领域和状态。
2. 只加载与当前任务相关的 active/proposed 规范，不默认加载整个目录。
3. 读取 `proposed` 规范时，必须同时读取实现状态、owner 和承接 PLAN；不得把目标态当成当前运行事实。
4. 发现 `AGENTS.md`、代码、OpenAPI、evidence 与规范冲突时，必须报告冲突并交由 PLAN/owner 解决，不能静默选择。
5. Agent 可以提出规范写回建议，但不得根据运行结果自动改写 active SPEC。

`AGENTS.md` 负责 Agent 的工作规则；本目录负责 XH 的领域契约。HTTP route/schema 以 OpenAPI 和 route inventory 为准，事件 wire schema 以对应事件 schema 为准。

## 5. Spec Impact 与写回

每个 XH PLAN 必须声明 Spec Impact：

| 值 | 含义 |
|---|---|
| `none` | 已确认不影响根级 SPEC |
| `read` | 消费现有 SPEC，但不改变契约 |
| `create` | 创建新的根级 SPEC 或治理入口 |
| `update` | 更新现有契约 |
| `supersede` | 用新契约替代旧契约 |

契约、代码、DEV 摘要、OpenAPI/事件 schema 和测试必须在同一变更波次同步。一个根级 SPEC 文件同一时间只能由一个 active PLAN 承接；其他 PLAN 只能在自己的 `spec/` 中提出草案。

`one/plans/` 与 `A03-xihe/` 是独立 Git 仓库。两边的提交、HEAD、工作区状态和 evidence 分别记录，不能用 one 的 PLAN 提交代表 A03 文档已落地。

## 6. 文档分工

| 位置 | 权威内容 |
|---|---|
| `spec/` | 跨 PLAN 的稳定领域契约 |
| `docs/i18n/*/DEV-*` | 架构解释、实现导航、运行命令、排错和示例 |
| `docs/api/openapi.yaml` | HTTP route、schema、错误响应 |
| SQL/Flyway/代码 | 各自的实现和持久化事实 |
| PLAN `spec/` | 当前变更的目标态草案和验收细节 |
| PLAN `evidence/` / `internal/` | 实测事实和历史资料 |

DEV 文档可以指向本目录，但不能复制另一份冲突的契约正文。归档 PLAN 保持只读；旧语义通过 supersede 和来源记录追溯。

## 7. 写作规则

中文为主，代码符号、route、event、字段名、状态值和协议关键字保留英文。详细语言、profile、Mermaid、ASCII、状态、证据和可读性规则见 [`writing-guide.md`](writing-guide.md)。

本目录 v1 采用 Agent/GitHub-only，不进入 A03 文档站渲染；DEV-030 和文档索引只提供导航。
