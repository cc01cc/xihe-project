---
title: DEV-012 - 集成测试策略
category: dev-guide
sidebar_order: 12
lang: zh-Hans
sidebar_group: "开发指南"
---

# DEV-012: 集成测试策略

> xihe 项目三层集成测试架构设计、目录规范、跨模块契约测试模式和运行指南。

## 1. 分层架构

集成测试分三层，与 E2E 的 mock/real 分层一致但关注点不同——集成测试验证**模块间接口契约**而非用户交互流程。

```
┌─────────────────────────────────────────────────────┐
│                    E2E (DEV-011)                     │
│    浏览器 + 全栈 Docker，验证完整用户流程            │
├─────────────────────────────────────────────────────┤
│  T3: Cross-module Real  ← 新增                      │
│     Docker partial stack，验证端到端模块通信         │
├─────────────────────────────────────────────────────┤
│  T2: Cross-module Stub  ← 新增                      │
│     WireMock/httpx mock，验证 HTTP 契约格式          │
├─────────────────────────────────────────────────────┤
│  T1: Module-internal     ← 已有                      │
│     Testcontainers/MockMvc，验证模块内部集成         │
├─────────────────────────────────────────────────────┤
│                    Unit Tests                        │
│     纯函数/组件逻辑，mock 所有外部依赖                │
└─────────────────────────────────────────────────────┘
```

### 各层对比

| 维度 | T1 模块内集成 | T2 跨模块 Stub | T3 跨模块 Real | E2E |
|------|-------------|----------------|----------------|-----|
| **验证目标** | 模块 + DB/内部依赖正确性 | HTTP 请求/响应格式正确 | 模块间真实通信正常 | 用户端到端流程 |
| **外部依赖** | DB (PG/H2) | 无 (WireMock/mock) | Docker (partial) | Docker + 浏览器 |
| **运行速度** | ~10-30s | ~5-15s | ~60-120s | ~2-5min |
| **失败定位** | 模块内问题 | 请求格式问题 | 模块间兼容问题 | 任意层问题 |
| **CI 运行** | ✅ 每次 | ✅ 每次 | ⏰ PR + nightly | ⏰ nightly |
| **框架** | JUnit/MockMvc, pytest, cargo | WireMock, httpx mock, mockito | pytest + httpx, cargo | Playwright |

## 2. 三层详解

### 2.1 T1: 模块内集成

> 每个模块依赖的内部基础设施（DB、文件系统、Docker daemon）与模块代码的集成。

**已存在**，不是本层的重点增量，但列出以便完整理解架构：

| 模块 | 测试 | 框架 | 需 Docker |
|------|------|------|-----------|
| CP (Java) | AuthIntegrationTest, SessionIntegrationTest, ChatIntegrationTest, WorkspaceIsolationTest, ConfigControllerTest, ChatControllerNpeTest | Spring MockMvc + H2 或 Testcontainers PG | H2: ❌ / PG: ✅ |
| Agent (Python) | test_vector_store.py, test_registry_integration.py | pytest + real PG | ✅ |
| Runtime (Rust) | sandbox_test.rs, bridge_integration_test.rs | cargo test + Docker | ✅ |

### 2.2 T2: 跨模块 Stub 集成

> 用 WireMock（CP 侧）或 httpx mock（Agent 侧）或 HTTP mock（Runtime 侧）模拟对方模块的 HTTP 接口，验证"本模块是否正确组装了跨模块请求"。

```
┌──────────────┐     HTTP (stubbed)     ┌──────────────┐
│  CP Test     │─────── WireMock ──────▶│  Mock Agent  │
│  (H2 + JUnit)│◀───────────────────────│  (no Docker) │
└──────────────┘                        └──────────────┘
```

**CP 侧模式**（WireMock）：

