package com.cc01cc.p.xihe.cp.service;

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
        principals = mock(AgentPrincipalRepository.class);
        roles = mock(com.cc01cc.p.xihe.cp.repository.AccessRoleRepository.class);
        AuthorizationGrantRepository grants = mock(AuthorizationGrantRepository.class);
        com.cc01cc.p.xihe.cp.auth.AuthService authService = mock(com.cc01cc.p.xihe.cp.auth.AuthService.class);
        when(authService.userExists(any())).thenReturn(true);
        WorkspaceService workspaceService = mock(WorkspaceService.class);
        when(workspaceService.isWorkspaceMember(any(), any())).thenReturn(true);
        GrantIntersectionEvaluator evaluator = mock(GrantIntersectionEvaluator.class);
        when(evaluator.union(any())).thenReturn(Set.of(
                new GrantIntersectionEvaluator.PermissionAtom("MANAGE_WORKSPACE_AGENTS", "*"),
                // PERSONAL creation is authorized by CREATE_OWN_AGENT (PLAN-0622 M0.3)
                new GrantIntersectionEvaluator.PermissionAtom("CREATE_OWN_AGENT", "*")));
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
                // （不是旧的 service 内联 evaluator 路径）。本测试创建 PERSONAL principal ⇒ 必须声明
                // CREATE_OWN_AGENT；WORKSPACE 路径的 MANAGE_WORKSPACE_AGENTS 一并声明，保持与旧 stub
                // （evaluator.union 返回两个 atom）同口径。真实 atom 路径仍由四个真上下文契约测试覆盖。
                new com.cc01cc.p.xihe.cp.policy.DeclaredAtomAuthority(
                        "CREATE_OWN_AGENT", "MANAGE_WORKSPACE_AGENTS"));
        // PLAN-0629（2026-11-04 裁定）：建 principal 现在总会解析默认实例角色并写角色绑定，
        // 所以纯 Mockito 测试必须提供角色目录桩——这不是放宽校验，而是补齐新依赖。
        when(roles.findByName(any())).thenReturn(java.util.Optional.of(new com.cc01cc.p.xihe.cp.entity.AccessRole(
                UUID.randomUUID(), "USER", "User", "fixture role", true)));

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
    void givenAResolvedSnapshotTheCreatePathKeepsTheSubscriptionsAndMarksProvenance() {
        when(templates.resolveForCreation(any(), any(), any()))
                .thenReturn(new AgentTemplateService.ResolvedTemplate("instance", guardSnapshot(true)));
        String actor = UUID.randomUUID().toString();

        AgentPrincipal principal = service.createPrincipalFromTemplate(actor, "Guard", GUARD_TEMPLATE_ID,
                "PERSONAL", null, null, null, null);

        assertEquals(AgentPrincipal.ORIGIN_SYSTEM_PRESET, principal.getOrigin(),
                "the builtin preset template marks the row as a preset guard");
        assertEquals(GUARD_TEMPLATE_ID, principal.getPresetId());
        assertEquals("guard", principal.getHooks().path("advisors").get(0).path("kind").asText(),
                "D25-09: the template is the declaration source of the subscription");
        assertEquals(HookAdvisorRegistry.ACTION_APPROVAL_ASK,
                principal.getHooks().path("advisors").get(0).path("on").get(0).asText());
    }

    @Test
    void givenAResolvedSnapshotTheCallersHooksOverrideTheTemplateSubscription() throws Exception {
        when(templates.resolveForCreation(any(), any(), any()))
                .thenReturn(new AgentTemplateService.ResolvedTemplate("instance", guardSnapshot(true)));
        String actor = UUID.randomUUID().toString();
        com.fasterxml.jackson.databind.JsonNode override = new ObjectMapper().readTree(
                "{\"advisors\":[{\"kind\":\"lint\",\"on\":[\"approval.ask\"]}]}");

        AgentPrincipal principal = service.createPrincipalFromTemplate(actor, "Guard", GUARD_TEMPLATE_ID,
                "PERSONAL", null, null, null, override, AgentPrincipal.ORIGIN_USER, null);

        assertEquals(AgentPrincipal.ORIGIN_SYSTEM_PRESET, principal.getOrigin());
        assertEquals("lint", principal.getHooks().path("advisors").get(0).path("kind").asText(),
                "an explicit request subscription overrides the template default (template remains the fallback)");
    }

    @Test
    void givenAStoredRowTheServiceListViewCarriesTheSubscription() throws Exception {
        // Read surface (task-92 item 3): the UI subscription row lights up only if the list projection
        // carries the subscription, so the projection is asserted on a real principal row.
        UUID workspaceId = UUID.randomUUID();
        AgentPrincipal principal = new AgentPrincipal();
        principal.setId(UUID.randomUUID());
        principal.setName("守卫 Guard");
        principal.setScope("WORKSPACE");
        principal.setOrigin(AgentPrincipal.ORIGIN_SYSTEM_PRESET);
        principal.setPresetId(GUARD_TEMPLATE_ID);
        principal.setCreatedAt(java.time.Instant.now());
        principal.setHooks(new ObjectMapper().readTree(
                "{\"advisors\":[{\"kind\":\"guard\",\"on\":[\"approval.ask\"]}]}"));
        com.cc01cc.p.xihe.cp.entity.WorkspaceAgent binding =
                new com.cc01cc.p.xihe.cp.entity.WorkspaceAgent(principal.getId().toString(),
                        workspaceId.toString(), new ObjectMapper().createArrayNode());
        when(bindings.findByIdWorkspaceId(workspaceId)).thenReturn(java.util.List.of(binding));
        when(principals.findById(principal.getId())).thenReturn(java.util.Optional.of(principal));
        when(principals.findByScopeAndOwnerUserId(any(), any())).thenReturn(java.util.List.of());
        when(principals.findByScope(any())).thenReturn(java.util.List.of());

        java.util.List<AgentPrincipalService.WorkspaceAgentView> views =
                service.listWorkspaceAgents(UUID.randomUUID().toString(), workspaceId);

        assertEquals(1, views.size());
        assertEquals("guard", views.get(0).hooks().path("advisors").get(0).path("kind").asText(),
                "the subscription is visible on the workspace-agent read surface");
        assertEquals("workspace", views.get(0).source());
    }

    @Test
    void userAuthoredTemplateStaysAUserPrincipalWithoutSubscriptions() {
        when(templates.resolveForCreation(any(), any(), any()))
                .thenReturn(new AgentTemplateService.ResolvedTemplate("user", guardSnapshot(false)));
        String actor = UUID.randomUUID().toString();

        AgentPrincipal principal = service.createPrincipalFromTemplate(actor, "MyAgent", GUARD_TEMPLATE_ID,
                "PERSONAL", null, null, null, null);

        assertEquals(AgentPrincipal.ORIGIN_USER, principal.getOrigin(),
                "only the builtin instance-layer preset makes a SYSTEM_PRESET row");
        assertNull(principal.getPresetId());
        org.junit.jupiter.api.Assertions.assertNull(principal.getHooks());
    }
}
