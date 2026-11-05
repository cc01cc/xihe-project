package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * PLAN-0660 M5-B / T5.12: delivers one answered question back to the waiting Agent.
 *
 * <p>Mirrors {@link ApprovalAgentClient}: same bearer header ({@code cp.agent-api-token}), same
 * {@code /internal/v1/agent/...} namespace, same short explicit timeouts, same fail-closed error
 * disposition. The Agent route it targets is
 * {@code POST /internal/v1/agent/user-question/respond} — the question counterpart of
 * {@code api/approval.py:15-34} (its 200 + {@code already_delivered} replay answer is what makes a
 * retried delivery idempotent).</p>
 *
 * <p><b>Only a 2xx counts as delivered.</b> Every other outcome — a 4xx/5xx from the Agent, a
 * timeout, a connection failure — is one {@code AGENT_QUESTION_DELIVERY_FAILED} failure, because the
 * caller's rule is "the answer is durable only if the waiting run actually received it" (T5.12
 * judgement: a failed callback must leave the row pending, never fabricate {@code answered}). The
 * exception never carries the answer body: only the upstream status code.</p>
 */
@Component
public class UserQuestionAgentClient {

    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .build();
    private final ObjectMapper objectMapper;
    private final String agentBaseUrl;
    private final String agentApiToken;

    public UserQuestionAgentClient(
            ObjectMapper objectMapper,
            @Value("${cp.agent-base-url:http://localhost:12632}") String agentBaseUrl,
            @Value("${cp.agent-api-token:dev-token-not-secure}") String agentApiToken) {
        this.objectMapper = objectMapper;
        this.agentBaseUrl = agentBaseUrl.replaceAll("/+$", "");
        this.agentApiToken = agentApiToken;
    }

    /**
     * Hands the answer to the Agent's blocked {@code ask_user} wait.
     *
     * @throws CpApiException {@code 502 AGENT_QUESTION_DELIVERY_FAILED} when the Agent did not accept
     *         it — the caller must then roll the state advance back (the question stays pending).
     */
    public void respond(String questionId, String sessionId, String runId, String answer) {
        requireUuid(questionId, "questionId");
        requireUuid(sessionId, "sessionId");
        requireUuid(runId, "runId");
        if (answer == null || answer.isBlank()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "answer is required");
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("questionId", questionId);
        body.put("sessionId", sessionId);
        body.put("runId", runId);
        body.put("answer", answer);
        post("/internal/v1/agent/user-question/respond", body);
    }

    private void post(String path, Map<String, Object> body) {
        try {
            HttpRequest request = HttpRequest.newBuilder(URI.create(agentBaseUrl + path))
                    .header("Content-Type", "application/json")
                    .header("Accept", "application/json")
                    .header("Authorization", "Bearer " + agentApiToken)
                    .timeout(Duration.ofSeconds(10))
                    .POST(HttpRequest.BodyPublishers.ofString(objectMapper.writeValueAsString(body)))
                    .build();
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                // Status code only: the answer body must never reach a log, an audit row or a
                // problem detail (spec/session/user-channel.md §5.2).
                throw new CpApiException(HttpStatus.BAD_GATEWAY, "AGENT_QUESTION_DELIVERY_FAILED",
                        "Agent did not accept the answer (status " + response.statusCode() + ")");
            }
        } catch (CpApiException e) {
            throw e;
        } catch (Exception e) {
            throw new CpApiException(HttpStatus.BAD_GATEWAY, "AGENT_QUESTION_DELIVERY_FAILED",
                    "Agent user-question service is unavailable", e);
        }
    }

    private static void requireUuid(String value, String field) {
        try {
            UUID.fromString(value);
        } catch (RuntimeException invalid) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    field + " is not a uuid", invalid);
        }
    }
}
