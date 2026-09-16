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
 * PLAN-0338: client for the Runtime slice-checkpoint contract
 * ({@code /internal/v1/runtime/workspaces/{ws}/checkpoints...}).
 *
 * <p>Slice model: a Run is captured exactly once at its terminal transition
 * ({@code capture}); the Runtime either writes one slice ref
 * ({@code refs/xihe/slices/<epochMs>-<hash>}) or reports {@code noChange}. Revert
 * works on a slice ref ({@code revert/preview} + {@code revert}); there is no
 * mutation lease and no per-run base/end tree.</p>
 *
 * <p>Follows {@link RuntimeExecutionClient} conventions: JDK {@link HttpClient},
 * service bearer auth, bounded connect/read timeouts, and a typed error mapping
 * instead of exceptions — 503 maps to {@code UNAVAILABLE}, every other
 * unrecognized non-2xx / transport failure to {@code TRANSPORT}. Callers decide
 * the degradation policy; the terminal capture path must never turn an
 * unreachable Runtime into a Run-transition failure.</p>
 */
@Component
public class RuntimeCheckpointClient {

    private static final Logger logger = LoggerFactory.getLogger(RuntimeCheckpointClient.class);

    /** Cross-process connect bound (aligned with the other Runtime clients). */
    private static final Duration CONNECT_TIMEOUT = Duration.ofSeconds(3);
    /** Capture scans the change set at the Run terminal; P95 ≤ 8s plus margin. */
    private static final Duration CAPTURE_TIMEOUT = Duration.ofSeconds(12);
    /** Read-only revert dry-run re-diffs the target slice against the current tree. */
    private static final Duration PREVIEW_TIMEOUT = Duration.ofSeconds(12);
    /**
     * Revert budget: the Runtime restores per file (V17 budget ≤ 50ms/file, 100
     * files P95 ≤ 5s); 60s bounds even a few thousand changed paths without
     * letting the CP request hang.
     */
    private static final Duration REVERT_TIMEOUT = Duration.ofSeconds(60);
    /** Blob reads are capped at 1 MiB by the Runtime; a plain git read. */
    private static final Duration BLOB_TIMEOUT = Duration.ofSeconds(5);
    private static final Duration GIT_STATUS_TIMEOUT = Duration.ofSeconds(5);
    private static final Duration GC_TIMEOUT = Duration.ofSeconds(10);

    /**
     * Typed call outcome; never an exception at the call site. The 409 codes of the
     * revert surface map to their own values ({@code TYPE_CHANGES_UNACKNOWLEDGED},
     * {@code RESTORE_LOCKED}); unrecognized non-2xx responses stay {@code TRANSPORT}.
     * {@code NOT_SEALED} is retained for callers that still distinguish the legacy
     * Runtime code, the slice contract itself never emits it.
     */
    public enum Outcome {
        OK, NOT_FOUND, UNAVAILABLE, TRANSPORT,
        NOT_SEALED, TYPE_CHANGES_UNACKNOWLEDGED, RESTORE_LOCKED, INVALID_REQUEST, TOO_LARGE
    }

    /** One entry of a capture change set. */
    public record ChangedFile(String status, String path) {}

    /**
     * Slice capture result. {@code noChange=true} carries no sliceRef/commit/
     * capturedAt (the tree equals the chain tail); {@code state} is
     * {@code captured|abnormal-captured}, {@code predecessor} is the previous
     * slice ref when the workspace chain is not empty.
     */
    public record CaptureResult(Outcome outcome, String runId, boolean noChange, String sliceRef,
                                String commit, String capturedAt, String state,
                                List<ChangedFile> changedFiles, List<String> opaqueNestedRepos,
                                String predecessor, String reason) {}

    public record GcResult(Outcome outcome, Map<String, Object> counts, String reason) {}

    /** One preview entry ({@code action} = restore|delete; {@code state} = planned|typeConflict). */
    public record PreviewEntry(String path, String action, String state, String reason) {}

    public record PreviewCounts(int restore, int delete, int typeConflict) {}

    /**
     * `revert/preview` result. {@code problem} carries the parsed RFC 9457 body of a
     * failed call (empty on success) so callers can inspect fields such as
     * {@code paths}.
     */
    public record RevertPreview(Outcome outcome, String sliceRef, PreviewCounts counts,
                                List<PreviewEntry> entries, boolean truncated,
                                Map<String, Object> problem, String reason) {}

    /** One executed revert item ({@code outcome} = restored|deleted|failed). */
    public record ExecuteEntry(String path, String outcome, String reason) {}

    public record ExecuteCounts(int restored, int deleted, int failed) {}

