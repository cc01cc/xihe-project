package com.cc01cc.p.xihe.cp.runtime;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * PLAN-0328 M2 W3: client for the Runtime Run-checkpoint contract
 * ({@code /internal/v1/runtime/workspaces/{ws}/checkpoints...}).
 *
 * <p>Follows {@link RuntimeExecutionClient} conventions: JDK {@link HttpClient},
 * service bearer auth, bounded connect/read timeouts, and a typed error mapping
 * instead of exceptions — 409 maps to {@code LEASE_HELD}, 503 to
 * {@code UNAVAILABLE}, every other non-2xx / transport failure to
 * {@code TRANSPORT}. Callers decide the degradation policy; the checkpoint
 * establishment path must never turn an unreachable Runtime into a dispatch
 * failure.</p>
 */
@Component
public class RuntimeCheckpointClient {

    private static final Logger logger = LoggerFactory.getLogger(RuntimeCheckpointClient.class);

    /** Cross-process connect bound (aligned with the other Runtime clients). */
    private static final Duration CONNECT_TIMEOUT = Duration.ofSeconds(3);
    /** Establishment budget: design §5.1 targets median ≤ 2s / P95 ≤ 8s. */
    private static final Duration CREATE_TIMEOUT = Duration.ofSeconds(10);
    /** Seal scans the change set after the Run; P95 ≤ 8s plus margin. */
    private static final Duration SEAL_TIMEOUT = Duration.ofSeconds(12);
    private static final Duration STATUS_TIMEOUT = Duration.ofSeconds(5);
    private static final Duration GC_TIMEOUT = Duration.ofSeconds(10);

    /** Typed call outcome; never an exception at the call site. */
    public enum Outcome { OK, NOT_FOUND, LEASE_HELD, UNAVAILABLE, TRANSPORT }

    /** One entry of a seal change set. */
    public record ChangedFile(String status, String path) {}

    public record CreateResult(Outcome outcome, String checkpointId, String runId, String state,
                               String baseRef, String createdAt, String reason) {}

    public record SealResult(Outcome outcome, String state, String endRef,
                             List<ChangedFile> changedFiles, boolean sealedWithLiveJobs,
                             boolean sealedAfterAbnormal, String reason) {}

    public record StatusResult(Outcome outcome, String state, Map<String, Object> body, String reason) {}

    public record GcResult(Outcome outcome, Map<String, Object> counts, String reason) {}

    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(CONNECT_TIMEOUT)
            .build();
    private static final ObjectMapper OBJECT_MAPPER = new ObjectMapper();
    private final String runtimeUrl;
    private final String serviceToken;

    public RuntimeCheckpointClient(
            @Value("${cp.mcp.runtime-url:http://localhost:12633}") String runtimeUrl,
            @Value("${cp.agent-api-token:dev-token-not-secure}") String serviceToken) {
        this.runtimeUrl = runtimeUrl;
        this.serviceToken = serviceToken;
    }

