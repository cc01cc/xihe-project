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
    /** Read-only revert dry-run re-diffs the sealed tree (same class as seal). */
    private static final Duration PREVIEW_TIMEOUT = Duration.ofSeconds(12);
    /**
     * Revert budget: the Runtime restores per file (V17 budget ≤ 50ms/file, 100
     * files P95 ≤ 5s); 60s bounds even a few thousand changed paths without
     * letting the CP request hang.
     */
    private static final Duration REVERT_TIMEOUT = Duration.ofSeconds(60);
    /** Blob reads are capped at 1 MiB by the Runtime; a plain git read. */
    private static final Duration BLOB_TIMEOUT = Duration.ofSeconds(5);
    private static final Duration STATUS_TIMEOUT = Duration.ofSeconds(5);
    private static final Duration GIT_STATUS_TIMEOUT = Duration.ofSeconds(5);
    private static final Duration GC_TIMEOUT = Duration.ofSeconds(10);

    /**
     * Typed call outcome; never an exception at the call site. The 409 codes of the
     * revert surface map to their own values ({@code NOT_SEALED}, {@code HEAD_CHANGED},
     * {@code CONFLICTS_UNACKNOWLEDGED}); unrecognized non-2xx responses stay
     * {@code TRANSPORT}.
     */
    public enum Outcome {
        OK, NOT_FOUND, LEASE_HELD, UNAVAILABLE, TRANSPORT,
        NOT_SEALED, HEAD_CHANGED, CONFLICTS_UNACKNOWLEDGED, INVALID_REQUEST, TOO_LARGE
    }

    /** One entry of a seal change set. */
    public record ChangedFile(String status, String path) {}

    public record CreateResult(Outcome outcome, String checkpointId, String runId, String state,
                               String baseRef, String createdAt, String reason) {}

    public record SealResult(Outcome outcome, String state, String endRef,
                             List<ChangedFile> changedFiles, boolean sealedWithLiveJobs,
                             boolean sealedAfterAbnormal, String reason) {}

    public record StatusResult(Outcome outcome, String state, Map<String, Object> body, String reason) {}

    public record GcResult(Outcome outcome, Map<String, Object> counts, String reason) {}

    /** One preview entry ({@code action} = restore|delete; noop items are not listed). */
    public record PreviewEntry(String path, String oldPath, String action, String conflictReason) {}

    public record PreviewCounts(int restore, int delete, int skipConflicts, int noop) {}

    /**
     * `revert/preview` result. {@code problem} carries the parsed RFC 9457 body of a
     * failed call (empty on success) so callers can forward fields such as
     * {@code paths}, {@code recorded}/{@code observed} or {@code heldByRunId}.
     */
    public record RevertPreview(Outcome outcome, String runId, String state, PreviewCounts counts,
                                List<PreviewEntry> entries, Map<String, Object> headFingerprint,
                                boolean sealedWithLiveJobs, boolean truncated,
                                Map<String, Object> problem, String reason) {}

    /** One executed revert item ({@code result} = restored|deleted|skippedConflict|failed|noop). */
    public record ExecuteEntry(String path, String result, String reason) {}

    public record ExecuteCounts(int restored, int deleted, int skippedConflict, int failed, int noop) {}

    /** `revert` execution result; {@code problem} as in {@link RevertPreview}. */
    public record RevertResult(Outcome outcome, String runId, String revertRef, ExecuteCounts counts,
                               List<ExecuteEntry> entries, long durationMs,
                               Map<String, Object> problem, String reason) {}

    /** One plain-text blob of the run's base/end tree; {@code problem} as in {@link RevertPreview}. */
    public record BlobResult(Outcome outcome, String path, String ref, String content,
                             String reason, Map<String, Object> problem) {}

    /** One entry of the workspace user-repository status. */
    public record GitStatusEntry(String status, String path) {}

    public record GitStatusResult(Outcome outcome, boolean isRepository,
                                  List<GitStatusEntry> entries, String reason) {}

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

    /**
     * Read-only revert dry-run for one sealed run (no lease; PLAN-0328 M3 W2).
     * 404 means the Runtime refs are gone (the caller flips the sealed row once).
     */
    public RevertPreview previewRevert(String workspaceId, String runId) {
        if (isBlank(workspaceId) || isBlank(runId)) {
            return transportPreview("invalid_request");
        }
        String url = baseUrl(workspaceId) + "/" + runId + "/revert/preview";
        try {
            HttpResponse<String> response = send("revert_preview", url, Map.of(), PREVIEW_TIMEOUT);
            int status = response.statusCode();
            if (status / 100 != 2) {
                Map<String, Object> problem = parseBody(response.body());
                return new RevertPreview(failureOutcome(status, problem), null, null, null, List.of(),
                        Map.of(), false, false, problem, errorReason(status, response.body()));
            }
            Map<String, Object> body = parseBody(response.body());
            return new RevertPreview(Outcome.OK, stringValue(body, "runId"),
                    stringValue(body, "state"), parsePreviewCounts(body.get("counts")),
                    parsePreviewEntries(body.get("entries")), objectMap(body.get("headFingerprint")),
                    Boolean.TRUE.equals(body.get("sealedWithLiveJobs")),
                    Boolean.TRUE.equals(body.get("truncated")), Map.of(), null);
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=runtime_checkpoint_revert_preview_unreachable "
                            + "workspaceId={} runId={} error={}",
                    workspaceId, runId, e.getMessage());
            return transportPreview("unreachable");
        }
    }

    /**
     * Executes the revert of one sealed run. The Runtime takes the workspace
     * mutation lease itself (a live run answers 409 {@code CHECKPOINT_LEASE_HELD}).
     */
    public RevertResult revert(String workspaceId, String runId,
                               List<String> acknowledgeConflicts, boolean acknowledgeHeadChange) {
        if (isBlank(workspaceId) || isBlank(runId)) {
            return transportRevert("invalid_request");
        }
        String url = baseUrl(workspaceId) + "/" + runId + "/revert";
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("acknowledgeConflicts", acknowledgeConflicts == null ? List.of() : acknowledgeConflicts);
        payload.put("acknowledgeHeadChange", acknowledgeHeadChange);
        try {
            HttpResponse<String> response = send("revert_execute", url, payload, REVERT_TIMEOUT);
            int status = response.statusCode();
            if (status / 100 != 2) {
                Map<String, Object> problem = parseBody(response.body());
                return new RevertResult(failureOutcome(status, problem), null, null, null, List.of(), 0L,
                        problem, errorReason(status, response.body()));
            }
            Map<String, Object> body = parseBody(response.body());
            return new RevertResult(Outcome.OK, stringValue(body, "runId"),
                    stringValue(body, "revertRef"), parseExecuteCounts(body.get("counts")),
                    parseExecuteEntries(body.get("entries")), longValue(body.get("durationMs")),
                    Map.of(), null);
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=runtime_checkpoint_revert_unreachable "
                            + "workspaceId={} runId={} error={}",
                    workspaceId, runId, e.getMessage());
            return transportRevert("unreachable");
        }
    }

    /** Reads one plain-text file out of the run's {@code base|end} tree (≤ 1 MiB). */
    public BlobResult checkpointBlob(String workspaceId, String runId, String ref, String path) {
        if (isBlank(workspaceId) || isBlank(runId) || isBlank(ref) || isBlank(path)) {
            return new BlobResult(Outcome.INVALID_REQUEST, path, ref, null, "invalid_request", Map.of());
        }
        String url = baseUrl(workspaceId) + "/" + runId + "/blob?path=" + encodeQuery(path)
                + "&ref=" + encodeQuery(ref);
        try {
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(url))
                    .header("Authorization", "Bearer " + serviceToken)
                    .header("Accept", "text/plain")
                    .GET()
                    .timeout(BLOB_TIMEOUT)
                    .build();
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
            int status = response.statusCode();
            if (status / 100 == 2) {
                return new BlobResult(Outcome.OK, path, ref, response.body(), null, Map.of());
            }
            Map<String, Object> problem = parseBody(response.body());
            return new BlobResult(failureOutcome(status, problem), path, ref, null,
                    errorReason(status, response.body()), problem);
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=runtime_checkpoint_blob_unreachable "
                            + "workspaceId={} runId={} error={}",
                    workspaceId, runId, e.getMessage());
            return new BlobResult(Outcome.TRANSPORT, path, ref, null, "unreachable", Map.of());
        }
    }

    /** Read-only user-repository status for the dual-diff "待提交" side. */
    public GitStatusResult workspaceGitStatus(String workspaceId) {
        if (isBlank(workspaceId)) {
            return new GitStatusResult(Outcome.INVALID_REQUEST, false, List.of(), "invalid_request");
        }
        String url = runtimeUrl + "/internal/v1/runtime/workspaces/" + workspaceId + "/git-status";
        try {
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(url))
                    .header("Authorization", "Bearer " + serviceToken)
                    .header("Accept", "application/json")
                    .GET()
                    .timeout(GIT_STATUS_TIMEOUT)
                    .build();
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
            int status = response.statusCode();
            if (status / 100 != 2) {
                Map<String, Object> problem = parseBody(response.body());
                return new GitStatusResult(failureOutcome(status, problem), false, List.of(),
                        errorReason(status, response.body()));
            }
            Map<String, Object> body = parseBody(response.body());
            return new GitStatusResult(Outcome.OK, Boolean.TRUE.equals(body.get("isRepository")),
                    parseGitStatusEntries(body.get("entries")), null);
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=runtime_git_status_unreachable workspaceId={} error={}",
                    workspaceId, e.getMessage());
            return new GitStatusResult(Outcome.TRANSPORT, false, List.of(), "unreachable");
        }
    }

    private HttpResponse<String> send(String operation, String url, Map<String, Object> payload,
                                      Duration timeout) throws Exception {        HttpRequest request = HttpRequest.newBuilder()
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

    private RevertPreview transportPreview(String reason) {
        return new RevertPreview(Outcome.TRANSPORT, null, null, null, List.of(), Map.of(), false,
                false, Map.of(), reason);
    }

    private RevertResult transportRevert(String reason) {
        return new RevertResult(Outcome.TRANSPORT, null, null, null, List.of(), 0L, Map.of(), reason);
    }

    /**
     * Maps a non-2xx revert/blob response to its typed outcome. Recognized 409
     * codes keep their frozen identity; every other status (including an
     * unrecognized 409 code) degrades to {@code TRANSPORT}.
     */
    private static Outcome failureOutcome(int status, Map<String, Object> problem) {
        if (status == 404) {
            return Outcome.NOT_FOUND;
        }
        if (status == 400) {
            return Outcome.INVALID_REQUEST;
        }
        if (status == 409) {
            String code = stringValue(problem, "code");
            if (code == null) {
                return Outcome.TRANSPORT;
            }
            return switch (code) {
                case "CHECKPOINT_NOT_SEALED" -> Outcome.NOT_SEALED;
                case "CHECKPOINT_LEASE_HELD" -> Outcome.LEASE_HELD;
                case "CHECKPOINT_HEAD_CHANGED" -> Outcome.HEAD_CHANGED;
                case "CHECKPOINT_CONFLICTS_UNACKNOWLEDGED" -> Outcome.CONFLICTS_UNACKNOWLEDGED;
                default -> Outcome.TRANSPORT;
            };
        }
        if (status == 413) {
            return Outcome.TOO_LARGE;
        }
        if (status == 503) {
            return Outcome.UNAVAILABLE;
        }
        return Outcome.TRANSPORT;
    }

    private static PreviewCounts parsePreviewCounts(Object raw) {
        if (!(raw instanceof Map<?, ?> map)) {
            return new PreviewCounts(0, 0, 0, 0);
        }
        return new PreviewCounts(intValue(map.get("restore")), intValue(map.get("delete")),
                intValue(map.get("skipConflicts")), intValue(map.get("noop")));
    }

    private static ExecuteCounts parseExecuteCounts(Object raw) {
        if (!(raw instanceof Map<?, ?> map)) {
            return new ExecuteCounts(0, 0, 0, 0, 0);
        }
        return new ExecuteCounts(intValue(map.get("restored")), intValue(map.get("deleted")),
                intValue(map.get("skippedConflict")), intValue(map.get("failed")),
                intValue(map.get("noop")));
    }

    private static List<PreviewEntry> parsePreviewEntries(Object raw) {
        if (!(raw instanceof List<?> list)) {
            return List.of();
        }
        List<PreviewEntry> entries = new ArrayList<>();
        for (Object item : list) {
            if (item instanceof Map<?, ?> map) {
                entries.add(new PreviewEntry(asString(map.get("path")), asString(map.get("oldPath")),
                        asString(map.get("action")), asString(map.get("conflictReason"))));
            }
        }
        return List.copyOf(entries);
    }

    private static List<ExecuteEntry> parseExecuteEntries(Object raw) {
        if (!(raw instanceof List<?> list)) {
            return List.of();
        }
        List<ExecuteEntry> entries = new ArrayList<>();
        for (Object item : list) {
            if (item instanceof Map<?, ?> map) {
                entries.add(new ExecuteEntry(asString(map.get("path")), asString(map.get("result")),
                        asString(map.get("reason"))));
            }
        }
        return List.copyOf(entries);
    }

    private static List<GitStatusEntry> parseGitStatusEntries(Object raw) {
        if (!(raw instanceof List<?> list)) {
            return List.of();
        }
        List<GitStatusEntry> entries = new ArrayList<>();
        for (Object item : list) {
            if (item instanceof Map<?, ?> map) {
                String status = asString(map.get("status"));
                String path = asString(map.get("path"));
                if (status != null || path != null) {
                    entries.add(new GitStatusEntry(status, path));
                }
            }
        }
        return List.copyOf(entries);
    }

    private static Map<String, Object> objectMap(Object raw) {
        return raw instanceof Map<?, ?> map ? toObjectMap(map) : Map.of();
    }

    private static int intValue(Object raw) {
        return raw instanceof Number number ? number.intValue() : 0;
    }

    private static long longValue(Object raw) {
        return raw instanceof Number number ? number.longValue() : 0L;
    }

    private static String encodeQuery(String value) {
        return java.net.URLEncoder.encode(value, java.nio.charset.StandardCharsets.UTF_8)
                .replace("+", "%20");
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
