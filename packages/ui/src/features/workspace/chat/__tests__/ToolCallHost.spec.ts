import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import ToolCallHost from "../components/ToolCallHost.vue";
import ToolCallCard from "../components/ToolCallCard.vue";
import CommandToolCard from "../components/CommandToolCard.vue";
import PatchToolCard from "../components/PatchToolCard.vue";
import ReadToolCard from "../components/ReadToolCard.vue";
import type * as apiModule from "../../../../composables/api";

const { getJobOutput, cancelJob } = vi.hoisted(() => ({
    getJobOutput: vi.fn<typeof apiModule.api.getJobOutput>(),
    cancelJob: vi.fn<typeof apiModule.api.cancelJob>(),
}));
vi.mock("../../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof apiModule>();
    return {
        ...actual,
        api: { ...actual.api, getJobOutput, cancelJob },
    };
});
const i18n = createI18n({
    legacy: false,
    locale: "en",
    messages: {
        en: {
            chat: {
                toolStatus: {
                    pending: "Pending",
                    running: "Running",
                    completed: "Completed",
                    failed: "Failed",
                    cancelled: "Cancelled",
                    refused: "Refused",
                },
                toolRefusedTitle: "This call was refused and never ran",
                toolRefusedGeneric: "The tool call was refused; nothing was executed",
                toolRefusedCodeLabel: "Reason code:",
                toolRefusedHint: "Adjust the task or retry later",
                waitingOnChild: "Waiting for child task",
                derivedStateUnnamedChild: "Child session",
                derivedStateStatus: { running: "Running" },
                toolDiagnosticsTitle: "Diagnostics",
                toolDiagnosticsSummary: "{total} total, {shown} shown",
                toolDiagnosticsMore: "{count} more",
                toolRawOutput: "Raw output",
                approve: "Approve",
                reject: "Reject",
                toolCard: {
                    exitCode: "Exit code",
                    stdout: "stdout",
                    stderr: "stderr",
                    noOutput: "No output yet",
                    truncated: "Output truncated",
                    artifactRetained: "Raw output retained as artifact",
                    changedFiles: "{count} files",
                    patchesPending: "{count} patches pending",
                    diffPreview: "Diff preview",
                    diffNote: "Diff is classified by line prefix; full content in raw output",
                    totalLines: "Total lines",
                    binaryPreview: "Binary content (base64)",
                    previewOnly: "Preview limited to 200 lines / 2000 characters",
                    previewLines: "Preview {count} lines",
                    success: "Success",
                    failure: "Failure",
                },
            },
        },
    },
});

function makeToolCall(overrides: Record<string, unknown> = {}) {
    return {
        id: "tc-1",
        name: "read_file",
        arguments: JSON.stringify({ path: "/test.txt" }),
        status: "running",
        ...overrides,
    };
}

function mountHost(toolCall: Record<string, unknown>) {
    return mount(ToolCallHost, {
        props: { toolCall },
        global: { plugins: [i18n] },
    });
}

async function expand(wrapper: ReturnType<typeof mountHost>): Promise<void> {
    await wrapper.find('[data-testid="tool-card-toggle"]').trigger("click");
}

function routedTo(wrapper: ReturnType<typeof mountHost>, component: unknown): boolean {
    return wrapper.findComponent(component as never).exists();
}

function expectFallbackCard(wrapper: ReturnType<typeof mountHost>, label: string): void {
    const card = wrapper.find('[data-testid="tool-card"]');
    expect(card.exists(), label).toBe(true);
    expect(card.text().trim(), label).not.toBe("");
    expect(wrapper.find("[data-tool-card]").exists(), label).toBe(false);
    expect(routedTo(wrapper, ToolCallCard), label).toBe(true);
}