```java
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("h2")
@WireMockTest(httpPort = 0)
class AgentChatIntegrationTest {

    @DynamicPropertySource
    static void configureAgent(DynamicPropertyRegistry reg, WireMockServer wm) {
        reg.add("cp.agent-url", () -> "http://localhost:%d/chat".formatted(wm.port()));
        reg.add("cp.agent-base-url", () -> "http://localhost:%d".formatted(wm.port()));
    }

    @Test
    void chatRelaySendsCorrectRequestToAgent() {
        // Arrange: WireMock stub Agent SSE response
        stubFor(post("/chat")
            .willReturn(aResponse()
                .withStatus(200)
                .withHeader("Content-Type", "text/event-stream")
                .withBody("event: message\ndata: {\"content\":\"hi\"}\n\n")));

        // Act: 通过 CP HTTP 端点触发 → CP 内部转发到 Agent
        String token = registerAndLogin();
        var response = restTemplate.postForEntity(
            url("/v1/chat"),
            httpEntity(Map.of("content", "hello"), token),
            String.class);

        // Assert: WireMock 验证 CP 发出的请求格式
        verify(postRequestedFor(urlEqualTo("/internal/v1/agent/chat"))
            .withHeader("Authorization", equalTo("Bearer dev-token-not-secure"))
            .withRequestBody(matchingJsonPath("$.content", equalTo("hello"))));
    }
}
```

**Agent 侧模式**（pytest-httpx）：

```python
@pytest.mark.integration
class TestConfigClientWithStub:
    def test_fetch_providers(self, httpx_mock):
        httpx_mock.add_response(
            url="http://localhost:8080/api/v1/internal/config/admin/llm-provider",
            json={"domain": "llm-provider", "config": {"openai": {"apiKey": "sk-mock"}}}
        )
        client = ConfigClient(cp_url="http://localhost:8080")
        providers = client.get_providers()
        assert "openai" in providers
```

**Runtime 侧模式**（mockito / wiremock-rs）：

```rust
#[tokio::test]
async fn test_config_client_fetch() {
    let mut mock_server = MockServer::new().await;

    // Arrange: stub CP response
    Mock::given(method("GET"))
        .and(path("/api/v1/internal/config/admin/llm-provider"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(serde_json::json!({"domain": "llm-provider", ...}))
        )
        .expect(1)
        .mount(&mock_server)
        .await;

    // Act
    let client = ConfigClient::new(mock_server.uri(), "token".into());
    let result = client.fetch_config("admin", "llm-provider").await;

    // Assert
    assert!(result.is_ok());
}
```

### 2.3 T3: 跨模块 Real 集成

> 用 Docker Compose 启动部分模块栈（如 CP+Agent 或 CP+Runtime），通过真实 HTTP 端口验证端到端通信。

```
┌──────────────┐     HTTP (real)        ┌──────────────┐
│  CP (Docker) │◀──────────────────────▶│  Agent/Runtime│
│  :12631      │                        │  (Docker)     │
└──────────────┘                        └──────────────┘
```

**启动方式**：

```bash
# CP + Agent
docker compose up -d control-plane agent
# 等待健康检查后，运行 Agent 侧 T3 测试
cd packages/agent && uv run pytest tests/integration/test_cp_real_integration.py -v
# 或 CP 侧（从宿主机访问 Docker CP）
cd packages/control-plane && mvn test -Dtest="RuntimeMcpRealIntegrationTest"

# CP + Runtime
docker compose up -d control-plane runtime
cd packages/runtime && cargo test --test cp_real_integration_test
```

**T3 测试关注点**：

- 验证模块间协议兼容性（请求/响应格式匹配）
- 验证健康检查、重试、超时等非功能行为
- 验证真实序列化/反序列化（T2 用 stub 可能忽略序列化差异）
- 验证配置同步（ConfigClient 从 CP 拉取）

## 3. 测试目录规范

### 3.1 CP (Java)

