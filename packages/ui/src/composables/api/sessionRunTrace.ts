/* task-1032：自 composables/api.ts 拆出的 sessionRunTrace 段（逐字节搬运）。 */
import type {
    ProviderRequestFingerprintDiffView,
    ProviderRequestFingerprintView,
    RunTraceCompleteness,
    RunTraceEvent,
    RunTraceEventKind,
    RunTraceEventStatus,
    RunTraceProvenance,
    RunTraceResponse,
    RunTraceSourceName,
    RunTraceSourceStatus,
    RunTraceUsage,
} from "../../types";
import { request } from "./_core";
import { asRecord, nullableCount, isNonEmptyString, isEnumValue } from "./_normalize";
export const runTraceSources = [
        "chat_run",
        "context_event",
        "provider_attempt",
        "mcp_invocation",
        "runtime_job",
    ] as const,
    runTraceSourceStatuses = ["complete", "unavailable", "not_applicable", "unknown"] as const,
    runTraceCompletenessValues = ["complete", "partial", "unknown"] as const,
    runTraceEventKinds = [
        "run.lifecycle",
        "input.admitted",
        "context.source",
        "agent.tool",
        "provider.attempt",
        "mcp.invocation",
        "runtime.job",
        "usage.recorded",
    ] as const,
    runTraceEventStatuses = [
        "created",
        "queued",
        "running",
        "awaiting_approval",
        "completed",
        "failed",
        "cancelled",
        "admitted",
        "resolved",
        "missing",
        "rejected",
        "stale",
        "started",
        "succeeded",
        "pending",
        "ambiguous",
        "recorded",
        "estimated",
        "unknown",
    ] as const,
    runTraceReferenceNames = [
        "contextEventId",
        "attemptId",
        "toolCallId",
        "mcpInvocationId",
        "runtimeJobId",
    ] as const;
