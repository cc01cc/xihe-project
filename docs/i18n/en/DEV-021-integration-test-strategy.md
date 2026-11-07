---
title: DEV-021 - Integration Test Strategy
category: dev-guide
sidebar_order: 21
lang: en
sidebar_group: "Developer Guide"
---

# DEV-021: Integration Test Strategy

> Persistent documentation for xihe project three-layer integration test architecture, directory standards, cross-module contract test patterns, and run guide.

## 1. Layered Architecture

Integration tests are split into three layers, consistent with E2E's mock/real separation but with different focus — integration tests verify **inter-module interface contracts** rather than user interaction flows.

```
┌─────────────────────────────────────────────────────┐
│                    E2E (DEV-020)                     │
│    Browser + host stack, verifies user flows         │
├─────────────────────────────────────────────────────┤
│  T3: Cross-module Real  ← New                       │
│     Docker partial stack (frozen) - historical       │
├─────────────────────────────────────────────────────┤
│  T2: Cross-module Stub  ← New                       │
│     WireMock/httpx mock, verifies HTTP contract format │
├─────────────────────────────────────────────────────┤
│  T1: Module-internal     ← Existing                  │
│     Testcontainers/MockMvc, verifies intra-module integration │
├─────────────────────────────────────────────────────┤
│                    Unit Tests                        │
│     Pure functions/component logic, mock all external dependencies │
└─────────────────────────────────────────────────────┘
```

### Layer Comparison

| Dimension | T1 Module-internal | T2 Cross-module Stub | T3 Cross-module Real | E2E |
|-----------|-------------------|---------------------|---------------------|-----|
| **Verification Target** | Module + DB/internal dependency correctness | HTTP request/response format correctness | Real inter-module communication | End-to-end user flow |
| **External Dependencies** | DB (PG/H2) | None (WireMock/mock) | Docker partial (frozen — see §2.3) | Host services (Windows native) + isolated PG + browser |
| **Run Speed** | ~10-30s | ~5-15s | ~60-120s | ~2-5min |
| **Failure Localization** | Intra-module issue | Request format issue | Inter-module compatibility | Any layer issue |
| **CI Run (target state)** | Every run | Every run | PR + nightly | nightly |
| **Framework** | JUnit/MockMvc, pytest, cargo | WireMock, httpx mock, mockito | pytest + httpx, cargo | Playwright |

> Two calibers corrected on 2026-11-07: (1) the **"CI Run" column is target state** — this repo has **no CI wired** today (`.github/workflows/` only holds `_disabled/` workflows; see §6); (2) the T3 row's "Docker partial" is the **historical lane** (service containerization frozen 2026-10-07); current acceptance runs on the host lane (§2.3).

## 2. Three Layers in Detail

### 2.1 T1: Module-internal Integration

> Integration of each module's dependent internal infrastructure (DB, file system, Docker daemon) with module code.

**Already exists**, not the focus of this layer's incremental work, but listed for complete architectural understanding:

| Module | Tests | Framework | Needs Docker |
|--------|-------|-----------|--------------|
| CP (Java) | AuthIntegrationTest, SessionIntegrationTest, ChatIntegrationTest, WorkspaceIsolationTest, ConfigControllerTest, ChatControllerNpeTest | Spring MockMvc + H2 or Testcontainers PG | H2: ❌ / PG: ✅ |
| Agent (Python) | test_vector_store.py, test_registry_integration.py | pytest + real PG | ✅ |
| Runtime (Rust) | sandbox_test.rs, bridge_integration_test.rs | cargo test + Docker | ✅ |

### 2.2 T2: Cross-module Stub Integration

> Uses WireMock (CP side) or httpx mock (Agent side) or HTTP mock (Runtime side) to simulate the other module's HTTP interface, verifying "whether this module correctly assembles cross-module requests."

```
┌──────────────┐     HTTP (stubbed)     ┌──────────────┐
│  CP Test     │─────── WireMock ──────▶│  Mock Agent  │
│  (H2 + JUnit)│◀───────────────────────│  (no Docker) │
└──────────────┘                        └──────────────┘
```

