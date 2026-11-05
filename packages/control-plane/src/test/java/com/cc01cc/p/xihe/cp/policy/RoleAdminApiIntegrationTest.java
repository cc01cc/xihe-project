package com.cc01cc.p.xihe.cp.policy;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.config.JwtTokenProvider;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.client.RestTemplate;

/**
 * PLAN-0610 W3-2a: the access-role administration surface on real PostgreSQL.
 *
 * <p>Every case goes through the public HTTP API (the authorization gate included) with SQL-built
 * fixtures — the role model is a database fact, so the fixture writes bindings directly and the
 * behaviour under test stays the HTTP contract. The caller roles exercised here:</p>
 *
 * <ul>
 *   <li><b>super</b> — instance {@code SUPER_ADMIN} binding: holds {@code MANAGE_ROLES} and every
 *       other atom;</li>
 *   <li><b>role-manager</b> — a custom instance role with {@code MANAGE_ROLES} + {@code read} only:
 *       proves the escalation check ({@code 403 PRIVILEGE_ESCALATION});</li>
 *   <li><b>instance admin</b> — {@code cap:instance:admin} but no {@code MANAGE_ROLES}: proves the
 *       gate is the action atom, not the capability (decision #23);</li>
 *   <li><b>plain user</b> — no binding at all.</li>
 * </ul>
 */
class RoleAdminApiIntegrationTest extends AbstractIntegrationTest {

    private static final String PASSWORD = "Roles-pass-1";

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private AuthzContext authzContext;

    @Autowired
    private JwtTokenProvider jwtTokenProvider;

    @org.springframework.beans.factory.annotation.Autowired
    private com.cc01cc.p.xihe.cp.integration.WorkspaceFixture workspaceFixture;

    @Autowired
    private RoleGrantMaterializer materializer;

    private RestTemplate api;

    @BeforeEach
    void resetState() {
        api = new RestTemplate(new JdkClientHttpRequestFactory());
        api.setErrorHandler(new org.springframework.web.client.DefaultResponseErrorHandler() {
            @Override
            public boolean hasError(org.springframework.http.HttpStatusCode statusCode) {
                return statusCode.is5xxServerError();
            }
        });
        // Custom roles from earlier cases must not survive: they would change the catalog counts.
        jdbc.update("DELETE FROM role_bindings WHERE role_id IN"
                + " (SELECT id FROM roles WHERE is_system = false)");
        jdbc.update("DELETE FROM role_permissions WHERE role_id IN"
                + " (SELECT id FROM roles WHERE is_system = false)");
        jdbc.update("DELETE FROM roles WHERE is_system = false");
        jdbc.update("DELETE FROM role_bindings WHERE scope_type = 'workspace' AND scope_id IN"
                + " (SELECT id FROM workspaces WHERE name LIKE 'role-api-%')");
        jdbc.update("DELETE FROM workspaces WHERE name LIKE 'role-api-%'");
    }

    // ── catalog ─────────────────────────────────────────────────────────────

