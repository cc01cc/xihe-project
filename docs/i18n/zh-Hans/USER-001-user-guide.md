---
title: USER-001 - 用户指南
category: user-guide
lang: zh-Hans
sidebar_group: "用户指南"
status: active
sidebar_order: 1
created: 2026-05-28
updated: 2026-10-25
---

# 用户指南 — xihe Agent 平台

> 面向最终用户：安装启动（§1）→ 功能使用（§2）→ 配置（§3）→ 排障（§4，先看表头“先查”列）。开发调试见 DEV-002。

## 1. 快速开始

### 1.1. 环境要求

- Docker Desktop（或 Docker Engine）
- Node.js 22+（UI 前端）
- 推荐安装 `mise`

### 1.2. 安装

```bash
mise install
mise run setup
cp .env.example .env.dev
# 在 UI 设置页或 ConfigService 中配置 LLM API key（如 DeepSeek）
# 注：应用层配置走 ConfigService，不写入 .env.dev（见 DEV-003）
```

### 1.3. 启动

```bash
# 一键启动（推荐）：PostgreSQL 跑 Docker，其余原生启动
mise run dev:host
```

`dev:host` 会先启动并等待 PostgreSQL，再并行启动原生 CP / Agent / Runtime / UI。浏览器打开 `http://localhost:12630`。

> `mise run dev:full` 仅用于一次性全容器基线场景，不用于日常开发。`dev:host` 不自动导入 `config.import.local.jsonc`；需要时在 CP ready 后显式运行 `mise run dev:host:import-config`。`dev:full` 保留独立的一次性导入流程。

### 1.4. 注册与登录

首次使用需要注册账号：
1. 打开 `http://localhost:12630`
2. 点击"注册"
3. 填写邮箱、密码（≥8 位）、名称；可选填**用户名**（小写字母开头，仅小写字母与数字，≤32 位）——留空则由邮箱自动生成唯一默认用户名
4. 登录后自动跳转到聊天界面

登录时「邮箱/用户名」输入框二选一：填注册邮箱或用户名均可（PLAN-0565）。

### 1.5. 测试

```bash
mise run validate       # 全部单元测试
mise run validate:full  # 单元 + 集成 + E2E
```

## 2. 功能使用

### 2.1. 聊天

1. 在侧边栏点击 "+" 创建新会话（进入 `/chat/:sessionId` 时自动建立会话级持久 SSE：`GET /api/v1/events?sessionId=`）。
2. 在输入框输入消息，按 Enter 或点击发送按钮发送。同一会话同一时间仅允许一条发送中的消息（`CHAT_IN_PROGRESS`）；若提示“已有进行中的对话”，请等待当前回复结束。
3. Agent 通过 SSE 流式回复：`token` 增量逐步追加到助手气泡（支持 `text`/`reasoning` 分区），工具调用以卡片形式展示，可折叠查看详情。
4. 首条回复结束后 SSE 保持连接，**无需刷新**即可继续发送下一条消息（第二条也会立即得到 `token` 增量）。`done` 仅结束当前轮次，不关闭会话 SSE。
5. 若网络抖动导致连接中断，UI 会自动以指数退避（250ms 起，上限 5s）重连并恢复连接状态。

发送失败时，输入内容会保留在输入框中。未创建 run 的失败不会进入历史消息，也不会留下空助手气泡；确定性失败可直接重试。若提示 provider 可能已经执行但连接中断，状态会显示为 `ambiguous`，系统不会自动重试，确认可能的重复调用/计费后才使用新的重试轮次。

**连续对话与流式验证（PLAN-230）**：在开发者工具查看 `Network → events` 的 `token`/`done` 事件数量——

- 真实长回复应产生多个 `token` 事件，助手气泡在 `done` 前可观察到多次文本增长。
- 若仅一次出现即为单包回落（provider 不支持流式时的兼容路径）。

### 2.2. 多模态

| 功能 | 操作 | 说明 |
|------|------|------|
| **图片上传** | 拖拽 / 点击选择 | 自动 Canvas 压缩（`maxDimension(file, 2048)`） |
| **截图** | 点击截图按钮 | Screen Capture API |
| **语音输入** | 点击麦克风按钮 | 浏览器 Web Speech API |
| **语音输出** | AI 回复朗读 | 浏览器 TTS |
| **PDF** | 拖拽上传 | pdfjs-dist 预览 + 文本提取 |

### 2.3. MCP 工具

