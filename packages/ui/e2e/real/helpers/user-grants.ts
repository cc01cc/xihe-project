import { execFileSync } from "node:child_process";

export interface GrantPermission {
    actionClass: string;
    resource: string;
}

/** V64/V65: the standard ceiling set every journey user needs for config/agent writes. */
export function standardWorkspaceUserPermissions(workspaceId: string): Array<GrantPermission> {
    return [
        { actionClass: "CREATE_ACCOUNT", resource: "*" },
        { actionClass: "CREATE_TEMPLATE", resource: "*" },
        { actionClass: "MANAGE_WORKSPACE_AGENTS", resource: workspaceId },
    ];
}

/**
 * Seeds (or merges into) the subject's single `source='direct'` grants row.
 * V65 `uq_grants_direct_subject` allows one direct row per subject, and the
 * CP binding path merges into it (CredentialBindingService round-4), so the
 * seed helper must be idempotent too: re-running a spec or topping up extra
 * ceilings for the same user unions the permission entries (jsonb dedupe)
 * instead of tripping the unique index.
 */
export function seedUserGrant(
    userId: string,
    workspaceId: string,
    extraPermissions: Array<GrantPermission> = [],
): void {
    seedUserGrantPermissions(userId, [
        ...standardWorkspaceUserPermissions(workspaceId),
        ...extraPermissions,
    ]);
}

/** Arbitrary-permission variant for specs seeding non-standard ceiling sets. */
export function seedUserGrantPermissions(
    userId: string,
    permissions: Array<GrantPermission>,
): void {
    const container = process.env.XIHE_E2E_PG_CONTAINER,
        database = process.env.XIHE_E2E_PG_DATABASE;
    const dbUser = process.env.XIHE_E2E_PG_USER;
    if (!container || !database || !dbUser) {
        throw new Error(
            "isolated PostgreSQL fixture metadata is unavailable; run through scripts/e2e-host.mjs",
        );
    }
    const permissionJson = JSON.stringify(permissions).replaceAll("'", "''");
    execFileSync(
        process.platform === "win32" ? "docker.exe" : "docker",
        [
            "exec",
            container,
            "psql",
            "-X",
            "-A",
            "-t",
            "-U",
            dbUser,
            "-d",
            database,
            "-c",
            `INSERT INTO grants (id, granter_type, granter_id, subject_type, subject_id, permissions, source, read_state) ` +
                `VALUES (gen_random_uuid(), 'user', '${userId}'::uuid, 'user', '${userId}'::uuid, ` +
                `'${permissionJson}'::jsonb, 'direct', 'read') ` +
                `ON CONFLICT (subject_type, subject_id) WHERE source = 'direct' DO UPDATE ` +
                `SET permissions = (SELECT jsonb_agg(DISTINCT entry ORDER BY entry) ` +
                `FROM jsonb_array_elements(grants.permissions || EXCLUDED.permissions) AS entry)`,
        ],
        { encoding: "utf8", timeout: 15_000, windowsHide: true },
    );
}
