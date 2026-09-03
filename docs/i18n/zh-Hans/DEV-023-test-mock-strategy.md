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

单元测试 mock 不能掩盖集成层 bug：

| 原则 | 说明 |
|------|------|
| **验证 body 格式** | mock `fetch` 时，不仅验证 `method: 'POST'`，还要验证 `Content-Type` 和 body 结构 |
| **验证端点路径** | mock URL 要与正典契约一致（公开 `/api/v1`、服务间 `/internal/v1`，见 `docs/api/openapi.yaml`；Vite 不再重写 API 路径） |
| **不用 `console.warn` 替代错误** | catch 块必须有用户可见的反馈（Toast），不能只 `console.warn` |
| **dynamic import 改 static（新测试目标）** | 新测试文件中 `await import()` 改为顶层 `import`，避免模块加载竞争导致 flaky；存量 20+ 处动态 import 逐步迁移 |
| **jsdom 限制** | `Image.onload`、`canvas.toBlob` 在 jsdom 中不可靠，需要 mock |
