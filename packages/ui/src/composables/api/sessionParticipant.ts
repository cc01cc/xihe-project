/* task-1032：自 composables/api.ts 拆出的 sessionParticipant 段（逐字节搬运）。 */
import type {
    ParticipantReadCursor,
    ParticipantRespondPolicy as RespondPolicy,
    ParticipantWakePolicy as WakePolicy,
    SessionParticipantCapabilities,
    SessionParticipantListResponse,
    SessionParticipantView,
} from "../../types/participant";
import type {
    UserQuestionListResponse,
    UserQuestionState,
    UserQuestionView,
} from "../../types/userQuestion";
import { request } from "./_core";
export function parseParticipantCapabilities(
    record: Record<string, unknown>,
): SessionParticipantCapabilities {
    const raw = record.capabilities;
    if (!raw || typeof raw !== "object") {
        return { view: false, manage: false, mention: false, speakAs: false };
    }
    const caps = raw as Record<string, unknown>;
    const flag = (key: string): boolean => caps[key] === true;
    return {
        view: flag("view"),
        manage: flag("manage"),
        mention: flag("mention"),
        speakAs: flag("speakAs"),
    };
}
export const PARTICIPANT_CURSOR_ADVANCE_TO_LATEST = Number.MAX_SAFE_INTEGER;
export const USER_QUESTION_STATES: readonly UserQuestionState[] = [
    "pending",
    "answered",
    "expired",
    "cancelled",
];
export const USER_QUESTION_REQUIRED_STRINGS = [
    "id",
    "sessionId",
    "runId",
    "prompt",
    "createdAt",
] as const;
export function assertUserQuestionView(raw: unknown, operation: string): UserQuestionView {
    const reject = (reason: string): never => {
        throw new Error(`${operation}: ${reason}`);
    };
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return reject(
            `unexpected payload (received ${
                Array.isArray(raw) ? "a bare array" : raw === null ? "null" : typeof raw
            }; expected a question object)`,
        );
    }
    const record = raw as Record<string, unknown>;
    for (const field of USER_QUESTION_REQUIRED_STRINGS) {
        if (typeof record[field] !== "string" || record[field] === "") {
            return reject(
                `"${field}" is not a non-empty string (received ${
                    record[field] === null ? "null" : typeof record[field]
                })`,
            );
        }
    }
    if (!USER_QUESTION_STATES.includes(record.state as UserQuestionState)) {
        return reject(
            `"state" is not one of ${USER_QUESTION_STATES.join("/")} (received ${JSON.stringify(
                record.state,
            )})`,
        );
    }
    return record as unknown as UserQuestionView;
}

