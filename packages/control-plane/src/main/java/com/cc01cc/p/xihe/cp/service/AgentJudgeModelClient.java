package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.provider.ProviderCredentialLeaseService;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * PLAN-0690 T1.2b CP-1 (spec §1/§3/§5): the real transport behind {@link JudgeModelClient}.
 *
 * <p>One call = read the session's provider binding, issue a short-lived credential lease
 * ({@link ProviderCredentialLeaseService} reused inline per design 决策 11 — no route service),
 * POST the assembled prompt to the Agent-side {@code /internal/v1/agent/judge/decide} endpoint
 * and validate the 200 envelope. The credential never travels in the body: the Agent redeems the
 * lease exactly like the summary hop does.</p>
 *
 * <p>Fail-closed contract (spec §1/§3): a missing session/binding/lease, a non-{@code ok}
 * envelope, a blank {@code verdictText}, a 4xx/5xx or an I/O error is {@code FAILED}; only the
 * request timeout is {@code TIMEOUT}. There is no retry and no synthetic verdict. Logging keeps
 * {@code status/requestId/Kind} — never the prompt, the lease token or a response body.</p>
 */
@Component
public class AgentJudgeModelClient implements JudgeModelClient {

    private static final Logger logger = LoggerFactory.getLogger(AgentJudgeModelClient.class);

    private static final String JUDGE_PATH = "/internal/v1/agent/judge/decide";
    private static final Duration CONNECT_TIMEOUT = Duration.ofSeconds(2);
    private static final long DEFAULT_TIMEOUT_MS = 8_000L;
    /** spec §3: the lease only has to outlive one bounded judge call (8 s hard cap). */
    static final Duration LEASE_TTL = Duration.ofSeconds(30);
    private static final int REASON_MAX_CHARS = 200;
    private static final int PROBLEM_CODE_MAX_CHARS = 60;

    private final SessionRepository sessionRepository;
    private final ProviderCredentialLeaseService credentialLeases;
    private final ObjectMapper objectMapper;
    private final HttpClient httpClient;
    private final String agentBaseUrl;
    private final String agentApiToken;
    private final long timeoutMs;

    public AgentJudgeModelClient(SessionRepository sessionRepository,
                                 ProviderCredentialLeaseService credentialLeases,
                                 ObjectMapper objectMapper,
                                 @Value("${cp.agent-base-url:http://localhost:12632}") String agentBaseUrl,
                                 @Value("${cp.agent-api-token:dev-token-not-secure}") String agentApiToken,
                                 @Value("${cp.judge.timeout-ms:8000}") long timeoutMs) {
        this.sessionRepository = sessionRepository;
        this.credentialLeases = credentialLeases;
        this.objectMapper = objectMapper;
        this.agentBaseUrl = stripTrailingSlash(agentBaseUrl);
        this.agentApiToken = agentApiToken;
        this.timeoutMs = timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
        this.httpClient = HttpClient.newBuilder().connectTimeout(CONNECT_TIMEOUT).build();
    }