    @Test
    void catalogExposesTheAtomVocabularyWithScopeClasses() throws Exception {
        String superToken = superAdmin("catalog-admin@test.com");

        ResponseEntity<String> response = call(HttpMethod.GET, "/api/v1/roles/catalog", null,
                superToken);
        assertEquals(HttpStatus.OK, response.getStatusCode(), response.getBody());
        JsonNode body = objectMapper.readTree(response.getBody());
        JsonNode atoms = body.path("atoms");
        // Derived, never a hard-coded count: the catalog is the union of the action atoms and the
        // capability atoms, and PLAN-0622 D8 appended CREATE_OWN_AGENT to the action atoms.
        assertEquals(PermissionAtomCatalog.actionAtoms().size() + PermissionAtomCatalog.capabilityAtoms().size(),
                atoms.size(), "catalog = every action atom plus every capability atom");
        assertEquals(List.of("instance", "workspace"), texts(body.path("scopes")));

        Map<String, JsonNode> byName = new LinkedHashMap<>();
        atoms.forEach(atom -> byName.put(atom.path("name").asText(), atom));
        assertEquals(PermissionAtomCatalog.actionAtoms().subList(0, 5),
                texts(atoms).subList(0, 5), "action atoms keep the canonical order");
        assertEquals("instance", byName.get("MANAGE_ROLES").path("scopeClass").asText());
        assertFalse(byName.get("MANAGE_ROLES").path("capability").asBoolean());
        assertEquals("both", byName.get("MANAGE_WORKSPACE_AGENTS").path("scopeClass").asText());
        assertTrue(byName.get("instance:admin").path("capability").asBoolean());
        assertEquals("instance", byName.get("instance:admin").path("scopeClass").asText());
        assertEquals("both", byName.get("workspace:admin").path("scopeClass").asText());
        // PLAN-0622 D8: the user-tier "create your own agent" atom must be in the catalog and is
        // instance-bindable only — a workspace binding would mean "create agents for the workspace".
        JsonNode ownAgent = byName.get(ToolFaceRegistry.ACTION_OWN_AGENT);
        assertNotNull(ownAgent, "D8: CREATE_OWN_AGENT is part of the catalog");
        assertEquals("instance", ownAgent.path("scopeClass").asText(),
                "D8: CREATE_OWN_AGENT is a user-tier atom, bindable only at the instance scope");
        assertFalse(ownAgent.path("capability").asBoolean(),
                "D8: it is an action atom, not a capability authority");
        assertEquals(PermissionAtomCatalog.capabilityAtoms().size(), atoms.findValues("capability").stream()
                .filter(JsonNode::asBoolean).count(), "exactly the catalog's capability atoms");
    }

    // ── role CRUD ───────────────────────────────────────────────────────────

    @Test
    void customRolesAreCreatedEditedAndDeleted() throws Exception {
        String superToken = superAdmin("crud-admin@test.com");

        ResponseEntity<String> created = call(HttpMethod.POST, "/api/v1/roles",
                Map.of("name", "AUDITOR", "displayName", "Auditor",
                        "description", "read only role", "atoms", List.of("read")), superToken);
        assertEquals(HttpStatus.CREATED, created.getStatusCode(), created.getBody());
        JsonNode role = objectMapper.readTree(created.getBody());
        String roleId = role.path("id").asText();
        assertFalse(role.path("system").asBoolean());
        assertEquals(List.of("read"), texts(role.path("atoms")));

        ResponseEntity<String> duplicate = call(HttpMethod.POST, "/api/v1/roles",
                Map.of("name", "AUDITOR", "atoms", List.of("read")), superToken);
        assertEquals(HttpStatus.CONFLICT, duplicate.getStatusCode());
        assertTrue(duplicate.getBody().contains("ROLE_NAME_EXISTS"), duplicate.getBody());

        ResponseEntity<String> unknownAtom = call(HttpMethod.POST, "/api/v1/roles",
                Map.of("name", "BROKEN", "atoms", List.of("no_such_atom")), superToken);
        assertEquals(HttpStatus.BAD_REQUEST, unknownAtom.getStatusCode());
        assertTrue(unknownAtom.getBody().contains("UNKNOWN_ACTION_CLASS"), unknownAtom.getBody());

        ResponseEntity<String> emptyAtoms = call(HttpMethod.POST, "/api/v1/roles",
                Map.of("name", "EMPTY", "atoms", List.of()), superToken);
        assertEquals(HttpStatus.BAD_REQUEST, emptyAtoms.getStatusCode());
        assertTrue(emptyAtoms.getBody().contains("INVALID_ROLE_ATOMS"), emptyAtoms.getBody());

        ResponseEntity<String> patched = call(HttpMethod.PATCH, "/api/v1/roles/" + roleId,
                Map.of("displayName", "Auditor (read-only)",
                        "atoms", List.of("read", "exec")), superToken);
        assertEquals(HttpStatus.OK, patched.getStatusCode(), patched.getBody());
        JsonNode patchedBody = objectMapper.readTree(patched.getBody());
        assertEquals("Auditor (read-only)", patchedBody.path("displayName").asText());
        assertEquals(List.of("exec", "read"), texts(patchedBody.path("atoms")));

        ResponseEntity<String> deleted = call(HttpMethod.DELETE, "/api/v1/roles/" + roleId, null,
                superToken);
        assertEquals(HttpStatus.NO_CONTENT, deleted.getStatusCode(), deleted.getBody());
        assertEquals(0, countRows("SELECT COUNT(*) FROM role_permissions WHERE role_id ="
                + " CAST(? AS UUID)", roleId), "the atom rows go with the role");
    }