**CP-side Pattern** (WireMock):

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

        // Act: Trigger via CP HTTP endpoint → CP internally forwards to Agent
        String token = registerAndLogin();
        String sessionId = fixture.sessionId();
        String branchId = fixture.rootBranchId(sessionId);
        var response = restTemplate.postForEntity(
            url("/api/v1/chat"),
            httpEntity(Map.of("sessionId", sessionId, "branchId", branchId, "content", "hello"), token),
            String.class);

        // Assert: WireMock verifies CP's outgoing request format
        verify(postRequestedFor(urlEqualTo("/internal/v1/agent/chat"))
            .withHeader("Authorization", equalTo("Bearer dev-token-not-secure"))
            .withRequestBody(matchingJsonPath("$.content", equalTo("hello"))));
    }
}
```

**Agent-side Pattern** (pytest-httpx):

```python
@pytest.mark.integration
class TestConfigClientWithStub:
    def test_fetch_providers(self, httpx_mock):
        httpx_mock.add_response(
            url="http://localhost:12631/api/v1/internal/config/admin/llm-provider",
            json={"domain": "llm-provider", "config": {"openai": {"apiKey": "sk-mock"}}}
        )
        client = ConfigClient(cp_url="http://localhost:12631")
        providers = client.get_providers()
        assert "openai" in providers
