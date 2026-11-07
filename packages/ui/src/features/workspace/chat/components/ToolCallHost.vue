<script setup lang="ts">
/**
 * PLAN-0688: the single dispatcher between the dedicated command/patch/read
 * cards and the generic ToolCallCard fallback.
 *
 * Routing is short-circuiting and exact-match only:
 * job surface -> reserved states -> unknown name -> argument shape -> result
 * shape -> dedicated card. Any shape mismatch falls back to ToolCallCard so the
 * raw body is still observable.
 */
import { computed } from "vue";
import type { ToolCall } from "../../../../types";
import type { ProcessRowActor } from "./ProcessRow.vue";
import CommandToolCard, {
    type CommandCardView,
    type CommandResultView,
} from "./CommandToolCard.vue";
import PatchToolCard, {
    type PatchArgView,
    type PatchCardView,
    type PatchResultView,
} from "./PatchToolCard.vue";
import ReadToolCard, { type ReadCardView } from "./ReadToolCard.vue";
import ToolCallCard from "./ToolCallCard.vue";

const props = defineProps<{ toolCall: ToolCall; actor?: ProcessRowActor }>();
const emit = defineEmits<{ approve: [id: string]; reject: [id: string] }>();

const JOB_TOOL_NAMES = [
    "start_background_process",
    "get_background_process",
    "cancel_background_process",
];

type Route = "command" | "patch" | "read" | "fallback";

function parseJsonObject(raw: unknown): Record<string, unknown> | null {
    if (typeof raw !== "string") return null;
    try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
        return parsed as Record<string, unknown>;
    } catch {
        // Invalid JSON is a shape failure, not a render failure: fall back to ToolCallCard.
        return null;
    }
}

function resultMissingAllowed(toolCall: ToolCall): boolean {
    return (
        toolCall.status === "running" ||
        toolCall.status === "pending" ||
        Boolean(toolCall.error?.trim())
    );
}

function hasJobSurface(toolCall: ToolCall): boolean {
    return JOB_TOOL_NAMES.includes(toolCall.name) || toolCall.jobSummary != null;
}

function hasReservedState(toolCall: ToolCall): boolean {
    const refusalCode =
        typeof toolCall.refusalCode === "string" && toolCall.refusalCode.trim() !== "";
    const waitingOn = toolCall.waitingOn != null;
    const diagnostics = (toolCall.diagnostics?.items?.length ?? 0) > 0;
    return refusalCode || waitingOn || diagnostics;
}

function normalizeCommandArgs(value: unknown): string[] | null {
    if (value === undefined || value === null) return [];
    if (Array.isArray(value)) return value.map((item) => String(item));
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed === "[]" || trimmed === "None" || trimmed === "null") return [];
    if (trimmed.startsWith("[")) {
        try {
            const parsed: unknown = JSON.parse(trimmed);
            return Array.isArray(parsed) ? parsed.map((item) => String(item)) : null;
        } catch {
            // A bracket-looking string that is not JSON is not an argv array.
            return null;
        }
    }
    return [value];
}

function toCommandResult(raw: Record<string, unknown>): CommandResultView | null {
    if (
        typeof raw.stdout !== "string" ||
        typeof raw.stderr !== "string" ||
        typeof raw.exit_code !== "number" ||
        typeof raw.success !== "boolean"
    ) {
        return null;
    }
    if (raw.artifact_id !== undefined && typeof raw.artifact_id !== "string") return null;
    if (raw.stdout_truncated !== undefined && typeof raw.stdout_truncated !== "boolean")
        return null;
    if (raw.stderr_truncated !== undefined && typeof raw.stderr_truncated !== "boolean")
        return null;

    const result: CommandResultView = {
        stdout: raw.stdout,
        stderr: raw.stderr,
        exit_code: raw.exit_code,
        success: raw.success,
    };
    if (typeof raw.artifact_id === "string") result.artifact_id = raw.artifact_id;
    if (typeof raw.stdout_truncated === "boolean") {
        result.stdout_truncated = raw.stdout_truncated;
    }
    if (typeof raw.stderr_truncated === "boolean") {
        result.stderr_truncated = raw.stderr_truncated;
    }
    return result;
}

function toPatchResult(raw: Record<string, unknown>): PatchResultView | null {
    if (
        !Array.isArray(raw.changed) ||
        !raw.changed.every((item): item is string => typeof item === "string") ||
        typeof raw.diff !== "string"
    ) {
        return null;
    }
    let newHashes: Record<string, string> | undefined;
    if (raw.newHashes !== undefined) {
        if (
            typeof raw.newHashes !== "object" ||
            raw.newHashes === null ||
            Array.isArray(raw.newHashes)
        ) {
            return null;
        }
        const entries = Object.entries(raw.newHashes);
        if (!entries.every((entry): entry is [string, string] => typeof entry[1] === "string")) {
            return null;
        }
        newHashes = Object.fromEntries(entries) as Record<string, string>;
    }
    const result: PatchResultView = { changed: raw.changed, diff: raw.diff };
    if (newHashes) result.newHashes = newHashes;
    return result;
}

function parseCommandView(toolCall: ToolCall): CommandCardView | null {
    const args = parseJsonObject(toolCall.arguments);
    if (!args || typeof args.command !== "string") return null;
    const normalizedArgs = normalizeCommandArgs(args.args);
    if (normalizedArgs === null) return null;

    let result: CommandResultView | null = null;
    if (toolCall.result !== undefined && toolCall.result !== null) {
        const raw = parseJsonObject(toolCall.result);
        if (!raw) return null;
        result = toCommandResult(raw);
        if (!result) return null;
    } else if (!resultMissingAllowed(toolCall)) {
        return null;
    }
    return { command: args.command, args: normalizedArgs, result };
}

