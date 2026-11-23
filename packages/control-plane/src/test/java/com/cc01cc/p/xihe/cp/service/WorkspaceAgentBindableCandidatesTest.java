package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.auth.AuthService;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.GrantPreset;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.policy.AuthzContext;
import com.cc01cc.p.xihe.cp.policy.DeclaredAtomAuthority;
import com.cc01cc.p.xihe.cp.policy.GrantDefaultService;
import com.cc01cc.p.xihe.cp.policy.GrantIntersectionEvaluator;
import com.cc01cc.p.xihe.cp.policy.GrantabilityGuard;
import com.cc01cc.p.xihe.cp.policy.OrgUnitGrantsTestFixture;
import com.cc01cc.p.xihe.cp.policy.PresetGrantMaterializer;
import com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.GrantPresetAtomRepository;
import com.cc01cc.p.xihe.cp.repository.GrantPresetBindingRepository;
import com.cc01cc.p.xihe.cp.repository.GrantPresetRepository;
import com.cc01cc.p.xihe.cp.repository.InstanceOwnerRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.support.TestAgentPrincipals;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * task-930（用户裁定 2026-11-24：工作区只能**绑定**成员、不能**创建**成员）。
 *
 * <p>缺陷现场：{@code GET /api/v1/workspaces/{ws}/agents} 只回答「本工作区已绑定 ∪ 工作区预设可达 ∪
 * 调用者自己的 legacy owner 行」，而 {@code owner_user_id} 为空的用户级主体（D-174 之后的全部新行）
 * 永不进列表（{@code AgentPrincipalService:listWorkspaceAgents} 的自陈注释）⇒ UI 上没有任何「未绑定行」
 * 可点，唯一入口退化成「创建智能体」。本类钉住新的候选读面
 * （{@code listBindableCandidates} + {@code GET …/agents?includeBindable=true}）。</p>
 *
 * <p>四条判据（卡面要求）：① 7 主体 / 1 已绑定 ⇒ 候选恰好 6；② 已绑定项不出现在候选；
 * ③ 无 {@code MANAGE_WORKSPACE_AGENTS} ⇒ 403 且错误信息不含主体名（不得变成存在性探针）；
 * ④ {@code disabled} 主体仍列出但标注不可绑。另加一条边界：INSTANCE-owned 行不进工作区候选
 * （task-173 / D-1540 ①）。</p>
 *
 * <p>为什么是 service 级纯 Mockito：HTTP 面的「冻结单键信封（默认调用仍是 {@code {agents}}）」与
 * 「403 只有 code/message 无主体名」由既有 {@code WorkspaceAgentControllerContractTest} 与
 * {@code ProblemDetailsHandler} 的共享路径覆盖；本类补的是本案新增的组合逻辑（pool − reach + 原子门
 * + 标注）。服务依赖图与 {@code AgentPrincipalTestSupport} 同形（一次 mock 图，逐条声明原子）。</p>
 */
class WorkspaceAgentBindableCandidatesTest {

    /** 现场读数：7 个用户级主体，其中 1 个已绑定。 */
    private static final int SEEDED_PRINCIPALS = 7;

    private final UUID actor = UUID.randomUUID();
    private final UUID workspaceId = UUID.randomUUID();

    private AgentPrincipalRepository principals;
    private WorkspaceAgentRepository bindings;
    private GrantPresetBindingRepository presetBindings;
    private AuthService authService;
    private WorkspaceService workspaceService;
    private final List<AgentPrincipal> seeded = new ArrayList<>();
    private AgentPrincipal bound;

