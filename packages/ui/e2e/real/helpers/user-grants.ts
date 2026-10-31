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
 * PLAN-0610 W6/T6.1: E2E ceiling seeds used to write one legacy `direct` grants row per subject.
 * V88 narrowed `ck_grants_source` to the post-migration five values and the authorization gate now
 * reads the union of the subject's access-role bindings, so the fixture seeds the real model:
 *
 *   `roles` (one deterministic per-subject E2E role) + `role_permissions`
 *   + `role_bindings` (user subject, instance scope) + materialized `grants(source='role')`.
 *
 * Materialized rows mirror `RoleGrantMaterializer`: one row per atom, `resource` omitted for a `*`
 * pattern, capability atoms never materialized. After each write the subject's role rows are
 * recomputed from **all** current bindings, so a re-run is additive and the narrowing helper cannot
 * leave a stale atom behind. Function signatures stay unchanged for the 12+ specs that import them;
 * only the seeding strategy moved from the retired `direct` source to access roles.
 */

/** Seeds (or tops up) the subject's E2E role with the standard ceiling set plus extras. */
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

/** Arbitrary-permission additive variant for specs seeding non-standard ceiling sets. */
export function seedUserGrantPermissions(
    userId: string,
    permissions: Array<GrantPermission>,
): void {
    runRoleSeedSql(userId, permissions, "merge");
}

/** Exact-set variant: drops the E2E role's previous atoms before seeding the given set. */
export function replaceUserGrantPermissions(
    userId: string,
    permissions: Array<GrantPermission>,
): void {
    runRoleSeedSql(userId, permissions, "replace");
}

/** Removes one atom from the subject's E2E role (and recomputes the materialized union). */
export function removeUserGrantPermission(
    userId: string,
    actionClass: string,
    resource: string = "*",
): void {
    runRoleSeedSql(userId, [{ actionClass, resource }], "remove");
}

type SeedMode = "merge" | "replace" | "remove";

function runRoleSeedSql(
    userId: string,
    permissions: Array<GrantPermission>,
    mode: SeedMode,
): void {
    const container = process.env.XIHE_E2E_PG_CONTAINER,
        database = process.env.XIHE_E2E_PG_DATABASE;
    const dbUser = process.env.XIHE_E2E_PG_USER;
    if (!container || !database || !dbUser) {
        throw new Error(
            "isolated PostgreSQL fixture metadata is unavailable; run through scripts/e2e-host.mjs",
        );
    }
    const roleName = `E2E_GRANT_${userId.replaceAll("-", "").toUpperCase()}`;
    const user = escapeSql(userId);
    const permissionJson = JSON.stringify(
        permissions.map((permission) => ({
            action: permission.actionClass,
            resource: permission.resource || "*",
        })),
    ).replaceAll("'", "''");
    const permissionWrite =
        mode === "remove"
            ? `DELETE FROM role_permissions
               WHERE role_id = v_role
                 AND action_class = '${escapeSql(permissions[0].actionClass)}'
                 AND resource_pattern = '${escapeSql(permissions[0].resource || "*")}';`
            : `${
                  mode === "replace" ? "DELETE FROM role_permissions WHERE role_id = v_role;" : ""
              }
               INSERT INTO role_permissions (role_id, action_class, resource_pattern)
               SELECT v_role, entry.action, entry.resource
               FROM jsonb_to_recordset('${permissionJson}'::jsonb) AS entry(action TEXT, resource TEXT)
               ON CONFLICT DO NOTHING;`;
    const sql = `
DO $$
DECLARE
    v_role UUID;
BEGIN
    INSERT INTO roles (id, name, display_name, description, is_system)
    VALUES (gen_random_uuid(), '${roleName}', 'E2E grant ${roleName.slice(-12)}',
            'E2E ceiling seed (PLAN-0610 W6/T6.1)', FALSE)
    ON CONFLICT (name) DO UPDATE SET updated_at = NOW()
    RETURNING id INTO v_role;

    ${permissionWrite}

    INSERT INTO role_bindings (id, role_id, subject_type, subject_id, scope_type)
    VALUES (gen_random_uuid(), v_role, 'user', '${user}'::uuid, 'instance')
    ON CONFLICT ON CONSTRAINT uq_role_bindings DO NOTHING;

    -- Recompute the union of every binding (the materializer's output shape) so a replace/remove
    -- never leaves a stale atom behind. DISTINCT ON collapses atoms shared by two instance roles
    -- (e.g. the seeded E2E role and the registration USER role both granting read/write).
    DELETE FROM grants
    WHERE subject_type = 'user' AND subject_id = '${user}'::uuid AND source = 'role';

    INSERT INTO grants (id, granter_type, granter_id, subject_type, subject_id, permissions,
                        source, scope_type, scope_id, read_state)
    SELECT DISTINCT ON (b.scope_type, b.scope_id, rp.action_class, rp.resource_pattern)
           gen_random_uuid(),
           CASE WHEN b.scope_type = 'instance' THEN 'user' END,
           CASE WHEN b.scope_type = 'instance' THEN '${user}'::uuid END,
           'user', '${user}'::uuid,
           jsonb_build_array(
               jsonb_build_object('actionClass', rp.action_class)
               || CASE WHEN rp.resource_pattern = '*'
                       THEN '{}'::jsonb
                       ELSE jsonb_build_object('resource', rp.resource_pattern) END
           ),
           'role', b.scope_type, b.scope_id, 'read'
    FROM role_bindings b
    JOIN role_permissions rp ON rp.role_id = b.role_id
    WHERE b.subject_type = 'user' AND b.subject_id = '${user}'::uuid
      AND rp.action_class NOT LIKE '%:%'
    ORDER BY b.scope_type, b.scope_id, rp.action_class, rp.resource_pattern;
END $$;`;
    execFileSync(
        process.platform === "win32" ? "docker.exe" : "docker",
        ["exec", container, "psql", "-X", "-A", "-t", "-U", dbUser, "-d", database, "-c", sql],
        { encoding: "utf8", timeout: 20_000, windowsHide: true },
    );
}