describe("ToolCallHost dedicated card mapping", () => {
    it("routes execute_command to CommandToolCard and renders structured stdout", async () => {
        const wrapper = mountHost(
            makeToolCall({
                name: "execute_command",
                arguments: JSON.stringify({ command: "printf hi", args: [] }),
                status: "completed",
                result: JSON.stringify({
                    stdout: "hi",
                    stderr: "",
                    exit_code: 0,
                    success: true,
                }),
            }),
        );

        expect(wrapper.find('[data-tool-card="command"]').exists()).toBe(true);
        expect(routedTo(wrapper, CommandToolCard)).toBe(true);
        expect(routedTo(wrapper, ToolCallCard)).toBe(false);
        await expand(wrapper);
        expect(wrapper.find('[data-testid="command-stdout"]').text()).toBe("hi");
        expect(wrapper.find('[data-testid="command-result"]').text()).toContain("0");
        expect(wrapper.find('[data-testid="tool-approve"]').exists()).toBe(false);
    });

    it("keeps command stdout and stderr in separate blocks", async () => {
        const wrapper = mountHost(
            makeToolCall({
                name: "execute_command",
                arguments: JSON.stringify({ command: "sh -c out-err" }),
                status: "completed",
                result: JSON.stringify({
                    stdout: "out",
                    stderr: "err",
                    exit_code: 1,
                    success: false,
                }),
            }),
        );

        await expand(wrapper);
        expect(wrapper.find('[data-testid="command-stdout"]').text()).toBe("out");
        expect(wrapper.find('[data-testid="command-stderr"]').text()).toBe("err");
        expect(wrapper.find('[data-testid="command-stderr"]').element).not.toBe(
            wrapper.find('[data-testid="command-stdout"]').element,
        );
    });

    it("renders command pending with shared approval actions", async () => {
        const wrapper = mountHost(
            makeToolCall({
                name: "execute_command",
                arguments: JSON.stringify({ command: "ls" }),
                status: "pending",
            }),
        );

        expect(wrapper.find('[data-tool-card="command"]').exists()).toBe(true);
        await expand(wrapper);
        expect(wrapper.find('[data-testid="tool-approve"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="tool-reject"]').exists()).toBe(true);
    });

    it("routes apply_patch and classifies only + lines with a muted background", async () => {
        const wrapper = mountHost(
            makeToolCall({
                name: "apply_patch",
                arguments: JSON.stringify({
                    patches: [{ path: "src/a.ts", expectedHash: "hash-a", hunks: [{}] }],
                }),
                status: "completed",
                result: JSON.stringify({
                    changed: ["src/a.ts"],
                    diff: "--- a/src/a.ts\n+++ b/src/a.ts\n+const a = 1;\n",
                }),
            }),
        );

        expect(wrapper.find('[data-tool-card="patch"]').exists()).toBe(true);
        expect(routedTo(wrapper, PatchToolCard)).toBe(true);
        await expand(wrapper);
        expect(wrapper.text()).toContain("src/a.ts");
        expect(wrapper.find('[data-testid="patch-diff"]').text()).toContain("+const a = 1;");
        const lines = wrapper
            .findAll('[data-testid="patch-diff"] > div')
            .map((line) => line.classes());
        expect(lines.some((classes) => classes.includes("bg-muted/20"))).toBe(true);
        expect(
            wrapper
                .findAll('[data-testid="patch-diff"] > div')
                .some((line) => line.classes().some((name) => name.includes("green"))),
        ).toBe(false);
    });

    it("routes read_file with plain-text result without JSON parsing", async () => {
        const wrapper = mountHost(
            makeToolCall({
                name: "read_file",
                status: "completed",
                result: "line one\nline two",
            }),
        );

        expect(wrapper.find('[data-tool-card="read"]').exists()).toBe(true);
        expect(routedTo(wrapper, ReadToolCard)).toBe(true);
        await expand(wrapper);
        expect(wrapper.find('[data-testid="read-content"]').text()).toContain("line one");
    });

    it("accepts an empty read_file result as a completed dedicated card", async () => {
        const wrapper = mountHost(
            makeToolCall({
                name: "read_file",
                status: "completed",
                result: "",
            }),
        );

        expect(wrapper.find('[data-tool-card="read"]').exists()).toBe(true);
        expect(routedTo(wrapper, ToolCallCard)).toBe(false);
        await expand(wrapper);
        expect(wrapper.text()).toContain("No output yet");
    });

    it("routes read_file_range and derives Lstart–end from offset/limit", async () => {
        const wrapper = mountHost(
            makeToolCall({
                name: "read_file_range",
                arguments: JSON.stringify({ path: "/range.txt", offset: 2, limit: 3 }),
                status: "completed",
                result: JSON.stringify({
                    content: "2 | a\n3 | b\n4 | c",
                    total_lines: 5,
                    is_binary: false,
                }),
            }),
        );

        expect(wrapper.find('[data-tool-card="read"]').exists()).toBe(true);
        expect(wrapper.text()).toContain("L2–4");
        await expand(wrapper);
        expect(wrapper.find('[data-testid="read-content"]').text()).toContain("2 | a");
    });

    it("renders read_file_range binary as a hint and base64 length, not the body", async () => {
        const body = "AAEC";
        const wrapper = mountHost(
            makeToolCall({
                name: "read_file_range",
                arguments: JSON.stringify({ path: "/bin.dat" }),
                status: "completed",
                result: JSON.stringify({
                    content: body,
                    total_lines: 0,
                    is_binary: true,
                }),
            }),
        );

        expect(wrapper.find('[data-tool-card="read"]').exists()).toBe(true);
        await expand(wrapper);
        expect(wrapper.text()).toContain("Binary content (base64)");
        expect(wrapper.text()).toContain("4 base64 chars");
        expect(wrapper.find('[data-testid="read-content"]').exists()).toBe(false);
    });
});

