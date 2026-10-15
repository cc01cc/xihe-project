package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.repository.RunTraceSourceRepository;
import com.cc01cc.p.xihe.cp.repository.RunTraceSourceRepository.Cursor;
import com.cc01cc.p.xihe.cp.repository.RunTraceSourceRepository.RunMetadata;
import com.cc01cc.p.xihe.cp.repository.RunTraceSourceRepository.RunIdentity;
import com.cc01cc.p.xihe.cp.repository.RunTraceSourceRepository.SourceRecord;
import com.cc01cc.p.xihe.cp.service.SessionService;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/** Read-only, authorization-first projection across existing durable Run sources. */
@Service
public class RunTraceReadService {

    private static final int DEFAULT_LIMIT = 100;
    private static final int MAX_LIMIT = 200;
    private static final Set<String> CURSOR_SOURCES = Set.of(
            "chat_run", "context_event", "provider_attempt", "mcp_invocation", "runtime_job");

    private final SessionService sessionService;
    private final RunTraceSourceRepository sourceRepository;

    public RunTraceReadService(SessionService sessionService,
                               RunTraceSourceRepository sourceRepository) {
        this.sessionService = sessionService;
        this.sourceRepository = sourceRepository;
    }

    @Transactional(readOnly = true)
    public TraceResponse getTrace(UUID runId, String userId, String workspaceId,
                                  String cursorValue, String limitValue) {
        if (userId == null || userId.isBlank() || workspaceId == null || workspaceId.isBlank()) {
            throw new CpApiException(HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED",
                    "Workspace context is required");
        }
        int limit = parseLimit(limitValue);
        CursorState cursorState = cursorValue == null ? null : decodeCursor(cursorValue, runId);
        Cursor cursor = cursorState == null ? null : cursorState.cursor();

        RunIdentity identity;
        try {
            identity = sourceRepository.readRunIdentity(runId).orElseThrow(() -> new CpApiException(
                    HttpStatus.NOT_FOUND, "RUN_NOT_FOUND", "Chat run not found"));
        } catch (CpApiException e) {
            throw e;
        } catch (RuntimeException e) {
            if (e instanceof CpApiException apiException) {
                throw apiException;
            }
            throw sourceUnavailable(e);
        }
        if (!userId.equals(identity.userId()) || !workspaceId.equals(identity.workspaceId())) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                    "Chat run does not belong to current user/workspace");
        }
        try {
            sessionService.requireCurrent(identity.sessionId(), userId, workspaceId);
        } catch (CpApiException e) {
            throw e;
        } catch (RuntimeException e) {
            if (e instanceof CpApiException apiException) {
                throw apiException;
            }
            throw sourceUnavailable(e);
        }

        RunMetadata run;
        try {
            run = sourceRepository.readRunMetadata(runId).orElseThrow(() -> new CpApiException(
                    HttpStatus.NOT_FOUND, "RUN_NOT_FOUND", "Chat run not found"));
        } catch (CpApiException e) {
            throw e;
        } catch (RuntimeException e) {
            throw sourceUnavailable(e);
        }

        Instant asOf = cursorState == null ? Instant.now() : cursorState.asOf();
        List<TraceSource> sources = new ArrayList<>();
        List<TraceItem> items = new ArrayList<>();
        boolean partial = false;
        boolean unknown = false;

        TraceItem runItem = runItem(run, asOf);
        TraceProvenance provenance = provenance(run);
        sources.add(new TraceSource("chat_run", "complete"));
        if (runItem != null) {
            items.add(runItem);
        }
        if (runItem != null && !runItem.mappingKnown()) {
            partial = true;
        }

        SourceLoad context = loadSource("context_event", () ->
                sourceRepository.readContextEvents(runId, asOf, cursor, limit + 1));
        sources.add(context.source());
        partial |= !"complete".equals(context.source().status());
        partial |= appendSourceItems(items, context.records(), run, "context_event");

        SourceLoad attempts = loadSource("provider_attempt", () ->
                sourceRepository.readProviderAttempts(runId, asOf, cursor, limit + 1));
        sources.add(attempts.source());
        partial |= !"complete".equals(attempts.source().status());
        partial |= appendSourceItems(items, attempts.records(), run, "provider_attempt");

        SourceLoad invocations = loadSource("mcp_invocation", () ->
                sourceRepository.readMcpInvocations(runId, asOf, cursor, limit + 1));
        sources.add(invocations.source());
        partial |= !"complete".equals(invocations.source().status());
        partial |= appendSourceItems(items, invocations.records(), run, "mcp_invocation");

        SourceLoad jobs = readRuntimeJobs(run, asOf, cursor, limit + 1);
        sources.add(jobs.source());
        partial |= "unavailable".equals(jobs.source().status());
        unknown |= "unknown".equals(jobs.source().status());
        partial |= appendSourceItems(items, jobs.records(), run, "runtime_job");

        items.sort(Comparator.comparing(TraceItem::occurredAt)
                .thenComparing(item -> item.event().source())
                .thenComparing(TraceItem::sourceRecordId));
        if (cursor != null) {
            items.removeIf(item -> compareKey(item, cursor) <= 0);
        }
        boolean hasMore = items.size() > limit;
        List<TraceItem> page = hasMore ? items.subList(0, limit) : items;
        String nextCursor = hasMore
                ? encodeCursor(runId, asOf, page.get(page.size() - 1)) : null;
        List<TraceEvent> events = page.stream().map(TraceItem::event).toList();
        String completeness = unknown ? "unknown" : partial ? "partial" : "complete";
        return new TraceResponse(runId.toString(), asOf.toString(), completeness,
                provenance, List.copyOf(sources), events, nextCursor);
    }

    private static int parseLimit(String value) {
        if (value == null || value.isBlank()) {
            return DEFAULT_LIMIT;
        }
        try {
            int parsed = Integer.parseInt(value);
            if (parsed < 1 || parsed > MAX_LIMIT) {
                throw new NumberFormatException("outside allowed range");
            }
            return parsed;
        } catch (NumberFormatException e) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "TRACE_LIMIT_INVALID",
                    "limit must be an integer between 1 and 200");
        }
    }

    private static CursorState decodeCursor(String encoded, UUID runId) {
        try {
            if (encoded.length() > 1024) {
                throw new IOException("cursor too long");
            }
            byte[] bytes = Base64.getUrlDecoder().decode(encoded);
            try (DataInputStream input = new DataInputStream(new ByteArrayInputStream(bytes))) {
                if (input.readUnsignedByte() != 1) {
                    throw new IOException("unsupported cursor version");
                }
                UUID cursorRunId = new UUID(input.readLong(), input.readLong());
                Instant asOf = Instant.ofEpochSecond(input.readLong(), input.readInt());
                Instant occurredAt = Instant.ofEpochSecond(input.readLong(), input.readInt());
                String source = input.readUTF();
                String sourceRecordId = input.readUTF();
                if (input.available() != 0 || !runId.equals(cursorRunId)
                        || !CURSOR_SOURCES.contains(source) || sourceRecordId.isBlank()
                        || occurredAt.isAfter(asOf) || asOf.isAfter(Instant.now().plusSeconds(60))) {
                    throw new IOException("cursor does not match request");
                }
                UUID.fromString(sourceRecordId);
                return new CursorState(new Cursor(occurredAt, source, sourceRecordId), asOf);
            }
        } catch (RuntimeException | IOException e) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "TRACE_CURSOR_INVALID",
                    "cursor is invalid or expired");
        }
    }

    private static String encodeCursor(UUID runId, Instant asOf, TraceItem item) {
        try {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream(96);
            try (DataOutputStream output = new DataOutputStream(bytes)) {
                output.writeByte(1);
                output.writeLong(runId.getMostSignificantBits());
                output.writeLong(runId.getLeastSignificantBits());
                output.writeLong(asOf.getEpochSecond());
                output.writeInt(asOf.getNano());
                output.writeLong(item.occurredAt().getEpochSecond());
                output.writeInt(item.occurredAt().getNano());
                output.writeUTF(item.event().source());
                output.writeUTF(item.sourceRecordId());
            }
            return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes.toByteArray());
        } catch (IOException e) {
            throw new IllegalStateException("Could not encode Run Trace cursor", e);
        }
    }

    private static int compareKey(TraceItem item, Cursor cursor) {
        int byTime = item.occurredAt().compareTo(cursor.occurredAt());
        if (byTime != 0) {
            return byTime;
        }
        int bySource = item.event().source().compareTo(cursor.source());
        if (bySource != 0) {
            return bySource;
        }
        return item.sourceRecordId().compareTo(cursor.sourceRecordId());
    }

    private static TraceItem runItem(RunMetadata run, Instant asOf) {
        Instant terminalAt = run.terminalAt();
        if (terminalAt == null || terminalAt.isAfter(asOf)) {
            return null;
        }
        String terminalOutcome = run.terminalOutcome();
        String status = switch (terminalOutcome == null ? "" : terminalOutcome) {
            case "success", "succeeded", "completed" -> "completed";
            case "error", "failed" -> "failed";
            case "cancelled" -> "cancelled";
            default -> "unknown";
        };
        Instant occurredAt = terminalAt;
        Map<String, String> references = Map.of();
        TraceEvent event = new TraceEvent("chat_run:" + run.id(), occurredAt.toString(),
                "chat_run", "run.lifecycle", status, null,
                safeIdentifier(run.provider()), safeIdentifier(run.model()),
                RunTraceSourceRepository.safeErrorCode(run.errorCode()), null, null, references);
        return new TraceItem(occurredAt, run.id().toString(), event,
                !"unknown".equals(status));
    }

    private boolean appendSourceItems(List<TraceItem> items, List<SourceRecord> records,
                                      RunMetadata run, String expectedSource) {
        boolean partial = false;
        for (SourceRecord record : records) {
            if (record == null || !expectedSource.equals(record.source())
                    || record.sourceRecordId() == null || record.occurredAt() == null) {
                partial = true;
                continue;
            }
            Map<String, String> references = references(record);
            Usage usage = record.inputTokens() == null && record.outputTokens() == null
                    && record.totalTokens() == null ? null
                    : new Usage(record.inputTokens(), record.outputTokens(), record.totalTokens());
            String projectedKind = record.mappingKnown() ? record.kind() : "run.lifecycle";
            String sourceStatus = normalizedStatus(projectedKind, record.status());
            boolean known = record.mappingKnown() && sourceStatus != null;
            String projectedStatus = known ? sourceStatus : "unknown";
            Long durationMs = "agent.tool".equals(projectedKind) && !record.pairingComplete()
                    ? null : record.durationMs();
            if (!record.pairingComplete()) {
                partial = true;
                if ("agent.tool".equals(projectedKind)
                        && ("succeeded".equals(projectedStatus) || "failed".equals(projectedStatus))) {
                    projectedStatus = "unknown";
                }
            }
            if (!known) {
                partial = true;
                projectedKind = "run.lifecycle";
                projectedStatus = "unknown";
            }
            String toolName = "agent.tool".equals(projectedKind)
                    || "mcp.invocation".equals(projectedKind) ? record.toolName() : null;
            String providerId = "provider.attempt".equals(projectedKind) ? safeIdentifier(run.provider()) : null;
            String modelId = "provider.attempt".equals(projectedKind) ? safeIdentifier(run.model()) : null;
            TraceEvent event = new TraceEvent(
                    record.source() + ":" + record.sourceRecordId(), record.occurredAt().toString(),
                    record.source(), projectedKind, projectedStatus,
                    durationMs, providerId, modelId,
                    RunTraceSourceRepository.safeErrorCode(record.errorCode()), usage,
                    toolName, references);
            items.add(new TraceItem(record.occurredAt(), record.sourceRecordId(), event, known));
        }
        return partial;
    }

    private static Map<String, String> references(SourceRecord record) {
        Map<String, String> references = new LinkedHashMap<>();
        switch (record.kind()) {
            case "input.admitted", "context.source", "usage.recorded" ->
                    references.put("contextEventId", record.sourceRecordId());
            case "agent.tool" -> {
                references.put("contextEventId", record.sourceRecordId());
                if (record.toolCallId() != null) {
                    references.put("toolCallId", record.toolCallId());
                }
            }
            case "provider.attempt" -> references.put("attemptId", record.sourceRecordId());
            case "mcp.invocation" -> {
                references.put("mcpInvocationId", record.sourceRecordId());
                if (record.toolCallId() != null) {
                    references.put("toolCallId", record.toolCallId());
                }
            }
            case "runtime.job" -> {
                if (record.runtimeJobId() != null) {
                    references.put("runtimeJobId", record.runtimeJobId());
                }
            }
            default -> {
                // Unknown mappings carry no caller-controlled references.
            }
        }
        return Map.copyOf(references);
    }

    private static String normalizedStatus(String kind, String status) {
        if (status == null) {
            return null;
        }
        return switch (kind) {
            case "context.source" -> Set.of("resolved", "missing", "rejected", "stale", "unknown").contains(status)
                    ? status : null;
            case "input.admitted" -> "admitted".equals(status) ? status : null;
            case "agent.tool" -> Set.of("started", "succeeded", "failed", "unknown").contains(status)
                    ? status : null;
            case "provider.attempt" -> Set.of("started", "succeeded", "failed", "unknown").contains(status)
                    ? status : null;
            case "mcp.invocation" -> Set.of("started", "succeeded", "failed", "pending",
                    "ambiguous", "unknown").contains(status)
                    ? status : null;
            case "runtime.job" -> Set.of("queued", "running", "completed", "failed",
                    "cancelled", "unknown").contains(status)
                    ? status : null;
            case "usage.recorded" -> Set.of("recorded", "estimated", "unknown").contains(status)
                    ? status : null;
            default -> null;
        };
    }

    private static String safeIdentifier(String value) {
        if (value == null || value.isBlank() || value.length() > 128
                || !value.matches("[A-Za-z0-9_.:/-]+")) {
            return null;
        }
        return value;
    }

    private static SourceLoad loadSource(String source, RecordReader reader) {
        try {
            return new SourceLoad(new TraceSource(source, "complete"), reader.read());
        } catch (RuntimeException e) {
            return new SourceLoad(new TraceSource(source, "unavailable"), List.of());
        }
    }

    private SourceLoad readRuntimeJobs(RunMetadata run, Instant asOf, Cursor cursor, int maxRows) {
        List<SourceRecord> records;
        try {
            records = sourceRepository.readRuntimeJobs(run.id(), asOf, cursor, maxRows);
        } catch (RuntimeException e) {
            return new SourceLoad(new TraceSource("runtime_job", "unavailable"), List.of());
        }
        Instant createdAt = run.createdAt();
        if (createdAt == null) {
            return new SourceLoad(new TraceSource("runtime_job", "unknown"), records);
        }
        Instant terminalAt = run.terminalAt();
        Instant windowEnd = terminalAt == null || terminalAt.isAfter(asOf) ? asOf : terminalAt;
        if (windowEnd.isBefore(createdAt)) {
            return new SourceLoad(new TraceSource("runtime_job", "unknown"), records);
        }
        try {
            boolean unlinkedCandidate = sourceRepository.hasUnlinkedRuntimeJobCandidate(
                    UUID.fromString(run.sessionId()), createdAt, windowEnd, asOf);
            String status = unlinkedCandidate ? "unknown" : "complete";
            return new SourceLoad(new TraceSource("runtime_job", status), records);
        } catch (RuntimeException e) {
            return new SourceLoad(new TraceSource("runtime_job", "unavailable"), records);
        }
    }

    private static TraceProvenance provenance(RunMetadata run) {
        String providerConnectionId = safeUuid(run.providerConnectionId());
        Long connectionRevision = nonNegative(run.connectionRevision());
        String apiTypeId = safeIdentifier(run.apiTypeId());
        Integer apiTypeVersion = positiveInt(run.apiTypeVersion());
        String rawContextTemplateLayer = run.contextTemplateLayer();
        String contextTemplateLayer = rawContextTemplateLayer != null
                && Set.of("instance", "user", "workspace").contains(rawContextTemplateLayer)
                ? rawContextTemplateLayer : null;
        String contextTemplateId = safeUuid(run.contextTemplateId());
        Integer contextTemplateVersion = positiveInt(run.contextTemplateVersion());

        int present = (providerConnectionId == null ? 0 : 1)
                + (connectionRevision == null ? 0 : 1)
                + (apiTypeId == null ? 0 : 1)
                + (apiTypeVersion == null ? 0 : 1)
                + (contextTemplateLayer == null ? 0 : 1)
                + (contextTemplateId == null ? 0 : 1)
                + (contextTemplateVersion == null ? 0 : 1);
        String status = present == 0 ? "unknown" : present == 7 ? "complete" : "partial";
        return new TraceProvenance(status, providerConnectionId, connectionRevision,
                apiTypeId, apiTypeVersion, contextTemplateLayer,
                contextTemplateId, contextTemplateVersion);
    }

    private static String safeUuid(String value) {
        if (value == null) {
            return null;
        }
        try {
            return UUID.fromString(value).toString();
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    private static Integer positiveInt(String value) {
        if (value == null || !value.matches("[0-9]{1,9}")) {
            return null;
        }
        try {
            int parsed = Integer.parseInt(value);
            return parsed > 0 ? parsed : null;
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private static Long nonNegative(Long value) {
        return value != null && value >= 0 ? value : null;
    }

    private static CpApiException sourceUnavailable(Throwable cause) {
        return new CpApiException(HttpStatus.SERVICE_UNAVAILABLE, "TRACE_SOURCE_UNAVAILABLE",
                "Run Trace source is unavailable", cause);
    }

    @FunctionalInterface
    private interface RecordReader {
        List<SourceRecord> read();
    }

    private record SourceLoad(TraceSource source, List<SourceRecord> records) {}

    private record CursorState(Cursor cursor, Instant asOf) {}

    private record TraceItem(Instant occurredAt, String sourceRecordId,
                             TraceEvent event, boolean mappingKnown) {}

    public record TraceResponse(String runId, String asOf, String completeness,
                                TraceProvenance provenance,
                                List<TraceSource> sources, List<TraceEvent> events,
                                String nextCursor) {}

    public record TraceProvenance(String status, String providerConnectionId,
                                  Long connectionRevision, String apiTypeId,
                                  Integer apiTypeVersion, String contextTemplateLayer,
                                  String contextTemplateId, Integer contextTemplateVersion) {}

    public record TraceSource(String source, String status) {}

    public record Usage(Long inputTokens, Long outputTokens, Long totalTokens) {}

    public record TraceEvent(String eventId, String occurredAt, String source, String kind,
                             String status, Long durationMs, String providerId, String modelId,
                             String errorCode, Usage usage, String toolName,
                             Map<String, String> references) {}
}
