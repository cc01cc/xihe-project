---
title: DEV-013 - Unit Test Strategy and Coverage Standards
category: dev-guide
sidebar_order: 13
lang: en
sidebar_group: "Developer Guide"
created: 2026-06-17
tags: [testing, unit, vitest, pytest, junit, cargo]
---

# DEV-013: Unit Test Strategy

> Persistent documentation for xihe project four-module unit test architecture design, Mock strategy, coverage targets, and PLAN-020 status tracking.

## 1. Four-Module Test Architecture

xihe is a four-module architecture, each with different tech stacks and test frameworks:

| Module | Language | Framework | Test Directory | Needs Docker |
|--------|----------|-----------|----------------|--------------|
| UI (Frontend) | TypeScript | Vitest + jsdom | `packages/ui/src/**/*.spec.ts` | ❌ |
| CP (Control Plane) | Java 25 | JUnit 5 + Mockito | `packages/control-plane/src/test/` | ❌ (unit) |
| Agent (Agent Service) | Python 3.12 | pytest + pytest-asyncio | `packages/agent/tests/unit/` | ❌ |
| Runtime (Sandbox) | Rust 1.88 | cargo test --lib | `packages/runtime/tests/` | ❌ (unit) |

### 1.1 Current Overview (2026-06-17)

| Module | Test Files | Estimated Cases | Estimated Coverage | Target Coverage |
|--------|-----------|-----------------|-------------------|-----------------|
| UI | 39 spec | ~245 | ~68% | ≥ 70% |
| Agent | 18 files | ~60 | ~70% | ≥ 80% |
| CP | 26 test classes | ~90 | ~67% | ≥ 80% |
| Runtime | 10 files | ~26 | ~55% | ≥ 70% |
| E2E Mock | 19 spec | ~36 | — | — |
| E2E Real | 12 spec | ~15 | — | — |

> Data source: PLAN-020 §1 baseline + file scan update. 9 UI api-integration tests fail (need backend), 3 E2E mock + 3 real failures are pre-existing issues.

## 2. UI Unit Test Strategy

### 2.1 Tech Stack

- Vitest + jsdom + `@vue/test-utils`
- `vue-router-mock` for routing tests
- `fake-indexeddb` for IndexedDB tests (rarely used, xihe primarily uses CP backend)
- Component tests use `mount()` / `shallowMount()`

### 2.2 Mock Principles

| Dependency | Mock Method | Description |
|-----------|-------------|-------------|
| `cpFetch` (API) | `globalThis.cpFetch = vi.fn()` | Intercept all backend API calls |
| `useToast` | `vi.mock()` or spy | Verify Toast call parameters |
| `useRouter` / `useRoute` | `vue-router-mock` | Route navigation tests |
| `HTMLCanvasElement` | `HTMLCanvasElement.prototype.toBlob = vi.fn()` | Image compression tests |
| `SpeechSynthesis` | `window.speechSynthesis = vi.fn()` | TTS tests |
| `webkitGetUserMedia` | `navigator.mediaDevices.getUserMedia = vi.fn()` | Screenshot/voice tests |
| Pinia Store | `setActivePinia(createPinia())` | Store state tests |

### 2.3 Directory Standards

```
packages/ui/src/
├── components/
│   ├── __tests__/           # Component unit tests
│   │   ├── ChatView.spec.ts
│   │   ├── InputArea.spec.ts
│   │   └── ...
│   └── ...
├── composables/
│   ├── __tests__/           # Composable unit tests
│   │   └── useToast.spec.ts
│   └── ...
└── stores/
    └── __tests__/            # Store unit tests
```

## 3. CP Unit Test Strategy

### 3.1 Tech Stack

- JUnit 5 + Mockito
- Spring Boot 4 `@WebMvcTest` / `@DataJpaTest`
- `MockHttpServletRequest` / `MockHttpServletResponse`
- H2 in-memory database (entity tests for non-JSONB fields)
- Testcontainers PostgreSQL (entity tests for JSONB fields, see `.kilo/rules/jpa-testcontainers-requirement.md`)

### 3.2 Mock Principles

| Dependency | Mock Method | Description |
|-----------|-------------|-------------|
| External HTTP calls (Agent/Runtime) | WireMock (T2) or Mockito | T2 integration tests use WireMock |
| HttpServletRequest | `new MockHttpServletRequest()` | Controller tests |
| JWT Token | `JwtTokenProvider` real implementation | Can use real JWT directly |
| ConfigService | `@MockBean` or `Mockito.mock()` | Service layer tests |

### 3.3 Concrete Class Test Notes

- `@JdbcTypeCode(SqlTypes.JSON)` must be used for JSONB columns (see `.kilo/rules/jpa-jsonb-mapping.md`)
- H2 tests don't expose JSONB issues; JSONB entities must use Testcontainers PG
- ConfigController uses `@Value` injection, tests need mocking