```
src/test/java/com/cc01cc/p/xihe/cp/
├── auth/
│   └── AuthIntegrationTest.java              ← T1 (MockMvc + H2)
├── chat/
│   ├── ChatIntegrationTest.java              ← T1
│   └── ChatControllerNpeTest.java            ← T1
├── config/
│   ├── ConfigControllerTest.java             ← T1
│   ├── SecurityConfigTest.java               ← T1
│   └── TenantContextInterceptorTest.java     ← unit
├── entity/
│   └── UserTest.java                         ← unit
├── integration/
│   └── WorkspaceIsolationTest.java           ← T1
├── mcp/
│   ├── McpProxyTest.java                    ← unit (Mockito)
│   └── McpProxyControllerTest.java          ← unit
├── service/
│   ├── WorkspaceServiceTest.java            ← unit
│   └── WorkspaceServiceCustomPathTest.java  ← unit
├── session/
│   └── SessionIntegrationTest.java           ← T1
├── crossmodule/                        ← T2 + T3 新增
│   ├── AgentChatIntegrationTest.java         ← T2 (WireMock)
│   ├── AgentRagIntegrationTest.java          ← T2 (WireMock)
│   ├── AgentModelsIntegrationTest.java       ← T2 (WireMock)
│   ├── RuntimeMcpIntegrationTest.java        ← T2 (WireMock)
│   └── RuntimeWorkspaceIntegrationTest.java  ← T2 (WireMock)
├── AbstractIntegrationTest.java              ← Testcontainers PG
└── AbstractH2Test.java                       ← H2 基础类
```

### 3.2 Agent (Python)

```
tests/
├── unit/                                 ← 纯单元测试
│   ├── test_llm_base.py
│   ├── test_rag.py
│   ├── test_config_client.py             ← unit (in-memory, 无 HTTP)
│   └── ...
├── integration/                          ← T1 + T2 + T3
│   ├── test_vector_store.py              ← T1 (real PG, 需 Docker)
│   ├── test_registry_integration.py      ← T1 (需 Docker)
│   ├── test_agent_cp_integration.py      ← T3 (real CP)
│   ├── test_cp_stub_integration.py       ← T2 (pytest-httpx)
│   └── test_cp_real_integration.py       ← T3 (real CP, partial Docker)
└── conftest.py
```

### 3.3 Runtime (Rust)

```
tests/
├── artifact_test.rs                      ← unit
├── background_test.rs                    ← unit
├── escape_test.rs                        ← unit
├── mcp_tools_test.rs                     ← unit
├── unit_tools_test.rs                    ← unit
├── sandbox_test.rs                       ← T1 (Docker)
├── bridge_integration_test.rs            ← T1 (Docker)
├── mcp_multi_workspace_test.rs           ← T1 (Docker)
└── crossmodule/                     ← T2 + T3 新增
    ├── cp_stub_integration_test.rs       ← T2 (mockito/wiremock)
    └── cp_real_integration_test.rs       ← T3 (real CP Docker)
```

### 3.4 目录位置设计决策

集成测试和 E2E 测试原则上归入各模块 package 内，而非抽取到根级 `tests/` 或 `e2e/`。理由如下：

**T2 测试无法出包**。CP 的 WireMock 测试是 Java JUnit，需要 `pom.xml` 类路径、Spring `@SpringBootTest` 上下文、`@DynamicPropertySource` 注入端口。Agent 的 T2 需要导入 `xihe_agent` 的 Python 模块。放到包外意味着为每种语言单独维护 build config 和模块导入路径，成本远高于收益。

**T3 测试技术上可出包，但存在位置浪费**。T3 测试本质上只是 HTTP 请求脚本——不需要模块内部的任何依赖。但如果抽取到 `tests/integration/`，需要为每个模块的 T3 开辟独立的 build 配置（JUnit/pytest/cargo），而每个模块的 T3 测试数量通常只有 1-3 个（见 §4 契约清单）。不如直接放在模块内测试目录，复用已有的语言框架配置，并在接口契约清单中统一索引。

**E2E 测试归属 UI 包的历史原因**。E2E 使用 Playwright，Playwright config 的 `webServer` 段配置了 Vite dev server 启动命令（`pnpm dev`），天然属于 UI 包。~33 个 spec 中仅 4 个 cross-module spec（`cross-module-chat.spec.ts` 等）涉及跨模块通信，其余均为 UI 组件测试。为 4 个 spec 将整个 E2E 套件移出 UI 包，破坏其余 29 个同目录 spec 的相邻性，收益小于成本。

**索引优于移动**。跨模块测试不通过目录位置标记，而是通过接口契约清单（§4）统一索引。接口契约清单列出了每个跨模块接口、对应的 T2/T3 测试文件、所在模块。无论文件物理上在哪，一表可查。

