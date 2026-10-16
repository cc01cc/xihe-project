import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { CP_URL, registerJourneyUser } from "./helpers/journey";
import {
    createSessionWithPrincipal,
    provisionWorkspaceAgentPrincipal,
} from "./helpers/agent-principal";

const AGENT_URL = `http://127.0.0.1:${process.env.XIHE_AGENT_PORT ?? "12632"}`,
    SERVICE_TOKEN = process.env.XIHE_CP_API_TOKEN ?? "",
    CREDENTIAL_CANARY_BYTES_HEX = Buffer.from(
        "checkpoint-probe-credential-canary",
        "utf8",
    ).toString("hex");

test.describe.configure({ mode: "serial", retries: 0 });

type SaverProbeResult = {
    threadId: string;
    lineageId: string;
    probeId: string;
    schemaVersion: number;
    traceMetadata: {
        lineageId: string;
        sourceRunId: string | null;
        probeId: string;
        sessionId: string;
        branchId: string;
        userId: string;
        workspaceId: string;
        stateSchemaVersion: number;
        createdAt: string;
        producerVersion: string;
    };
    checkpointIds: string[];
    listedCheckpointIds: string[];
    limitedCheckpointIds: string[];
    beforeLatestCheckpointIds: string[];
    filteredCheckpointIds: string[];
    pendingWrites: number;
    stateMatches: boolean;
    credentialCanaryAbsent: boolean;
    stateFingerprint: string;
};

function checkpointCanaryAbsentFromDurableBlobs(lineageId: string): {
    checkpoints: boolean;
    pendingWrites: boolean;
} {
    const container = process.env.XIHE_E2E_PG_CONTAINER,
        database = process.env.XIHE_E2E_PG_DATABASE,
        dbUser = process.env.XIHE_E2E_PG_USER;
    if (!container || !database || !dbUser || !/^[0-9a-f-]{36}$/i.test(lineageId)) {
        throw new Error("isolated PostgreSQL fixture metadata is unavailable");
    }
    try {
        const result = execFileSync(
                process.platform === "win32" ? "docker.exe" : "docker",
                [
                    "exec",
                    container,
                    "psql",
                    "-X",
                    "-A",
                    "-t",
                    "-F",
                    ",",
                    "-U",
                    dbUser,
                    "-d",
                    database,
                    "-c",
                    `SELECT NOT EXISTS (` +
                        `SELECT 1 FROM agent_graph_checkpoints ` +
                        `WHERE lineage_id='${lineageId}'::uuid ` +
                        `AND position(decode('${CREDENTIAL_CANARY_BYTES_HEX}','hex') ` +
                        `in checkpoint_blob) > 0),` +
                        `NOT EXISTS (` +
                        `SELECT 1 FROM agent_graph_checkpoint_writes ` +
                        `WHERE lineage_id='${lineageId}'::uuid ` +
                        `AND position(decode('${CREDENTIAL_CANARY_BYTES_HEX}','hex') ` +
                        `in value_blob) > 0)`,
                ],
                {
                    encoding: "utf8",
                    timeout: 15_000,
                    windowsHide: true,
                    stdio: ["ignore", "pipe", "ignore"],
                },
            ).trim(),
            values = result.split(",");
        if (values.length !== 2 || values.some((value) => value !== "t" && value !== "f")) {
            throw new Error("invalid canary scan result");
        }
        return { checkpoints: values[0] === "t", pendingWrites: values[1] === "t" };
    } catch {
        // Do not surface child-process output; it can contain SQL or runtime details.
        throw new Error("isolated checkpoint payload scan failed");
    }
}

async function restartServiceAndRecover(
    request: APIRequestContext,
    service: "agent" | "control-plane",
    requestBody: Record<string, unknown>,
): Promise<SaverProbeResult> {
    const controlUrl = process.env.XIHE_E2E_HOST_CONTROL_URL,
        controlToken = process.env.XIHE_E2E_HOST_CONTROL_TOKEN;
    if (!controlUrl || !controlToken) {
        throw new Error("checkpoint probe host control is unavailable");
    }
    const restart = await fetch(`${controlUrl}/restart-service`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${controlToken}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ service }),
        signal: AbortSignal.timeout(120_000),
    });
    expect(restart.status, `${service} must restart through the runner control surface`).toBe(200);
    const restartResult = (await restart.json()) as { service: string; pidChanged: boolean };
    expect(restartResult).toEqual({ service, pidChanged: true });

    const recovered = await request.post(`${AGENT_URL}/internal/v1/agent/checkpoint-probe`, {
        headers: {
            Authorization: `Bearer ${SERVICE_TOKEN}`,
            "Content-Type": "application/json",
        },
        data: { ...requestBody, operation: "recover" },
        timeout: 30_000,
    });
    expect(recovered.status(), "the durable lineage must recover after process restart").toBe(200);
    return (await recovered.json()) as SaverProbeResult;
}

