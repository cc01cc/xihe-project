package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.AbstractReusableIntegrationTest;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.AccessRole;
import com.cc01cc.p.xihe.cp.entity.AccessRoleBinding;
import com.cc01cc.p.xihe.cp.entity.AccessRolePermission;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgentId;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.policy.AccessScope;
import com.cc01cc.p.xihe.cp.policy.GrantDefaultService;
import com.cc01cc.p.xihe.cp.policy.RoleGrantMaterializer;
import com.cc01cc.p.xihe.cp.policy.SystemAccessRoleCatalog;
import com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry;
import com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRolePermissionRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRoleRepository;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.Set;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0673 D-180 (方案 A): setWorkspaceCap's three gates with zero-write refusals.
 * cap = hard ceiling (intersection at resolveCapFor), role = reach, grantor subset in the TARGET
 * scope + agent-forbidden hard gate on the structural default binding.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class SetWorkspaceCapGateIntegrationTest extends AbstractReusableIntegrationTest {

    @Autowired private UserRepository userRepository;
    @Autowired private WorkspaceFixture workspaceFixture;
    @Autowired private GrantDefaultService grantDefaultService;
    @Autowired private AgentPrincipalService agentPrincipalService;
    @Autowired private AgentPrincipalRepository principalRepository;
    @Autowired private AccessRoleRepository accessRoleRepository;
    @Autowired private AccessRolePermissionRepository permissionRepository;
    @Autowired private AccessRoleBindingRepository bindingRepository;
    @Autowired private WorkspaceAgentRepository workspaceAgentRepository;
    @Autowired private RoleGrantMaterializer materializer;
    @Autowired private AgentTemplateService agentTemplateService;
    @Autowired private JdbcTemplate jdbcTemplate;

    @AfterEach
    void clearTenant() {
        com.cc01cc.p.xihe.cp.config.TenantContext.clear();
    }

    /** A→B: workspace-A authority must not authorize a workspace-B cap write (scoped union). */
    @Test
    void workspaceAAuthorityCannotWriteWorkspaceBCap() {
        User actor = newUser("a2b");
        grantDefaultService.ensureUserDefault(actor);
        User host = newUser("a2b-host");
        grantDefaultService.ensureUserDefault(host);
        Workspace wsA = workspaceFixture.createOwnedWorkspace("A2B A", actor.getId().toString());
        Workspace wsB = workspaceFixture.createOwnedWorkspace("A2B B", host.getId().toString());
        // Membership + the workspace management atom in B (so the ACTION gate passes there), while
        // N9 exists only in A — the pre-fix unscoped union let A's authority reach into B.
        workspaceFixture.bindWorkspaceRole(wsB.getId(), actor.getId(), WorkspaceRole.VIEWER);
        UUID manageInB = roleWith("TEST_A2B_MANAGE_B", ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_AGENTS);
        bindingRepository.save(new AccessRoleBinding(manageInB, "user", actor.getId(),
                AccessScope.WORKSPACE, wsB.getId(), actor.getId()));
        materializer.materializeSubject("user", actor.getId(), actor.getId(), wsB.getId().toString());
        UUID principal = newPrincipal(actor, "A2BP");

        // The principal holds N9 instance-wide; the actor holds it only in wsA (WS_OWNER of A).
        bindInstanceRole(principal, roleWith("TEST_A2B_N9", ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_POLICY),
                actor.getId());
        JsonNode cap = json("[{\"actionClass\":\"" + ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_POLICY
                + "\",\"resource\":\"*\"}]");

        CpApiException denied = assertThrows(CpApiException.class,
                () -> agentPrincipalService.setWorkspaceCap(actor.getId().toString(),
                        wsB.getId(), principal, cap));
        assertEquals("AGENT_PERMISSION_SCOPE_EXCEEDED", denied.getCode());
        // D-160 ③: the refusal names the exceeding atoms per side (409 naming style). The principal
        // side is clean here (its instance N9 covers B) — the actor's wsA-only N9 is the named gap.
        assertTrue(denied.getMessage().contains("principal-exceeding=[]"),
                "principal side holds N9 everywhere: " + denied.getMessage());
        assertTrue(denied.getMessage().contains("actor-exceeding=["
                        + ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_POLICY + "@*]"),
                "the actor-side exceeding atom is named: " + denied.getMessage());
        assertFalse(workspaceAgentRepository.existsById(new WorkspaceAgentId(principal, wsB.getId())),
                "a refused cap write must leave zero rows");
    }

    /** instance ⊇ workspace: an instance-level hold covers any workspace's cap write. */
    @Test
    void instanceHoldCoversAnyWorkspaceCap() {
        User actor = newUser("i2w");
        grantDefaultService.ensureUserDefault(actor);
        Workspace ws = workspaceFixture.createOwnedWorkspace("I2W ws", actor.getId().toString());
        UUID principal = newPrincipal(actor, "I2WP");
        bindInstanceRole(principal, roleWith("TEST_I2W_N9", ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_POLICY), actor.getId());
        UUID authority = roleWith("TEST_I2W_AUTH",
                ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_AGENTS,
                ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_POLICY);
        bindingRepository.save(new AccessRoleBinding(authority, "user", actor.getId(),
                AccessScope.INSTANCE, null, actor.getId()));
        materializer.materializeSubject("user", actor.getId(), actor.getId(), null);

        JsonNode cap = json("[{\"actionClass\":\"" + ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_POLICY
                + "\",\"resource\":\"*\"}]");
        agentPrincipalService.setWorkspaceCap(actor.getId().toString(), ws.getId(), principal, cap);
        assertTrue(workspaceAgentRepository.existsById(new WorkspaceAgentId(principal, ws.getId())));
    }

    /** D-180 A: empty and read-only caps still bind structurally; effective = role ∩ cap. */
    @Test
    void emptyAndReadOnlyCapsBindAndEffectiveIsTheIntersection() throws Exception {
        User owner = newUser("cap-intersection");
        grantDefaultService.ensureUserDefault(owner);
        Workspace ws = workspaceFixture.createOwnedWorkspace("CapIntersection", owner.getId().toString());
        UUID principal = newPrincipal(owner, "CapIP");

        agentPrincipalService.setWorkspaceCap(owner.getId().toString(), ws.getId(), principal, json("[]"));
        assertNotNull(workspaceAgentRepository.findById(new WorkspaceAgentId(principal, ws.getId())));
        JsonNode emptyEffective = agentPrincipalService.resolveCapFor(principal, ws.getId());
        assertTrue(emptyEffective.isEmpty(), "empty cap ⇒ empty effective: " + emptyEffective);

        UUID second = newPrincipal(owner, "CapIR");
        agentPrincipalService.setWorkspaceCap(owner.getId().toString(), ws.getId(), second,
                json("[{\"actionClass\":\"read\",\"resource\":\"*\"}]"));
        JsonNode readOnly = agentPrincipalService.resolveCapFor(second, ws.getId());
        assertEquals(Set.of("read"), readOnly.findValuesAsText("actionClass").stream().collect(java.util.stream.Collectors.toSet()),
                "read-only cap ⇒ effective exactly {read}: " + readOnly);
        assertFalse(readOnly.findValuesAsText("actionClass").contains("write"));
    }

    /** Automatic WS_EDITOR default binding must clear the grantor subset gate, zero rows otherwise. */
    @Test
    void grantorWithoutDefaultRoleAtomsIsRefusedWithZeroWrites() {
        User weak = newUser("weak-grantor");
        grantDefaultService.ensureUserDefault(weak);
        // The target workspace belongs to someone else; weak is only a viewer (read+N7 there) and
        // carries the management atom instance-side — so the ACTION gate passes, the cap is empty,
        // yet the automatic WS_EDITOR default needs write/delete/exec/N6/N9 it does not hold.
        User host = newUser("weak-host");
        grantDefaultService.ensureUserDefault(host);
        Workspace ws = workspaceFixture.createOwnedWorkspace("WeakGrantor", host.getId().toString());
        workspaceFixture.bindWorkspaceRole(ws.getId(), weak.getId(), WorkspaceRole.VIEWER);
        UUID principal = newPrincipal(host, "WeakP");
        jdbcTemplate.update("DELETE FROM grants WHERE subject_type='user' AND subject_id=?"
                + " AND source IN ('default','role')", weak.getId());
        UUID manageOnly = roleWith("TEST_WEAK_MANAGE", ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_AGENTS);
        bindingRepository.save(new AccessRoleBinding(manageOnly, "user", weak.getId(),
                AccessScope.INSTANCE, null, weak.getId()));
        materializer.materializeSubject("user", weak.getId(), weak.getId(), null);

        CpApiException denied = assertThrows(CpApiException.class,
                () -> agentPrincipalService.setWorkspaceCap(weak.getId().toString(), ws.getId(),
                        principal, json("[]")));
        assertEquals("PRIVILEGE_ESCALATION", denied.getCode());
        assertFalse(workspaceAgentRepository.existsById(new WorkspaceAgentId(principal, ws.getId())));
        assertEquals(0, jdbcTemplate.queryForObject("SELECT count(*) FROM role_bindings"
                + " WHERE subject_type='agent_principal' AND subject_id=CAST(? AS UUID)"
                + " AND scope_type='workspace'", Integer.class,
                principal.toString()), "zero workspace role_binding rows on refusal (creation-time"
                + " instance seed rows are not this path)");
        assertEquals(0, jdbcTemplate.queryForObject("SELECT count(*) FROM grants"
                + " WHERE subject_type='agent_principal' AND subject_id=CAST(? AS UUID)"
                + " AND scope_type='workspace'", Integer.class,
                principal.toString()), "zero workspace agent grant rows on refusal");
    }

    /** GRANT_ANY_ATOM bypasses the subset gate and is audited with the skipped list (T2.4). */
    @Test
    void grantAnyAtomBypassesTheDefaultRoleGateAndIsAudited() {
        User bypass = newUser("bypass-grantor");
        grantDefaultService.ensureUserDefault(bypass);
        Workspace ws = workspaceFixture.createOwnedWorkspace("BypassWs", bypass.getId().toString());
        UUID principal = newPrincipal(bypass, "BypassP");
        jdbcTemplate.update("DELETE FROM grants WHERE subject_type='user' AND subject_id=?"
                + " AND source IN ('default','role')", bypass.getId());
        UUID bypassRole = roleWith("TEST_BYPASS_ROLE", ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_AGENTS,
                ToolFaceRegistry.ACTION_GRANT_ANY_ATOM);
        bindingRepository.save(new AccessRoleBinding(bypassRole, "user", bypass.getId(),
                AccessScope.INSTANCE, null, bypass.getId()));
        materializer.materializeSubject("user", bypass.getId(), bypass.getId(), null);

        agentPrincipalService.setWorkspaceCap(bypass.getId().toString(), ws.getId(), principal, json("[]"));
        assertTrue(workspaceAgentRepository.existsById(new WorkspaceAgentId(principal, ws.getId())));
        Integer audited = jdbcTemplate.queryForObject("SELECT count(*) FROM audit_logs"
                + " WHERE action='role_grant_guard_bypassed' AND user_id=CAST(? AS UUID)", Integer.class,
                bypass.getId().toString());
        assertNotNull(audited);
        assertTrue(audited >= 1, "the bypass must be audited with what it skipped");
    }

    /**
     * D-180 约束 2/4: the SAME role with the SAME read-only cap behaves differently by path —
     * the structural default binding (create+cap, intersection makes it harmless) succeeds, while
     * the explicit 0667 role-binding endpoint keeps its 409 cap gate untouched (D-160).
     */
    @Test
    void sameRoleTwoPathsKeepTheirOwnGates() throws Exception {
        User owner = newUser("two-paths");
        grantDefaultService.ensureUserDefault(owner);
        Workspace ws = workspaceFixture.createOwnedWorkspace("TwoPaths", owner.getId().toString());
        JsonNode readOnly = json("[{\"actionClass\":\"read\",\"resource\":\"*\"}]");

        // Path A (setWorkspaceCap structural default): binds WS_EDITOR, effective = {read}.
        UUID structural = newPrincipal(owner, "PathA");
        agentPrincipalService.setWorkspaceCap(owner.getId().toString(), ws.getId(), structural, readOnly);
        assertTrue(workspaceAgentRepository.existsById(new WorkspaceAgentId(structural, ws.getId())));
        JsonNode effective = agentPrincipalService.resolveCapFor(structural, ws.getId());
        assertEquals(Set.of("read"),
                effective.findValuesAsText("actionClass").stream().collect(java.util.stream.Collectors.toSet()),
                "structural path: role ∩ cap = {read}");

        // Path B (explicit agent-principal role bind): the same WS_EDITOR role under the same cap
        // must still answer the BL-287 cap gate with 409 — binding never bypasses the cap.
        UUID explicit = newPrincipal(owner, "PathB");
        agentPrincipalService.setWorkspaceCap(owner.getId().toString(), ws.getId(), explicit, readOnly);
        UUID wsEditorRole = accessRoleRepository.findByName(SystemAccessRoleCatalog.WS_EDITOR)
                .orElseThrow().getId();
        String token = TestDataFactory.createWorkspaceToken(owner.getId().toString(), owner.getEmail(),
                "OWNER", ws.getId().toString(), 0);
        org.springframework.http.HttpHeaders headers = new org.springframework.http.HttpHeaders();
        headers.setBearerAuth(token);
        headers.setContentType(org.springframework.http.MediaType.APPLICATION_JSON);
        headers.set("X-Workspace-Id", ws.getId().toString());
        var refused = restTemplate.exchange(url("/api/v1/agent-principals/" + explicit + "/roles"
                        + "?workspaceId=" + ws.getId()), org.springframework.http.HttpMethod.POST,
                new org.springframework.http.HttpEntity<>(java.util.Map.of("roleId",
                        wsEditorRole.toString()), headers), String.class);
        assertEquals(org.springframework.http.HttpStatus.CONFLICT, refused.getStatusCode(),
                String.valueOf(refused.getBody()));
        assertTrue(String.valueOf(refused.getBody()).contains("ROLE_BINDING_EXCEEDS_CAP"),
                "the explicit path keeps the cap gate (D-160): " + refused.getBody());
    }

    private User newUser(String prefix) {
        String suffix = UUID.randomUUID().toString().replace("-", "").substring(0, 8);
        return userRepository.saveAndFlush(new User(
                prefix + "-" + suffix + "@test.local", "hash", prefix, prefix + suffix));
    }

    private UUID newPrincipal(User owner, String name) {
        UUID ws = workspaceFixture.ensureOwnedWorkspace(owner.getId()).getId();
        com.cc01cc.p.xihe.cp.config.TenantContext.setUserId(owner.getId().toString());
        com.cc01cc.p.xihe.cp.config.TenantContext.setWorkspaceId(ws.toString());
        com.cc01cc.p.xihe.cp.config.TenantContext.setWorkspaceSource("test");
        try {
            var template = agentTemplateService.resolveForCreation(
                    owner.getId().toString(), ws.toString(), null);
            return agentPrincipalService.createPrincipal(owner.getId().toString(), name, null,
                    template.snapshot(), null, null, null, null, null, null, null).getId();
        } finally {
            com.cc01cc.p.xihe.cp.config.TenantContext.clear();
        }
    }

    private UUID roleWith(String name, String... atoms) {
        AccessRole role = accessRoleRepository.saveAndFlush(new AccessRole(
                UUID.randomUUID(), name, name, "test-only", false));
        for (String atom : atoms) {
            permissionRepository.saveAndFlush(new AccessRolePermission(
                    role.getId(), atom, com.cc01cc.p.xihe.cp.policy.PermissionAtomCatalog.atom(atom)
                            .canonicalResource()));
        }
        return role.getId();
    }

    private void bindInstanceRole(UUID subjectId, UUID roleId, UUID granterUserId) {
        bindingRepository.save(new AccessRoleBinding(roleId, "agent_principal", subjectId,
                AccessScope.INSTANCE, null, granterUserId));
        materializer.materializeSubject("agent_principal", subjectId, granterUserId, null);
    }

    private JsonNode json(String value) {
        try {
            return new com.fasterxml.jackson.databind.ObjectMapper().readTree(value);
        } catch (Exception e) {
            throw new IllegalStateException(value, e);
        }
    }
}
