import type { ModelCache, ProviderCatalog } from "../../../types/provider";
import type { ProviderConnection } from "../../../types/providerConnection";
import type { SessionModelBinding } from "../../../types";
import type { LlmProviderProfile } from "../../../services/llmProviderProfile";

/**
 * PLAN-0555: read-only display resolver for the composer model label.
 *
 * The server Session is authoritative for a bound run (CP reads
 * `providerConnectionId` and the Session model on dispatch), so the label uses
 * the Session first, then the local binding cache, then the llm-provider
 * profile. It never mutates config/session state and never changes what a run
 * dispatches.
 */
export type ConnectionDisplayState = "resolved" | "loading" | "unavailable" | "not-recorded";

export interface ModelDisplayInput {
    session?: {
        modelProvider?: string;
        modelName?: string;
        providerConnectionId?: string;
    };
    binding?: SessionModelBinding;
    profile?: LlmProviderProfile | null;
    catalogs?: ModelCache["providers"];
    connections: ProviderConnection[];
    connectionsLoaded: boolean;
    connectionsError?: boolean;
    /** Offline provider-name fallback (the catalog is the SSOT). */
    fallbackProviderName?: (providerId: string) => string | undefined;
}

export interface ModelDisplay {
    hasBinding: boolean;
    model: string | null;
    providerId: string | null;
    providerName: string | null;
    /** `label`, `label · connectionKey`, `connectionKey`, `—` or `…` (loading). */
    connectionDisplay: string;
    connectionLabel: string | null;
    connectionKey: string | null;
    connectionId: string | null;
    state: ConnectionDisplayState;
}

const EMPTY: ModelDisplay = {
    hasBinding: false,
    model: null,
    providerId: null,
    providerName: null,
    connectionDisplay: "—",
    connectionLabel: null,
    connectionKey: null,
    connectionId: null,
    state: "not-recorded",
};

function normalizeLabel(value: string | null | undefined): string {
    return (value ?? "").trim().toLowerCase();
}

function visibleConnectionLabel(connection: ProviderConnection): string {
    const label = (connection.label ?? "").trim();
    return label || connection.connectionKey;
}

function findCatalog(
    catalogs: ModelCache["providers"] | undefined,
    providerId: string,
    connectionId?: string,
): ProviderCatalog | undefined {
    const entries = Object.entries(catalogs ?? {});
    if (connectionId) {
        const byConnection = entries.find(
            ([key, catalog]) => key === connectionId || catalog.connectionId === connectionId,
        );
        if (byConnection) return byConnection[1];
    }
    return entries.find(([key, catalog]) => (catalog.providerId ?? key) === providerId)?.[1];
}

/** A profile connection is matched by provider+key; prefer WORKSPACE like the picker. */
function findProfileConnection(
    connections: ProviderConnection[],
    providerId: string,
    connectionKey: string,
): ProviderConnection | undefined {
    const matches = connections.filter(
        (item) => item.providerId === providerId && item.connectionKey === connectionKey,
    );
    return matches.find((item) => item.scope === "WORKSPACE") ?? matches[0];
}

export function resolveModelDisplay(input: ModelDisplayInput): ModelDisplay {
    const { session, binding, profile, connections, connectionsLoaded } = input;

    let providerId: string | null = null,
        model: string | null = null,
        connectionId: string | undefined,
        connectionKey: string | undefined;

    // 1. A bound Session is what CP actually dispatches.
    if (session?.modelProvider && session.modelName) {
        providerId = session.modelProvider;
        model = session.modelName;
        connectionId = session.providerConnectionId;
    } else if (binding?.provider && binding.model) {
        // 2. Local binding cache (also covers the profile fallback of getEffectiveModel).
        providerId = binding.provider;
        model = binding.model;
        connectionId = binding.connectionId;
        if (
            !connectionId &&
            profile &&
            profile.providerId === binding.provider &&
            profile.model === binding.model
        ) {
            connectionKey = profile.connectionKey;
        }
    } else if (profile) {
        // 3. llm-provider profile default.
        providerId = profile.providerId;
        model = profile.model;
        connectionKey = profile.connectionKey;
    }

    if (!providerId || !model) return EMPTY;

    const catalog = findCatalog(input.catalogs, providerId, connectionId),
        providerName =
            catalog?.displayName ?? input.fallbackProviderName?.(providerId) ?? providerId;

    let connection: ProviderConnection | undefined,
        state: ConnectionDisplayState = "not-recorded",
        connectionDisplay = "—";

    if (connectionId) {
        if (!connectionsLoaded) {
            state = input.connectionsError ? "unavailable" : "loading";
            connectionDisplay = input.connectionsError ? "—" : "…";
        } else {
            connection = connections.find((item) => item.id === connectionId);
            if (connection) {
                state = "resolved";
                connectionDisplay = visibleConnectionLabel(connection);
            } else {
                state = "unavailable";
            }
        }
    } else if (connectionKey) {
        if (!connectionsLoaded) {
            state = input.connectionsError ? "unavailable" : "loading";
            connectionDisplay = input.connectionsError ? "—" : "…";
        } else {
            connection = findProfileConnection(connections, providerId, connectionKey);
            state = "resolved";
            // The profile records the key even when the connection is not visible.
            connectionDisplay = connection ? visibleConnectionLabel(connection) : connectionKey;
        }
    }

    const connectionLabel = connection ? (connection.label ?? "").trim() || null : null,
        resolvedKey = connection?.connectionKey ?? connectionKey ?? null;

    // PLAN-0555 decision #16: uniqueness is per owner, so USER and WORKSPACE can
    // still share a label. Within the visible set the key disambiguates the
    // third segment instead of adding a fourth one.
    if (connection && connectionLabel) {
        const normalized = normalizeLabel(connectionLabel),
            conflicts = connections.filter(
                (item) =>
                    item.providerId === providerId && normalizeLabel(item.label) === normalized,
            );
        if (conflicts.length > 1 && resolvedKey) {
            connectionDisplay = `${connectionLabel} · ${resolvedKey}`;
        }
    }

    return {
        hasBinding: true,
        model,
        providerId,
        providerName,
        connectionDisplay,
        connectionLabel,
        connectionKey: resolvedKey,
        connectionId: connection?.id ?? connectionId ?? null,
        state,
    };
}