export const runTraceStatusesByKind: Record<RunTraceEventKind, readonly RunTraceEventStatus[]> = {
    "run.lifecycle": [
        "created",
        "queued",
        "running",
        "awaiting_approval",
        "completed",
        "failed",
        "cancelled",
        "unknown",
    ],
    "context.source": ["resolved", "missing", "rejected", "stale", "unknown"],
    "input.admitted": ["admitted"],
    "agent.tool": ["started", "succeeded", "failed", "unknown"],
    "provider.attempt": ["started", "succeeded", "failed", "unknown"],
    "mcp.invocation": ["started", "succeeded", "failed", "pending", "ambiguous", "unknown"],
    "runtime.job": ["queued", "running", "completed", "failed", "cancelled", "unknown"],
    "usage.recorded": ["recorded", "estimated", "unknown"],
};
export function safeTraceIdentifier(value: unknown): string | null {
    return typeof value === "string" && value.length <= 128 && /^[A-Za-z0-9_.:-]+$/.test(value)
        ? value
        : null;
}
export function safeProviderModelId(value: unknown): string | null {
    return typeof value === "string" &&
        value.length > 0 &&
        value.length <= 128 &&
        /^[A-Za-z0-9_.:/-]+$/.test(value)
        ? value
        : null;
}
export function normalizeRunTraceUsage(value: unknown): RunTraceUsage | null {
    if (value === null || value === undefined) return null;
    const record = asRecord(value);
    if (!record) return null;
    return {
        inputTokens: nullableCount(record.inputTokens),
        outputTokens: nullableCount(record.outputTokens),
        totalTokens: nullableCount(record.totalTokens),
    };
}
export function normalizeRunTraceEvent(value: unknown): RunTraceEvent {
    const record = asRecord(value);
    const eventId = record ? safeTraceIdentifier(record.eventId) : null;
    if (
        !record ||
        eventId === null ||
        !isNonEmptyString(record.occurredAt) ||
        !isEnumValue(record.source, runTraceSources) ||
        !isEnumValue(record.kind, runTraceEventKinds)
    ) {
        throw new Error("Invalid run trace event");
    }

    const status = record.status;
    if (
        status !== null &&
        (!isEnumValue(status, runTraceEventStatuses) ||
            !runTraceStatusesByKind[record.kind].includes(status))
    ) {
        throw new Error("Invalid run trace status");
    }

    const rawReferences = asRecord(record.references),
        references: RunTraceEvent["references"] = {};
    if (rawReferences) {
        for (const name of runTraceReferenceNames) {
            const reference = safeTraceIdentifier(rawReferences[name]);
            if (reference !== null) references[name] = reference;
        }
    }

    const rawToolName = record.toolName,
        toolName =
            typeof rawToolName === "string" &&
            rawToolName.length <= 128 &&
            /^[A-Za-z0-9_.:-]+$/.test(rawToolName)
                ? rawToolName
                : null,
        rawErrorCode = record.errorCode,
        errorCode = safeTraceIdentifier(rawErrorCode);

    if (record.kind === "input.admitted") {
        const referenceNames = rawReferences ? Object.keys(rawReferences) : [];
        if (
            record.source !== "context_event" ||
            status !== "admitted" ||
            referenceNames.length !== 1 ||
            referenceNames[0] !== "contextEventId" ||
            references.contextEventId === undefined ||
            eventId !== `context_event:${references.contextEventId}` ||
            record.durationMs !== null ||
            record.toolName !== null ||
            record.providerId !== null ||
            record.modelId !== null ||
            record.errorCode !== null ||
            record.usage !== null
        ) {
            throw new Error("Invalid input admission event");
        }
    }

    return {
        eventId,
        occurredAt: record.occurredAt,
        source: record.source,
        kind: record.kind,
        status: status as RunTraceEventStatus | null,
        durationMs: nullableCount(record.durationMs),
        toolName,
        providerId: safeProviderModelId(record.providerId),
        modelId: safeProviderModelId(record.modelId),
        errorCode,
        usage: normalizeRunTraceUsage(record.usage),
        references,
    };
}
export function safeUuid(value: unknown): string | null {
    return typeof value === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
        ? value.toLowerCase()
        : null;
}
export function positiveCount(value: unknown): number | null {
    const parsed = nullableCount(value);
    return parsed !== null && parsed > 0 ? parsed : null;
}
export function normalizeRunTraceProvenance(value: unknown): RunTraceProvenance {
    const record = asRecord(value);
    if (!record || !isEnumValue(record.status, runTraceCompletenessValues)) {
        throw new Error("Invalid run trace provenance");
    }

    const providerConnectionId = safeUuid(record.providerConnectionId),
        connectionRevision = nullableCount(record.connectionRevision),
        apiTypeId = safeTraceIdentifier(record.apiTypeId),
        apiTypeVersion = positiveCount(record.apiTypeVersion),
        contextTemplateLayer = isEnumValue(record.contextTemplateLayer, [
            "instance",
            "user",
            "workspace",
        ] as const)
            ? record.contextTemplateLayer
            : null,
        contextTemplateId = safeUuid(record.contextTemplateId),
        contextTemplateVersion = positiveCount(record.contextTemplateVersion);

    const values = [
        providerConnectionId,
        connectionRevision,
        apiTypeId,
        apiTypeVersion,
        contextTemplateLayer,
        contextTemplateId,
        contextTemplateVersion,
    ];
    const present = values.filter((item) => item !== null).length,
        expectedStatus =
            present === 0 ? "unknown" : present === values.length ? "complete" : "partial";
    if (record.status !== expectedStatus) {
        throw new Error("Invalid run trace provenance status");
    }

    return {
        status: expectedStatus,
        providerConnectionId,
        connectionRevision,
        apiTypeId,
        apiTypeVersion,
        contextTemplateLayer,
        contextTemplateId,
        contextTemplateVersion,
    };
}
export function normalizeRunTraceResponse(value: unknown): RunTraceResponse {
    const record = asRecord(value);
    if (
        !record ||
        !isNonEmptyString(record.runId) ||
        !isNonEmptyString(record.asOf) ||
        !isEnumValue(record.completeness, runTraceCompletenessValues) ||
        !asRecord(record.provenance) ||
        !Array.isArray(record.sources) ||
        !Array.isArray(record.events) ||
        !(
            record.nextCursor === null ||
            (typeof record.nextCursor === "string" && record.nextCursor.length <= 1024)
        )
    ) {
        throw new Error("Invalid run trace response");
    }

    const sources = record.sources.map((value) => {
        const source = asRecord(value);
        if (
            !source ||
            !isEnumValue(source.source, runTraceSources) ||
            !isEnumValue(source.status, runTraceSourceStatuses)
        ) {
            throw new Error("Invalid run trace source");
        }
        return {
            source: source.source as RunTraceSourceName,
            status: source.status as RunTraceSourceStatus,
        };
    });

    return {
        runId: record.runId,
        asOf: record.asOf,
        completeness: record.completeness as RunTraceCompleteness,
        provenance: normalizeRunTraceProvenance(record.provenance),
        sources,
        events: record.events.map(normalizeRunTraceEvent),
        nextCursor: record.nextCursor,
    };
}

export const sessionRunTraceApi = {
    async getRunTrace(
        runId: string,
        options: { cursor?: string; limit?: number } = {},
    ): Promise<RunTraceResponse> {
        const params = new URLSearchParams();
        if (options.cursor !== undefined) params.set("cursor", options.cursor);
        if (options.limit !== undefined) params.set("limit", String(options.limit));
        const query = params.toString();
        const payload = await request<unknown>(
            `/chat/runs/${encodeURIComponent(runId)}/trace${query ? `?${query}` : ""}`,
        );
        return normalizeRunTraceResponse(payload);
    },
    getRunProviderRequestFingerprint(
        runId: string,
        options: { against?: string } = {},
    ): Promise<ProviderRequestFingerprintView | ProviderRequestFingerprintDiffView> {
        const params = new URLSearchParams();
        if (options.against) params.set("against", options.against);
        const query = params.toString();
        return request(
            `/chat/runs/${encodeURIComponent(runId)}/provider-request-fingerprint${query ? `?${query}` : ""}`,
        );
    },
};