function parsePatchView(toolCall: ToolCall): PatchCardView | null {
    const args = parseJsonObject(toolCall.arguments);
    if (!args) return null;
    const rawPatches = args.patches;
    if (!Array.isArray(rawPatches) || rawPatches.length === 0) return null;

    const patches: PatchArgView[] = [];
    for (const rawPatch of rawPatches) {
        if (typeof rawPatch !== "object" || rawPatch === null || Array.isArray(rawPatch)) {
            return null;
        }
        const patch = rawPatch as Record<string, unknown>;
        if (
            typeof patch.path !== "string" ||
            typeof patch.expectedHash !== "string" ||
            !Array.isArray(patch.hunks)
        ) {
            return null;
        }
        patches.push({
            path: patch.path,
            expectedHash: patch.expectedHash,
            hunks: patch.hunks,
        });
    }

    let result: PatchResultView | null = null;
    if (toolCall.result !== undefined && toolCall.result !== null) {
        const raw = parseJsonObject(toolCall.result);
        if (!raw) return null;
        result = toPatchResult(raw);
        if (!result) return null;
    } else if (!resultMissingAllowed(toolCall)) {
        return null;
    }
    return { patches, result };
}

function parseReadView(toolCall: ToolCall): ReadCardView | null {
    const args = parseJsonObject(toolCall.arguments);
    if (!args || typeof args.path !== "string") return null;

    if (toolCall.name === "read_file") {
        let content = "";
        let hasResult = false;
        if (toolCall.result !== undefined && toolCall.result !== null) {
            if (typeof toolCall.result !== "string") return null;
            content = toolCall.result;
            hasResult = true;
        } else if (!resultMissingAllowed(toolCall)) {
            return null;
        }
        return {
            mode: "full",
            path: args.path,
            content,
            totalLines: null,
            isBinary: false,
            offset: null,
            limit: null,
            hasResult,
        };
    }

    if (toolCall.name !== "read_file_range") return null;

    let offset: number | null = null;
    let limit: number | null = null;
    if (args.offset !== undefined) {
        if (typeof args.offset !== "number" || !Number.isFinite(args.offset)) return null;
        offset = args.offset;
    }
    if (args.limit !== undefined) {
        if (typeof args.limit !== "number" || !Number.isFinite(args.limit)) return null;
        limit = args.limit;
    }

    let content = "";
    let totalLines: number | null = null;
    let isBinary = false;
    let hasResult = false;
    if (toolCall.result !== undefined && toolCall.result !== null) {
        if (typeof toolCall.result !== "string") return null;
        const raw = parseJsonObject(toolCall.result);
        if (
            !raw ||
            typeof raw.content !== "string" ||
            typeof raw.total_lines !== "number" ||
            typeof raw.is_binary !== "boolean"
        ) {
            return null;
        }
        content = raw.content;
        totalLines = raw.total_lines;
        isBinary = raw.is_binary;
        hasResult = true;
    } else if (!resultMissingAllowed(toolCall)) {
        return null;
    }
    return {
        mode: "range",
        path: args.path,
        content,
        totalLines,
        isBinary,
        offset,
        limit,
        hasResult,
    };
}

const commandView = computed(() => parseCommandView(props.toolCall));
const patchView = computed(() => parsePatchView(props.toolCall));
const readView = computed(() => parseReadView(props.toolCall));

const route = computed<Route>(() => {
    // Single fallback decision point: unknown/untyped names, job surfaces and
    // reserved states all converge here; the dedicated cards never re-check fallback.
    if (hasJobSurface(props.toolCall) || hasReservedState(props.toolCall)) return "fallback";
    switch (props.toolCall.name) {
        case "execute_command":
            return commandView.value ? "command" : "fallback";
        case "apply_patch":
            return patchView.value ? "patch" : "fallback";
        case "read_file":
        case "read_file_range":
            return readView.value ? "read" : "fallback";
        default:
            return "fallback";
    }
});

const EMPTY_COMMAND_VIEW: CommandCardView = { command: "", args: [], result: null };
const EMPTY_PATCH_VIEW: PatchCardView = { patches: [], result: null };
const EMPTY_READ_VIEW: ReadCardView = {
    mode: "full",
    path: "",
    content: "",
    totalLines: null,
    isBinary: false,
    offset: null,
    limit: null,
    hasResult: false,
};
</script>

<template>
    <CommandToolCard
        v-if="route === 'command'"
        :tool-call="toolCall"
        :actor="actor"
        :view="commandView ?? EMPTY_COMMAND_VIEW"
        @approve="emit('approve', $event)"
        @reject="emit('reject', $event)"
    />
    <PatchToolCard
        v-else-if="route === 'patch'"
        :tool-call="toolCall"
        :actor="actor"
        :view="patchView ?? EMPTY_PATCH_VIEW"
        @approve="emit('approve', $event)"
        @reject="emit('reject', $event)"
    />
    <ReadToolCard
        v-else-if="route === 'read'"
        :tool-call="toolCall"
        :actor="actor"
        :view="readView ?? EMPTY_READ_VIEW"
        @approve="emit('approve', $event)"
        @reject="emit('reject', $event)"
    />
    <ToolCallCard
        v-else
        :tool-call="toolCall"
        :actor="actor"
        @approve="emit('approve', $event)"
        @reject="emit('reject', $event)"
    />
</template>
