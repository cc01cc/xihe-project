import { describe, expect, it } from "vitest";

import type { JobSummary, MessagePart } from "../../../../types";
import { mergeHistoryReasoning, mergeHistoryToolCalls } from "../components/jobSummaryToolCalls.ts";

const job: JobSummary = {
    jobId: "job-1",
    workspaceId: "ws-1",
    toolCallId: "call-1",
    toolName: "execute_command",
    status: "running",
    startedAt: "2026-10-28T10:00:00Z",
    endedAt: null,
};

describe("mergeHistoryToolCalls", () => {
    it("keeps the existing jobSummary projection when no snapshot exists", () => {
        const cards = mergeHistoryToolCalls(undefined, [job]);
        expect(cards).toHaveLength(1);
        expect(cards?.[0]).toMatchObject({
            id: "call-1",
            name: "execute_command",
            status: "running",
            jobSummary: job,
        });
    });

    it("merges a persisted tool call with its job summary by id", () => {
        const cards = mergeHistoryToolCalls(
            [
                {
                    id: "call-1",
                    name: "execute_command",
                    arguments: '{"command":"cargo test"}',
                    status: "completed",
                    startedAt: "2026-10-28T09:59:59Z",
                    completedAt: "2026-10-28T10:00:02Z",
                    result: "placeholder",
                },
            ],
            [job],
        );
        expect(cards).toHaveLength(1);
        expect(cards?.[0]).toMatchObject({
            id: "call-1",
            arguments: '{"command":"cargo test"}',
            status: "running",
            startedAt: "2026-10-28T09:59:59Z",
            completedAt: "2026-10-28T10:00:02Z",
            result: "placeholder",
            jobSummary: job,
        });
    });

    it("appends job cards that have no persisted call", () => {
        const cards = mergeHistoryToolCalls(
            [
                {
                    id: "call-2",
                    name: "read_file",
                    arguments: "{}",
                    status: "completed",
                    startedAt: "2026-10-28T10:00:00Z",
                },
            ],
            [job],
        );
        expect(cards?.map((card) => card.id)).toEqual(["call-2", "call-1"]);
    });

    it("returns undefined when neither source has cards", () => {
        expect(mergeHistoryToolCalls(undefined, undefined)).toBeUndefined();
        expect(mergeHistoryToolCalls([], [])).toBeUndefined();
    });

    it("carries the PLAN-0649 refusal code from the persisted snapshot", () => {
        // Refusals are judged by `refusalCode`, not by `status` — the durable status
        // of a non-CP tool error can still be `completed`.
        const cards = mergeHistoryToolCalls(
            [
                {
                    id: "call-9",
                    name: "spawn_agent",
                    arguments: "{}",
                    status: "completed",
                    startedAt: "2026-11-03T10:00:00Z",
                    refusalCode: "DELEGATION_LIMIT_EXCEEDED",
                },
            ],
            undefined,
        );

        expect(cards?.[0]).toMatchObject({
            id: "call-9",
            status: "completed",
            refusalCode: "DELEGATION_LIMIT_EXCEEDED",
        });
    });
});

/**
 * PLAN-0761 (BL-555): the history → reasoning-part assembly is the piece that makes a
 * refresh keep the thinking block. Absent reasoning must add nothing at all, so the
 * UI keeps its single "no reasoning ⇒ no thinking block" path.
 */
describe("mergeHistoryReasoning", () => {
    it("prepends the persisted thinking block ahead of the parsed text parts", () => {
        const parts: MessagePart[] = [{ type: "text", content: "answer" }];
        expect(mergeHistoryReasoning(parts, "思考过程")).toEqual([
            { type: "reasoning", content: "思考过程" },
            { type: "text", content: "answer" },
        ]);
    });

    it("works on an empty part list (a reasoning-only turn)", () => {
        expect(mergeHistoryReasoning([], "only thinking")).toEqual([
            { type: "reasoning", content: "only thinking" },
        ]);
    });

    it("adds nothing for a missing, blank or whitespace-only field", () => {
        const parts: MessagePart[] = [{ type: "text", content: "answer" }];
        expect(mergeHistoryReasoning(parts, undefined)).toBe(parts);
        expect(mergeHistoryReasoning(parts, null)).toBe(parts);
        expect(mergeHistoryReasoning(parts, "")).toBe(parts);
        expect(mergeHistoryReasoning(parts, "   ")).toBe(parts);
    });
});