    @Test
    void systemRolesOnlyAcceptADisplayNameChange() throws Exception {
        String superToken = superAdmin("system-admin@test.com");
        String adminRoleId = roleId("ADMIN");

        ResponseEntity<String> renamed = call(HttpMethod.PATCH, "/api/v1/roles/" + adminRoleId,
                Map.of("displayName", "Instance Administrator"), superToken);
        assertEquals(HttpStatus.OK, renamed.getStatusCode(), renamed.getBody());
        assertEquals("Instance Administrator",
                objectMapper.readTree(renamed.getBody()).path("displayName").asText());

        ResponseEntity<String> atoms = call(HttpMethod.PATCH, "/api/v1/roles/" + adminRoleId,
                Map.of("atoms", List.of("read")), superToken);
        assertEquals(HttpStatus.CONFLICT, atoms.getStatusCode());
        assertTrue(atoms.getBody().contains("SYSTEM_ROLE_IMMUTABLE"), atoms.getBody());

        ResponseEntity<String> renamedName = call(HttpMethod.PATCH, "/api/v1/roles/" + adminRoleId,
                Map.of("name", "SUPERVISOR"), superToken);
        assertEquals(HttpStatus.CONFLICT, renamedName.getStatusCode());
        assertTrue(renamedName.getBody().contains("SYSTEM_ROLE_IMMUTABLE"));

        ResponseEntity<String> deleted = call(HttpMethod.DELETE, "/api/v1/roles/" + adminRoleId,
                null, superToken);
        assertEquals(HttpStatus.CONFLICT, deleted.getStatusCode());
        assertTrue(deleted.getBody().contains("SYSTEM_ROLE_IMMUTABLE"));

        // Restore the seeded display name so the shared database keeps the V87 state.
        jdbc.update("UPDATE roles SET display_name = 'Administrator' WHERE name = 'ADMIN'");
    }

    @Test
    void aBoundCustomRoleCannotBeDeleted() throws Exception {
        String superToken = superAdmin("inuse-admin@test.com");
        String roleId = createRole(superToken, "TEMP_READER", List.of("read"));
        String subjectId = userIdOf(register("inuse-subject@test.com"));

        assertEquals(HttpStatus.OK, appendInstanceBinding(superToken, subjectId, roleId).getStatusCode());

        ResponseEntity<String> deleted = call(HttpMethod.DELETE, "/api/v1/roles/" + roleId, null,
                superToken);
        assertEquals(HttpStatus.CONFLICT, deleted.getStatusCode());
        assertTrue(deleted.getBody().contains("ROLE_IN_USE"), deleted.getBody());

        List<Map<String, String>> remaining = new ArrayList<>(instanceBindings(superToken));
        remaining.removeIf(binding -> binding.get("subjectId").equals(subjectId));
        putBindings(superToken, "instance", null, remaining);
        assertEquals(HttpStatus.NO_CONTENT,
                call(HttpMethod.DELETE, "/api/v1/roles/" + roleId, null, superToken).getStatusCode());
    }

    // ── bindings ────────────────────────────────────────────────────────────

