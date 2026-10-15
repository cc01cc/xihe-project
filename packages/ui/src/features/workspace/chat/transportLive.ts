import { reactive } from "vue";
import { logger } from "../../../lib/logger";

/**
 * PLAN-0508 T4.1: live bounded transport facts parsed from the single chat SSE
 * channel (`transport_progress` / `transport_attempt`). CP durable state stays
 * authoritative; this registry only mirrors the latest observed facts so the
 * Monitor can render in-flight attempts between refetches. It never opens a
 * second SSE connection.
 */

export const TRANSPORT_STAGES = [
    "attempt_started",
    "first_chunk",
    "streaming",
    "attempt_finished",
] as const;

export type TransportStage = (typeof TRANSPORT_STAGES)[number];

export interface LiveTransportAttempt {
    attemptId: string;
    runId: string;
    seq: number;
    /** Highest observed stage; out-of-order or duplicate updates never regress it. */
    stage: TransportStage | null;
    /** `elapsedMs` of the last accepted observation (static, never extrapolated). */
    stageElapsedMs: number | null;
    status: "running" | "terminal";
    outcome: string | null;
    errorCode: string | number | null;
    durationMs: number | null;
    firstChunkMs: number | null;
    chunkCount: number | null;
    /** v1 wire bytes are fixed null/unknown; kept for shape parity with durable rows. */
    uploadBytes: number | null;
    downloadBytes: number | null;
    startedAt: string;
    endedAt: string | null;
}

type LiveRunState = Record<string, LiveTransportAttempt>;
type LiveSessionState = Record<string, LiveRunState>;

/** Bounded registry: long tool loops can dispatch many attempts per run. */
const MAX_ATTEMPTS_PER_SESSION = 60;

const sessions = reactive<Record<string, LiveSessionState>>({});

function stageRank(stage: TransportStage): number {
    return TRANSPORT_STAGES.indexOf(stage) + 1;
}

function asStage(value: unknown): TransportStage | null {
    return typeof value === "string" && (TRANSPORT_STAGES as readonly string[]).includes(value)
        ? (value as TransportStage)
        : null;
}

function asNonNegativeInt(value: unknown): number | null {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function asErrorCode(value: unknown): string | number | null {
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number" && Number.isInteger(value)) return value;
    return null;
}

interface AttemptIdentity {
    runId: string;
    attemptId: string;
    seq: number;
    startedAt: string;
}

function readIdentity(data: Record<string, unknown>): AttemptIdentity | null {
    const { runId, attemptId, seq, startedAt } = data;
    if (typeof runId !== "string" || runId.length === 0) return null;
    if (typeof attemptId !== "string" || attemptId.length === 0) return null;
    if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1) return null;
    if (typeof startedAt !== "string" || startedAt.length === 0) return null;
    return { runId, attemptId, seq, startedAt };
}

function ensureAttempt(sessionId: string, identity: AttemptIdentity): LiveTransportAttempt {
    const session = (sessions[sessionId] ??= {});
    const run = (session[identity.runId] ??= {});
    let attempt = run[identity.attemptId];
    if (!attempt) {
        attempt = {
            attemptId: identity.attemptId,
            runId: identity.runId,
            seq: identity.seq,
            stage: null,
            stageElapsedMs: null,
            status: "running",
            outcome: null,
            errorCode: null,
            durationMs: null,
            firstChunkMs: null,
            chunkCount: null,
            uploadBytes: null,
            downloadBytes: null,
            startedAt: identity.startedAt,
            endedAt: null,
        };
        run[identity.attemptId] = attempt;
    }
    return attempt;
}

function pruneSession(sessionId: string): void {
    const session = sessions[sessionId];
    if (!session) return;
    const ids: Array<{ runId: string; attemptId: string }> = [];
    for (const runId of Object.keys(session)) {
        for (const attemptId of Object.keys(session[runId])) ids.push({ runId, attemptId });
    }
    for (const { runId, attemptId } of ids.slice(0, ids.length - MAX_ATTEMPTS_PER_SESSION)) {
        delete session[runId][attemptId];
        if (Object.keys(session[runId]).length === 0) delete session[runId];
    }
}

/**
 * Mirror one `transport_progress` payload; returns whether it changed state.
 * Malformed payloads and out-of-order/duplicate stages are dropped.
 */
export function applyTransportProgress(sessionId: string, data: Record<string, unknown>): boolean {
    const identity = readIdentity(data);
    const stage = asStage(data.stage);
    const elapsedMs = asNonNegativeInt(data.elapsedMs);
    if (!identity || !stage || elapsedMs === null) {
        logger.warn("Dropped malformed transport_progress payload");
        return false;
    }
    const attempt = ensureAttempt(sessionId, identity);
    if (attempt.status === "terminal") return false;
    if (attempt.stage !== null && stageRank(stage) <= stageRank(attempt.stage)) return false;
    attempt.stage = stage;
    attempt.stageElapsedMs = elapsedMs;
    pruneSession(sessionId);
    return true;
}

/**
 * Mirror one `transport_attempt` terminal payload; the first terminal wins and
 * any later progress for the attempt is ignored.
 */
export function applyTransportAttempt(sessionId: string, data: Record<string, unknown>): boolean {
    const identity = readIdentity(data);
    const outcome =
        typeof data.outcome === "string" && data.outcome.length > 0 ? data.outcome : null;
    if (!identity || outcome === null) {
        logger.warn("Dropped malformed transport_attempt payload");
        return false;
    }
    const attempt = ensureAttempt(sessionId, identity);
    if (attempt.status === "terminal") return false;
    attempt.status = "terminal";
    attempt.outcome = outcome;
    attempt.errorCode = asErrorCode(data.errorCode);
    attempt.durationMs = asNonNegativeInt(data.durationMs);
    attempt.firstChunkMs = asNonNegativeInt(data.firstChunkMs);
    attempt.chunkCount = asNonNegativeInt(data.chunkCount);
    attempt.uploadBytes = asNonNegativeInt(data.uploadBytes);
    attempt.downloadBytes = asNonNegativeInt(data.downloadBytes);
    attempt.endedAt =
        typeof data.endedAt === "string" && data.endedAt.length > 0 ? data.endedAt : null;
    if (attempt.stage === null) attempt.stage = "attempt_finished";
    pruneSession(sessionId);
    return true;
}

/** Live attempts of one run in `seq` order (empty when none were observed). */
export function liveRunAttempts(sessionId: string, runId: string): LiveTransportAttempt[] {
    const run = sessions[sessionId]?.[runId];
    if (!run) return [];
    return Object.values(run).sort((left, right) => left.seq - right.seq);
}

/** Test/reset helper: drops every live session registry. */
export function clearTransportLive(): void {
    for (const sessionId of Object.keys(sessions)) delete sessions[sessionId];
}