    @BeforeEach
    void setUp() {
        principals = mock(AgentPrincipalRepository.class);
        bindings = mock(WorkspaceAgentRepository.class);
        presetBindings = mock(GrantPresetBindingRepository.class);
        authService = mock(AuthService.class);
        workspaceService = mock(WorkspaceService.class);
        when(authService.userExists(any())).thenReturn(true);
        when(workspaceService.isWorkspaceMember(any(), any())).thenReturn(true);
        when(presetBindings.findBySubjectTypeAndScopeTypeAndScopeId(anyString(), anyString(), any()))
                .thenReturn(List.of());

        for (int index = 0; index < SEEDED_PRINCIPALS; index++) {
            AgentPrincipal principal = TestAgentPrincipals.newUserAgentPrincipal();
            principal.setId(UUID.randomUUID());
            principal.setName("bindable-target-" + (char) ('a' + index));
            // D-174 真实形状：用户级行没有 owner，因此只能经个人视图发现、只能经绑定点进入工作区。
            principal.setCreatedByUserId(actor.toString());
            seeded.add(principal);
        }
        bound = seeded.get(0);
        WorkspaceAgent bindingRow = new WorkspaceAgent(bound.getId().toString(), workspaceId.toString(),
                new ObjectMapper().createArrayNode());
        when(bindings.findByIdWorkspaceId(workspaceId)).thenReturn(List.of(bindingRow));
        when(bindings.findByIdWorkspaceIdAndIsDefaultTrue(workspaceId)).thenReturn(Optional.empty());
        when(principals.findById(bound.getId())).thenReturn(Optional.of(bound));
        when(principals.findByOwnerUserId(any())).thenReturn(List.of());
        when(principals.findByCreatedByUserId(anyString())).thenReturn(seeded);
        when(principals.findAllById(any())).thenReturn(seeded);
    }

    @Test
    @DisplayName("7 principals / 1 bound ⇒ exactly 6 candidates, and every unbound one is offered")
    void boundRowsAreExcludedAndUnboundRowsAreOffered() {
        AgentPrincipalService service = service(new DeclaredAtomAuthority(ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_AGENTS));

        List<AgentPrincipalService.BindableCandidate> candidates =
                service.listBindableCandidates(actor.toString(), workspaceId);

        assertEquals(SEEDED_PRINCIPALS - 1, candidates.size(), String.valueOf(candidates));
        assertFalse(candidates.stream().anyMatch(c -> c.principalId().equals(bound.getId())),
                "an already bound principal must not be offered as a bind candidate");
        for (AgentPrincipal principal : seeded) {
            if (!principal.getId().equals(bound.getId())) {
                assertTrue(candidates.stream().anyMatch(c -> c.principalId().equals(principal.getId())),
                        "unbound visible principal missing from candidates: " + principal.getName());
            }
        }
    }

    @Test
    @DisplayName("no MANAGE_WORKSPACE_AGENTS ⇒ 403 and the reason names no principal")
    void candidateReadWithoutTheAtomIsForbiddenAndLeaksNoNames() {
        AgentPrincipalService service = service(new DeclaredAtomAuthority());

        CpApiException denied = assertThrows(CpApiException.class,
                () -> service.listBindableCandidates(actor.toString(), workspaceId));

        assertEquals(HttpStatus.FORBIDDEN, denied.getStatus());
        assertEquals("FORBIDDEN", denied.getCode());
        for (AgentPrincipal principal : seeded) {
            assertFalse(String.valueOf(denied.getMessage()).contains(principal.getName()),
                    "the refusal must not become an existence oracle: " + principal.getName());
        }
    }

    @Test
    @DisplayName("a disabled principal stays listed, marked unbindable with the write face's own code")
    void disabledPrincipalIsListedButNotBindable() {
        AgentPrincipal disabled = seeded.get(1);
        disabled.setDisabledAt(Instant.now());
        AgentPrincipalService service = service(new DeclaredAtomAuthority(ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_AGENTS));

        AgentPrincipalService.BindableCandidate row = service
                .listBindableCandidates(actor.toString(), workspaceId).stream()
                .filter(c -> c.principalId().equals(disabled.getId()))
                .findFirst()
                .orElseThrow(() -> new AssertionError("a disabled principal must stay visible (marked)"));

        assertTrue(row.disabled());
        assertFalse(row.bindable());
        assertEquals("AGENT_PRINCIPAL_DISABLED", row.unbindableReason());
        assertFalse(row.isDefault(), "an unbound row can never be the workspace default");
    }