## 4. Agent Unit Test Strategy

### 4.1 Tech Stack

- pytest + pytest-asyncio
- pytest-httpx (HTTP mock, used for integration tests)
- unittest.mock

### 4.2 Mock Principles

| Dependency | Mock Method | Description |
|-----------|-------------|-------------|
| httpx.AsyncClient | `httpx_mock` (pytest-httpx) | HTTP calls not actually sent |
| redis | `unittest.mock.AsyncMock` | T1 unit tests use mock |
| ConfigService (CP interface) | httpx mock | Configuration fetching |
| LLM response | mock `litellm.completion` | Chat function tests |
| Embedding model | mock embedding function | RAG tests |

### 4.3 Directory Standards

```
packages/agent/tests/
├── unit/                    # T1 unit tests (pure mock)
│   ├── test_*.py
│   └── conftest.py
├── integration/             # T2 cross-module tests
│   └── ...
```

## 5. Runtime Unit Test Strategy

### 5.1 Tech Stack

- cargo test --lib (unit tests don't start containers)
- Some tests need Docker (marked with `#[cfg_attr(not(feature = "docker-tests"), ignore)]`)

### 5.2 Mock Principles

| Dependency | Mock Method | Description |
|-----------|-------------|-------------|
| bollard (Docker API) | `mockall` crate | Container operations mock |
| HTTP (CP calls) | mock HTTP server (localhost) | T2 integration tests |
| File system | Temporary directory (`tempfile` crate) | Sandbox file operation tests |

### 5.3 Test Classification

- `*_test.rs` files: Pure unit tests (no external dependencies)
- `*_integration_test.rs`: Integration tests (need Docker or external services)
- CP stubs use `mockito` crate or embedded HTTP server

## 6. Mock Strategy Summary

| Dependency Type | UI | CP | Agent | Runtime |
|----------------|-----|-----|-------|---------|
| HTTP calls | `vi.fn()` (cpFetch) | WireMock / Mockito | pytest-httpx | mockito / temp server |
| Database | ❌ (rarely used) | H2 / Testcontainers PG | pytest-asyncio + mock | ❌ (not directly used) |
| External services | `vi.fn()` | `@MockBean` | AsyncMock | mockall |
| Routing | vue-router-mock | ❌ | ❌ | ❌ |
| Browser APIs | `vi.fn()` (speech/canvas) | ❌ | ❌ | ❌ |

## 7. Current Coverage Gaps

### 7.1 Per-module Gaps

| Module | Current | Target | Gap | Main Missing |
|--------|---------|--------|-----|-------------|
| UI | ~65% | ≥ 70% | ~5% | 22 components + 2 composables + 6 stores without tests |
| Agent | ~75% | ≥ 80% | ~5% | main.py, mcp_client, models, watcher zero tests |
| CP | ~67% | ≥ 80% | ~13% | ImportService, ExportService, security filters, etc. 16 files |
| Runtime | ~55% | ≥ 70% | ~15% | fetch.rs, workspace.rs, dotenv_loader no inline tests |

See `plans/PLAN-052-unit-test-gap-fill.md` §2.1 for the complete gap list.

### 7.2 Known Limitations

- 9 UI api-integration tests need backend, not pure unit tests
- Runtime timeout functionality not implemented, corresponding tests are `#[ignore]`
- ScreenshotCapture/VoiceInput E2E require user manual authorization, not available in CI

## 8. PLAN Status Tracking

### PLAN-020 — Test Coverage Fill

| Milestone | Status | Description |
|-----------|--------|-------------|
| M1-M5 all tasks | ✅ Completed | All execution table items ✅ |
| Coverage targets met | ⚠️ Not reached | All modules below target |

### PLAN-052 — Unit Test Gap Fill (Current)

New PLAN created for coverage gaps, split into P0/P1/P2 three phases. Current progress:

| Phase | Task | Status |
|-------|------|--------|
| P0 | UI auth/chat/provider stores (22 tests) | ✅ Completed |
| P0 | UI fileService + useLangChainSSE composables (14 tests) | ✅ Completed |
| P0 | CP ToolNameRewriter (6 tests) + PolicyEngine (4 tests) | ✅ Completed |
| P0 | Runtime error.rs (3 tests) | ✅ Completed |
| P0 | Agent models/watcher | ⏳ Pending (HTTP/IO dependencies, P1 level) |
| P0 | Runtime dotenv_loader | ⏸ Blocked (module in main.rs not lib.rs) |
| P1 | UI 6 key component tests | ⏳ Pending |
| P1 | CP ExportService + ImportService + AuditLogger + SseEmitter | ⏳ Pending |
| P1 | Agent mcp_client | ⏳ Pending |
| P2 | CP security filters + Runtime fetch + Agent main (partial) | ⏳ Pending |

See `plans/PLAN-052-unit-test-gap-fill.md`.

See `plans/PLAN-052-unit-test-gap-fill.md`.