```

**Runtime-side Pattern** (mockito / wiremock-rs):

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

### 2.3 T3: Cross-module Real Integration

> 🧊 **Lane frozen (2026-10-07 user ruling; reinforced 2026-10-09)**: T3's Docker Compose partial-stack lane is discontinued together with the **service-containerization freeze** (only PostgreSQL stays containerized; CP/Agent/Runtime/UI all run as host processes; `mise run test:e2e:compose` / `test:e2e` are commented out in `mise.toml`). The diagram and command blocks in this section are kept as **historical reference**; current acceptance runs on the **host lane**: Windows-native services + per-round isolated PostgreSQL (T2 via `mise run test:integration:t2`; real-stack T3 runs against host processes — see "Host lane" below).
>
> Historical wording: Uses Docker Compose to start partial module stacks (e.g., CP+Agent or CP+Runtime), verifying end-to-end communication through real HTTP ports.
>
> ⚠️ **Documentation vs task state (settled — D-223: keep the task, fix only the docs)**: `mise run test:integration` still declares a `t3` dependency and its body will try `docker compose up`. The task is **neither commented out nor removed** — the lane is frozen and the task is kept so existing references and callers are not cut off (`test:integration:t2` remains the clean T2 entry point). Treat this document as authoritative: the T3 compose lane **must not be used for acceptance**; real-stack acceptance runs on the "Host lane" above. Removing the `t3` dependency would be a task-behavior change (B class) and needs its own ruling, not a docs-only edit.

```
┌──────────────┐     HTTP (real)        ┌──────────────┐
│  CP (Docker) │◀──────────────────────▶│  Agent/Runtime│
│  :12631      │                        │  (Docker)     │
└──────────────┘                        └──────────────┘
```

**Default Agent collection surface (BL-361, 2026-11-06)**: `packages/agent/pyproject.toml` sets `addopts = '-m "not integration"'`, so a plain `uv run pytest` **deselects** `tests/integration/**` (host-only cases such as `test_vector_store.py` no longer hard-fail the ordinary gate; the `deselected` count is printed).
Host lane: inject `XIHE_E2E_PG_DATABASE/USER/PORT` from the isolated runner first, then run `uv run pytest -m integration` explicitly. A missing `integration` marker is caught by the meta test `tests/unit/test_integration_markers.py`.
**Measured counts (2026-11-07 re-measure)**: the default run collects **1488/1518 (30 integration tests deselected)**; adding `-m "not docker"` on the command line **overrides** the `addopts` `-m` (pytest's later single-value option wins, it does not intersect) and collects **1510/1518, deselecting only 8** — the `@pytest.mark.docker` items, all in `test_cp_real_integration.py` ⇒ the `not integration` default is gone and 22 of the 30 integration tests really run. `tests/integration/test_agent_cp_integration.py` and `test_cp_real_integration.py` also carry `skipif(not cp_available)` ⇒ **those tests skip silently inside the integration lane when CP is not running** (not failures). Restore: start the host CP first (port from `XIHE_CP_PORT`, **12631 by default on stack-1** — not 8080), then `uv run pytest -m integration`.

**Startup Method** (historical — the compose lane is frozen since 2026-10-07 and no longer used for acceptance):

```bash
# ⚠️ Historical reference (compose lane frozen 2026-10-07): not used for acceptance anymore
# CP + Agent
docker compose up -d control-plane agent
# After health check passes, run Agent-side T3 tests
cd packages/agent && uv run pytest tests/integration/test_cp_real_integration.py -v
# Or CP-side (access Docker CP from host)
cd packages/control-plane && mvn test -Dtest="RuntimeMcpRealIntegrationTest"

# CP + Runtime
docker compose up -d control-plane runtime
cd packages/runtime && cargo test --test cp_real_integration_test
```

**Host lane (current; replaces the compose block above)**:

```bash
# T2: cross-module stubs — no Docker, no real stack
mise run test:integration:t2

# Real-stack T3: bring up the host stack first (PostgreSQL is the only container; four host processes)
mise run dev:host
# Agent-side real CP cases (reads XIHE_CP_PORT, default 12631)
cd packages/agent && uv run pytest -m integration
# Runtime-side real CP cases (every test in the file is #[ignore] — --ignored is required)
cd packages/runtime && cargo test --test cp_real_integration_test -- --ignored
```

**T3 Test Focus**:

- Verify inter-module protocol compatibility (request/response format matching)
- Verify health checks, retries, timeouts, and other non-functional behaviors
- Verify real serialization/deserialization (T2 stubs may miss serialization differences)
- Verify configuration synchronization (ConfigClient fetching from CP)

## 3. Test Directory Standards

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
├── crossmodule/                        ← T2 + T3 new additions
│   ├── AgentChatIntegrationTest.java         ← T2 (WireMock)
│   ├── AgentRagIntegrationTest.java          ← T2 (WireMock)
│   ├── AgentModelsIntegrationTest.java       ← T2 (WireMock)
│   ├── RuntimeMcpIntegrationTest.java        ← T2 (WireMock)
│   └── RuntimeWorkspaceIntegrationTest.java  ← T2 (WireMock)
├── AbstractIntegrationTest.java              ← Testcontainers PG
└── AbstractH2Test.java                       ← H2 base class
```

### 3.2 Agent (Python)

```
tests/
├── unit/                                 ← Pure unit tests
│   ├── test_llm_base.py
│   ├── test_rag.py
│   ├── test_config_client.py             ← unit (in-memory, no HTTP)
│   └── ...
├── integration/                          ← T1 + T2 + T3
│   ├── test_vector_store.py              ← T1 (real PG, needs Docker)
│   ├── test_registry_integration.py      ← T1 (needs Docker)
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
└── crossmodule/                     ← T2 + T3 new additions
    ├── cp_stub_integration_test.rs       ← T2 (mockito/wiremock)
    └── cp_real_integration_test.rs       ← T3 (real CP Docker)
```

### 3.4 Directory Location Design Decision

Integration and E2E tests belong within each module's package rather than being extracted to root-level `tests/` or `e2e/`. Reasons:

**T2 tests cannot leave the package**. CP's WireMock tests are Java JUnit, requiring `pom.xml` classpath, Spring `@SpringBootTest` context, and `@DynamicPropertySource` port injection. Agent's T2 needs to import `xihe_agent` Python modules. Moving them outside the package means maintaining separate build configs and module import paths for each language — cost far exceeds benefit.

**T3 tests could technically leave the package, but location waste exists**. T3 tests are essentially just HTTP request scripts — they don't need any intra-module dependencies. But if extracted to `tests/integration/`, separate build configurations (JUnit/pytest/cargo) would be needed for each module's T3, and each module typically has only 1-3 T3 tests (see §4 contract list). It's better to keep them within the module's test directory, reusing existing language framework configurations, and uniformly indexing them in the interface contract list.

**E2E tests belong to UI package for historical reasons**. E2E uses Playwright, and Playwright config's `webServer` section configures the Vite dev server startup command (`pnpm dev`), naturally belonging to the UI package. Of ~213 spec files (mock 78 + real 132 + headed 3; counted from `packages/ui/e2e` on 2026-11-07), only 4 cross-module specs (`cross-module-chat.spec.ts`, etc.) involve cross-module communication; the rest are UI component tests. Moving the entire E2E suite out of the UI package for 4 specs would break the co-location of the remaining 209 specs in the same directory — benefit is less than cost.

**Indexing is better than moving**. Cross-module tests are not marked by directory location but uniformly indexed through the interface contract list (§4). The interface contract list lists each cross-module interface, corresponding T2/T3 test files, and their module location. Regardless of where files physically reside, one table covers all.

| Dimension | In-module | Root-level |
|-----------|-----------|------------|
| Build config | Reuse existing pom/pyproject/Cargo | Need independent runner per language |
| Module import | Naturally visible | Need extra classpath/PYTHONPATH |
| Cross-module visibility | Needs index table | Directory is the index |
| Multi-language compatibility | Isolated (each language manages itself) | Need unified runner adapting multiple languages |
| E2E webServer config | Playwright directly calls pnpm dev | Needs extra config or scripts |

## 4. Interface Contract List

The following lists each cross-module interface and its corresponding T2/T3 test coverage:

| Interface | Protocol | Direction | T2 Test | T3 Test |
|-----------|----------|-----------|---------|---------|
| Chat SSE persistence | `GET /api/v1/events?sessionId=` per-session (1 emitter/session, `generation` + `compareAndRemove`) → `POST /api/v1/chat` must find emitter (`409 SSE_SUBSCRIPTION_REQUIRED`) | CP internal | `SseEmitterManagerTest` (replacement / stale completion-timeout-error / `stale_cleanup_ignored` / send failure) | — |
| Chat SSE consecutive | First `POST /api/v1/chat` completes with `done` yet SSE stays open, second without refresh returns `202` | CP→Agent (stub) | `ChatIntegrationTest` (two rounds of `202` + single persist) / `AgentChatIntegrationTest` (token/done order + `stream=true` / `X-Request-Id` / `X-Chat-Run-Id`) | `cross-module-chat.spec.ts` host named E2E (real CP/Agent/Runtime + isolated DB) — consecutive messages, incremental streaming, repeated navigation |
| Chat SSE streaming | `XiheLiteLLM._astream()` sets `streaming=True` → `on_chat_model_stream` multi-token, `LangGraphEventAdapter` deduplicates per `run_id`, `on_chat_model_end` is fallback only | Agent internal | `test_sse_adapter.py` (multi-chunk / end fallback / run isolation) / `test_llm_base.py` (stream param + provider compat) / `test_log_redact.py` (Authorization masking) | Manual CLI real streaming: 400-char prompt → `bubble-content` 115 lengths (0→704) + `xh-incremental-stream-verified.png` |
| Chat SSE error/timeout | `error` + `done(error)` as single terminal; synthesized `done(synthetic)` when missing; Agent down/401/timeout/partial tokens | CP/Agent | `ChatIntegrationTest` / `AgentChatIntegrationTest` / `main.py` failure paths | Host `startup-failure` smoke + manual disconnect recovery |
| UI SSE lifecycle | `chatTransport` single flight + backoff reconnect + one-shot `409` recovery; `useSSE` / `SSEStream` / `chatStore.replaceStreamingParts` | UI | `chatStore.spec.ts` (replaceStreamingParts) / `ChatStreamIntegration.spec.ts` (per-token live) / `useSSE.spec.ts` (close/reconnect/409) | `chat.spec.ts` / `chat-interactions.spec.ts` / `auth-flows.spec.ts` (repeated navigation/reload/session switch) |
| Chat (SSE) | HTTP POST → SSE | CP→Agent | `AgentChatIntegrationTest` | `test_cp_real_integration.py` |
| RAG Ingest | HTTP POST multipart | CP→Agent | `AgentRagIntegrationTest` | `test_cp_real_integration.py` |
| RAG Search | HTTP POST form | CP→Agent | `AgentRagIntegrationTest` | `test_cp_real_integration.py` |
| Models List | HTTP GET | CP→Agent | `AgentModelsIntegrationTest` | (E2E coverage) |
| MCP tools/list | JSON-RPC 2.0 POST | CP→Runtime | `RuntimeMcpIntegrationTest` | `cp_real_integration_test.rs` |
| MCP tools/call | JSON-RPC 2.0 POST | CP→Runtime | `RuntimeMcpIntegrationTest` | `cp_real_integration_test.rs` |
| Workspace Create | HTTP POST JSON | CP→Runtime | `RuntimeWorkspaceIntegrationTest` | `cp_real_integration_test.rs` |
| Workspace Delete | HTTP POST JSON | CP→Runtime | `RuntimeWorkspaceIntegrationTest` | `cp_real_integration_test.rs` |
| File Write | HTTP POST binary | CP→Runtime | `RuntimeWorkspaceIntegrationTest` | (E2E coverage) |
| File Delete | HTTP POST JSON | CP→Runtime | `RuntimeWorkspaceIntegrationTest` | (E2E coverage) |
| Config Fetch | HTTP GET | Agent→CP | `test_cp_stub_integration.py` | `test_cp_real_integration.py` |
| MCP Connect | Streamable HTTP POST | Agent→CP | `test_cp_stub_integration.py` | `test_cp_real_integration.py` |
| Config Fetch | HTTP GET | Runtime→CP | `cp_stub_integration_test.rs` | `cp_real_integration_test.rs` |
| MCP Config Poll | HTTP GET | Runtime→CP | `cp_stub_integration_test.rs` | `cp_real_integration_test.rs` |

### 4.1 WireMock Stub Pattern

Each T2 test follows a three-step pattern:

```java
// STEP 1: Arrange — Stub remote module response
stubFor(post("/chat")
    .willReturn(aResponse().withStatus(200)
        .withHeader("Content-Type", "text/event-stream")
        .withBody("event: message\ndata: {...}\n\n")));

// STEP 2: Act — Trigger via CP public endpoint
ResponseEntity<String> resp = restTemplate.exchange(
    url("/v1/chat"), POST, httpEntity(request, token), String.class);

// STEP 3: Assert — Verify CP's outgoing request format
verify(postRequestedFor(urlEqualTo("/internal/v1/agent/chat"))
    .withHeader("Authorization", equalTo("Bearer dev-token-not-secure"))
    .withRequestBody(matchingJsonPath("$.content", equalTo("hello"))));
```

**Stub tests that only verify status=200 are prohibited**. Every T2 test must use `verify()` to assert that CP's outgoing request body/headers contain correct fields — this is the verification value of T2.

### 4.1 PLAN-247 ChatRun and tool boundary coverage

The CP integration contract includes durable `ChatRun` state, `(userId, sessionId, Idempotency-Key)` deduplication, request-hash conflicts, and conditional terminal transitions. A stream that ends without a terminal `done` is `ambiguous`; it is never auto-retried. Normal Chat uses `toolMode=none` and must not call MCP discovery, while Workspace actions explicitly use `toolMode=workspace`.

The Host fake-LLM matrix adds missing-credential, provider-401, multi-token success, provider-disconnect, model capability filtering, and canonical provider/model binding scenarios. Direct fixture requests are supplementary only; the browser tests assert the UI request and visible result.

## 5. Run Commands

```bash
# Full integration test (T3 = historical compose lane, service-containerization freeze 2026-10-07;
# current acceptance runs on the host lane — see §2.3)
# Note: the task still declares a t3 dependency and its body tries docker compose — that is settled
# current state (D-223: task kept, docs fixed), not an open question; for T2 only use test:integration:t2,
# and run real-stack acceptance on the host lane (see §2.3)
mise run test:integration

# Run each module independently
# CP all tests (including T1 + T2 unit + T2 crossmodule)
mvn test -pl packages/control-plane

# CP cross-module T2 only
mvn test -Dtest="crossmodule/*IntegrationTest"

# ⚠️ `-m` caliber (measured 2026-11-07, reproducible): the CLI `-m` OVERRIDES pyproject's `-m`, it does not intersect —
#   ① pyproject `addopts = '-m "not integration"'`: plain `uv run pytest --collect-only -q` ⇒ 1488/1518 collected, 30 deselected;
#   ② adding `-m "not docker"`: `uv run pytest --collect-only -q -m "not docker"` ⇒ 1510/1518 collected, only 8 deselected
#      (all `@pytest.mark.docker` items live in test_cp_real_integration.py) ⇒ the `not integration` default no longer applies;
#   ③ so the line below is NOT "T2+T1": it collects and really runs 22 of the 30 integration tests (30 minus the docker subset).
#      For the default gate use plain `uv run pytest`; for the integration lane only use an explicit `-m integration`.
uv run pytest packages/agent/tests/integration/ -v -m "not docker"

# Agent T3 (historical: compose lane frozen; real stack now uses `mise run dev:host` + `uv run pytest -m integration`, §2.3)
docker compose up -d control-plane agent
uv run pytest packages/agent/tests/integration/test_cp_real_integration.py -v
docker compose down

# Runtime T2 (no Docker)
cargo test --test cp_stub_integration_test

# Runtime T3 (historical: compose lane frozen; real stack now uses `mise run dev:host` + the --ignored command below)
docker compose up -d control-plane runtime
cargo test --test cp_real_integration_test
docker compose down

# Coverage baseline: this repo has NO coverage-baseline tooling (no gate script, no baseline file) ⇒ the former
# "Update coverage baseline / mise run test:integration" lines did not hold; test:integration is the integration
# task and produces no baseline. The old coverage gate workflow is disabled with CI (.github/workflows/_disabled/coverage.yml, §6).
```

## 6. CI Strategy

**Current state (verified 2026-11-07): this repo has NO CI wired** — `.github/workflows/` only holds `_disabled/ci.yml` (four module unit jobs) and `_disabled/coverage.yml` (CP coverage), neither running; there is no T2/T3/nightly job anywhere. **The table below is target state**, not current fact; until CI is wired, T1/T2 run locally only.

| Trigger Condition | T1 | T2 | T3 (historical lane) |
|-------------------|----|----|-----|
| PR (every push) | target: ✅ | target: ✅ | target: ❌ |
| Nightly (daily) | target: ✅ | target: ✅ | target: ✅ |
| Manual trigger | target: ✅ | target: ✅ | target: ✅ |

T3 doesn't run in PRs because: Docker partial stack startup + test ≈ 2min, which is too long for high-frequency PR feedback cycles (that lane has been discontinued since the 2026-10-07 service-containerization freeze; current real-stack verification runs on the host lane, §2.3). T2 in PRs = fast contract check, nightly T3 = full compatibility verification — both are the target split **after** CI is wired.

## 7. References

- `plans/PLAN-049-integration-test-design.md` — Implementation PLAN
- `docs/i18n/en/DEV-020-e2e-test-strategy.md` — E2E test strategy
- Test strategy decision framework is maintained as a workspace skill.
- WireMock documentation: `http://wiremock.org/docs/`
- pytest-httpx documentation: `https://github.com/Colin-b/pytest_httpx`