Agent 可通过 MCP 反向代理调用 Runtime 工具：

| 工具 | 说明 | 示例 |
|------|------|------|
| `read_file` | 读取文件 | "读取 /tmp/test.txt" |
| `write_file` | 写入文件 | "写入 /tmp/output.txt 内容为 hello" |
| `list_directory` | 列出目录 | "列出 /tmp 目录内容" |
| `glob` | 文件匹配 | "查找所有 .py 文件" |
| `grep` | 文本搜索 | "搜索包含 TODO 的文件" |
| `execute_command` | 执行命令 | "运行 ls -la" |

### 2.4. Agent 审批

当 Agent 需要执行高风险操作时，会弹出审批窗口：
- **批准**：允许 Agent 继续
- **拒绝**：阻止操作

### 2.5. 设置

点击侧边栏底部的设置图标：
- **模型**：LLM Provider（OpenAI / DeepSeek / 小米 MiMo / Anthropic 预设 + 自定义）、Model、API Key、Base URL
  - 选择预设 Provider 时自动填充模型名和 API Base URL
  - 选择"自定义"后可手动输入任意 Provider 信息
- **主题**：dark / light / system
- **MCP**：MCP Server 管理
- **Workspace**：工作区管理
- **知识库**：文档上传、分块、Embedding

**工作区设置（PLAN-0560）**：每个工作区有自己的设置页（工具栏齿轮或 `/workspace/:workspaceId/settings`），分「常规 / 配置 / 成员 / MCP」四块——常规区 OWNER 可改名、删除工作区；配置区管理本工作区的连接、审批策略、任务策略等（覆盖个人与实例默认）；MCP 区管理本工作区的 MCP Server。全局设置页只保留实例与个人两层，页面顶部提供前往工作区设置的入口。

**工作区成员（PLAN-0565）**：工作区设置的「成员」tab——OWNER 可按用户名添加已有账号（角色选「可编辑 / 只读」）、修改成员角色、移除成员；「可编辑」（EDITOR）能看到成员列表但不能改；「只读」（VIEWER）看不到该 tab。唯一所有者不能被移除或降级（服务端强制）。目标用户名未注册时提示「该用户不存在，请对方先注册」。每次添加/改角色/移除都会记入审计日志。

### 2.6. 工作区执行后端

- **受管工作区（managed_import）**：新建时默认使用 Docker 执行后端，且不能切换为 MXC 或宿主执行；Docker 不可用时文件读写/列表/状态接口会显式失败（503），不会静默降级。
- **直挂工作区（direct_attach）**：新建时选择「使用已存在的宿主机目录」，指定目录并选择 MXC 或宿主执行；已有受管工作区不能转换为直挂工作区，也不能切到 MXC/宿主，需要新建直挂工作区并挂载目标目录。
- **MXC（windows-mxc）**：受限沙盒，成熟度为 experimental，要求目标机器可执行 `wxc-exec.exe`；不可用时创建与切换都会显式失败，不自动降级。
- **宿主执行（windows-host）**：不受沙盒限制，仅做路径守卫；不保护工作区外写入，必须勾选风险确认，仍受审批与授权约束。
- **切换**：直挂工作区只允许在 MXC 与宿主执行之间切换；Docker 不参与切换，存储与执行也不解耦。

## 3. 配置

### 3.1. LLM 提供商

UI 内置 4 个预设 Provider（`BUILTIN_PROVIDERS`）；`mock`/`ollama`/自定义由 Agent/Config 层提供：

| 值 | 说明 | 需要 | 来源 |
|------|------|------|------|
| `openai` | OpenAI GPT 系列 | API Key | UI 内置 |
| `deepseek` | DeepSeek V3/R1 系列 | API Key | UI 内置 |
| `xiaomi` | 小米 MiMo 系列 | API Key | UI 内置 |
| `anthropic` | Anthropic Claude 系列 | API Key | UI 内置 |
| `mock` | Mock 模式，返回固定回复 | 无 | Agent/Config 层 |
| `ollama` | 本地 Ollama | Ollama 服务运行中 | Agent/Config 层 |
| `自定义` | 任意 OpenAI-compatible API | API Key（如有） | Agent/Config 层 |

Provider 可在设置页面的模型配置中管理，选择预设后自动填充 Base URL；模型从连接目录中选择。

模型选择器只显示已验证且支持 chat 的模型；ASR/TTS 等非对话模型不会出现在聊天选项中。provider 凭据属于管理员配置，普通用户只能看到安全状态。