    @Override
    public JudgeVerdict decide(JudgeRequest request) throws JudgeException {
        String requestId = UUID.randomUUID().toString();
        String leaseToken = leaseToken(request, requestId);
        HttpRequest httpRequest = buildRequest(request, leaseToken, requestId);
        long startedNanos = System.nanoTime();
        HttpResponse<String> response;
        try {
            response = httpClient.send(httpRequest,
                    HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        } catch (HttpTimeoutException timeout) {
            throw failure(JudgeException.Kind.TIMEOUT,
                    "judge timed out after " + timeoutMs + "ms", requestId);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw failure(JudgeException.Kind.FAILED, "judge request interrupted", requestId);
        } catch (IOException io) {
            throw failure(JudgeException.Kind.FAILED,
                    "judge transport failed: " + io.getClass().getSimpleName(), requestId);
        }
        if (response.statusCode() != 200) {
            String code = problemCode(response.body());
            throw failure(JudgeException.Kind.FAILED, "judge agent status=" + response.statusCode()
                    + (code.isEmpty() ? "" : " code=" + code), requestId);
        }
        return verdict(response.body(), startedNanos, requestId);
    }

    /**
     * Issues the lease the Agent redeems. The session is the only owner context this seam has, so
     * an unbound session fails closed instead of borrowing another owner's credential (spec §2).
     */
    private String leaseToken(JudgeRequest request, String requestId) throws JudgeException {
        if (request.sessionId() == null) {
            throw failure(JudgeException.Kind.FAILED, "judge owner context missing", requestId);
        }
        Session session = sessionRepository.findById(request.sessionId()).orElse(null);
        if (session == null) {
            throw failure(JudgeException.Kind.FAILED, "judge session not found", requestId);
        }
        String userId = session.getUserId();
        String workspaceId = session.getWorkspaceId();
        String connectionId = session.getProviderConnectionId();
        String providerId = session.getModelProvider();
        if (blank(userId) || blank(workspaceId)) {
            throw failure(JudgeException.Kind.FAILED, "judge owner context missing", requestId);
        }
        if (blank(connectionId) || blank(providerId)) {
            throw failure(JudgeException.Kind.FAILED, "judge provider binding missing", requestId);
        }
        if (blank(request.modelName())) {
            throw failure(JudgeException.Kind.FAILED, "judge model identity missing", requestId);
        }
        try {
            return credentialLeases.issue(userId, workspaceId, request.sessionId().toString(),
                    request.runId() == null ? null : request.runId().toString(),
                    connectionId, providerId, request.modelName(), session.getConnectionRevision(),
                    LEASE_TTL).token();
        } catch (RuntimeException rejected) {
            // The lease gate can refuse (stale revision, limit, visibility); never leak its body.
            logger.warn("[LIFECYCLE] service=cp event=judge_client_failed requestId={} stage=lease "
                    + "failureType={}", requestId, rejected.getClass().getSimpleName());
            throw new JudgeException(JudgeException.Kind.FAILED, "judge credential lease rejected");
        }
    }

    private HttpRequest buildRequest(JudgeRequest request, String leaseToken, String requestId)
            throws JudgeException {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("modelProvider", request.modelProvider());
        payload.put("modelName", request.modelName());
        payload.put("prompt", request.prompt());
        payload.put("judgeCredentialLease", leaseToken);
        try {
            return HttpRequest.newBuilder(URI.create(agentBaseUrl + JUDGE_PATH))
                    .header("Content-Type", "application/json")
                    .header("Accept", "application/json")
                    .header("Authorization", "Bearer " + agentApiToken)
                    .header("X-Request-Id", requestId)
                    .timeout(Duration.ofMillis(timeoutMs))
                    .POST(HttpRequest.BodyPublishers.ofString(
                            objectMapper.writeValueAsString(payload), StandardCharsets.UTF_8))
                    .build();
        } catch (RuntimeException | JsonProcessingException build) {
            throw failure(JudgeException.Kind.FAILED, "judge request could not be built", requestId);
        }
    }

    /** spec §1: the 200 envelope must be JSON, {@code status=ok} and carry a non-blank verdict. */
    private JudgeVerdict verdict(String body, long startedNanos, String requestId)
            throws JudgeException {
        JsonNode envelope;
        try {
            envelope = objectMapper.readTree(body);
        } catch (JsonProcessingException invalid) {
            throw failure(JudgeException.Kind.FAILED, "judge envelope is not JSON", requestId);
        }
        if (envelope == null || !envelope.isObject()) {
            throw failure(JudgeException.Kind.FAILED, "judge envelope is not a JSON object", requestId);
        }
        if (!"ok".equals(envelope.path("status").asText(""))) {
            throw failure(JudgeException.Kind.FAILED, "judge envelope status="
                    + truncate(envelope.path("status").asText(""), PROBLEM_CODE_MAX_CHARS), requestId);
        }
        String verdictText = envelope.path("verdictText").asText("");
        if (verdictText.isBlank()) {
            throw failure(JudgeException.Kind.FAILED, "judge envelope has no verdictText", requestId);
        }
        long latencyMs = envelope.path("latencyMs").asLong(-1L);
        if (latencyMs < 0) {
            latencyMs = elapsedMillis(startedNanos);
        }
        // spec §5: provider counters the response did not carry are recorded as 0, never guessed.
        return new JudgeVerdict(verdictText,
                Math.max(0L, envelope.path("promptTokens").asLong(0L)),
                Math.max(0L, envelope.path("completionTokens").asLong(0L)),
                latencyMs);
    }

    /** Best-effort Problem Details code for logs/messages; the status line already failed closed. */
    private String problemCode(String body) {
        try {
            JsonNode problem = objectMapper.readTree(body);
            return problem == null ? ""
                    : truncate(problem.path("code").asText(""), PROBLEM_CODE_MAX_CHARS);
        } catch (JsonProcessingException notJson) {
            return "";
        }
    }

    private JudgeException failure(JudgeException.Kind kind, String reason, String requestId) {
        String bounded = truncate(reason, REASON_MAX_CHARS);
        logger.warn("[LIFECYCLE] service=cp event=judge_client_failed requestId={} kind={} reason={}",
                requestId, kind, bounded);
        return new JudgeException(kind, bounded);
    }

    private static long elapsedMillis(long startedNanos) {
        return Math.max(0L, (System.nanoTime() - startedNanos) / 1_000_000L);
    }

    private static boolean blank(String value) {
        return value == null || value.isBlank();
    }

    private static String truncate(String text, int maxChars) {
        if (text == null || text.length() <= maxChars) {
            return text == null ? "" : text;
        }
        int codePoints = text.codePointCount(0, text.length());
        int limit = Math.min(codePoints, maxChars);
        return text.substring(0, text.offsetByCodePoints(0, limit));
    }

    private static String stripTrailingSlash(String value) {
        String trimmed = value == null ? "" : value.trim();
        while (trimmed.endsWith("/")) {
            trimmed = trimmed.substring(0, trimmed.length() - 1);
        }
        return trimmed;
    }
}
