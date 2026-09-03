---
title: DEV-022 - 单元测试策略与覆盖率标准
category: dev-guide
sidebar_order: 22
lang: zh-Hans
sidebar_group: "开发指南"
created: 2026-06-17
tags: [testing, unit, vitest, pytest, junit, cargo]
---

# DEV-022: 单元测试策略

> xihe 项目四模块单元测试架构设计、Mock 策略、覆盖率目标和 PLAN-020 状态追踪的持久化文档。

## 1. 四模块测试架构

xihe 是四模块架构，各模块技术栈和测试框架不同：

| 模块 | 语言 | 框架 | 测试目录 | 需 Docker |
|------|------|------|---------|-----------|
| UI (前端) | TypeScript | Vitest + jsdom | `packages/ui/src/**/*.spec.ts` | ❌ |
| CP (控制面) | Java 25 | JUnit 5 + Mockito | `packages/control-plane/src/test/` | ❌ (unit) |
| Agent (Agent服务) | Python 3.12 | pytest + pytest-asyncio | `packages/agent/tests/unit/` | ❌ |
| Runtime (沙盒) | Rust 1.88 | cargo test --lib | `packages/runtime/tests/` | ❌ (unit) |

### 1.1 当前概况（2026-09-03 更新；基线为 2026-06-17 PLAN-020 快照，覆盖率数字以各模块实测为准）

| 模块 | 测试文件 | 估算用例 | 估算覆盖率 | 目标覆盖率 |
|------|---------|---------|-----------|-----------|
| UI | ~49 spec | ~245+ | ~68% | ≥ 70% |
| Agent | ~20 文件 | ~60+ | ~70% | ≥ 80% |
| CP | ~50 测试类 | ~90+ | ~67% | ≥ 80% |
| Runtime | ~13 文件 | ~26+ | ~55% | ≥ 70% |
| E2E Mock | 19 spec | ~66 | — | — |
| E2E Real | 21 spec | ~37+ | — | — |

> 数据来源：PLAN-020 §1 基线 + 文件扫描更新。PLAN-034 已修复 E2E 测试债，mock 66 + real 37 用例全绿。

## 2. UI 单元测试策略

### 2.1 技术栈

- Vitest + jsdom + `@vue/test-utils`
- 真实 `createRouter` + `createWebHistory` 或 `vi.mock('vue-router')` 用于路由测试（无 `vue-router-mock` 依赖）
- IndexedDB 测试手 mock `dexie`（无 `fake-indexeddb` 依赖；xihe 以 CP 后端为主）
- 组件测试使用 `mount()` / `shallowMount()`

### 2.2 Mock 原则

| 依赖 | Mock 方式 | 说明 |
|------|----------|------|
| API 调用 | spy 全局 `fetch`（`composables/api.ts` 导出 `api/apiRaw`，无 `cpFetch`） | 拦截所有后端 API 调用 |
| `useToast` | `vi.mock()` 或 spy | 验证 Toast 调用参数 |
| `useRouter` / `useRoute` | 真实 `createRouter` + `createWebHistory` 或 `vi.mock('vue-router')`（无 `vue-router-mock` 依赖） | 路由导航测试 |
| `HTMLCanvasElement.toBlob` | 当前无 mock（仅源码调用；如需图片压缩测试须补） | 图片压缩测试 |
| `SpeechSynthesis` | `window.speechSynthesis = vi.fn()` | TTS 测试 |
| `webkitGetUserMedia` | `navigator.mediaDevices.getUserMedia = vi.fn()` | 截图/语音测试 |
| Pinia Store | `setActivePinia(createPinia())` | Store 状态测试 |

### 2.3 目录规范

```
packages/ui/src/
├── components/
│   ├── __tests__/           # 组件单元测试
│   │   ├── ChatView.spec.ts
│   │   ├── InputArea.spec.ts
│   │   └── ...
│   └── ...
├── composables/
│   ├── __tests__/           # Composable 单元测试
│   │   └── useToast.spec.ts
│   └── ...
└── stores/
    └── __tests__/            # Store 单元测试
```

## 3. CP 单元测试策略

### 3.1 技术栈

- JUnit 5 + Mockito
- Spring Boot 4 `@WebMvcTest` / `@DataJpaTest`
- `MockHttpServletRequest` / `MockHttpServletResponse`
- H2 内存库（非 JSONB 字段的实体测试）
- Testcontainers PostgreSQL（JSONB 字段的实体测试）

### 3.2 Mock 原则

| 依赖 | Mock 方式 | 说明 |
|------|----------|------|
| 外部 HTTP 调用 (Agent/Runtime) | WireMock (T2) 或 Mockito；Spring Boot 4 用 `@MockitoBean`（无 `@MockBean`/`@WebMvcTest`/`@DataJpaTest`） | T2 集成测试用 WireMock |
| HttpServletRequest | `new MockHttpServletRequest()` | Controller 测试 |
| JWT Token | `JwtTokenProvider` 真实实现 | 可以直接用真实 JWT |
| ConfigService | `@MockitoBean` 或 `Mockito.mock()` | Service 层测试 |

### 3.3 混凝土类测试注意事项

- `@JdbcTypeCode(SqlTypes.JSON)` 必须用于 JSONB 列
- H2 测试不暴露 JSONB 问题，JSONB 实体必须用 Testcontainers PG
- ConfigController 使用 `@Value` 注入依赖，测试时需 mock

## 4. Agent 单元测试策略

### 4.1 技术栈