describe("ToolCallHost fallback gates", () => {
    it.each([
        [
            "job name start_background_process",
            { name: "start_background_process", arguments: "{}" },
        ],
        ["job name get_background_process", { name: "get_background_process", arguments: "{}" }],
        [
            "job name cancel_background_process",
            { name: "cancel_background_process", arguments: "{}" },
        ],
        [
            "jobSummary",
            {
                name: "read_file",
                jobSummary: {
                    jobId: "job-1",
                    workspaceId: "ws-1",
                    status: "running",
                },
            },
        ],
        ["refusalCode", { refusalCode: "DELEGATION_LIMIT_EXCEEDED" }],
        ["waitingOn", { waitingOn: { childRunId: "run-1", name: null, status: "running" } }],
        [
            "diagnostics",
            {
                diagnostics: {
                    items: [
                        {
                            file: "a.ts",
                            line: 1,
                            column: 1,
                            severity: "error",
                            kind: "type",
                            message: "boom",
                            confidence: "high",
                        },
                    ],
                    total: 1,
                    confidence: "high",
                },
            },
        ],
    ])("falls back to ToolCallCard for %s", (label, overrides) => {
        expectFallbackCard(mountHost(makeToolCall(overrides)), label);
    });

    it("does not fall back for an empty diagnostics bundle", () => {
        const wrapper = mountHost(
            makeToolCall({
                status: "completed",
                result: "text",
                diagnostics: { items: [], total: 0, confidence: "high" },
            }),
        );

        expect(wrapper.find('[data-tool-card="read"]').exists()).toBe(true);
    });

    it("falls back for dynamic MCP, supervisor, and near-miss names", () => {
        for (const name of [
            "",
            "unknown_tool",
            "server__read_file",
            "transfer_to_researcher",
            "read_file_v2",
            "exec_command",
        ]) {
            const wrapper = mountHost(makeToolCall({ name }));
            expectFallbackCard(wrapper, name || "(empty name)");
        }
    });

    it("falls back for unparsable command arguments", () => {
        const wrapper = mountHost(
            makeToolCall({
                name: "execute_command",
                arguments: "not-json",
                status: "completed",
                result: JSON.stringify({
                    stdout: "",
                    stderr: "",
                    exit_code: 0,
                    success: true,
                }),
            }),
        );

        expectFallbackCard(wrapper, "unparsable command arguments");
    });

    it("falls back for a non-array command args shape", () => {
        const wrapper = mountHost(
            makeToolCall({
                name: "execute_command",
                arguments: JSON.stringify({ command: "ls", args: 42 }),
                status: "completed",
                result: JSON.stringify({
                    stdout: "",
                    stderr: "",
                    exit_code: 0,
                    success: true,
                }),
            }),
        );

        expectFallbackCard(wrapper, "non-array command args");
    });

    it("falls back for a malformed command result shape", () => {
        const wrapper = mountHost(
            makeToolCall({
                name: "execute_command",
                arguments: JSON.stringify({ command: "ls" }),
                status: "completed",
                result: JSON.stringify({ stdout: "x" }),
            }),
        );

        expectFallbackCard(wrapper, "malformed command result");
    });

    it("falls back for a terminal result-less call without error", () => {
        const wrapper = mountHost(
            makeToolCall({
                name: "read_file",
                status: "completed",
            }),
        );

        expectFallbackCard(wrapper, "terminal result-less call");
    });

    it("renders a dedicated card when error is present and the result is absent", async () => {
        const wrapper = mountHost(
            makeToolCall({
                name: "execute_command",
                arguments: JSON.stringify({ command: "ls" }),
                status: "failed",
                error: "exit status 2",
            }),
        );

        expect(wrapper.find('[data-tool-card="command"]').exists()).toBe(true);
        await expand(wrapper);
        expect(wrapper.find('[data-testid="command-error"]').text()).toContain("exit status 2");
    });

    it("falls back for malformed read_file_range result shape", () => {
        const wrapper = mountHost(
            makeToolCall({
                name: "read_file_range",
                arguments: JSON.stringify({ path: "/x" }),
                status: "completed",
                result: "{}",
            }),
        );

        expectFallbackCard(wrapper, "malformed read_file_range result");
    });

    it("falls back for a non-string read_file result", () => {
        const wrapper = mountHost(
            makeToolCall({
                name: "read_file",
                status: "completed",
                result: 42,
            }),
        );

        expectFallbackCard(wrapper, "non-string read_file result");
    });
});

describe("ToolCallHost shared contract", () => {
    it("forwards approve/reject from a dedicated card to the host listener", async () => {
        const wrapper = mountHost(
            makeToolCall({
                name: "execute_command",
                arguments: JSON.stringify({ command: "ls" }),
                status: "pending",
            }),
        );

        await expand(wrapper);
        await wrapper.find('[data-testid="tool-approve"]').trigger("click");
        expect(wrapper.emitted("approve")?.[0]).toEqual(["tc-1"]);

        await wrapper.find('[data-testid="tool-reject"]').trigger("click");
        expect(wrapper.emitted("reject")?.[0]).toEqual(["tc-1"]);
    });

    it("keeps actor on the shared ProcessRow shell", () => {
        const wrapper = mountHost(
            makeToolCall({
                name: "read_file",
                status: "completed",
                result: "x",
                actor: undefined,
            }),
        );

        expect(wrapper.find('[data-tool-card="read"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="tool-card"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="tool-card-toggle"]').exists()).toBe(true);
    });
});