    @Test
    @DisplayName("INSTANCE-owned principals never enter the workspace candidate list")
    void instanceOwnedPrincipalIsNotAWorkspaceCandidate() {
        AgentPrincipal instanceOwned = TestAgentPrincipals.newInstanceAgentPrincipal();
        instanceOwned.setId(UUID.randomUUID());
        instanceOwned.setName("instance-only-principal");
        instanceOwned.setCreatedByUserId(actor.toString());
        // listPrincipals answers this row too, then drops it (task-173 / D-1540 ①) — so the exclusion
        // must happen above this service, not inside the candidate mapping.
        when(principals.findByCreatedByUserId(anyString())).thenReturn(
                List.of(seeded.get(0), seeded.get(1), seeded.get(2), seeded.get(3), seeded.get(4),
                        seeded.get(5), seeded.get(6), instanceOwned));
        when(principals.findAllById(any())).thenReturn(
                List.of(seeded.get(0), seeded.get(1), seeded.get(2), seeded.get(3), seeded.get(4),
                        seeded.get(5), seeded.get(6)));
        AgentPrincipalService service = service(new DeclaredAtomAuthority(ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_AGENTS));

        List<AgentPrincipalService.BindableCandidate> candidates =
                service.listBindableCandidates(actor.toString(), workspaceId);

        assertFalse(candidates.stream().anyMatch(c -> c.principalId().equals(instanceOwned.getId())),
                "INSTANCE-owned rows belong to /api/v1/instance/agent-principals");
        assertEquals(SEEDED_PRINCIPALS - 1, candidates.size());
    }

    @Test
    @DisplayName("ownership is the stored USER/INSTANCE fact, not the retired workspace-agent scope")
    void candidateOwnershipIsTheStoredAgentPrincipalFact() {
        AgentPrincipalService service = service(new DeclaredAtomAuthority(ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_AGENTS));

        AgentPrincipalService.BindableCandidate row = service
                .listBindableCandidates(actor.toString(), workspaceId).stream()
                .filter(c -> !c.principalId().equals(bound.getId()))
                .findFirst()
                .orElseThrow();

        assertNotNull(row.ownership());
        assertEquals(AgentPrincipal.OWNERSHIP_USER, row.ownership());
        assertTrue(row.bindable());
        assertNull(row.unbindableReason());
    }

    // ------------------------------------------------------------------ helpers

    private AgentPrincipalService service(DeclaredAtomAuthority atomAuthority) {
        GrantPresetRepository roles = mock(GrantPresetRepository.class);
        GrantPreset fixturePreset = new GrantPreset(UUID.randomUUID(), "USER", "User", "fixture", true);
        when(roles.findByName(any())).thenReturn(Optional.of(fixturePreset));
        when(roles.findById(any())).thenReturn(Optional.of(fixturePreset));
        when(roles.findByIdForUpdate(any())).thenReturn(Optional.of(fixturePreset));
        GrantIntersectionEvaluator evaluator = mock(GrantIntersectionEvaluator.class);
        when(evaluator.union(any())).thenReturn(java.util.Set.of());
        AuthorizationGrantRepository grants = mock(AuthorizationGrantRepository.class);
        when(grants.findScopedGrants(any(), any(), any(), any())).thenReturn(List.of());
        return new AgentPrincipalService(principals, grants, authService, workspaceService,
                mock(GrantDefaultService.class), bindings, evaluator, mock(AuditLogger.class),
                new ObjectMapper(), mock(AgentTemplateService.class), mock(AuthzContext.class),
                presetBindings, roles, mock(GrantPresetAtomRepository.class),
                mock(PresetGrantMaterializer.class), atomAuthority, mock(GrantabilityGuard.class),
                mock(InstanceOwnerRepository.class), OrgUnitGrantsTestFixture.withoutRows());
    }
}