    /** Establishes the Run base checkpoint (Runtime-side idempotent per run). */
    public CreateResult create(String workspaceId, String runId, String actor, String callId) {
        if (isBlank(workspaceId) || isBlank(runId)) {
            return new CreateResult(Outcome.TRANSPORT, null, runId, null, null, null, "invalid_request");
        }
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("runId", runId);
        payload.put("actor", actor);
        payload.put("callId", callId);
        String url = baseUrl(workspaceId);
        try {
            HttpResponse<String> response = send("create", url, payload, CREATE_TIMEOUT);
            int status = response.statusCode();
            if (status == 409) {
                return new CreateResult(Outcome.LEASE_HELD, null, runId, null, null, null,
                        errorReason(status, response.body()));
            }
            if (status == 503) {
                return new CreateResult(Outcome.UNAVAILABLE, null, runId, null, null, null,
                        errorReason(status, response.body()));
            }
            if (status / 100 != 2) {
                return new CreateResult(Outcome.TRANSPORT, null, runId, null, null, null,
                        errorReason(status, response.body()));
            }
            Map<String, Object> body = parseBody(response.body());
            return new CreateResult(Outcome.OK, stringValue(body, "checkpointId"),
                    stringValue(body, "runId") == null ? runId : stringValue(body, "runId"),
                    stringValue(body, "state"), stringValue(body, "baseRef"),
                    stringValue(body, "createdAt"), null);
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=runtime_checkpoint_create_unreachable workspaceId={} runId={} error={}",
                    workspaceId, runId, e.getMessage());
            return new CreateResult(Outcome.TRANSPORT, null, runId, null, null, null, "unreachable");
        }
    }

    /** Seals the Run (Runtime-side idempotent: an existing end ref is returned). */
    public SealResult seal(String workspaceId, String runId) {
        if (isBlank(workspaceId) || isBlank(runId)) {
            return transportSeal("invalid_request");
        }
        String url = baseUrl(workspaceId) + "/" + runId + "/seal";
        try {
            HttpResponse<String> response = send("seal", url, Map.of(), SEAL_TIMEOUT);
            int status = response.statusCode();
            if (status == 404) {
                return new SealResult(Outcome.NOT_FOUND, null, null, List.of(), false, false,
                        errorReason(status, response.body()));
            }
            if (status == 503) {
                return new SealResult(Outcome.UNAVAILABLE, null, null, List.of(), false, false,
                        errorReason(status, response.body()));
            }
            if (status / 100 != 2) {
                return transportSeal(errorReason(status, response.body()));
            }
            Map<String, Object> body = parseBody(response.body());
            return new SealResult(Outcome.OK, stringValue(body, "state"),
                    stringValue(body, "endRef"), parseChangedFiles(body.get("changedFiles")),
                    Boolean.TRUE.equals(body.get("sealedWithLiveJobs")),
                    Boolean.TRUE.equals(body.get("sealedAfterAbnormal")), null);
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=runtime_checkpoint_seal_unreachable workspaceId={} runId={} error={}",
                    workspaceId, runId, e.getMessage());
            return transportSeal("unreachable");
        }
    }

    /** Reads the Runtime-side checkpoint status for one Run. */
    public StatusResult status(String workspaceId, String runId) {
        if (isBlank(workspaceId) || isBlank(runId)) {
            return new StatusResult(Outcome.TRANSPORT, null, Map.of(), "invalid_request");
        }
        String url = baseUrl(workspaceId) + "/" + runId;
        try {
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(url))
                    .header("Authorization", "Bearer " + serviceToken)
                    .header("Accept", "application/json")
                    .GET()
                    .timeout(STATUS_TIMEOUT)
                    .build();
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
            int status = response.statusCode();
            if (status == 404) {
                return new StatusResult(Outcome.NOT_FOUND, null, Map.of(), errorReason(status, response.body()));
            }
            if (status / 100 != 2) {
                return new StatusResult(Outcome.TRANSPORT, null, Map.of(), errorReason(status, response.body()));
            }
            Map<String, Object> body = parseBody(response.body());
            return new StatusResult(Outcome.OK, stringValue(body, "state"), body, null);
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=runtime_checkpoint_status_unreachable workspaceId={} runId={} error={}",
                    workspaceId, runId, e.getMessage());
            return new StatusResult(Outcome.TRANSPORT, null, Map.of(), "unreachable");
        }
    }

    /** Runs the Runtime retention sweep for one workspace and returns its counts. */
    public GcResult gc(String workspaceId) {
        if (isBlank(workspaceId)) {
            return new GcResult(Outcome.TRANSPORT, Map.of(), "invalid_request");
        }
        String url = baseUrl(workspaceId) + "/gc";
        try {
            HttpResponse<String> response = send("gc", url, Map.of(), GC_TIMEOUT);
            int status = response.statusCode();
            if (status / 100 != 2) {
                return new GcResult(Outcome.TRANSPORT, Map.of(), errorReason(status, response.body()));
            }
            Map<String, Object> body = parseBody(response.body());
            Map<String, Object> counts = body.get("counts") instanceof Map<?, ?> nested
                    ? toObjectMap(nested) : body;
            return new GcResult(Outcome.OK, counts, null);
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=runtime_checkpoint_gc_unreachable workspaceId={} error={}",
                    workspaceId, e.getMessage());
            return new GcResult(Outcome.TRANSPORT, Map.of(), "unreachable");
        }
    }

    private HttpResponse<String> send(String operation, String url, Map<String, Object> payload,
                                      Duration timeout) throws Exception {
        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .header("Authorization", "Bearer " + serviceToken)
                .header("Content-Type", "application/json")
                .header("Accept", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(OBJECT_MAPPER.writeValueAsString(payload)))
                .timeout(timeout)
                .build();
        HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() / 100 != 2 && response.statusCode() != 404
                && response.statusCode() != 409 && response.statusCode() != 503) {
            logger.warn("[LIFECYCLE] service=cp event=runtime_checkpoint_http_error op={} status={}",
                    operation, response.statusCode());
        }
        return response;
    }

    private String baseUrl(String workspaceId) {
        return runtimeUrl + "/internal/v1/runtime/workspaces/" + workspaceId + "/checkpoints";
    }

    private SealResult transportSeal(String reason) {
        return new SealResult(Outcome.TRANSPORT, null, null, List.of(), false, false, reason);
    }

    private static String errorReason(int status, String body) {
        try {
            Map<String, Object> parsed = OBJECT_MAPPER.readValue(
                    body == null || body.isBlank() ? "{}" : body,
                    new TypeReference<Map<String, Object>>() {});
            Object reason = parsed.get("reason");
            if (reason instanceof String value && !value.isBlank()) {
                return value;
            }
            Object code = parsed.get("code");
            if (code instanceof String value && !value.isBlank()) {
                return value;
            }
        } catch (Exception ignored) {
            // fall through to the status-derived reason
        }
        return "http_" + status;
    }

    private Map<String, Object> parseBody(String body) {
        try {
            if (body == null || body.isBlank()) {
                return Map.of();
            }
            return OBJECT_MAPPER.readValue(body, new TypeReference<Map<String, Object>>() {});
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=runtime_checkpoint_body_unparsable error={}", e.getMessage());
            return Map.of();
        }
    }

    private static List<ChangedFile> parseChangedFiles(Object raw) {
        if (!(raw instanceof List<?> list)) {
            return List.of();
        }
        List<ChangedFile> files = new ArrayList<>();
        for (Object item : list) {
            if (item instanceof Map<?, ?> map) {
                String status = asString(map.get("status"));
                String path = asString(map.get("path"));
                if (status != null || path != null) {
                    files.add(new ChangedFile(status, path));
                }
            }
        }
        return List.copyOf(files);
    }

    private static Map<String, Object> toObjectMap(Map<?, ?> raw) {
        Map<String, Object> mapped = new LinkedHashMap<>();
        raw.forEach((key, value) -> mapped.put(String.valueOf(key), value));
        return mapped;
    }

    private static String stringValue(Map<String, Object> body, String key) {
        return asString(body.get(key));
    }

    private static String asString(Object value) {
        return value instanceof String text && !text.isBlank() ? text : null;
    }

    private static boolean isBlank(String value) {
        return value == null || value.isBlank();
    }
}
