import { defineStore } from "pinia";
import { ref } from "vue";
import { ApiError, api } from "../composables/api";
import { logger } from "../lib/logger";
import type { WorkspaceCheckpoint, WorkspaceCheckpointEvent } from "../types";

export interface WorkspaceCheckpointRecord extends WorkspaceCheckpoint {
    workspaceId: string;
    loading: boolean;
    error: string | null;
    loaded: boolean;
    updatedAt: number;
}

function errorMessage(cause: unknown, fallback: string): string {
    if (cause instanceof ApiError) {
        return `${cause.problem.code}: ${cause.problem.detail ?? cause.message}`;
    }
    return cause instanceof Error ? cause.message : fallback;
}

export const useCheckpointStore = defineStore("checkpoint", () => {
    const records = ref<Record<string, WorkspaceCheckpointRecord>>({});
    const eventRecords = ref<Record<string, WorkspaceCheckpointEvent>>({});
    const workspaceErrors = ref<Record<string, string>>({});
    const inFlight = new Map<string, Promise<WorkspaceCheckpointRecord[] | null>>();
    const loadedWorkspaces = new Set<string>();
    let storeGeneration = 0;

    function key(workspaceId: string, id: string): string {
        return `${workspaceId}:${id}`;
    }

    function getForWorkspace(workspaceId: string): WorkspaceCheckpointRecord[] {
        return Object.values(records.value)
            .filter((record) => record.workspaceId === workspaceId && record.state !== "expired")
            .sort((left, right) => (right.capturedAt ?? "").localeCompare(left.capturedAt ?? ""));
    }

    function getForRun(workspaceId: string, runId: string): WorkspaceCheckpointRecord | undefined {
        return getForWorkspace(workspaceId).find((record) => record.sourceRunId === runId);
    }

    function getEvent(runId: string): WorkspaceCheckpointEvent | undefined {
        return eventRecords.value[runId];
    }

    function mergeEvent(event: WorkspaceCheckpointEvent): void {
        const previous = eventRecords.value[event.runId];
        if (previous && previous.sessionId !== event.sessionId) return;
        eventRecords.value[event.runId] = event;
    }

    async function fetchWorkspaceCheckpoints(
        workspaceId: string,
        options: { force?: boolean } = {},
    ): Promise<WorkspaceCheckpointRecord[] | null> {
        if (!workspaceId) return null;
        const existing = getForWorkspace(workspaceId);
        if (!options.force && loadedWorkspaces.has(workspaceId)) return existing;
        const pending = inFlight.get(workspaceId);
        if (pending) {
            if (!options.force) return pending;
            return pending.then(() => fetchWorkspaceCheckpoints(workspaceId, { force: true }));
        }

        const requestGeneration = storeGeneration;
        const request = Promise.resolve().then(
            async (): Promise<WorkspaceCheckpointRecord[] | null> => {
                try {
                    const list = await api.listWorkspaceCheckpoints(workspaceId);
                    if (requestGeneration !== storeGeneration) return null;
                    for (const existingKey of Object.keys(records.value)) {
                        if (records.value[existingKey]?.workspaceId === workspaceId)
                            delete records.value[existingKey];
                    }
                    const merged = list.map((checkpoint): WorkspaceCheckpointRecord => ({
                        ...checkpoint,
                        workspaceId,
                        loading: false,
                        error: null,
                        loaded: true,
                        updatedAt: Date.now(),
                    }));
                    for (const checkpoint of merged)
                        records.value[key(workspaceId, checkpoint.id)] = checkpoint;
                    loadedWorkspaces.add(workspaceId);
                    delete workspaceErrors.value[workspaceId];
                    return merged;
                } catch (cause) {
                    if (requestGeneration !== storeGeneration) return null;
                    const message = errorMessage(cause, "Failed to load workspace checkpoints");
                    workspaceErrors.value[workspaceId] = message;
                    const current = getForWorkspace(workspaceId);
                    for (const record of current) {
                        record.loading = false;
                        record.error = message;
                    }
                    logger.warn("Failed to load workspace checkpoints", cause);
                    return current;
                } finally {
                    if (inFlight.get(workspaceId) === request) inFlight.delete(workspaceId);
                }
            },
        );
        inFlight.set(workspaceId, request);
        return request;
    }

    function clearForUserSwitch(): void {
        storeGeneration += 1;
        records.value = {};
        eventRecords.value = {};
        workspaceErrors.value = {};
        loadedWorkspaces.clear();
        inFlight.clear();
    }

    function clearWorkspace(workspaceId: string): void {
        storeGeneration += 1;
        for (const recordKey of Object.keys(records.value)) {
            if (records.value[recordKey]?.workspaceId === workspaceId)
                delete records.value[recordKey];
        }
        eventRecords.value = {};
        loadedWorkspaces.delete(workspaceId);
        inFlight.delete(workspaceId);
        delete workspaceErrors.value[workspaceId];
    }

    return {
        records,
        eventRecords,
        workspaceErrors,
        getForWorkspace,
        getForRun,
        getEvent,
        mergeEvent,
        fetchWorkspaceCheckpoints,
        clearWorkspace,
        clearForUserSwitch,
    };
});