    @Test
    void workspaceBindingReplacementIsAFullIdempotentSet() throws Exception {
        String superToken = superAdmin("binding-admin@test.com");
        String workspaceId = createWorkspace(superToken);
        String subjectId = userIdOf(register("binding-subject@test.com"));
        String viewerRoleId = roleId("WS_VIEWER");

        List<Map<String, String>> desired = new ArrayList<>(
                workspaceBindings(superToken, workspaceId));
        assertTrue(desired.stream().anyMatch(binding -> binding.get("roleId").equals(roleId("WS_OWNER"))),
                "the creator's WS_OWNER binding is part of the workspace set");
        desired.add(Map.of("subjectId", subjectId, "roleId", viewerRoleId));

        ResponseEntity<String> first = putBindings(superToken, "workspace", workspaceId, desired);
        assertEquals(HttpStatus.OK, first.getStatusCode(), first.getBody());
        JsonNode firstBody = objectMapper.readTree(first.getBody());
        assertEquals("workspace", firstBody.path("scopeType").asText());
        assertEquals(workspaceId, firstBody.path("scopeId").asText());
        assertEquals(desired.size(), firstBody.path("bindings").size());
        assertEquals(2, firstBody.path("bindings").size(),
                "the workspace owner binding plus the granted viewer");
        int epochAfterFirst = tokenVersion(subjectId);
        int auditsAfterFirst = auditCount("role_bindings_replaced");
        assertEquals(RoleAtomExpectations.materializedAtomCount(SystemAccessRoleCatalog.WS_VIEWER),
                grantRows(subjectId, "workspace", workspaceId),
                "WS_VIEWER materializes one row per catalog atom (0651 M2 added USE_WORKSPACE_RUNTIME)");
        assertEquals(0, epochAfterFirst,
                "PLAN-0610 W3-3: a workspace-tier binding does not move the epoch — the token "
                        + "carries no workspace role, so only the capability cache is invalidated");

        // Same body again: a true no-op (no epoch bump, no audit row, no second binding).
        ResponseEntity<String> second = putBindings(superToken, "workspace", workspaceId, desired);
        assertEquals(HttpStatus.OK, second.getStatusCode(), second.getBody());
        assertEquals(desired.size(), objectMapper.readTree(second.getBody()).path("bindings").size());
        assertEquals(epochAfterFirst, tokenVersion(subjectId), "idempotent PUT must not bump");
        assertEquals(auditsAfterFirst, auditCount("role_bindings_replaced"));

        // The read surface returns the same set.
        ResponseEntity<String> listed = call(HttpMethod.GET,
                "/api/v1/bindings?scope=workspace&scopeId=" + workspaceId, null, superToken);
        assertEquals(HttpStatus.OK, listed.getStatusCode());
        assertEquals(desired.size(), objectMapper.readTree(listed.getBody()).path("bindings").size());

        // Dropping the granted binding (keeping the workspace owner) clears the subject's atoms.
        List<Map<String, String>> ownersOnly = new ArrayList<>(desired);
        ownersOnly.removeIf(binding -> binding.get("subjectId").equals(subjectId));
        ResponseEntity<String> cleared = putBindings(superToken, "workspace", workspaceId,
                ownersOnly);
        assertEquals(1, objectMapper.readTree(cleared.getBody()).path("bindings").size(),
                "only the workspace owner is left");
        assertEquals(0, grantRows(subjectId, "workspace", workspaceId));
    }

    @Test
    void instanceBindingReplacementKeepsTheSuperAdminAndIsIdempotent() throws Exception {
        String superToken = superAdmin("instance-binding-admin@test.com");
        String superId = userIdOf(superToken);
        String roleId = createRole(superToken, "REPORT_READER", List.of("read"));
        String subjectId = userIdOf(register("instance-binding-subject@test.com"));

        List<Map<String, String>> desired = new ArrayList<>(instanceBindings(superToken));
        assertTrue(desired.stream().anyMatch(binding ->
                        binding.get("subjectId").equals(superId)),
                "the caller's own SUPER_ADMIN binding is part of the full set");
        desired.add(Map.of("subjectId", subjectId, "roleId", roleId));

        ResponseEntity<String> first = putBindings(superToken, "instance", null, desired);
        assertEquals(HttpStatus.OK, first.getStatusCode(), first.getBody());
        JsonNode firstBody = objectMapper.readTree(first.getBody());
        assertEquals(desired.size(), firstBody.path("bindings").size());
        int epochAfterFirst = tokenVersion(subjectId);
        int auditsAfterFirst = auditCount("role_bindings_replaced");
        assertEquals(2, bindingRows(subjectId),
                "the registration USER tier plus the new role");

        // Re-sending the same set is a no-op, and the caller's own binding survives.
        ResponseEntity<String> second = putBindings(superToken, "instance", null, desired);
        assertEquals(HttpStatus.OK, second.getStatusCode(), second.getBody());
        assertEquals(epochAfterFirst, tokenVersion(subjectId));
        assertEquals(auditsAfterFirst, auditCount("role_bindings_replaced"));
        assertTrue(authzContext.authoritiesFor(UUID.fromString(superId))
                        .contains("cap:instance:super"),
                "the caller keeps cap:instance:super after its own full-set write");

        // Removing the extra binding again (keeping the super admin and the USER tier) is allowed.
        List<Map<String, String>> withoutExtra = new ArrayList<>(instanceBindings(superToken));
        withoutExtra.removeIf(binding -> binding.get("subjectId").equals(subjectId)
                && binding.get("roleId").equals(roleId));
        ResponseEntity<String> removed = putBindings(superToken, "instance", null,
                withoutExtra);
        assertEquals(HttpStatus.OK, removed.getStatusCode(), removed.getBody());
        assertEquals(1, bindingRows(subjectId), "only the registration USER tier is left");
    }