function checkpointRowsAfterSessionDelete(lineageId: string): {
    lineages: number;
    checkpoints: number;
    pendingWrites: number;
    total: number;
} {
    const container = process.env.XIHE_E2E_PG_CONTAINER,
        database = process.env.XIHE_E2E_PG_DATABASE,
        dbUser = process.env.XIHE_E2E_PG_USER;
    if (!container || !database || !dbUser) {
        throw new Error("isolated PostgreSQL fixture metadata is unavailable");
    }
    if (!/^[0-9a-f-]{36}$/i.test(lineageId)) {
        throw new Error("checkpoint probe did not return a UUID lineage id");
    }
    try {
        const result = execFileSync(
                process.platform === "win32" ? "docker.exe" : "docker",
                [
                    "exec",
                    container,
                    "psql",
                    "-X",
                    "-A",
                    "-t",
                    "-F",
                    ",",
                    "-U",
                    dbUser,
                    "-d",
                    database,
                    "-c",
                    `SELECT ` +
                        `(SELECT count(*) FROM agent_graph_checkpoint_lineages ` +
                        `WHERE lineage_id='${lineageId}'::uuid),` +
                        `(SELECT count(*) FROM agent_graph_checkpoints ` +
                        `WHERE lineage_id='${lineageId}'::uuid),` +
                        `(SELECT count(*) FROM agent_graph_checkpoint_writes ` +
                        `WHERE lineage_id='${lineageId}'::uuid)`,
                ],
                {
                    encoding: "utf8",
                    timeout: 15_000,
                    windowsHide: true,
                    stdio: ["ignore", "pipe", "ignore"],
                },
            ).trim(),
            counts = result.split(",").map(Number);
        if (counts.length !== 3 || counts.some((count) => !Number.isInteger(count))) {
            throw new Error("invalid row counts");
        }
        const [lineages, checkpoints, pendingWrites] = counts as [number, number, number];
        return {
            lineages,
            checkpoints,
            pendingWrites,
            total: lineages + checkpoints + pendingWrites,
        };
    } catch {
        // Do not surface child-process output; it can contain SQL or runtime details.
        throw new Error("isolated checkpoint lineage row-count query failed");
    }
}