/**
 * PLAN-0610 W3-3: rewrites the subject's workspace-scope membership (one binding per workspace).
 *
 * The member surface, the tenant gate, D9 and the grant evaluation all read the workspace-scope
 * role binding now, so a negative case that used to rely on "the owner has no
 * MANAGE_WORKSPACE_AGENTS" must first move that subject to a role that really lacks it — the
 * workspace creator receives `WS_OWNER` automatically. This helper deletes the subject's
 * workspace-tier binding for that workspace, inserts the requested one and recomputes the
 * materialized `source='role'` rows of the workspace scope (the materializer's output shape).
 */
export function replaceWorkspaceRole(
    userId: string,
    workspaceId: string,
    roleName: "WS_OWNER" | "WS_EDITOR" | "WS_VIEWER",
): void {
    const container = process.env.XIHE_E2E_PG_CONTAINER,
        database = process.env.XIHE_E2E_PG_DATABASE,
        dbUser = process.env.XIHE_E2E_PG_USER;
    if (!container || !database || !dbUser) {
        throw new Error(
            "isolated PostgreSQL fixture metadata is unavailable; run through scripts/e2e-host.mjs",
        );
    }
    const user = escapeSql(userId);
    const workspace = escapeSql(workspaceId);
    const role = escapeSql(roleName);
    const sql = `
DO $$
DECLARE
    v_role UUID;
BEGIN
    SELECT id INTO v_role FROM roles WHERE name = '${role}';
    IF v_role IS NULL THEN
        RAISE EXCEPTION 'workspace role % is missing', '${role}';
    END IF;

    DELETE FROM role_bindings
    WHERE subject_type = 'user' AND subject_id = '${user}'::uuid
      AND scope_type = 'workspace' AND scope_id = '${workspace}'::uuid;

    INSERT INTO role_bindings (id, role_id, subject_type, subject_id, scope_type, scope_id)
    VALUES (gen_random_uuid(), v_role, 'user', '${user}'::uuid, 'workspace',
            '${workspace}'::uuid);

    DELETE FROM grants
    WHERE subject_type = 'user' AND subject_id = '${user}'::uuid AND source = 'role'
      AND scope_type = 'workspace' AND scope_id = '${workspace}'::uuid;

    INSERT INTO grants (id, granter_type, granter_id, subject_type, subject_id, permissions,
                        source, scope_type, scope_id, read_state)
    SELECT gen_random_uuid(),
           CASE WHEN b.scope_type = 'instance' THEN 'user' END,
           CASE WHEN b.scope_type = 'instance' THEN '${user}'::uuid END,
           'user', '${user}'::uuid,
           jsonb_build_array(
               jsonb_build_object('actionClass', rp.action_class)
               || CASE WHEN rp.resource_pattern = '*'
                       THEN '{}'::jsonb
                       ELSE jsonb_build_object('resource', rp.resource_pattern) END
           ),
           'role', b.scope_type, b.scope_id, 'read'
    FROM role_bindings b
    JOIN role_permissions rp ON rp.role_id = b.role_id
    WHERE b.subject_type = 'user' AND b.subject_id = '${user}'::uuid
      AND b.scope_type = 'workspace' AND b.scope_id = '${workspace}'::uuid
      AND rp.action_class NOT LIKE '%:%';
END $$;`;
    execFileSync(
        process.platform === "win32" ? "docker.exe" : "docker",
        ["exec", container, "psql", "-X", "-A", "-t", "-U", dbUser, "-d", database, "-c", sql],
        { encoding: "utf8", timeout: 20_000, windowsHide: true },
    );
}

function escapeSql(value: string): string {
    return value.replaceAll("'", "''");
}
