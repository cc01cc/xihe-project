import { describe, expect, it } from "vitest";

import type { JobSummary } from "../../../../types";
import { mergeHistoryToolCalls } from "../components/jobSummaryToolCalls.ts";

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
});