    @Test
    void instanceBindingReplacementCannotDropTheLastSuperAdmin() throws Exception {
        String superToken = superAdmin("last-super-admin@test.com");
        List<Map<String, String>> before = instanceBindings(superToken);

        ResponseEntity<String> denied = putBindings(superToken, "instance", null, List.of());
        assertEquals(HttpStatus.CONFLICT, denied.getStatusCode(), denied.getBody());
        assertTrue(denied.getBody().contains("LAST_SUPER_ADMIN"), denied.getBody());
        assertEquals(before, instanceBindings(superToken),
                "the refused replacement must leave every binding in place");
    }

    @Test
    void workspaceBindingsRequireAScopeCompatibleRole() throws Exception {
        String superToken = superAdmin("ws-binding-admin@test.com");
        String workspaceId = createWorkspace(superToken);
        String subjectId = userIdOf(register("ws-binding-subject@test.com"));
        String viewerRoleId = roleId("WS_VIEWER");

        List<Map<String, String>> set = new ArrayList<>(workspaceBindings(superToken, workspaceId));
        set.add(Map.of("subjectId", subjectId, "roleId", viewerRoleId));
        ResponseEntity<String> ok = putBindings(superToken, "workspace", workspaceId, set);
        assertEquals(HttpStatus.OK, ok.getStatusCode(), ok.getBody());
        assertEquals(workspaceId, objectMapper.readTree(ok.getBody()).path("scopeId").asText());

        // An instance-only atom cannot be bound in a workspace (decision #12 / #27).
        String instanceOnlyRoleId = createRole(superToken, "INSTANCE_READER",
                List.of("read", "MANAGE_ROLES"));
        List<Map<String, String>> mismatchSet = new ArrayList<>(set);
        mismatchSet.removeIf(binding -> binding.get("subjectId").equals(subjectId));
        mismatchSet.add(Map.of("subjectId", subjectId, "roleId", instanceOnlyRoleId));
        ResponseEntity<String> mismatch = putBindings(superToken, "workspace", workspaceId,
                mismatchSet);
        assertEquals(HttpStatus.BAD_REQUEST, mismatch.getStatusCode(), mismatch.getBody());
        assertTrue(mismatch.getBody().contains("ROLE_SCOPE_MISMATCH"), mismatch.getBody());

        // Scope selectors are validated, never trusted.
        assertEquals(HttpStatus.BAD_REQUEST,
                call(HttpMethod.GET, "/api/v1/bindings?scope=instance&scopeId=" + workspaceId,
                        null, superToken).getStatusCode());
        assertEquals(HttpStatus.BAD_REQUEST,
                call(HttpMethod.GET, "/api/v1/bindings?scope=workspace", null, superToken)
                        .getStatusCode());
        assertEquals(HttpStatus.NOT_FOUND,
                call(HttpMethod.GET, "/api/v1/bindings?scope=workspace&scopeId=" + UUID.randomUUID(),
                        null, superToken).getStatusCode());
    }

    // ── gates ───────────────────────────────────────────────────────────────