    /**
     * `revert` execution result; {@code suspects} lists paths whose result was
     * detected as concurrent-moved during the restore (PLAN-0338).
     */
    public record RevertResult(Outcome outcome, String sliceRef, ExecuteCounts counts,
                               List<ExecuteEntry> entries, long durationMs, List<String> suspects,
                               Map<String, Object> problem, String reason) {}

    /** One plain-text blob of a slice tree; {@code problem} as in {@link RevertPreview}. */
    public record BlobResult(Outcome outcome, String path, String sliceRef, String content,
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

    /**
     * Captures the terminal Run into one slice (Runtime-side idempotent per run;
     * no-change answers {@code noChange=true} without writing a ref).
     */
    public CaptureResult capture(String workspaceId, String runId, String actor, String callId,
                                 boolean abnormal) {
        if (isBlank(workspaceId) || isBlank(runId)) {
            return transportCapture(runId, "invalid_request");
        }
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("runId", runId);
        payload.put("actor", actor);
        payload.put("callId", callId);
        payload.put("abnormal", abnormal);
        String url = baseUrl(workspaceId) + "/capture";
        try {
            HttpResponse<String> response = send("capture", url, payload, CAPTURE_TIMEOUT);
            int status = response.statusCode();
            if (status == 400) {
                return new CaptureResult(Outcome.INVALID_REQUEST, runId, false, null, null, null,
                        null, List.of(), List.of(), null, errorReason(status, response.body()));
            }
            if (status == 404) {
                return new CaptureResult(Outcome.NOT_FOUND, runId, false, null, null, null,
                        null, List.of(), List.of(), null, errorReason(status, response.body()));
            }
            if (status == 503) {
                return new CaptureResult(Outcome.UNAVAILABLE, runId, false, null, null, null,
                        null, List.of(), List.of(), null, errorReason(status, response.body()));
            }
            if (status / 100 != 2) {
                return new CaptureResult(Outcome.TRANSPORT, runId, false, null, null, null,
                        null, List.of(), List.of(), null, errorReason(status, response.body()));
            }
            Map<String, Object> body = parseBody(response.body());
            return new CaptureResult(Outcome.OK,
                    stringValue(body, "runId") == null ? runId : stringValue(body, "runId"),
                    Boolean.TRUE.equals(body.get("noChange")),
                    stringValue(body, "sliceRef"), stringValue(body, "commit"),
                    stringValue(body, "capturedAt"), stringValue(body, "state"),
                    parseChangedFiles(body.get("changedFiles")),
                    parseStringList(body.get("opaqueNestedRepos")),
                    stringValue(body, "predecessor"), null);
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=runtime_checkpoint_capture_unreachable workspaceId={} runId={} error={}",
                    workspaceId, runId, e.getMessage());
            return transportCapture(runId, "unreachable");
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
     * Read-only revert dry-run against one target slice ref. 404 means the slice
     * ref is gone (the caller flips the projection row to expired once).
     */
    public RevertPreview previewRevert(String workspaceId, String sliceRef) {
        if (isBlank(workspaceId) || isBlank(sliceRef)) {
            return transportPreview("invalid_request");
        }
        String url = baseUrl(workspaceId) + "/revert/preview";
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("sliceRef", sliceRef);
        try {
            HttpResponse<String> response = send("revert_preview", url, payload, PREVIEW_TIMEOUT);
            int status = response.statusCode();
            if (status / 100 != 2) {
                Map<String, Object> problem = parseBody(response.body());
                return new RevertPreview(failureOutcome(status, problem), null, null, List.of(),
                        false, problem, errorReason(status, response.body()));
            }
            Map<String, Object> body = parseBody(response.body());
            return new RevertPreview(Outcome.OK, stringValue(body, "sliceRef"),
                    parsePreviewCounts(body.get("counts")), parsePreviewEntries(body.get("entries")),
                    Boolean.TRUE.equals(body.get("truncated")), Map.of(), null);
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=runtime_checkpoint_revert_preview_unreachable "
                            + "workspaceId={} sliceRef={} error={}",
                    workspaceId, sliceRef, e.getMessage());
            return transportPreview("unreachable");
        }
    }

    /**
     * Executes the restore back to one target slice ref. The Runtime serializes
     * restores itself (a concurrent restore answers 409 {@code CHECKPOINT_RESTORE_LOCKED});
     * type changes must be acknowledged explicitly in {@code acknowledgeTypeChanges}.
     */
    public RevertResult revert(String workspaceId, String sliceRef,
                               List<String> acknowledgeTypeChanges) {
        if (isBlank(workspaceId) || isBlank(sliceRef)) {
            return transportRevert("invalid_request");
        }
        String url = baseUrl(workspaceId) + "/revert";
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("sliceRef", sliceRef);
        payload.put("acknowledgeTypeChanges",
                acknowledgeTypeChanges == null ? List.of() : acknowledgeTypeChanges);
        try {
            HttpResponse<String> response = send("revert_execute", url, payload, REVERT_TIMEOUT);
            int status = response.statusCode();
            if (status / 100 != 2) {
                Map<String, Object> problem = parseBody(response.body());
                return new RevertResult(failureOutcome(status, problem), null, null, List.of(), 0L,
                        List.of(), problem, errorReason(status, response.body()));
            }
            Map<String, Object> body = parseBody(response.body());
            return new RevertResult(Outcome.OK, stringValue(body, "sliceRef"),
                    parseExecuteCounts(body.get("counts")), parseExecuteEntries(body.get("entries")),
                    longValue(body.get("durationMs")), parseStringList(body.get("suspects")),
                    Map.of(), null);
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=runtime_checkpoint_revert_unreachable "
                            + "workspaceId={} sliceRef={} error={}",
                    workspaceId, sliceRef, e.getMessage());
            return transportRevert("unreachable");
        }
    }