test("@host PLAN-0510 T0.5 — Agent BaseCheckpointSaver persists through CP", async ({
    request,
}) => {
    test.setTimeout(240_000);

    const runId = process.env.XIHE_E2E_RUN_ID,
        pgFixture = [
            process.env.XIHE_E2E_PG_CONTAINER,
            process.env.XIHE_E2E_PG_DATABASE,
            process.env.XIHE_E2E_PG_USER,
        ];
    expect(Boolean(runId), "must run inside the isolated host harness").toBe(true);
    expect(pgFixture.every(Boolean), "isolated PostgreSQL metadata must be present").toBe(true);
    expect(Boolean(SERVICE_TOKEN), "internal service token must be present").toBe(true);
    expect(
        Object.keys(process.env).some((key) =>
            /(?:^|_)(?:PGPASSWORD|POSTGRES(?:QL)?_PASSWORD|DATABASE_URL|DATABASE_PASSWORD|DATASOURCE(?:_[A-Z0-9]+)*|JDBC_URL|DB_(?:URL|PASSWORD|USERNAME))(?:_|$)/i.test(
                key,
            ),
        ),
        "the Playwright process must not receive a database credential or DSN",
    ).toBe(false);
    expect(
        process.env.XIHE_E2E_AGENT_DB_CONFIG_PRESENT,
        "runner's Agent env audit must be boolean false",
    ).toBe("false");
    expect(process.env.XIHE_E2E_CHECKPOINT_PROBE_ACTIVE).toBe("true");

    const journey = await registerJourneyUser(request, "checkpoint-saver-probe"),
        me = await request.get(`${CP_URL}/api/v1/auth/me`, { headers: journey.headers });
    expect(me.ok(), "authenticated owner lookup must succeed").toBeTruthy();
    const userId = (await me.json()) as { id: string };
    const principalId = await provisionWorkspaceAgentPrincipal(
        request,
        { accessToken: journey.authToken, workspaceId: journey.workspaceId },
        { name: `Checkpoint Probe ${runId}` },
    );
    const sessionId = await createSessionWithPrincipal(
        request,
        { accessToken: journey.authToken, workspaceId: journey.workspaceId },
        { principalId, title: `checkpoint-probe-${runId}` },
    );

    // This internal Agent probe must exercise the production BaseCheckpointSaver
    // adapter against CP-owned storage with synthetic, checkpoint-safe state.
    // It returns IDs/counts only; message and tool payloads stay out of evidence.
    const probe = await request.post(`${AGENT_URL}/internal/v1/agent/checkpoint-probe`, {
        headers: {
            Authorization: `Bearer ${SERVICE_TOKEN}`,
            "Content-Type": "application/json",
        },
        data: {
            operation: "round-trip",
            sessionId,
            userId: userId.id,
            workspaceId: journey.workspaceId,
        },
    });
    expect(
        probe.status(),
        "Agent checkpoint probe endpoint must complete the saver round-trip",
    ).toBe(200);

    const result = (await probe.json()) as SaverProbeResult;
    expect(typeof result.threadId === "string" && result.threadId.length > 0).toBe(true);
    expect(typeof result.lineageId === "string" && result.lineageId.length > 0).toBe(true);
    expect(result.probeId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(result.schemaVersion).toBeGreaterThan(0);
    expect(result.traceMetadata).toMatchObject({
        lineageId: result.lineageId,
        sourceRunId: null,
        probeId: result.probeId,
        sessionId,
        userId: userId.id,
        workspaceId: journey.workspaceId,
        stateSchemaVersion: result.schemaVersion,
    });
    expect(result.traceMetadata.branchId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(result.traceMetadata.createdAt.length).toBeGreaterThan(0);
    expect(result.traceMetadata.producerVersion.length).toBeGreaterThan(0);
    expect(Array.isArray(result.checkpointIds) && result.checkpointIds.length === 2).toBe(true);
    expect(result.listedCheckpointIds).toEqual(result.checkpointIds.toReversed());
    expect(result.limitedCheckpointIds).toEqual([result.checkpointIds[1]]);
    expect(result.beforeLatestCheckpointIds).toEqual([result.checkpointIds[0]]);
    expect(result.filteredCheckpointIds).toEqual([result.checkpointIds[1]]);
    expect(result.pendingWrites).toBeGreaterThan(0);
    expect(result.stateMatches).toBe(true);
    expect(result.credentialCanaryAbsent).toBe(true);
    expect(result.stateFingerprint).toMatch(/^[0-9a-f]{64}$/);

    const durableCanaryScan = checkpointCanaryAbsentFromDurableBlobs(result.lineageId);
    expect(durableCanaryScan).toEqual({ checkpoints: true, pendingWrites: true });

    const recoveryRequest = {
        sessionId,
        userId: userId.id,
        workspaceId: journey.workspaceId,
        threadId: result.threadId,
        probeId: result.probeId,
        checkpointId: result.checkpointIds[1],
    };
    for (const service of ["agent", "control-plane"] as const) {
        const recovered = await restartServiceAndRecover(request, service, recoveryRequest);
        expect(recovered.lineageId).toBe(result.lineageId);
        expect(recovered.threadId).toBe(result.threadId);
        expect(recovered.schemaVersion).toBe(result.schemaVersion);
        expect(recovered.checkpointIds).toEqual(result.checkpointIds);
        expect(recovered.listedCheckpointIds).toEqual(result.listedCheckpointIds);
        expect(recovered.limitedCheckpointIds).toEqual(result.limitedCheckpointIds);
        expect(recovered.beforeLatestCheckpointIds).toEqual(result.beforeLatestCheckpointIds);
        expect(recovered.filteredCheckpointIds).toEqual(result.filteredCheckpointIds);
        expect(recovered.traceMetadata).toEqual(result.traceMetadata);
        expect(recovered.stateFingerprint).toBe(result.stateFingerprint);
        expect(recovered.pendingWrites).toBe(result.pendingWrites);
        expect(recovered.stateMatches).toBe(true);
        expect(recovered.credentialCanaryAbsent).toBe(true);
    }

    const controlUrl = process.env.XIHE_E2E_HOST_CONTROL_URL,
        controlToken = process.env.XIHE_E2E_HOST_CONTROL_TOKEN;
    expect(Boolean(controlUrl && controlToken)).toBe(true);
    const migrationRecovery = await fetch(`${controlUrl}/migration-recovery`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${controlToken}`,
            "Content-Type": "application/json",
        },
        body: "{}",
        signal: AbortSignal.timeout(120_000),
    });
    expect(migrationRecovery.status, "scratch migration rollback and replay must complete").toBe(
        200,
    );
    expect(await migrationRecovery.json()).toEqual({
        migrationFailed: true,
        rollbackTableCount: 0,
        recoveredTableCount: 3,
        cleanupSucceeded: true,
    });

    const deleted = await request.delete(`${CP_URL}/api/v1/sessions/${sessionId}`, {
        headers: journey.headers,
    });
    expect(deleted.status()).toBe(204);
    expect(checkpointRowsAfterSessionDelete(result.lineageId)).toEqual({
        lineages: 0,
        checkpoints: 0,
        pendingWrites: 0,
        total: 0,
    });
});