| 维度 | 放模块内 | 放根级 |
|------|---------|-------|
| build 配置 | 复用现有 pom/pyproject/Cargo | 需为每种语言配独立 runner |
| 模块导入 | 自然可见 | 需额外 classpath/PYTHONPATH |
| 跨模块可见性 | 需索引表 | 目录即索引 |
| 多语言兼容 | 隔离 (各语言各自管理) | 需统一 runner 适配多语言 |
| E2E webServer 配置 | Playwright 直接调用 pnpm dev | 需额外配置或脚本 |

## 4. 接口契约清单

以下列出每个跨模块接口及对应的 T2/T3 测试覆盖：

| 接口 | 协议 | 方向 | T2 测试 | T3 测试 |
|------|------|------|---------|---------|
| Chat SSE persistence | `GET /api/v1/events?sessionId=` per-session (1 emitter/session, `generation` + `compareAndRemove`) → `POST /api/v1/chat` must find emitter (`409 SSE_SUBSCRIPTION_REQUIRED`) | CP internal | `SseEmitterManagerTest` (replacement / stale completion-timeout-error / `stale_cleanup_ignored` / send failure) | — |
| Chat SSE consecutive | 首条 `POST /api/v1/chat` 完成 `done` 后 SSE 仍可用，第二条不刷新返回 `202` | CP→Agent (stub) | `ChatIntegrationTest` (两轮 `202` + 助理只持久化一次) / `AgentChatIntegrationTest` (token/done 顺序 + `stream=true` / `X-Request-Id` / `X-Chat-Run-Id`) | `cross-module-chat.spec.ts` host named E2E (真实 CP/Agent/Runtime + 隔离 DB) — 连续消息、增量流、重复导航 |
| Chat SSE streaming | `XiheLiteLLM._astream()` 显式 `streaming=True` → `on_chat_model_stream` 多 token，`LangGraphEventAdapter` 按 `run_id` 去重，`on_chat_model_end` 仅 fallback | Agent internal | `test_sse_adapter.py` (多 chunk / end fallback / run 隔离) / `test_llm_base.py` (stream 参数 + provider 兼容) / `test_log_redact.py` (Authorization 脱敏) | 手工 CLI 真实流式：400 字长回复 → `bubble-content` 115 长度递增（0→704）+ `xh-incremental-stream-verified.png` |
| Chat SSE error/timeout | `error` + `done(error)` 仅一次终结信号；`missing done` 合成 `done(synthetic)`；`Agent down` / 401 / 超时 / 部分 token 后异常 | CP/Agent | `ChatIntegrationTest` / `AgentChatIntegrationTest` / `main.py` 失败路径 | Host `startup-failure` smoke + manual 断线恢复 |
| UI SSE lifecycle | `chatTransport` 单飞 + 退避重连 + `409` 一次恢复；`useSSE` / `SSEStream` / `chatStore.replaceStreamingParts` | UI | `chatStore.spec.ts` (replaceStreamingParts) / `ChatStreamIntegration.spec.ts` (逐 token live 更新) / `useSSE.spec.ts` (close/reconnect/409) | `chat.spec.ts` / `chat-interactions.spec.ts` / `auth-flows.spec.ts` (重复导航/reload/session switch 不破坏新连接) |
| Chat (SSE) | HTTP POST → SSE | CP→Agent | `AgentChatIntegrationTest` | `test_cp_real_integration.py` |
| RAG Ingest | HTTP POST multipart | CP→Agent | `AgentRagIntegrationTest` | `test_cp_real_integration.py` |
| RAG Search | HTTP POST form | CP→Agent | `AgentRagIntegrationTest` | `test_cp_real_integration.py` |
| Models List | HTTP GET | CP→Agent | `AgentModelsIntegrationTest` | (E2E 覆盖) |
| MCP tools/list | JSON-RPC 2.0 POST | CP→Runtime | `RuntimeMcpIntegrationTest` | `cp_real_integration_test.rs` |
| MCP tools/call | JSON-RPC 2.0 POST | CP→Runtime | `RuntimeMcpIntegrationTest` | `cp_real_integration_test.rs` |
| Workspace Create | HTTP POST JSON | CP→Runtime | `RuntimeWorkspaceIntegrationTest` | `cp_real_integration_test.rs` |
| Workspace Delete | HTTP POST JSON | CP→Runtime | `RuntimeWorkspaceIntegrationTest` | `cp_real_integration_test.rs` |
| File Write | HTTP POST binary | CP→Runtime | `RuntimeWorkspaceIntegrationTest` | (E2E 覆盖) |
| File Delete | HTTP POST JSON | CP→Runtime | `RuntimeWorkspaceIntegrationTest` | (E2E 覆盖) |
| Config Fetch | HTTP GET | Agent→CP | `test_cp_stub_integration.py` | `test_cp_real_integration.py` |
| MCP Connect | Streamable HTTP POST | Agent→CP | `test_cp_stub_integration.py` | `test_cp_real_integration.py` |
| Config Fetch | HTTP GET | Runtime→CP | `cp_stub_integration_test.rs` | `cp_real_integration_test.rs` |
| MCP Config Poll | HTTP GET | Runtime→CP | `cp_stub_integration_test.rs` | `cp_real_integration_test.rs` |

