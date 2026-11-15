package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.support.TestAgentPrincipals;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.policy.GrantIntersectionEvaluator;
import com.cc01cc.p.xihe.cp.policy.HookAdvisorRegistry;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.Set;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * PLAN-0625 task-92 (D25-09): the builtin guard template is the declaration source — creating a
 * principal from it must carry the template's hook subscriptions AND its provenance
 * (origin=SYSTEM_PRESET + preset_id).
 *
 * <p><b>What this class does and does not prove.</b> It hands {@code AgentPrincipalService} a
 * <i>given</i> snapshot ({@code resolveForCreation} is mocked), so it covers the consumer side: "if a
 * resolved snapshot already carries hooks, the create path copies them and marks provenance". It
 * cannot see the resolver, because the snapshot here is written by the test itself.</p>
 *
 * <p>The walkthrough's Gap H was exactly that blind spot: the real
 * {@code AgentTemplateService.snapshotFromTemplate} never copied {@code hooks}, so the mocked snapshot
 * "passing" proved nothing. The real chain (config-domain template → resolver → snapshot → create →
 * {@code agent_principals.hooks} row) is asserted in
 * {@link AgentPrincipalHooksHttpTest#templateHooksReachTheDatabaseThroughTheRealResolver}; the create
 * <i>response</i> shape is asserted in {@link AgentPrincipalHooksHttpTest} too. Do not cite this class
 * as evidence that template propagation works end to end.</p>
 */
class GuardTemplatePropagationTest {

    private static final String GUARD_TEMPLATE_ID = AgentPrincipal.BUILTIN_GUARD_PRESET_TEMPLATE_ID;

    private AgentPrincipalRepository principals;
    private AgentTemplateService templates;
    private WorkspaceAgentRepository bindings;
    private AgentPrincipalService service;
    private com.cc01cc.p.xihe.cp.repository.AccessRoleRepository roles;

    @BeforeEach
    void setUp() {
        // D-174: the single create path is the workspace-authorized one; a unit test must declare
        // the request context it simulates (409 WORKSPACE_CONTEXT_REQUIRED without it).
        com.cc01cc.p.xihe.cp.config.TenantContext.setUserId(UUID.randomUUID().toString());
        com.cc01cc.p.xihe.cp.config.TenantContext.setWorkspaceId(UUID.randomUUID().toString());
        com.cc01cc.p.xihe.cp.config.TenantContext.setWorkspaceSource("test");
        principals = mock(AgentPrincipalRepository.class);
        roles = mock(com.cc01cc.p.xihe.cp.repository.AccessRoleRepository.class);
        AuthorizationGrantRepository grants = mock(AuthorizationGrantRepository.class);
        com.cc01cc.p.xihe.cp.auth.AuthService authService = mock(com.cc01cc.p.xihe.cp.auth.AuthService.class);
        when(authService.userExists(any())).thenReturn(true);
        WorkspaceService workspaceService = mock(WorkspaceService.class);
        when(workspaceService.isWorkspaceMember(any(), any())).thenReturn(true);
        GrantIntersectionEvaluator evaluator = mock(GrantIntersectionEvaluator.class);
        when(evaluator.union(any())).thenReturn(Set.of(
                new GrantIntersectionEvaluator.PermissionAtom("MANAGE_WORKSPACE_AGENTS", "*")));
        // The authorization gate itself is covered elsewhere; here the subject is template propagation.
        when(evaluator.allows(any(), any())).thenReturn(true);
        templates = mock(AgentTemplateService.class);
        bindings = mock(WorkspaceAgentRepository.class);

        service = new AgentPrincipalService(principals, grants, authService, workspaceService,
                mock(com.cc01cc.p.xihe.cp.policy.GrantDefaultService.class),
                bindings, evaluator,
                mock(com.cc01cc.p.xihe.cp.audit.AuditLogger.class),
                new ObjectMapper(), templates,
                mock(com.cc01cc.p.xihe.cp.policy.AuthzContext.class),
                // PLAN-0629: role bindings are the permission source, not the scope field.
                mock(com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository.class),
                roles,
                    mock(com.cc01cc.p.xihe.cp.repository.AccessRolePermissionRepository.class),
                mock(com.cc01cc.p.xihe.cp.policy.RoleGrantMaterializer.class),
                // PLAN-0651 T1.5-A1：建 principal 走共享内核 `RequesterAuthority.allowsForUser`
                // （不是旧的 service 内联 evaluator 路径）。创建门自 T5.1 起只认
                // MANAGE_WORKSPACE_AGENTS；BL-312（2026-11-09）移除 CREATE_OWN_AGENT 后声明集
                // 收缩为单原子。真实 atom 路径仍由四个真上下文契约测试覆盖。
                new com.cc01cc.p.xihe.cp.policy.DeclaredAtomAuthority(
                        "MANAGE_WORKSPACE_AGENTS"),
                // D-180: the subset guard is a Spring bean; unit envs pass a permissive mock (the
                // guard's own decisions are covered by Spring/integration tests).
                mock(com.cc01cc.p.xihe.cp.policy.GrantabilityGuard.class),
                // D-180 锁序：unit envs pass a permissive instance-mutex mock.
                mock(com.cc01cc.p.xihe.cp.repository.InstanceOwnerRepository.class),
                // PLAN-0773 M2-8b: no org-unit rows ⇒ the read points behave as before.
                com.cc01cc.p.xihe.cp.policy.OrgUnitGrantsTestFixture.withoutRows());
        // PLAN-0629（2026-11-04 裁定）：建 principal 现在总会解析默认实例角色并写角色绑定，
        // 所以纯 Mockito 测试必须提供角色目录桩——这不是放宽校验，而是补齐新依赖。
        // D-180: the default role is validated (name → id) before the write, so BOTH catalog lookups
        // must resolve the same fixture row.
        com.cc01cc.p.xihe.cp.entity.AccessRole defaultFixtureRole =
                new com.cc01cc.p.xihe.cp.entity.AccessRole(
                        UUID.randomUUID(), "USER", "User", "fixture role", true);
        when(roles.findByName(any())).thenReturn(java.util.Optional.of(defaultFixtureRole));
        when(roles.findById(any())).thenReturn(java.util.Optional.of(defaultFixtureRole));
        when(roles.findByIdForUpdate(any())).thenReturn(java.util.Optional.of(defaultFixtureRole));

        when(principals.saveAndFlush(any())).thenAnswer(invocation -> {
            AgentPrincipal saved = invocation.getArgument(0);
            if (saved.getId() == null) {
                saved.setId(UUID.randomUUID());
            }
            if (saved.getCreatedAt() == null) {
                saved.setCreatedAt(java.time.Instant.now());
            }
            return saved;
        });
    }

    @org.junit.jupiter.api.AfterEach
    void clearTenantContext() {
        com.cc01cc.p.xihe.cp.config.TenantContext.clear();
    }

    private ObjectNode guardSnapshot(boolean withHooks) {
        ObjectNode snapshot = new ObjectMapper().createObjectNode();
        snapshot.put("templateId", GUARD_TEMPLATE_ID);
        snapshot.put("name", "守卫 Guard");
        snapshot.putArray("permissions");
        if (withHooks) {
            ObjectNode hooks = snapshot.putObject("hooks");
            ObjectNode entry = hooks.withArray("advisors").addObject();
            entry.put("kind", "guard");
            entry.withArray("on").add("approval.ask");
        }
        return snapshot;
    }

    @Test
    void theUserDoorRefusesTheBuiltinPresetInsteadOfCreatingAnUneditableRow() {
        // task-173 (V170 / user ruling 40C, Lead ruling on the contradictory case): V170 pins
        // "origin=SYSTEM_PRESET => ownership=INSTANCE" one-way, so a user-door row built from the
        // builtin preset is an instance asset the creator can never edit again. The door therefore
        // refuses BEFORE the write, with its own code — not "201 now, 403 later".
        when(templates.resolveForCreation(any(), any(), any()))
                .thenReturn(new AgentTemplateService.ResolvedTemplate("instance", guardSnapshot(true)));
        String actor = UUID.randomUUID().toString();

        com.cc01cc.p.xihe.cp.config.CpApiException refused = org.junit.jupiter.api.Assertions.assertThrows(
                com.cc01cc.p.xihe.cp.config.CpApiException.class,
                () -> service.createPrincipalFromTemplate(actor, "Guard", GUARD_TEMPLATE_ID,
                        null, null, null, null, null, null, null));

        assertEquals(org.springframework.http.HttpStatus.FORBIDDEN, refused.getStatus());
        assertEquals("AGENT_PRESET_INSTANCE_ONLY", refused.getCode());
        org.mockito.Mockito.verify(principals, org.mockito.Mockito.never()).saveAndFlush(any());
    }

    @Test
    void theCreateKernelStoresPresetProvenanceWithInstanceOwnership() {
        // The preset guard itself is built by the INSTANCE door (createInstancePrincipal), which needs
        // N1 at instance scope; that gate is covered by InstanceAgentPrincipalControllerIntegrationTest.
        // Here the subject is the create kernel: a preset guard row pairs its provenance
        // (SYSTEM_PRESET + preset_id) with INSTANCE ownership — V170's cross-axis CHECK in the database
        // states the same rule, and the kernel fails closed on the pair before the insert.
        String actor = UUID.randomUUID().toString();

        AgentPrincipal principal = service.createPrincipal(actor, "Guard", GUARD_TEMPLATE_ID,
                guardSnapshot(true), null, null, null, guardSnapshot(true).path("hooks"),
                AgentPrincipal.ORIGIN_SYSTEM_PRESET, GUARD_TEMPLATE_ID, null,
                com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry.ACTION_MANAGE_AGENT_PRINCIPALS,
                AgentPrincipal.OWNERSHIP_INSTANCE);

        assertEquals(AgentPrincipal.ORIGIN_SYSTEM_PRESET, principal.getOrigin(),
                "the builtin preset template marks the row as a preset guard");
        assertEquals(GUARD_TEMPLATE_ID, principal.getPresetId());
        assertEquals(AgentPrincipal.OWNERSHIP_INSTANCE, principal.getOwnership());
        assertEquals("guard", principal.getHooks().path("advisors").get(0).path("kind").asText(),
                "D25-09: the template is the declaration source of the subscription");
        assertEquals(HookAdvisorRegistry.ACTION_APPROVAL_ASK,
                principal.getHooks().path("advisors").get(0).path("on").get(0).asText());
    }

    @Test
    void givenAResolvedSnapshotTheCallersHooksOverrideTheTemplateSubscription() throws Exception {
        // The builtin preset is instance-only since task-173, so the default/override branch is
        // exercised on a USER-layer template (same create path, same precedence rule).
        when(templates.resolveForCreation(any(), any(), any()))
                .thenReturn(new AgentTemplateService.ResolvedTemplate("user", guardSnapshot(true)));
        String actor = UUID.randomUUID().toString();
        com.fasterxml.jackson.databind.JsonNode override = new ObjectMapper().readTree(
                "{\"advisors\":[{\"kind\":\"lint\",\"on\":[\"approval.ask\"]}]}");

        AgentPrincipal principal = service.createPrincipalFromTemplate(actor, "Guard", GUARD_TEMPLATE_ID,
                null, null, null, override, null, null, null);

        assertEquals(AgentPrincipal.ORIGIN_USER, principal.getOrigin(),
                "a user-layer template never produces a preset guard");
        assertEquals("lint", principal.getHooks().path("advisors").get(0).path("kind").asText(),
                "an explicit request subscription overrides the template default (template remains the fallback)");
    }

    @Test
    void whenTheCallerPassesNoSubscriptionsTheTemplateDefaultIsStored() {
        // The other half of the same precedence rule: the template's own hooks document IS the default.
        when(templates.resolveForCreation(any(), any(), any()))
                .thenReturn(new AgentTemplateService.ResolvedTemplate("user", guardSnapshot(true)));
        String actor = UUID.randomUUID().toString();

        AgentPrincipal principal = service.createPrincipalFromTemplate(actor, "Guard", GUARD_TEMPLATE_ID,
                null, null, null, null, null, null, null);

        assertEquals("guard", principal.getHooks().path("advisors").get(0).path("kind").asText(),
                "D25-09: the template is the declaration source of the subscription");
        assertEquals(HookAdvisorRegistry.ACTION_APPROVAL_ASK,
                principal.getHooks().path("advisors").get(0).path("on").get(0).asText());
    }

    @Test
    void givenAStoredRowTheServiceListViewCarriesTheSubscription() throws Exception {
        // Read surface (task-92 item 3): the UI subscription row lights up only if the list projection
        // carries the subscription, so the projection is asserted on a real principal row.
        UUID workspaceId = UUID.randomUUID();
        AgentPrincipal principal = TestAgentPrincipals.newPresetGuardPrincipal(GUARD_TEMPLATE_ID);
        principal.setId(UUID.randomUUID());
        principal.setName("守卫 Guard");
        principal.setCreatedAt(java.time.Instant.now());
        principal.setHooks(new ObjectMapper().readTree(
                "{\"advisors\":[{\"kind\":\"guard\",\"on\":[\"approval.ask\"]}]}"));
        com.cc01cc.p.xihe.cp.entity.WorkspaceAgent binding =
                new com.cc01cc.p.xihe.cp.entity.WorkspaceAgent(principal.getId().toString(),
                        workspaceId.toString(), new ObjectMapper().createArrayNode());
        when(bindings.findByIdWorkspaceId(workspaceId)).thenReturn(java.util.List.of(binding));
        when(principals.findById(principal.getId())).thenReturn(java.util.Optional.of(principal));
        when(principals.findByOwnerUserId(any())).thenReturn(java.util.List.of());

        java.util.List<AgentPrincipalService.WorkspaceAgentView> views =
                service.listWorkspaceAgents(UUID.randomUUID().toString(), workspaceId);

        assertEquals(1, views.size());
        assertEquals("guard", views.get(0).hooks().path("advisors").get(0).path("kind").asText(),
                "the subscription is visible on the workspace-agent read surface");
    }

    @Test
    void userAuthoredTemplateStaysAUserPrincipalWithoutSubscriptions() {
        when(templates.resolveForCreation(any(), any(), any()))
                .thenReturn(new AgentTemplateService.ResolvedTemplate("user", guardSnapshot(false)));
        String actor = UUID.randomUUID().toString();

        AgentPrincipal principal = service.createPrincipalFromTemplate(actor, "MyAgent", GUARD_TEMPLATE_ID,
                null, null, null, null, null, null, null);

        assertEquals(AgentPrincipal.ORIGIN_USER, principal.getOrigin(),
                "only the builtin instance-layer preset makes a SYSTEM_PRESET row");
        assertNull(principal.getPresetId());
        org.junit.jupiter.api.Assertions.assertNull(principal.getHooks());
    }
}