export const sessionParticipantApi = {
    async getSessionParticipants(sessionId: string): Promise<SessionParticipantListResponse> {
        const raw = await request<unknown>(
            `/sessions/${encodeURIComponent(sessionId)}/participants`,
        );
        if (Array.isArray(raw)) {
            throw new Error(
                `getSessionParticipants: unexpected payload (received a bare array of length ${raw.length}; ` +
                    `expected an object with a "participants" array)`,
            );
        }
        if (!raw || typeof raw !== "object") {
            throw new Error(
                `getSessionParticipants: unexpected payload (received ${raw === null ? "null" : typeof raw}; ` +
                    `expected an object with a "participants" array)`,
            );
        }
        const record = raw as Record<string, unknown>;
        if (!("participants" in record)) {
            const keys = Object.keys(record);
            throw new Error(
                `getSessionParticipants: unexpected payload (received keys: [${keys
                    .map((key) => JSON.stringify(key))
                    .join(", ")}]; expected a "participants" array)`,
            );
        }
        const participants = record.participants;
        if (!Array.isArray(participants)) {
            // 键在、但类型错：与"键缺失"分开报，便于一眼定位是契约变更还是网关返回异常。
            throw new Error(
                `getSessionParticipants: "participants" is not an array (received ${participants === null ? "null" : typeof participants})`,
            );
        }
        return {
            participants: participants as SessionParticipantView[],
            capabilities: parseParticipantCapabilities(record),
        };
    },
    async updateSessionParticipant(
        sessionId: string,
        participantId: string,
        body: { wakePolicy?: WakePolicy; respondPolicy?: RespondPolicy },
    ): Promise<void> {
        await request<void>(
            `/sessions/${encodeURIComponent(sessionId)}/participants/${encodeURIComponent(participantId)}`,
            {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            },
        );
    },
    async addSessionParticipant(
        sessionId: string,
        body: { principalKind: "AGENT" | "HUMAN"; principalId: string; role?: string },
        workspaceId?: string,
    ): Promise<void> {
        await request<void>(`/sessions/${encodeURIComponent(sessionId)}/participants`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...(workspaceId ? { "X-Workspace-Id": workspaceId } : {}),
            },
            body: JSON.stringify(body),
        });
    },
    async removeSessionParticipant(sessionId: string, participantId: string): Promise<void> {
        await request<void>(
            `/sessions/${encodeURIComponent(sessionId)}/participants/${encodeURIComponent(participantId)}`,
            { method: "DELETE" },
        );
    },
    async advanceParticipantCursor(
        sessionId: string,
        participantId: string,
        value: number,
    ): Promise<ParticipantReadCursor> {
        const raw = await request<unknown>(
            `/sessions/${encodeURIComponent(sessionId)}/participants/${encodeURIComponent(participantId)}/cursor`,
            {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ lastReadEventSeq: value }),
            },
        );
        if (!raw || typeof raw !== "object") {
            throw new Error(
                `advanceParticipantCursor: unexpected payload (received ${raw === null ? "null" : typeof raw}; ` +
                    `expected an object with lastReadEventSeq/mentionCount)`,
            );
        }
        const record = raw as Record<string, unknown>;
        const lastReadEventSeq = record.lastReadEventSeq,
            mentionCount = record.mentionCount;
        if (typeof lastReadEventSeq !== "number" || typeof mentionCount !== "number") {
            // 形状不符就抛错：用 0 冒充"没有未读"会把"契约破了"显示成"已读完"，是最坏的一种静默。
            throw new Error(
                `advanceParticipantCursor: unexpected payload (lastReadEventSeq=${String(lastReadEventSeq)}, ` +
                    `mentionCount=${String(mentionCount)}; expected both to be numbers)`,
            );
        }
        return {
            lastReadEventSeq,
            mentionCount,
            // 时间戳缺失就留空串（"未知"），不用当前时间伪造一个 CP 没给的时刻。
            updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "",
        };
    },
    async listUserQuestions(params?: {
        state?: UserQuestionState;
        limit?: number;
    }): Promise<UserQuestionListResponse> {
        const query = new URLSearchParams();
        if (params?.state) query.set("state", params.state);
        if (params?.limit !== undefined) query.set("limit", String(params.limit));
        const suffix = query.toString();
        const raw = await request<unknown>(`/user-questions${suffix ? `?${suffix}` : ""}`);
        // 严格信封：形状不符就抛错。用空列表冒充「没有待答问题」会把契约破损显示成业务空态。
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
            throw new Error(
                `listUserQuestions: unexpected payload (received ${
                    Array.isArray(raw) ? "a bare array" : raw === null ? "null" : typeof raw
                }; expected an object with "items" and "pendingCount")`,
            );
        }
        const record = raw as Record<string, unknown>;
        if (!Array.isArray(record.items)) {
            throw new Error(
                `listUserQuestions: "items" is not an array (received ${
                    record.items === null ? "null" : typeof record.items
                })`,
            );
        }
        if (typeof record.pendingCount !== "number") {
            throw new Error(
                `listUserQuestions: "pendingCount" is not a number (received ${typeof record.pendingCount}); ` +
                    `refusing to substitute 0 — that would render a broken contract as "nothing pending"`,
            );
        }
        return { items: record.items as UserQuestionView[], pendingCount: record.pendingCount };
    },
    async getUserQuestion(id: string): Promise<UserQuestionView> {
        const raw = await request<unknown>(`/user-questions/${encodeURIComponent(id)}`);
        return assertUserQuestionView(raw, "getUserQuestion");
    },
    async answerUserQuestion(id: string, answer: string): Promise<UserQuestionView> {
        const raw = await request<unknown>(`/user-questions/${encodeURIComponent(id)}/answer`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ answer }),
        });
        return assertUserQuestionView(raw, "answerUserQuestion");
    },
};
