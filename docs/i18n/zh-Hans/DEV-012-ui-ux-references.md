---
title: DEV-012 - UI/UX 参考项目
category: dev-guide
lang: zh-Hans
sidebar_group: "开发指南"
sidebar_order: 12
status: active
created: 2026-07-01
updated: 2026-09-03
---

# DEV-012: UI/UX Reference Projects

以下开源/商业产品可作为 xihe 各模块 UI/UX 与交互设计的参考来源。xihe 使用 **Vue 3 + reka-ui（shadcn-vue 封装层共存）+ Tailwind v4**，因此只借鉴其**布局、交互模式、信息架构和视觉层级**，不直接引入其 React/Vue 组件或样式系统。

## 通用 AI 聊天界面

| 项目 | 仓库/地址 | 借鉴范围 | xihe 对应模块 |
|------|----------|---------|-------------|
| **LibreChat** | `danny-avila/LibreChat` | 消息列表、模型选择器、Artifacts 渲染、会话管理、多用户权限 | `packages/ui/src/components/chat/` |
| **Lobe Chat** | `lobehub/lobe-chat` | 暗色/亮色主题一致性、消息气泡、模型选择 Popover、插件市场、PWA 布局 | `packages/ui/src/components/chat/` |
| **Open WebUI** | `open-webui/open-webui` | 3-tier 配置分层、Admin Panel、文档 RAG、pipeline 式模型管理 | `packages/ui/src/views/settings/ConfigSettings.vue` |
| **NextChat** | `ChatGPTNextWeb/NextChat` | 极简输入区、Preset/Mask、Artifact 弹窗、响应式侧边栏 | `packages/ui/src/components/chat/` |

## Agent 编排与可视化

| 项目 | 仓库/地址 | 借鉴范围 | xihe 对应模块 |
|------|----------|---------|-------------|
| **Langflow** | `langflow-ai/langflow` | 节点式 Agent 流程编辑器、Playground 测试、执行 trace、MCP server 导出 | `packages/agent/`（未来可视化编排） |
| **Flowise** | `FlowiseAI/Flowise` | AgentFlow V2、Human-in-the-loop 节点、执行追踪、API/嵌入部署 | `packages/agent/`、`packages/ui/src/components/chat/ApprovalModal.vue` |
| **n8n** | `n8n-io/n8n` | 工作流节点编辑器、执行历史、权限控制、审计日志 | `packages/control-plane/`（未来工作流管理） |

## 代码 / 沙盒 / Workspace

| 项目 | 仓库/地址 | 借鉴范围 | xihe 对应模块 |
|------|----------|---------|-------------|
| **Bolt.new** | `stackblitz/bolt.new` | 聊天-文件树-预览三分栏、终端/浏览器集成、实时预览、Agent 执行状态 | `packages/ui/src/components/workspace/` |
| **Replit Agent** | `replit/replit-agent`（如开源） | 文件树、包管理、运行输出面板、计划/执行交互 | `packages/ui/src/components/workspace/` |
| **Cursor / Cline** | 商业/VS Code 扩展 | Agent Plan/Act 模式、工具调用审批、diff 可视化、checkpoint | `packages/ui/src/components/chat/ApprovalModal.vue`、`packages/ui/src/components/workspace/DiffViewer.vue` |

## 知识库 / RAG

| 项目 | 仓库/地址 | 借鉴范围 | xihe 对应模块 |
|------|----------|---------|-------------|
| **AnythingLLM** | `Mintplex-Labs/anything-llm` | Workspace 隔离、文档上传/embedding、引用来源、chunking 配置 | `packages/ui/src/views/settings/KnowledgeBaseView.vue` |
| **NexusRAG** | `LeDat98/NexusRAG` | Inline citation badge、source card、文档查看器跳转、Agent step timeline | `packages/ui/src/components/chat/parts/` + `MarkstreamCodeBlockAdapter` |
| **RAG Web UI** | `rag-web-ui/rag-web-ui` | 文档处理状态、引用展示、API key 管理 | `packages/ui/src/views/settings/KnowledgeBaseView.vue` |

## 管理后台 / 配置面板

| 项目 | 仓库/地址 | 借鉴范围 | xihe 对应模块 |
|------|----------|---------|-------------|
| **shadcn-admin-kit** | `marmelab/shadcn-admin-kit` | CRUD、数据表、RBAC 权限矩阵、侧边栏导航 | `packages/ui/src/views/settings/` |
| **shadcn/ui Dashboard** | `https://ui.shadcn.com/examples/dashboard` | 数据展示、卡片布局、表单、响应式 | `packages/ui/src/views/settings/` |

## 限制说明

- **禁止直接复制组件代码**：上述项目多为 React/Ant Design，与 xihe 的 Vue + reka-ui 栈不兼容。
- **禁止引入其完整设计系统**：只提取适合 xihe 的交互模式，并在 xihe 的设计 token 下重新实现。
- **新增参考项目前需评估**：是否与 xihe 的模块职责匹配，是否会造成技术栈冲突。