    /**
     * D-168 (user ruling 2026-11-05, migration V125): ADMIN now holds {@code MANAGE_ROLES}, so the
     * old "ADMIN has no MANAGE_ROLES ⇒ blanket 403" assertion is a fact this round deliberately
     * changed. Recorded here as an approved semantic change (not a masked failure): the gate is
     * still the action atom, and the subset guard is now what bounds ADMIN.
     *
     * <p>Core negative (V3.3): ADMIN cannot create a role carrying {@code GRANT_ANY_ATOM} — it does
     * not hold the bypass atom, so {@code GrantabilityGuard} answers 403 {@code PRIVILEGE_ESCALATION}
     * and names it.</p>
     */
    @Test
    void theGateIsTheManageRolesAtomWhichAdminNowHoldsBoundedByTheSubset() throws Exception {
        String superToken = superAdmin("gate-admin@test.com");
        String adminId = userIdOf(register("gate-instance-admin@test.com"));
        grantInstanceRole(adminId, "ADMIN");
        String adminToken = login("gate-instance-admin@test.com");
        assertTrue(authzContext.isInstanceAdmin(UUID.fromString(adminId)));

        for (String path : List.of("/api/v1/roles/catalog",
                "/api/v1/bindings?scope=instance")) {
            assertEquals(HttpStatus.OK,
                    call(HttpMethod.GET, path, null, adminToken).getStatusCode(),
                    "ADMIN holds MANAGE_ROLES since V125 (D-168): " + path);
        }
        assertEquals(HttpStatus.OK,
                call(HttpMethod.GET, "/api/v1/roles", null, adminToken).getStatusCode());

        // Positive (V3.1): within its own atom set (read is a USER-default atom) ADMIN may create.
        assertEquals(HttpStatus.CREATED, call(HttpMethod.POST, "/api/v1/roles",
                        Map.of("name", "ADMIN_MADE", "atoms", List.of("read")), adminToken)
                        .getStatusCode(),
                "ADMIN may delegate atoms it holds");

        // Negative (V3.2 / M2+M3 core): GRANT_ANY_ATOM is SUPER_ADMIN-only ⇒ 403 + atom named.
        ResponseEntity<String> escalated = call(HttpMethod.POST, "/api/v1/roles",
                Map.of("name", "ADMIN_ESCALATED", "atoms", List.of("GRANT_ANY_ATOM")), adminToken);
        assertEquals(HttpStatus.FORBIDDEN, escalated.getStatusCode(),
                "ADMIN cannot grant the subset bypass it does not hold: " + escalated.getBody());
        assertTrue(String.valueOf(escalated.getBody()).contains("GRANT_ANY_ATOM"),
                "the refusal names the exceeding atom: " + escalated.getBody());

        String plainToken = register("gate-plain@test.com");
        assertEquals(HttpStatus.FORBIDDEN,
                call(HttpMethod.GET, "/api/v1/roles", null, plainToken).getStatusCode());

        // A custom instance role carrying only MANAGE_ROLES + read passes the gate.
        String managerId = userIdOf(register("gate-role-manager@test.com"));
        createRole(superToken, "ROLE_MANAGER", List.of("MANAGE_ROLES", "read"));
        // Replace the registration USER tier so the only atoms this manager holds are the two
        // above (the tier would otherwise add read/write/delete/exec/network).
        grantInstanceRole(managerId, "ROLE_MANAGER");
        String managerToken = login("gate-role-manager@test.com");
        assertEquals(HttpStatus.OK,
                call(HttpMethod.GET, "/api/v1/roles/catalog", null, managerToken).getStatusCode());
    }

