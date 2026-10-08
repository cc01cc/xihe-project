package com.cc01cc.p.xihe.cp.runtime;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Map;

import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * Client for the Runtime tool-call cancellation endpoint
 * ({@code POST /internal/v1/runtime/workspaces/{workspaceId}/executions/{toolCallId}/cancel}).
 *
 * <p>The Runtime side waits (bounded) for the container to acknowledge the
 * abort, so this client keeps a longer read timeout than the endpoint's own
 * confirmation window. A failed/unreachable Runtime is reported as
 * {@code unreachable} — the caller treats the outcome as unconfirmed and
 * continues the cancel-flow settlement.
 */
@Component
public class RuntimeExecutionClient {

    private static final Logger logger = LoggerFactory.getLogger(RuntimeExecutionClient.class);

    /** Runtime 内部端的有界确认窗口为 6s，此处留出余量。 */
    private static final Duration CANCEL_TIMEOUT = Duration.ofSeconds(8);

    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(3))
            .build();
    private final ObjectMapper objectMapper = new ObjectMapper();
    private final String runtimeUrl;
    private final String serviceToken;

    public RuntimeExecutionClient(
            @Value("${cp.mcp.runtime-url:http://localhost:12633}") String runtimeUrl,
            @Value("${cp.agent-api-token:dev-token-not-secure}") String serviceToken) {
        this.runtimeUrl = runtimeUrl;
        this.serviceToken = serviceToken;
    }

    /**
     * @param found    false when Runtime has no in-flight execution for the key
     *                 (HTTP 404) or could not be reached
     * @param status   cancelled / unconfirmed / already_finished (null when !found)
     * @param confirmed whether the container ack'ed the termination
     * @param unreachable true when the Runtime call itself failed
     */
    public record CancelOutcome(boolean found, String status, boolean confirmed, boolean unreachable) {

        public static CancelOutcome unreachableOutcome() {
            return new CancelOutcome(false, null, false, true);
        }
    }

    public CancelOutcome cancel(String workspaceId, String toolCallId) {
        if (workspaceId == null || workspaceId.isBlank()
                || toolCallId == null || toolCallId.isBlank()) {
            return CancelOutcome.unreachableOutcome();
        }
        String url = runtimeUrl + "/internal/v1/runtime/workspaces/" + workspaceId
                + "/executions/" + toolCallId + "/cancel";
        try {
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(url))
                    .header("Authorization", "Bearer " + serviceToken)
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString("{}"))
                    .timeout(CANCEL_TIMEOUT)
                    .build();
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() == 404) {
                return new CancelOutcome(false, null, false, false);
            }
            if (response.statusCode() / 100 != 2) {
                logger.warn("[LIFECYCLE] service=cp event=runtime_cancel_http_error workspaceId={} toolCallId={} status={}",
                        workspaceId, toolCallId, response.statusCode());
                return CancelOutcome.unreachableOutcome();
            }
            @SuppressWarnings("unchecked")
            Map<String, Object> body = objectMapper.readValue(response.body(), Map.class);
            String status = body.get("status") instanceof String value ? value : "unconfirmed";
            boolean confirmed = Boolean.TRUE.equals(body.get("confirmed"));
            return new CancelOutcome(true, status, confirmed, false);
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=runtime_cancel_unreachable workspaceId={} toolCallId={} error={}",
                    workspaceId, toolCallId, e.getMessage());
            return CancelOutcome.unreachableOutcome();
        }
    }
}
