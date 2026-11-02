import { onScopeDispose, ref, watch, type Ref } from "vue";
import { api, type SessionCommandView } from "../../../../composables/api";
import { logger } from "../../../../lib/logger";
import { useAuthStore } from "../../../../stores/auth";

/**
 * PLAN-0635 M3: `/` command source.
 *
 * The server registry (`GET /sessions/{id}/commands`) owns availability, but the UI still needs
 * commands that only exist locally (`/clear`, `/help`) and must keep working when the registry is
 * unreachable. So the two sources are **merged, never replaced**: server rows win on a name
 * collision, local-only rows survive, and a failed request degrades to the local table alone.
 */

/** State of the registry read. `idle` never issues a request (no session / not signed in). */
export type SessionCommandsState = "idle" | "loading" | "ready" | "fallback";

/** One command as the composer consumes it (local table row or merged server row). */
export interface SlashCommand {
    /** Command name including the leading slash (wire `name`, e.g. `/export`). */
    key: string;
    /** i18n key of the one-line hint (never user-supplied text). */
    descriptionKey: string;
    /** Server verdict; local-only commands are always available. */
    available: boolean;
    /** Raw wire reason; `null` when available (or for local-only commands). */
    reason: string | null;
    /** `!available`: the menu/help greys these out and refuses to execute them. */
    disabled: boolean;
}

/**
 * Local commands stay the floor of the menu. They are not "server commands that CP happens not to
 * list": `/clear` and `/help` are pure browser actions and must work offline.
 */
export const LOCAL_SLASH_COMMANDS: readonly SlashCommand[] = [
    {
        key: "/clear",
        descriptionKey: "chat.input.commandClear",
        available: true,
        reason: null,
        disabled: false,
    },
    {
        key: "/help",
        descriptionKey: "chat.input.commandHelp",
        available: true,
        reason: null,
        disabled: false,
    },
];

/**
 * Server rows carry no description, so the hint is resolved by name. An unknown command is still
 * rendered (the server may grow new ones) with an honest "not implemented in this UI" hint.
 */
const COMMAND_DESCRIPTION_KEYS: Record<string, string> = {
    "/export": "chat.commands.description.export",
    "/compact": "chat.commands.description.compact",
};

export const UNKNOWN_COMMAND_DESCRIPTION_KEY = "chat.commands.description.unknown";

/** Reason → localized copy. `Record<string, string>` keeps the mapping open by design. */
const COMMAND_REASON_KEYS: Record<string, string> = {
    approval_required: "chat.commands.reason.approvalRequired",
    denied: "chat.commands.reason.denied",
    policy_unavailable: "chat.commands.reason.policyUnavailable",
    branch_locked: "chat.commands.reason.branchLocked",
};

/**
 * Fallback copy for a reason this build does not know. It must never be the raw enum (or blank):
 * an unknown value is a real state the user needs to see explained.
 */
export const UNKNOWN_COMMAND_REASON_KEY = "chat.commands.reason.unknown";

function ownsKey(map: Record<string, string>, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(map, key);
}

export function commandDescriptionKey(name: string): string {
    return ownsKey(COMMAND_DESCRIPTION_KEYS, name)
        ? (COMMAND_DESCRIPTION_KEYS[name] ?? UNKNOWN_COMMAND_DESCRIPTION_KEY)
        : UNKNOWN_COMMAND_DESCRIPTION_KEY;
}

export function commandReasonKey(reason: string | null | undefined): string {
    if (!reason || !ownsKey(COMMAND_REASON_KEYS, reason)) return UNKNOWN_COMMAND_REASON_KEY;
    return COMMAND_REASON_KEYS[reason] ?? UNKNOWN_COMMAND_REASON_KEY;
}

function isCommandRow(value: unknown): value is SessionCommandView {
    if (!value || typeof value !== "object") return false;
    const row = value as Record<string, unknown>;
    return typeof row.name === "string" && row.name.startsWith("/") && row.name.length > 1;
}

/**
 * Merge by name: server rows first (server priority), then every local command the server did not
 * mention. The result is never empty because the local table is always present.
 */
export function mergeSessionCommands(serverRows: readonly unknown[]): SlashCommand[] {
    const byName = new Map<string, SlashCommand>();
    for (const row of serverRows) {
        if (!isCommandRow(row)) continue;
        const available = row.available === true;
        byName.set(row.name, {
            key: row.name,
            descriptionKey: commandDescriptionKey(row.name),
            available,
            reason: typeof row.reason === "string" ? row.reason : null,
            disabled: !available,
        });
    }
    for (const local of LOCAL_SLASH_COMMANDS) {
        if (!byName.has(local.key)) byName.set(local.key, local);
    }
    return [...byName.values()];
}

/** Upper bound on the registry read; a hung request must degrade to `fallback`, not stay loading. */
const COMMAND_REQUEST_TIMEOUT_MS = 10_000;

/**
 * @param sessionIdRef current session; a change (and sign-in) re-reads the registry.
 */
export function useSessionCommands(sessionIdRef: Ref<string | null | undefined>) {
    const authStore = useAuthStore();

    const commands = ref<SlashCommand[]>([...LOCAL_SLASH_COMMANDS]);
    const state = ref<SessionCommandsState>("idle");

    /** Guards against a slow response for a session the user already left. */
    let generation = 0;
    let controller: AbortController | null = null;

    async function reload(): Promise<void> {
        generation += 1;
        const current = generation;
        controller?.abort();
        controller = null;

        const sessionId = sessionIdRef.value;
        if (!sessionId || !authStore.isAuthenticated) {
            commands.value = [...LOCAL_SLASH_COMMANDS];
            state.value = "idle";
            return;
        }

        state.value = "loading";
        const call = new AbortController();
        controller = call;
        const timer = setTimeout(() => call.abort(), COMMAND_REQUEST_TIMEOUT_MS);
        try {
            const response = await api.listSessionCommands(sessionId, { signal: call.signal });
            if (current !== generation) return;
            commands.value = mergeSessionCommands(response.commands);
            state.value = "ready";
        } catch (error) {
            if (current !== generation) return;
            // Fail soft, not empty: the local table is still usable and `/help` must have content.
            commands.value = [...LOCAL_SLASH_COMMANDS];
            state.value = "fallback";
            logger.warn("Session command registry unavailable; falling back to local commands", {
                sessionId,
                error: error instanceof Error ? error.message : String(error),
            });
        } finally {
            clearTimeout(timer);
            if (controller === call) controller = null;
        }
    }

    watch([() => sessionIdRef.value, () => authStore.isAuthenticated], () => void reload(), {
        immediate: true,
    });

    onScopeDispose(() => {
        generation += 1;
        controller?.abort();
        controller = null;
    });

    return { commands, state, reload };
}
