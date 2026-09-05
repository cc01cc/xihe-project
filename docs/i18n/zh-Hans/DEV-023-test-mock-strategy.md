---
title: DEV-023 - 测试 Mock 策略约束
category: dev-guide
lang: zh-Hans
sidebar_group: "开发指南"
sidebar_order: 23
status: active
created: 2026-07-01
updated: 2026-09-03
---

# DEV-023: 测试 Mock 策略约束

> 面向测试开发者：5 条红线，违反即假绿。配套：DEV-022 各模块 Mock 表。

单元测试 mock 不能掩盖集成层 bug：

| 原则 | 说明 |
|------|------|
| **验证 body 格式** | mock `fetch` 时，不仅验证 `method: 'POST'`，还要验证 `Content-Type` 和 body 结构 |
| **验证端点路径** | mock URL 要与正典契约一致（公开 `/api/v1`、服务间 `/internal/v1`，见 `docs/api/openapi.yaml`；Vite 不再重写 API 路径） |
| **不用 `console.warn` 替代错误** | catch 块必须有用户可见的反馈（Toast），不能只 `console.warn` |
| **dynamic import 改 static（新测试目标）** | 新测试文件中 `await import()` 改为顶层 `import`，避免模块加载竞争导致 flaky；存量 20+ 处动态 import 逐步迁移 |
| **jsdom 限制** | `Image.onload`、`canvas.toBlob` 在 jsdom 中不可靠，需要 mock |

### PLAN-247 fake LLM 边界

`packages/ui/e2e/fixtures/fake-llm-server.mjs` 仅用于 Host/真实进程场景的受控 provider：`missing`、`invalid`、`success` 和 `disconnect`。配置必须通过 CP Admin API 导入，不能直接改 Agent 环境变量绕过 ConfigService；fixture request log 只记录 provider/model/status/count，不记录凭据。

Host runner 的 fake LLM 结果必须与浏览器、CP、Agent 的真实调用图及 teardown 结果一起记录。直接调用 fixture 或单元 mock 不能作为 ChatRun、MCP 边界或 UI 终态的完成证据。
