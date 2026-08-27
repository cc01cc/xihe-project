---
title: USER-001 - 用户指南
category: guide
lang: zh-Hans
sidebar_group: "用户指南"
status: active
created: 2026-05-28
updated: 2026-06-15
---

# 用户指南 — xihe Agent 平台

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
# 编辑 .env.dev，设置 XIHE_DEEPSEEK_API_KEY
```

### 1.3. 启动

```bash
# 一键启动（推荐）
mise run dev:full
```

`dev:full` 会：
1. 通过 Docker Compose 启动 CP / Agent / Runtime / PostgreSQL
2. 等待 CP 健康检查通过
3. 在宿主机启动 UI（Vite dev server）

浏览器打开 `http://localhost:12630`。

### 1.4. 注册与登录

首次使用需要注册账号：
1. 打开 `http://localhost:12630`
2. 点击"注册"
3. 填写邮箱、密码（≥8 位）、名称
4. 登录后自动跳转到聊天界面

### 1.5. 测试

```bash
mise run validate       # 全部单元测试
mise run validate:full  # 单元 + 集成 + E2E
```

## 2. 功能使用

### 2.1. 聊天

1. 在侧边栏点击 "+" 创建新会话
2. 在输入框输入消息，按 Enter 发送
3. Agent 通过 SSE 流式回复
4. 工具调用以卡片形式展示，可折叠查看详情

### 2.2. 多模态

| 功能 | 操作 | 说明 |
|------|------|------|
| **图片上传** | 拖拽 / 点击选择 | 自动 Canvas 压缩 ≤1920px |
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

## 3. 配置

### 3.1. LLM 提供商

系统内置 5 个预设 Provider，也支持自定义任意 OpenAI-compatible Provider：

| 值 | 说明 | 需要 |
|------|------|------|
| `mock` | Mock 模式，返回固定回复 | 无 |
| `deepseek` | DeepSeek V3/R1 系列 | `XIHE_DEEPSEEK_API_KEY` |
| `openai` | OpenAI GPT 系列 | `XIHE_OPENAI_API_KEY` |
| `xiaomi` | 小米 MiMo 系列 | `XIHE_XIAOMI_API_KEY` |
| `anthropic` | Anthropic Claude 系列 | `XIHE_ANTHROPIC_API_KEY` |
| `ollama` | 本地 Ollama | Ollama 服务运行中 |
| `自定义` | 任意 OpenAI-compatible API | API Key（如有） |

Provider 可在设置页面的模型配置中管理，选择预设后自动填充模型名和 Base URL。

### 3.2. 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `XIHE_LLM_PROVIDER` | `deepseek` | LLM 提供商（deepseek/openai/anthropic/ollama/xiaomi/mock） |
| `XIHE_DEEPSEEK_API_KEY` | — | DeepSeek API Key |
| `XIHE_DEEPSEEK_MODEL` | `deepseek-chat` | DeepSeek 模型 |
| `XIHE_XIAOMI_API_KEY` | — | 小米 MiMo API Key |
| `XIHE_XIAOMI_MODEL` | `mimo-v2-omni` | 小米 MiMo 模型 |
| `XIHE_CP_PORT` | `12631` | CP 端口（宿主机映射，Docker 内为 8080） |
| `XIHE_AGENT_PORT` | `12632` | Agent 端口（宿主机映射，Docker 内为 8000） |
| `XIHE_RUNTIME_PORT` | `12633` | Runtime 端口（宿主机映射，Docker 内为 8001） |
| `XIHE_UI_PORT` | `12630` | UI 端口（可通过环境变量覆盖） |
| `XIHE_CP_DATASOURCE_URL` | `jdbc:postgresql://localhost:12634/xihe` | 数据库连接（宿主机映射，Docker 内为 5432） |
| `XIHE_CP_JWT_SECRET` | — | JWT 签名密钥 |
| `XIHE_LOG_LEVEL` | `info` | 日志等级 |

## 4. 故障排查

| 现象 | 原因 | 解决 |
|------|------|------|
| UI 无法连接 CP | Docker 服务未启动 | `docker compose up -d` |
| Agent MCP 重试 | CP 尚未就绪 | 等待 CP 启动完成（约 10s） |
| 注册返回 400 | 密码不足 8 位 | 使用 ≥8 位密码 |
| 401 错误 | 未登录或 Token 过期 | 重新登录 |
| SSE 断开 | 网络问题 | 自动重连（指数退避） |
| PostgreSQL 连接失败 | Docker 容器未运行 | `docker compose up -d postgres` |

## 5. 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+K` | 搜索会话 |
| `Ctrl+Shift+N` | 新建会话 |
| `Ctrl+Shift+,` | 打开设置 |
| `Ctrl+Shift+Enter` | 重新生成回复 |