    /** Reads one plain-text file out of a slice tree (≤ 1 MiB). */
    public BlobResult checkpointBlob(String workspaceId, String sliceRef, String path) {
        if (isBlank(workspaceId) || isBlank(sliceRef) || isBlank(path)) {
            return new BlobResult(Outcome.INVALID_REQUEST, path, sliceRef, null, "invalid_request", Map.of());
        }
        String url = baseUrl(workspaceId) + "/blob?sliceRef=" + encodeQuery(sliceRef)
                + "&path=" + encodeQuery(path);
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
                return new BlobResult(Outcome.OK, path, sliceRef, response.body(), null, Map.of());
            }
            Map<String, Object> problem = parseBody(response.body());
            return new BlobResult(failureOutcome(status, problem), path, sliceRef, null,
                    errorReason(status, response.body()), problem);
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=runtime_checkpoint_blob_unreachable "
                            + "workspaceId={} sliceRef={} error={}",
                    workspaceId, sliceRef, e.getMessage());
            return new BlobResult(Outcome.TRANSPORT, path, sliceRef, null, "unreachable", Map.of());
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

    private CaptureResult transportCapture(String runId, String reason) {
        return new CaptureResult(Outcome.TRANSPORT, runId, false, null, null, null, null,
                List.of(), List.of(), null, reason);
    }

    private RevertPreview transportPreview(String reason) {
        return new RevertPreview(Outcome.TRANSPORT, null, null, List.of(), false, Map.of(), reason);
    }

    private RevertResult transportRevert(String reason) {
        return new RevertResult(Outcome.TRANSPORT, null, null, List.of(), 0L, List.of(), Map.of(), reason);
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
                case "CHECKPOINT_TYPE_CHANGES_UNACKNOWLEDGED" -> Outcome.TYPE_CHANGES_UNACKNOWLEDGED;
                case "CHECKPOINT_RESTORE_LOCKED" -> Outcome.RESTORE_LOCKED;
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
            return new PreviewCounts(0, 0, 0);
        }
        return new PreviewCounts(intValue(map.get("restore")), intValue(map.get("delete")),
                intValue(map.get("typeConflict")));
    }

    private static ExecuteCounts parseExecuteCounts(Object raw) {
        if (!(raw instanceof Map<?, ?> map)) {
            return new ExecuteCounts(0, 0, 0);
        }
        return new ExecuteCounts(intValue(map.get("restored")), intValue(map.get("deleted")),
                intValue(map.get("failed")));
    }

    private static List<PreviewEntry> parsePreviewEntries(Object raw) {
        if (!(raw instanceof List<?> list)) {
            return List.of();
        }
        List<PreviewEntry> entries = new ArrayList<>();
        for (Object item : list) {
            if (item instanceof Map<?, ?> map) {
                entries.add(new PreviewEntry(asString(map.get("path")), asString(map.get("action")),
                        asString(map.get("state")), asString(map.get("reason"))));
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
                entries.add(new ExecuteEntry(asString(map.get("path")), asString(map.get("outcome")),
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

    private static List<String> parseStringList(Object raw) {
        if (!(raw instanceof List<?> list)) {
            return List.of();
        }
        List<String> values = new ArrayList<>();
        for (Object item : list) {
            String value = asString(item);
            if (value != null) {
                values.add(value);
            }
        }
        return List.copyOf(values);
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