    @Test
    void grantingAtomsTheCallerDoesNotHoldIsAPrivilegeEscalation() throws Exception {
        String superToken = superAdmin("escalation-admin@test.com");
        String managerId = userIdOf(register("escalation-manager@test.com"));
        createRole(superToken, "LIMITED_ROLE_MANAGER", List.of("MANAGE_ROLES", "read"));
        // Only MANAGE_ROLES + read: the registration USER tier is replaced, otherwise exec/write
        // would come along and the escalation assertions below would pass for the wrong reason.
        grantInstanceRole(managerId, "LIMITED_ROLE_MANAGER");
        String managerToken = login("escalation-manager@test.com");

        // The manager holds read + MANAGE_ROLES, so a read-only role is grantable…
        String readerRoleId = createRole(superToken, "ESC_READER", List.of("read"));
        String subjectId = userIdOf(register("escalation-subject@test.com"));
        assertEquals(HttpStatus.OK, appendInstanceBinding(managerToken, subjectId, readerRoleId)
                .getStatusCode());

        // …but executing and spawning are not: it cannot hand out what it does not hold.
        String execRoleId = createRole(superToken, "ESC_EXEC", List.of("exec"));
        ResponseEntity<String> escalation = appendInstanceBinding(managerToken, subjectId, execRoleId);
        assertEquals(HttpStatus.FORBIDDEN, escalation.getStatusCode(), escalation.getBody());
        assertTrue(escalation.getBody().contains("PRIVILEGE_ESCALATION"), escalation.getBody());

        // The capability atom is compared against the caller's real capability, not its atom list.
        String superGrantId = roleId("SUPER_ADMIN");
        ResponseEntity<String> capabilityEscalation =
                appendInstanceBinding(managerToken, subjectId, superGrantId);
        assertEquals(HttpStatus.FORBIDDEN, capabilityEscalation.getStatusCode());
        assertTrue(capabilityEscalation.getBody().contains("PRIVILEGE_ESCALATION"),
                capabilityEscalation.getBody());
    }

    // ── fixtures / helpers ──────────────────────────────────────────────────

    private String superAdmin(String email) throws Exception {
        register(email);
        String userId = userIdOf(login(email));
        grantInstanceRole(userId, "SUPER_ADMIN");
        return login(email);
    }

    private String createRole(String token, String name, List<String> atoms) throws Exception {
        ResponseEntity<String> created = call(HttpMethod.POST, "/api/v1/roles",
                Map.of("name", name, "displayName", name, "atoms", atoms), token);
        assertEquals(HttpStatus.CREATED, created.getStatusCode(), created.getBody());
        return objectMapper.readTree(created.getBody()).path("id").asText();
    }

    /** The current instance-scope set as PUT-ready pairs (full-set semantics need the basis). */
    private List<Map<String, String>> instanceBindings(String token) throws Exception {
        ResponseEntity<String> listed = call(HttpMethod.GET, "/api/v1/bindings?scope=instance",
                null, token);
        assertEquals(HttpStatus.OK, listed.getStatusCode(), listed.getBody());
        List<Map<String, String>> pairs = new ArrayList<>();
        for (JsonNode binding : objectMapper.readTree(listed.getBody()).path("bindings")) {
            pairs.add(Map.of("subjectId", binding.path("subjectId").asText(),
                    "roleId", binding.path("roleId").asText()));
        }
        return pairs;
    }

    /** The current workspace-scope set as PUT-ready pairs. */
    private List<Map<String, String>> workspaceBindings(String token, String workspaceId)
            throws Exception {
        ResponseEntity<String> listed = call(HttpMethod.GET,
                "/api/v1/bindings?scope=workspace&scopeId=" + workspaceId, null, token);
        assertEquals(HttpStatus.OK, listed.getStatusCode(), listed.getBody());
        List<Map<String, String>> pairs = new ArrayList<>();
        for (JsonNode binding : objectMapper.readTree(listed.getBody()).path("bindings")) {
            pairs.add(Map.of("subjectId", binding.path("subjectId").asText(),
                    "roleId", binding.path("roleId").asText()));
        }
        return pairs;
    }

    private ResponseEntity<String> appendInstanceBinding(String token, String subjectId,
                                                         String roleId) throws Exception {
        List<Map<String, String>> desired = new ArrayList<>(instanceBindings(token));
        desired.add(Map.of("subjectId", subjectId, "roleId", roleId));
        return putBindings(token, "instance", null, desired);
    }

    /** Materialized role atoms of one scope (`scopeId` null = every workspace of that type). */
    private int grantRows(String subjectId, String scopeType, String scopeId) {
        return countRows("SELECT COUNT(*) FROM grants WHERE subject_id = CAST(? AS UUID)"
                        + " AND source = ? AND scope_type = ?"
                        + (scopeId == null ? "" : " AND scope_id = CAST(? AS UUID)"),
                scopeId == null
                        ? new Object[] {subjectId, "role", scopeType}
                        : new Object[] {subjectId, "role", scopeType, scopeId});
    }