### 3.2. 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `XIHE_LLM_PROVIDER` | `deepseek` | LLM 提供商（Agent 离线兜底默认值；其余 key/模型走 ConfigService，不在 `.env` 设置） |
| 模型名/API Key（如 DeepSeek/小米） | — | 走 ConfigService（UI 设置页「默认 LLM 配置」= 连接 + 模型，或 `config.import.local.jsonc`），`.env.example` 仅保留 `XIHE_LLM_PROVIDER=mock` 注释行 |
| 默认 LLM 配置（`llm-provider.profile`） | — | 整单元 `{providerId, connectionKey, model}`，三层（实例/工作区/个人）首存在层生效；未设置时新会话需显式选择模型（`config.import.example.jsonc` 同形），非 `.env` 变量 |
| `XIHE_CP_PORT` | `12631` | CP 端口（宿主机映射，Docker 内为 8080） |
| `XIHE_AGENT_PORT` | `12632` | Agent 端口（宿主机映射，Docker 内为 8000） |
| `XIHE_RUNTIME_PORT` | `12633` | Runtime 端口（宿主机映射，Docker 内为 8001） |
| `XIHE_UI_PORT` | `12630` | UI 端口（可通过环境变量覆盖） |
| `XIHE_CP_DATASOURCE_URL` | `jdbc:postgresql://localhost:12634/xihe` | 数据库连接（宿主机映射，Docker 内为 5432） |
| `XIHE_STACK_ID` | `stack-1` | 栈槽位（`stack-1`..`stack-8`）；上表是 stack-1 的值，stack-2 起整体换段（ui 12640/12641/…），见 DEV-002「模式 D」 |
| `XIHE_CP_JWT_SECRET` | — | JWT 签名密钥 |
| `XIHE_LOG_LEVEL` | `info` | 日志等级 |

## 4. 故障排查

| 先查 | 现象 | 原因 | 解决 |
|------|------|------|------|
| 服务状态 | UI 无法连接 CP | Docker 服务未启动 | `docker compose up -d` 或 `mise run dev:host` |
| 服务状态 | Agent MCP 重试 | CP 尚未就绪 | 等待 CP 启动完成（约 10s） |
| 输入 | 注册返回 400 | 密码不足 8 位 | 使用 ≥8 位密码 |
| 登录态 | 401 错误 | 未登录或 Token 过期 | 重新登录；持久 SSE 会在过期前关闭并清理本地 token，需重新登录 |
| Network `/events` | `409 SSE_SUBSCRIPTION_REQUIRED` | 页面未建立 `GET /api/v1/events` 订阅就发送 | 刷新页面或等待 SSE `connected` 后重发；发送前 `SSEStream` 会手工确认连接（无自动 409 重试分支） |
| 等待 `done` | `409 CHAT_IN_PROGRESS` | 同一会话已有进行中的 run | 等待当前 `done` 结束后再发送；刷新不会清除服务端租约 |
| Network + `logs/cp.log` | 发送后仅用户气泡、无助手回复 | 曾为 `SSE_SUBSCRIPTION_REQUIRED` 误判；已由 PLAN-230 修复（持久 SSE + 代数隔离） | 确认 `Network` 中 `/events` 仍为 `200 text/event-stream` 且 `POST /api/v1/chat` 返回 `202`；检查 `logs/cp.log` 的 `stale_cleanup_ignored` / `replaced` |
| Network `token` 数 | 长回复只有一次内容变化 | provider 不支持流式，触发单 `token` 回落 | 属兼容路径：查看 `Network → events` 的 `token` 数量；真实 MiMo 应产生 ≥2 `token` |
| 等待重连 | SSE 断开（网络抖动） | 网络问题或心跳超时 | 自动重连（指数退避 250ms 起，上限 5s）；重连后重新加载 `/api/v1/sessions/{id}/messages` 恢复最终内容 |
| 服务状态 | PostgreSQL 连接失败 | Docker 容器未运行 | `docker compose up -d postgres` 或 `mise run dev:host`（自动等待 Postgres） |

## 5. 快捷键

| 快捷键 | 功能 |
|--------|------|
> ⚠️ 以下快捷键为规划中，当前 UI 无绑定（待实现）：

| `Ctrl+K` | 搜索会话 |
| `Ctrl+Shift+N` | 新建会话 |
| `Ctrl+Shift+,` | 打开设置 |
| `Ctrl+Shift+Enter` | 重新生成回复 |
