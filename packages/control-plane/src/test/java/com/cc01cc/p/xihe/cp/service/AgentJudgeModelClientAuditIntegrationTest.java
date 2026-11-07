package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.AbstractH2Test;
import com.cc01cc.p.xihe.cp.entity.JudgeDecision;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.provider.ProviderCredentialLeaseService;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.JudgeDecisionRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoBean;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.when;

/**
 * PLAN-0690 T1.2b（Lead 补充洞，2026-11-07）：真实 {@link AgentJudgeModelClient} 的失败映射
 * 必须真的落到 {@code judge_decisions} 行，而不只是单测里的异常类型。
 *
 * <p>单测（{@code AgentJudgeModelClientTest}）断的是客户端异常类型/消息，{@code JudgeDecisionServiceTest}
 * 用的是 mock 桩 —— 两者都证明不了「lease 拒绝 / 超时 / 信封非 JSON」会跨过真实事务边界写成
 * {@code outcome=failed|timeout} 的行。本类补的就是这一段：{@link JudgeDecisionService}
 * 是真实 Bean、{@link AgentJudgeModelClient} 是真实 Bean 且真的走 HTTP，只有两个外部边界被替换
 * （{@link ProviderCredentialLeaseService} mock + 本机 {@link HttpServer} 桩传输）。</p>
 *
 * <p>同时锁定 spec §5 与 Lead 裁定：客户端失败的 {@code error} 文本尾部带
 * {@code requestId=...}，把 {@code judge_decisions} 行与 {@code judge_client_failed} 日志接起来
 * （schema 无 request_id 列，故走 error 文本）。四种失败都断言 {@code chat_runs} 零增量——
 * 判定失败不产生 run（T1.2 口径：JUDGE 判定不写 durable run 源）。</p>
 *
 * <p>测试方法**故意不加 {@code @Transactional}**：Spring 测试默认回滚会藏掉 REQUIRES_NEW 的提交结果。</p>
 */
class AgentJudgeModelClientAuditIntegrationTest extends AbstractH2Test {

    private static final String JUDGE_PATH = "/internal/v1/agent/judge/decide";
    private static final long TIMEOUT_MS = 800L;

    private static final AtomicReference<String> RESPONSE_BODY = new AtomicReference<>("{}");
    private static final AtomicLong RESPONSE_STATUS = new AtomicLong(200L);
    private static final AtomicLong RESPONSE_DELAY_MS = new AtomicLong(0L);
    private static final AtomicReference<String> LAST_JUDGE_BODY = new AtomicReference<>();
    private static final AtomicReference<String> LAST_REQUEST_ID = new AtomicReference<>();
    private static final AtomicLong JUDGE_REQUESTS = new AtomicLong();

    private static final HttpServer AGENT_STUB = startAgentStub();

    @Autowired
    private JudgeDecisionService judgeDecisionService;

    @Autowired
    private SessionRepository sessions;

    @Autowired
    private JudgeDecisionRepository judgeDecisions;

    @Autowired
    private ChatRunRepository chatRuns;

    @Autowired
    private JdbcTemplate jdbc;

    /** Boundary: the lease gate needs real provider/credential rows; its verdict is stubbed. */
    @MockitoBean
    private ProviderCredentialLeaseService credentialLeases;

    @DynamicPropertySource
    static void judgeTransportProperties(DynamicPropertyRegistry registry) {
        registry.add("cp.agent-base-url",
                () -> "http://127.0.0.1:" + AGENT_STUB.getAddress().getPort());
        registry.add("cp.judge.timeout-ms", () -> TIMEOUT_MS);
    }

    @AfterAll
    static void stopAgentStub() {
        AGENT_STUB.stop(0);
    }

    @BeforeEach
    void resetStub() {
        RESPONSE_STATUS.set(200L);
        RESPONSE_BODY.set("{}");
        RESPONSE_DELAY_MS.set(0L);
        LAST_JUDGE_BODY.set(null);
        LAST_REQUEST_ID.set(null);
        JUDGE_REQUESTS.set(0L);
        when(credentialLeases.issue(anyString(), anyString(), anyString(), any(), anyString(),
                anyString(), anyString(), any(), any()))
                .thenReturn(new ProviderCredentialLeaseService.IssuedLease(
                        "lease-token", Instant.now().plusSeconds(30)));
    }

    @Test
    void leaseRejectionPersistsFailedRowWithRequestId() {
        when(credentialLeases.issue(anyString(), anyString(), anyString(), any(), anyString(),
                anyString(), anyString(), any(), any()))
                .thenThrow(new IllegalStateException("STALE_PROVIDER_CONNECTION"));
        UUID sessionId = seedJudgeSession();
        long chatRunsBefore = chatRuns.count();

        JudgeDecisionService.JudgeOutcome outcome = judgeDecisionService.decide(
                input(sessionId, "wake:mention:t12b-lease"));

        assertEquals(JudgeDecision.OUTCOME_FAILED, outcome.outcome());
        assertEquals(chatRunsBefore, chatRuns.count(), "no chat run may exist after a judge failure");
        Map<String, Object> row = judgeRow(sessionId);
        assertEquals(JudgeDecision.OUTCOME_FAILED, row.get("outcome"));
        String error = (String) row.get("error");
        assertTrue(error.startsWith("judge credential lease rejected"), error);
        assertTrue(error.matches(".* requestId=[0-9a-fA-F-]{36}$"),
                "the lease failure must carry requestId: " + error);
        assertEquals(0L, JUDGE_REQUESTS.get(), "a refused lease must never reach the Agent");
    }