- pytest + pytest-asyncio
- pytest-httpx（HTTP mock，集成测试使用）
- unittest.mock

### 4.2 Mock 原则

| 依赖 | Mock 方式 | 说明 |
|------|----------|------|
| httpx.AsyncClient | `httpx_mock` (pytest-httpx) | HTTP 调用不真实发出 |
| redis | `unittest.mock.AsyncMock` | T1 单元测试用 mock |
| ConfigService (CP 接口) | httpx mock | 配置获取 |
| LLM 响应 | monkeypatch `model.client.acompletion`（无 `litellm.completion` mock 点） | Chat 功能测试 |
| Embedding 模型 | mock embedding 函数 | RAG 测试 |

### 4.3 目录规范

```
packages/agent/tests/
├── unit/                    # T1 单元测试（纯 mock）
│   ├── test_*.py
│   └── conftest.py
├── integration/             # T2 跨模块测试
│   └── ...
```

## 5. Runtime 单元测试策略

### 5.1 技术栈

- cargo test --lib（单元测试不启动容器）
- 部分测试需要 Docker（标注 `#[cfg_attr(not(feature = "docker-tests"), ignore)]`）

### 5.2 Mock 原则

| 依赖 | Mock 方式 | 说明 |
|------|----------|------|
| bollard (Docker API) | 当前无 mock 层（无 `mockall` 依赖；Docker 测试走真实 daemon + `#[ignore]` 门控） | 容器操作 mock |
| HTTP (CP 调用) | mock HTTP server (localhost) | T2 集成测试 |
| 文件系统 | 临时目录 (`tempfile` crate) | 沙盒文件操作测试 |

### 5.3 测试分类

- `*_test.rs` 文件：纯单元测试（无外部依赖）
- `*_integration_test.rs`：集成测试（需 Docker 或外部服务）
- CP stubs 使用 `mockito` crate 或内嵌 HTTP server

## 6. Mock 策略汇总

| 依赖类型 | UI | CP | Agent | Runtime |
|---------|-----|-----|-------|---------|
| HTTP 调用 | `vi.fn()` (cpFetch) | WireMock / Mockito | pytest-httpx | mockito / temp server |
| 数据库 | ❌ (极少使用) | H2 / Testcontainers PG | pytest-asyncio + mock | ❌ (不直接使用) |
| 外部服务 | `vi.fn()` | `@MockBean` | AsyncMock | mockall |
| 路由 | vue-router-mock | ❌ | ❌ | ❌ |
| 浏览器 API | `vi.fn()` (speech/canvas) | ❌ | ❌ | ❌ |

## 7. 当前覆盖率缺口

### 7.1 各模块缺口

| 模块 | 当前 | 目标 | 缺口 | 主要缺失 |
|------|------|------|------|---------|
| UI | ~65% | ≥ 70% | ~5% | 22 组件 + 2 composables + 6 stores 无测试 |
| Agent | ~75% | ≥ 80% | ~5% | main.py, mcp_client, models, watcher 零测试 |
| CP | ~67% | ≥ 80% | ~13% | ImportService, ExportService, 安全过滤器等 16 文件 |
| Runtime | ~55% | ≥ 70% | ~15% | fetch.rs, workspace.rs, dotenv_loader 无 inline test |

详见 `plans/archive/20260629/A03-xihe/PLAN-052-unit-test-gap-fill.md` §2.1 完整缺口清单。

### 7.2 已知限制

- UI 9 个 api-integration 测试需要后端，非纯单元测试
- Runtime timeout 已由 PLAN-235 M2 实现（timeout/cancel 终止并等待 child/process group）；对应测试见 `container_runtime` 超时用例
- ScreenshotCapture/VoiceInput E2E 需用户手动授权，CI 不可用

## 8. PLAN 状态追踪

### PLAN-020 — 测试覆盖补齐

| 里程碑 | 状态 | 说明 |
|--------|------|------|
| M1-M5 全部任务 | ✅ 已完成 | 执行表全部 ✅ |
| 覆盖率达标 | ⚠️ 未达到 | 全部模块低于目标 |

### PLAN-052 — 单元测试缺口补齐（当前）

针对覆盖率缺口创建的新 PLAN，分 P0/P1/P2 三阶段。当前进度：

| 阶段 | 任务 | 状态 |
|------|------|------|
| P0 | UI auth/chat/provider stores (22 tests) | ✅ 已完成 |
| P0 | UI fileService + useLangChainSSE composables (14 tests) | ✅ 已完成 |
| P0 | CP ToolNameRewriter (6 tests) + PolicyEngine (4 tests) | ✅ 已完成 |
| P0 | Runtime error.rs (3 tests) | ✅ 已完成 |
| P0 | Agent models/watcher | ⏳ 待实施（HTTP/IO 依赖，P1 级别） |
| P0 | Runtime dotenv_loader | ✅ 已解决（PLAN-235 M3 全量 210+ 通过；dotenv CWD 测试已用 mutex 串行化，见 DEV-018） |
| P1 | UI 6 key component tests | ⏳ 待实施 |
| P1 | CP ExportService + ImportService + AuditLogger + SseEmitter | ⏳ 待实施 |
| P1 | Agent mcp_client | ⏳ 待实施 |
| P2 | CP 安全过滤器 + Runtime fetch + Agent main (partial) | ⏳ 待实施 |

详见 `plans/archive/20260629/A03-xihe/PLAN-052-unit-test-gap-fill.md`。