    /** Instance-scope binding rows of one subject (workspace memberships excluded). */
    private int bindingRows(String subjectId) {
        return countRows("SELECT COUNT(*) FROM role_bindings WHERE subject_id = CAST(? AS UUID)"
                + " AND scope_type = 'instance'", subjectId);
    }

    private ResponseEntity<String> putBindings(String token, String scope, String scopeId,
                                               List<Map<String, String>> bindings) {
        String path = "/api/v1/bindings?scope=" + scope
                + (scopeId == null ? "" : "&scopeId=" + scopeId);
        return call(HttpMethod.PUT, path, Map.of("bindings", bindings), token);
    }

    private String createWorkspace(String token) throws Exception {
        // PLAN-0618: the public create route requires an explicit direct_attach payload + Runtime probe;
        // these tests exercise the role API, so the carrier workspace comes from the fixture instead.
        return workspaceFixture.createOwnedWorkspace("role-api-" + UUID.randomUUID(), userIdOf(token))
                .getId().toString();
    }

    private ResponseEntity<String> call(HttpMethod method, String path, Object body, String token) {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.setBearerAuth(token);
        return api.exchange(url(path), method, new HttpEntity<>(body, headers), String.class);
    }

    private String register(String email) throws Exception {
        ResponseEntity<String> response = api.postForEntity(url("/api/v1/auth/register"),
                Map.of("email", email, "password", PASSWORD, "name", "Roles"), String.class);
        assertEquals(HttpStatus.CREATED, response.getStatusCode(), response.getBody());
        return objectMapper.readTree(response.getBody()).path("accessToken").asText();
    }

    private String login(String email) throws Exception {
        ResponseEntity<String> response = api.postForEntity(url("/api/v1/auth/login"),
                Map.of("identifier", email, "password", PASSWORD), String.class);
        assertEquals(HttpStatus.OK, response.getStatusCode(), response.getBody());
        return objectMapper.readTree(response.getBody()).path("accessToken").asText();
    }

    private String userIdOf(String token) {
        return jwtTokenProvider.getUserIdFromToken(token);
    }

    private void grantInstanceRole(String userId, String roleName) {
        jdbc.update("DELETE FROM role_bindings WHERE subject_type = 'user'"
                + " AND subject_id = CAST(? AS UUID) AND scope_type = 'instance'", userId);
        jdbc.update("INSERT INTO role_bindings (id, role_id, subject_type, subject_id, scope_type,"
                        + " granted_at) SELECT CAST(? AS UUID), r.id, 'user', CAST(? AS UUID),"
                        + " 'instance', NOW() FROM roles r WHERE r.name = ?",
                UUID.randomUUID().toString(), userId, roleName);
        // SQL-written bindings have no grants yet: materialize them exactly like the bootstrap
        // path does, otherwise MANAGE_ROLES (an action atom, read from grants) stays invisible.
        materializer.materializeSubject(AuthzContext.SUBJECT_USER, UUID.fromString(userId), null,
                null);
        authzContext.invalidate(UUID.fromString(userId));
    }

    private String roleId(String name) {
        return jdbc.queryForObject("SELECT CAST(id AS VARCHAR) FROM roles WHERE name = ?",
                String.class, name);
    }

    private int tokenVersion(String userId) {
        return jdbc.queryForObject("SELECT token_version FROM users WHERE id = CAST(? AS UUID)",
                Integer.class, userId);
    }

    private int countRows(String sql, Object... args) {
        Integer count = jdbc.queryForObject(sql, Integer.class, args);
        return count == null ? 0 : count;
    }

    private int auditCount(String action) {
        return countRows("SELECT COUNT(*) FROM audit_logs WHERE action = ?", action);
    }

    private static List<String> texts(JsonNode array) {
        List<String> values = new ArrayList<>();
        array.forEach(node -> values.add(node.isObject() ? node.path("name").asText()
                : node.asText()));
        return values;
    }
}