    @Test
    void timeoutPersistsTimeoutRowWithRequestId() {
        RESPONSE_DELAY_MS.set(TIMEOUT_MS * 2 + 400L);
        UUID sessionId = seedJudgeSession();
        long chatRunsBefore = chatRuns.count();

        JudgeDecisionService.JudgeOutcome outcome = judgeDecisionService.decide(
                input(sessionId, "wake:mention:t12b-timeout"));

        assertEquals(JudgeDecision.OUTCOME_TIMEOUT, outcome.outcome());
        assertEquals(chatRunsBefore, chatRuns.count(), "no chat run may exist after a judge timeout");
        Map<String, Object> row = judgeRow(sessionId);
        assertEquals(JudgeDecision.OUTCOME_TIMEOUT, row.get("outcome"));
        String error = (String) row.get("error");
        assertTrue(error.startsWith("judge timed out after " + TIMEOUT_MS + "ms"), error);
        assertTrue(error.endsWith("requestId=" + LAST_REQUEST_ID.get()),
                "the persisted requestId must be the X-Request-Id the Agent saw: " + error);
        assertEquals(1L, JUDGE_REQUESTS.get(), "the timeout must be observed on the real transport");
    }

    @Test
    void nonJsonEnvelopePersistsFailedRowWithRequestId() {
        RESPONSE_BODY.set("<html>upstream proxy error</html>");
        UUID sessionId = seedJudgeSession();
        long chatRunsBefore = chatRuns.count();

        JudgeDecisionService.JudgeOutcome outcome = judgeDecisionService.decide(
                input(sessionId, "wake:mention:t12b-bad-envelope"));

        assertEquals(JudgeDecision.OUTCOME_FAILED, outcome.outcome());
        assertEquals(chatRunsBefore, chatRuns.count());
        Map<String, Object> row = judgeRow(sessionId);
        assertEquals(JudgeDecision.OUTCOME_FAILED, row.get("outcome"));
        String error = (String) row.get("error");
        assertTrue(error.startsWith("judge envelope is not JSON"), error);
        assertTrue(error.endsWith("requestId=" + LAST_REQUEST_ID.get()), error);
        assertNotNull(LAST_JUDGE_BODY.get(), "the real client must have POSTed the judge payload");
    }

    @Test
    void nonJsonVerdictPersistsStrictReasonCode() {
        // The transport succeeded; the strict-verdict gate (spec §1) is what rejects the answer,
        // so the row carries the reason code, not a client requestId (no client failure was logged).
        RESPONSE_BODY.set("{\"status\":\"ok\",\"verdictText\":\"speak: yes\","
                + "\"promptTokens\":9,\"completionTokens\":2,\"latencyMs\":15}");
        UUID sessionId = seedJudgeSession();
        long chatRunsBefore = chatRuns.count();

        JudgeDecisionService.JudgeOutcome outcome = judgeDecisionService.decide(
                input(sessionId, "wake:mention:t12b-bad-verdict"));

        assertEquals(JudgeDecision.OUTCOME_FAILED, outcome.outcome());
        assertEquals(chatRunsBefore, chatRuns.count());
        Map<String, Object> row = judgeRow(sessionId);
        assertEquals(JudgeDecision.OUTCOME_FAILED, row.get("outcome"));
        assertEquals("verdict_not_json", row.get("error"));
        assertEquals(1L, JUDGE_REQUESTS.get());
    }

    private JudgeDecisionService.JudgeInput input(UUID sessionId, String wakeRoundId) {
        return new JudgeDecisionService.JudgeInput(sessionId, null, UUID.randomUUID(), wakeRoundId,
                "mention", "(no messages yet)", "respondPolicy=JUDGE", "bailian",
                "decision-model-preview", "You are the wake judge.");
    }

    private UUID seedJudgeSession() {
        // workspaceId/userId/providerConnectionId are @Convert(UuidStringConverter) columns.
        Session session = new Session();
        session.setId(UUID.randomUUID());
        session.setWorkspaceId(UUID.randomUUID().toString());
        session.setUserId(UUID.randomUUID().toString());
        session.setTitle("T1.2b judge fail-closed audit");
        session.setProviderConnectionId(UUID.randomUUID().toString());
        session.setModelProvider("bailian");
        session.setConnectionRevision(7L);
        sessions.saveAndFlush(session);
        return session.getId();
    }

    private Map<String, Object> judgeRow(UUID sessionId) {
        return jdbc.queryForMap(
                "SELECT outcome, error FROM judge_decisions WHERE session_id = ?", sessionId);
    }

    private static HttpServer startAgentStub() {
        try {
            HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            server.createContext("/", exchange -> {
                try {
                    handle(exchange);
                } catch (IOException clientGone) {
                    // the timeout case closes the socket before the stub answers
                }
            });
            server.start();
            return server;
        } catch (IOException startFailed) {
            throw new IllegalStateException("judge stub server could not start", startFailed);
        }
    }

    private static void handle(HttpExchange exchange) throws IOException {
        String path = exchange.getRequestURI().getPath();
        if (!JUDGE_PATH.equals(path)) {
            respond(exchange, 404, "{\"status\":\"unexpected-path\"}");
            return;
        }
        JUDGE_REQUESTS.incrementAndGet();
        LAST_REQUEST_ID.set(exchange.getRequestHeaders().getFirst("X-Request-Id"));
        LAST_JUDGE_BODY.set(new String(exchange.getRequestBody().readAllBytes(),
                StandardCharsets.UTF_8));
        long delay = RESPONSE_DELAY_MS.get();
        if (delay > 0) {
            try {
                Thread.sleep(delay);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
        }
        respond(exchange, (int) RESPONSE_STATUS.get(), RESPONSE_BODY.get());
    }

    private static void respond(HttpExchange exchange, int status, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().add("Content-Type", "application/json");
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(bytes);
        }
    }
}