### 4.1 WireMock stub 模式

每个 T2 测试遵循三步模式：

```java
// STEP 1: Arrange — Stub 远程模块响应
stubFor(post("/chat")
    .willReturn(aResponse().withStatus(200)
        .withHeader("Content-Type", "text/event-stream")
        .withBody("event: message\ndata: {...}\n\n")));

// STEP 2: Act — 通过 CP 公共端点触发
ResponseEntity<String> resp = restTemplate.exchange(
    url("/v1/chat"), POST, httpEntity(request, token), String.class);

// STEP 3: Assert — 验证 CP 发出的请求格式
verify(postRequestedFor(urlEqualTo("/internal/v1/agent/chat"))
    .withHeader("Authorization", equalTo("Bearer dev-token-not-secure"))
    .withRequestBody(matchingJsonPath("$.content", equalTo("hello"))));
```

**禁止仅验证 status=200 的 stub 测试**。每个 T2 测试必须用 `verify()` 断言 CP 发出的请求 body/headers 包含正确字段——这才是 T2 的验证价值。

## 5. 运行命令

```bash
# 全量集成测试（Docker 可用时含 T3，不可用时仅 T2）
task integration:test

# 各模块独立运行
# CP 全部测试（含 T1 + T2 unit + T2 crossmodule）
mvn test -pl packages/control-plane

# CP 仅跨模块 T2
mvn test -Dtest="crossmodule/*IntegrationTest"

# Agent 集成测试（T2+T1，T3 需 Docker）
uv run pytest packages/agent/tests/integration/ -v -m "not docker"

# Agent T3（需 Docker）
docker compose up -d control-plane agent
uv run pytest packages/agent/tests/integration/test_cp_real_integration.py -v
docker compose down

# Runtime T2（无 Docker）
cargo test --test cp_stub_integration_test

# Runtime T3（需 Docker）
docker compose up -d control-plane runtime
cargo test --test cp_real_integration_test
docker compose down

# 更新覆盖率基线
task integration:test && task coverage:report
```

## 6. CI 策略

| 触发条件 | T1 | T2 | T3 |
|----------|----|----|-----|
| PR (每次 push) | ✅ | ✅ | ❌ |
| Nightly (每日) | ✅ | ✅ | ✅ |
| 手动触发 | ✅ | ✅ | ✅ |

T3 不在 PR 中运行的原因：Docker partial stack 启动 + 测试 ≈ 2min，对于高频 PR 反馈周期太长。PR 中 T2 = 快速契约检查，nightly T3 = 全量兼容验证。

## 7. 参考

- `plans/PLAN-049-integration-test-design.md` — 实施 PLAN
- `docs/i18n/zh-Hans/DEV-011-e2e-test-strategy.md` — E2E 测试策略
- 测试策略决策框架 — 维护在 workspace skill 中
- WireMock 文档：`http://wiremock.org/docs/`
- pytest-httpx 文档：`https://github.com/Colin-b/pytest_httpx`
