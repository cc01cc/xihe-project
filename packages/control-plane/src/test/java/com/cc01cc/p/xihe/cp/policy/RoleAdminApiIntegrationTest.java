package com.cc01cc.p.xihe.cp.policy;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.cc01cc.p.xihe.cp.AbstractReusableIntegrationTest;
import com.cc01cc.p.xihe.cp.config.JwtTokenProvider;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
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
class RoleAdminApiIntegrationTest extends AbstractReusableIntegrationTest {

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
        // capability atoms (BL-312 removed the former PLAN-0622 D8 atom from the action atoms).
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
        // PLAN-0750 M1 (G1, user ruling 2026-11-10): the atom is back with user-level semantics —
        // the roles/catalog face must list it again, as an instance-bindable action atom that is
        // also agent-principal-forbidden (not a capability).
        assertTrue(byName.containsKey("CREATE_OWN_AGENT"),
                "PLAN-0750 M1: the user-level create atom is part of the catalog vocabulary");
        assertEquals("instance", byName.get("CREATE_OWN_AGENT").path("scopeClass").asText(),
                "creating one's own principal produced no binding, so the atom is instance-bindable only");
        assertFalse(byName.get("CREATE_OWN_AGENT").path("capability").asBoolean(),
                "it is an action atom, not a capability atom");
        assertEquals(PermissionAtomCatalog.capabilityAtoms().size(), atoms.findValues("capability").stream()
                .filter(JsonNode::asBoolean).count(), "exactly the catalog's capability atoms");
    }

    // ── task-415 (RBAC P0-1① / P1-2): the catalog's two missing projections ────

    @Test
    void catalogProjectsTheAgentPrincipalForbiddenFlag() throws Exception {
        String superToken = superAdmin("catalog-forbidden@test.com");

        ResponseEntity<String> response = call(HttpMethod.GET, "/api/v1/roles/catalog", null, superToken);
        assertEquals(HttpStatus.OK, response.getStatusCode(), response.getBody());
        JsonNode atoms = objectMapper.readTree(response.getBody()).path("atoms");
        assertTrue(atoms.size() > 0, "the catalog is not empty");

        // Derived from the SSOT, never a hard-coded list: every atom's flag must equal the catalog's
        // own membership test, and the number of true flags must equal the forbidden set's size.
        Set<String> forbidden = PermissionAtomCatalog.agentPrincipalForbiddenAtoms();
        int trueFlags = 0;
        for (JsonNode atom : atoms) {
            String name = atom.path("name").asText();
            assertTrue(atom.has("agentPrincipalForbidden"),
                    "task-415: the flag must be on the wire for " + name);
            assertEquals(forbidden.contains(name), atom.path("agentPrincipalForbidden").asBoolean(),
                    "the projected flag must equal PermissionAtomCatalog's membership for " + name);
            if (atom.path("agentPrincipalForbidden").asBoolean()) {
                trueFlags++;
            }
        }
        assertEquals(forbidden.size(), trueFlags,
                "every agent-forbidden atom is visible as such (the UI can pre-disable the bind)");
        assertTrue(trueFlags > 0, "the forbidden set is not empty");
        // Two concrete readings, both verified against AGENT_FORBIDDEN_ATOMS:
        JsonNode createOwn = findAtom(atoms, "CREATE_OWN_AGENT");
        assertTrue(createOwn.path("agentPrincipalForbidden").asBoolean(),
                "PLAN-0750 M1: creating a principal is account-level, never agent-bindable");
        JsonNode wsAgents = findAtom(atoms, "MANAGE_WORKSPACE_AGENTS");
        assertTrue(wsAgents.path("agentPrincipalForbidden").asBoolean(),
                "workspace agent management is a human administration face");
        // And a non-forbidden atom really reports false (not a constant true).
        JsonNode allowed = null;
        for (JsonNode atom : atoms) {
            if (!forbidden.contains(atom.path("name").asText())) {
                allowed = atom;
                break;
            }
        }
        assertNotNull(allowed, "the catalog has at least one agent-bindable atom");
        assertFalse(allowed.path("agentPrincipalForbidden").asBoolean(),
                "an agent-bindable atom must report false: " + allowed.path("name").asText());
    }

    @Test
    void catalogExposesTheBuiltInDefaultGrantSets() throws Exception {
        String superToken = superAdmin("catalog-defaults@test.com");

        ResponseEntity<String> response = call(HttpMethod.GET, "/api/v1/roles/catalog", null, superToken);
        assertEquals(HttpStatus.OK, response.getStatusCode(), response.getBody());
        JsonNode body = objectMapper.readTree(response.getBody());
        JsonNode defaults = body.path("defaultGrants");
        List<SystemAccessRoleCatalog.RoleSeed> seeds = SystemAccessRoleCatalog.roleSeeds();
        assertEquals(seeds.size(), defaults.size(),
                "task-415: one default grant set per built-in role seed");

        Map<String, JsonNode> byRole = new LinkedHashMap<>();
        for (int i = 0; i < seeds.size(); i++) {
            assertEquals(seeds.get(i).name(), defaults.get(i).path("roleName").asText(),
                    "seed order is kept (instance tier first)");
            byRole.put(defaults.get(i).path("roleName").asText(), defaults.get(i));
        }
        // The fixed administrator set is visible: instance:admin is a default grant of ADMIN.
        assertTrue(texts(byRole.get("ADMIN").path("atoms")).contains("instance:admin"),
                "instance:admin belongs to the fixed instance-administrator default set");
        assertFalse(texts(byRole.get("USER").path("atoms")).contains("instance:admin"),
                "a plain user is not an instance administrator by default");
        // Lead's flow-P0 question (ui-1 step 0): the instance-agent write gate needs BOTH halves, and
        // the administrator default set carries both — so a disabled button on a plain account is the
        // gate working, not a missing default grant.
        assertTrue(texts(byRole.get("ADMIN").path("atoms")).contains("MANAGE_AGENT_PRINCIPALS"),
                "ADMIN's default set carries the instance-agent write atom (SystemAccessRoleCatalog:159)");
        assertTrue(texts(byRole.get("SUPER_ADMIN").path("atoms")).contains("MANAGE_AGENT_PRINCIPALS"),
                "SUPER_ADMIN holds every action atom by construction");
        assertFalse(texts(byRole.get("USER").path("atoms")).contains("MANAGE_AGENT_PRINCIPALS"),
                "a plain account creates its OWN principal (CREATE_OWN_AGENT), not an instance one");
        assertTrue(texts(byRole.get("USER").path("atoms")).contains("CREATE_OWN_AGENT"),
                "PLAN-0750 M1: the user-level create atom is in the registration default set");
        // Every seeded atom name is part of the exposed vocabulary (no phantom default grant).
        Set<String> vocabulary = new LinkedHashSet<>(texts(body.path("atoms")));
        for (JsonNode grant : defaults) {
            for (String atom : texts(grant.path("atoms"))) {
                assertTrue(vocabulary.contains(atom),
                        "default grant atom must be in the catalog vocabulary: " + atom);
            }
        }
    }

    private static JsonNode findAtom(JsonNode atoms, String name) {
        for (JsonNode atom : atoms) {
            if (name.equals(atom.path("name").asText())) {
                return atom;
            }
        }
        throw new AssertionError("atom not in catalog: " + name);
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

    /**
     * BL-394: the service pattern must be the V87 {@code ck_roles_name_format} pattern. Names the
     * old looser pattern accepted (lowercase, dot, hyphen, leading digit, wrong length) used to
     * reach the INSERT and answer 500 INTERNAL_ERROR; the service now refuses them as field-level
     * 400s, and every name it accepts also lands in the database.
     */
    @Test
    void roleNamesFollowTheV87CheckConstraintInsteadOfFailingAtInsert() throws Exception {
        String superToken = superAdmin("name-format@test.com");

        List<String> rejected = List.of(
                "auditor", // lowercase: the old pattern allowed it, the DB does not
                "AUDITOR.1", // dot
                "AUDITOR-1", // hyphen
                "auditor_2", // lowercase with underscore
                "1AUDITOR", // leading digit
                "A", // shorter than the 2-char floor
                "A".repeat(65)); // longer than the 64-char ceiling
        for (String name : rejected) {
            ResponseEntity<String> refused = call(HttpMethod.POST, "/api/v1/roles",
                    Map.of("name", name, "atoms", List.of("read")), superToken);
            assertEquals(HttpStatus.BAD_REQUEST, refused.getStatusCode(),
                    name + " must be a field-level 400, not an INSERT failure: "
                            + refused.getBody());
            assertTrue(refused.getBody().contains("INVALID_ROLE_NAME"), refused.getBody());
            // Field-level information: the detail names `name`, the pattern and the DB constraint.
            assertTrue(refused.getBody().contains("name must match"), refused.getBody());
            assertTrue(refused.getBody().contains("ck_roles_name_format"), refused.getBody());
        }

        // Boundary names the constraint accepts both land and are usable (create → delete).
        for (String name : List.of("A2", "AUDITOR_2")) {
            ResponseEntity<String> created = call(HttpMethod.POST, "/api/v1/roles",
                    Map.of("name", name, "displayName", name, "atoms", List.of("read")),
                    superToken);
            assertEquals(HttpStatus.CREATED, created.getStatusCode(), created.getBody());
            String roleId = objectMapper.readTree(created.getBody()).path("id").asText();
            ResponseEntity<String> deleted = call(HttpMethod.DELETE, "/api/v1/roles/" + roleId,
                    null, superToken);
            assertEquals(HttpStatus.NO_CONTENT, deleted.getStatusCode(), deleted.getBody());
        }
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

    /**
     * PLAN-0673 V3.1 身份级正例（audit-1 §5.2 的整改项）：“ADMIN 能绑定”是产品承诺，而此前只有
     * 自定义 {@code ROLE_MANAGER}（同持 {@code MANAGE_ROLES}）的 HTTP 正/负例。
     *
     * <p>设计不变式是“门是原子不是角色名”，所以原子级证明是主证；本用例是**防退化**锁：一旦 ADMIN
     * 的原子集被收窄，这条会直接红，而不是让产品承诺悄悄消失。同时覆盖“绑定行真的落库”和
     * “ADMIN 仍不能绑定它没有的原子（{@code GRANT_ANY_ATOM}，仅 SUPER_ADMIN）”。</p>
     */
    @Test
    void adminBindsAUserRoleWithinItsOwnSubsetAndTheRowLands() throws Exception {
        String superToken = superAdmin("bind-super@test.com");
        String adminId = userIdOf(register("bind-admin@test.com"));
        grantInstanceRole(adminId, "ADMIN");
        String adminToken = login("bind-admin@test.com");
        String readerRoleId = createRole(superToken, "ADMIN_BIND_READER", List.of("read"));
        String subjectId = userIdOf(register("bind-subject@test.com"));
        int rowsBefore = bindingRows(subjectId);

        ResponseEntity<String> bound = appendInstanceBinding(adminToken, subjectId, readerRoleId);

        assertEquals(HttpStatus.OK, bound.getStatusCode(),
                "ADMIN holds MANAGE_ROLES + read ⇒ binding a read-only role is inside its subset: "
                        + bound.getBody());
        assertEquals(rowsBefore + 1, bindingRows(subjectId),
                "the binding row really landed (not just a 2xx)");
        assertTrue(instanceBindings(adminToken).stream().anyMatch(pair ->
                                subjectId.equals(pair.get("subjectId"))
                                        && readerRoleId.equals(pair.get("roleId"))),
                "the instance binding set reports the new pair");
        assertTrue(grantRows(subjectId, "instance", null) >= 1,
                "the subject's role atoms were materialized in the same transaction");

        // Same identity, outside its subset: GRANT_ANY_ATOM is SUPER_ADMIN-only (V2.1 fresh assertion).
        String bypassRoleId = createRole(superToken, "ADMIN_BIND_BYPASS", List.of("GRANT_ANY_ATOM"));
        ResponseEntity<String> denied = appendInstanceBinding(adminToken, subjectId, bypassRoleId);
        assertEquals(HttpStatus.FORBIDDEN, denied.getStatusCode(), denied.getBody());
        assertTrue(denied.getBody().contains("PRIVILEGE_ESCALATION"), denied.getBody());
        assertEquals(rowsBefore + 1, bindingRows(subjectId),
                "a refused bind inside the same identity writes nothing");
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





