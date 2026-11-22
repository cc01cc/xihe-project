package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.AbstractReusableIntegrationTest;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.GrantPreset;
import com.cc01cc.p.xihe.cp.entity.GrantPresetBinding;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgentId;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.repository.GrantPresetBindingRepository;
import com.cc01cc.p.xihe.cp.repository.GrantPresetRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.service.AgentPrincipalService;
import com.cc01cc.p.xihe.cp.service.AgentTemplateService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * DSD-1500 R2+R3 (Q-93) at the evaluation boundary: an Agent principal is born without exec, and
 * exec comes back only when the preset that carries it (WS_RUNNER) is landed on BOTH levels of the
 * principal path.
 *
 * <p>The evaluator intersects every level ({@link GrantIntersectionEvaluator#allows}), so a
 * Workspace-only grant of exec is dead weight: the instance level (role grants) and the Workspace
 * binding cap must both carry it, and the Session snapshot freezes whatever the cap was at
 * creation time. That is why this test walks the levels in order and re-creates the Session after
 * the cap moves - the old Session must stay denied.</p>
 *
 * <p>Fixture note: the two levels are written straight through the repositories plus
 * {@link PresetGrantMaterializer} (the same fixture technique as
 * {@code SetWorkspaceCapGateIntegrationTest}). The production order is "raise the cap, then bind",
 * because {@code AgentPrincipalPresetBindingService} refuses a role whose atoms exceed the cap
 * (BL-287 / ROLE_BINDING_EXCEEDS_CAP); that gate has its own coverage in
 * {@code SetWorkspaceCapGateIntegrationTest} and
 * {@code AgentPrincipalRoleBindingIntegrationTest}. This class pins the evaluation OUTCOME, which
 * is what DSD-1500 changed.</p>
 */
class AgentExecLandingIntegrationTest extends AbstractReusableIntegrationTest {

    private static final String EXEC = ToolFaceRegistry.ACTION_EXEC;
    @Autowired private UserRepository userRepository;
    @Autowired private WorkspaceFixture workspaceFixture;
    @Autowired private GrantDefaultService grantDefaultService;
    @Autowired private AgentPrincipalService agentPrincipalService;
    @Autowired private AgentTemplateService agentTemplateService;
    @Autowired private GrantPresetRepository accessRoleRepository;
    @Autowired private GrantPresetBindingRepository bindingRepository;
    @Autowired private WorkspaceAgentRepository workspaceAgentRepository;
    @Autowired private AuthorizationGrantRepository grantRepository;
    @Autowired private SessionRepository sessionRepository;
    @Autowired private PresetGrantMaterializer materializer;
    @Autowired private GrantAuthorizationService grantAuthorizationService;
    @Autowired private GrantIntersectionEvaluator evaluator;
    @Autowired private ObjectMapper objectMapper;

    @AfterEach
    void clearTenant() {
        TenantContext.clear();
    }

    /** 正 1: a freshly created principal carries no exec on either level, and keeps the rest. */
    @Test
    void aFreshPrincipalIsBornWithoutExec() throws Exception {
        Fixture fixture = newFixture("r2-default");

        Set<String> bindingAtoms = actionClasses(fixture.binding.getPermissionsSnapshot());
        Set<String> instanceAtoms = actionClasses(fixture.instanceAtoms);

        assertTrue(bindingAtoms.containsAll(seedActionClasses(SystemGrantPresetCatalog.WS_EDITOR)),
                "the inherited Workspace cap covers the whole WS_EDITOR seed: " + bindingAtoms);
        assertFalse(bindingAtoms.contains(EXEC),
                "DSD-1500 R2 removed exec from the WS_EDITOR seed: " + bindingAtoms);
        assertTrue(bindingAtoms.containsAll(List.of("read", "write", "delete")),
                "WS_EDITOR keeps the read/write/delete core: " + bindingAtoms);
        assertFalse(instanceAtoms.contains(EXEC),
                "AGENT_USER must not confer exec any more: " + instanceAtoms);
        assertTrue(instanceAtoms.containsAll(List.of("read", "write", "delete")),
                "AGENT_USER keeps the non-executing base set: " + instanceAtoms);
        assertEquals(List.of(SystemGrantPresetCatalog.AGENT_USER), fixture.instanceRoleNames,
                "the default instance role is still AGENT_USER");
        assertEquals(List.of(SystemGrantPresetCatalog.WS_EDITOR), fixture.workspaceRoleNames,
                "the default Workspace role is still WS_EDITOR");
    }

    /**
     * 正 2 + frozen-snapshot invariant: exec is denied before the preset lands, WS_RUNNER at both
     * levels permits it, and a Session created earlier keeps its old denial.
     */
    @Test
    void explicitRunnerPresetIsWhatBringsExecBack() throws Exception {
        Fixture fixture = newFixture("r2-runner");
        UUID workspaceId = fixture.workspace.getId();
        String ownerId = fixture.owner.getId().toString();

        ArrayNode capBefore = fixture.binding.getPermissionsSnapshot().deepCopy();
        Session frozenSession = saveAgentSession(fixture, "before WS_RUNNER", capBefore);

        assertFalse(grantAuthorizationService.allows(execRequest(workspaceId, ownerId, frozenSession)),
                "exec is denied for a default principal (AGENT_USER + WS_EDITOR have no exec)");
        assertTrue(grantAuthorizationService.allows(
                        request(workspaceId, ownerId, frozenSession, "read", "*")),
                "the same path still authorizes read, so the denial above is about exec only");

        // Risk pinned by the card: a Session created BEFORE the upgrade keeps its old snapshot,
        // exec included. That snapshot must not resurrect execution on its own — the instance level
        // (AGENT_USER) no longer holds exec and the intersection requires every level to agree.
        ArrayNode legacyCap = capBefore.deepCopy();
        ObjectNode legacyExec = legacyCap.addObject();
        legacyExec.put("actionClass", EXEC);
        legacyExec.put("resource", "*");
        Session legacySession = saveAgentSession(fixture, "pre-upgrade snapshot", legacyCap);
        assertFalse(grantAuthorizationService.allows(execRequest(workspaceId, ownerId, legacySession)),
                "a frozen pre-upgrade snapshot carrying exec does not authorize: AGENT_USER no "
                        + "longer holds exec and every level of the path must agree");
        assertTrue(grantAuthorizationService.allows(
                        request(workspaceId, ownerId, legacySession, "read", "*")),
                "the same frozen Session still authorizes read, so the denial above is the atom "
                        + "intersection and not a principal path that never evaluated");

        // 1) reach: WS_RUNNER bound on the instance level and on the Workspace level.
        bindRole(fixture, AccessScope.INSTANCE, null);
        bindRole(fixture, AccessScope.WORKSPACE, workspaceId);

        // 2) ceiling: the Workspace binding cap gains exec (production order: cap first, then bind).
        ArrayNode capAfter = capBefore.deepCopy();
        ObjectNode execAtom = capAfter.addObject();
        execAtom.put("actionClass", EXEC);
        execAtom.put("resource", "*");
        WorkspaceAgent binding = workspaceAgentRepository
                .findById(new WorkspaceAgentId(fixture.principalId, workspaceId)).orElseThrow();
        binding.setPermissionsSnapshot(capAfter);
        workspaceAgentRepository.saveAndFlush(binding);

        // Re-read the materialized grants: the Fixture node is the pre-bind snapshot.
        Set<String> landedInstanceAtoms = actionClasses(atomsNode(evaluator.union(
                grantRepository.findScopedGrants(GrantPrincipalPathResolver.AGENT_PRINCIPAL,
                        fixture.principalId, GrantSources.EVALUATION_SOURCES, workspaceId))));
        assertTrue(landedInstanceAtoms.contains(EXEC),
                "the instance level now carries exec through WS_RUNNER: " + landedInstanceAtoms);
        assertTrue(actionClasses(binding.getPermissionsSnapshot()).contains(EXEC),
                "the Workspace cap now carries exec: "
                        + actionClasses(binding.getPermissionsSnapshot()));

        assertFalse(grantAuthorizationService.allows(execRequest(workspaceId, ownerId, frozenSession)),
                "a Session keeps the cap it was created with, so the old Session stays denied");
        assertTrue(grantAuthorizationService.allows(
                        request(workspaceId, ownerId, frozenSession, "read", "*")),
                "the old Session still evaluates (read passes), so its exec denial is the frozen "
                        + "cap and not a broken principal path");

        Session runnerSession = saveAgentSession(fixture, "after WS_RUNNER", capAfter);
        assertTrue(grantAuthorizationService.allows(execRequest(workspaceId, ownerId, runnerSession)),
                "WS_RUNNER on both levels is what permits exec (DSD-1500 R3 / acceptance 正 2)");
    }

    // ── fixture ─────────────────────────────────────────────────────────────────────────────

    private static final class Fixture {
        private final User owner;
        private final Workspace workspace;
        private final UUID principalId;
        private final WorkspaceAgent binding;
        private final JsonNode instanceAtoms;
        private final List<String> instanceRoleNames;
        private final List<String> workspaceRoleNames;

        private Fixture(User owner, Workspace workspace, UUID principalId, WorkspaceAgent binding,
                        JsonNode instanceAtoms, List<String> instanceRoleNames,
                        List<String> workspaceRoleNames) {
            this.owner = owner;
            this.workspace = workspace;
            this.principalId = principalId;
            this.binding = binding;
            this.instanceAtoms = instanceAtoms;
            this.instanceRoleNames = instanceRoleNames;
            this.workspaceRoleNames = workspaceRoleNames;
        }

        private JsonNode instanceGrants() {
            return instanceAtoms;
        }
    }

    private Fixture newFixture(String prefix) throws Exception {
        String suffix = UUID.randomUUID().toString().replace("-", "").substring(0, 8);
        User owner = userRepository.saveAndFlush(
                new User(prefix + "-" + suffix + "@test.local", "hash", prefix, prefix + suffix));
        // The owner needs the instance default registration set (USER) before its own creation path may
        // grant the agent's default atoms; otherwise GrantabilityGuard refuses with
        // "Cannot grant atoms the caller does not hold".
        grantDefaultService.ensureUserDefault(owner);
        Workspace workspace = workspaceFixture.createOwnedWorkspace(prefix, owner.getId().toString());

        TenantContext.setUserId(owner.getId().toString());
        TenantContext.setWorkspaceId(workspace.getId().toString());
        TenantContext.setWorkspaceSource("test");
        UUID principalId;
        try {
            var template = agentTemplateService.resolveForCreation(
                    owner.getId().toString(), workspace.getId().toString(), null);
            // The product name format is letters/digits/CJK only (NameFormat), no spaces/hyphens.
            String principalName = "R" + prefix.replaceAll("[^A-Za-z0-9]", "") + "Agent";
            principalId = agentPrincipalService.createPrincipal(owner.getId().toString(),
                            principalName, null, template.snapshot(),
                            null, null, null, null, null, null, null)
                    .getId();
        } finally {
            TenantContext.clear();
        }

        // Placing the agent into the workspace is the product path that materializes the default
        // Workspace binding: PUT /api/v1/workspaces/{id}/agents/{principalId} with an empty body
        // means "inherit the role baseline" (D-1109 / setWorkspaceCap(null)), so the cap is derived
        // by the product from the default Workspace role instead of being hand-built here.
        TenantContext.setUserId(owner.getId().toString());
        TenantContext.setWorkspaceId(workspace.getId().toString());
        TenantContext.setWorkspaceSource("test");
        try {
            agentPrincipalService.setWorkspaceCap(owner.getId().toString(), workspace.getId(),
                    principalId, null);
        } finally {
            TenantContext.clear();
        }

        WorkspaceAgent binding = workspaceAgentRepository
                .findById(new WorkspaceAgentId(principalId, workspace.getId()))
                .orElseThrow(() -> new AssertionError(
                        "setWorkspaceCap must materialize the default Workspace binding"));
        List<AuthorizationGrant> grants = grantRepository.findScopedGrants(
                GrantPrincipalPathResolver.AGENT_PRINCIPAL, principalId,
                GrantSources.EVALUATION_SOURCES, workspace.getId());

        return new Fixture(owner, workspace, principalId, binding,
                atomsNode(evaluator.union(grants)),
                roleNames(principalId, AccessScope.INSTANCE),
                roleNames(principalId, AccessScope.WORKSPACE));
    }

    private void bindRole(Fixture fixture, String scope, UUID scopeId) {
        bindingRepository.save(new GrantPresetBinding(SystemGrantPresetCatalog.WS_RUNNER_ID,
                GrantPrincipalPathResolver.AGENT_PRINCIPAL, fixture.principalId, scope, scopeId,
                fixture.owner.getId()));
        materializer.materializeSubject(GrantPrincipalPathResolver.AGENT_PRINCIPAL,
                fixture.principalId, fixture.owner.getId(),
                scopeId == null ? null : scopeId.toString());
    }

    // ── helpers ─────────────────────────────────────────────────────────────────────────────

    private Session saveAgentSession(Fixture fixture, String title, JsonNode cap) {
        Session session = new Session(fixture.workspace.getId().toString(),
                fixture.owner.getId().toString(), title);
        session.setId(UUID.randomUUID());
        session.setAgentPermissionsSnapshot(cap);
        Session saved = sessionRepository.saveAndFlush(session);
        bindPrimaryParticipant(saved.getId().toString(), fixture.principalId.toString());
        return saved;
    }

    private static PolicyRequest execRequest(UUID workspaceId, String ownerId, Session session) {
        return new PolicyRequest("run_command", List.of(EXEC), List.of("*"), ToolShape.OPAQUE,
                ownerId, workspaceId.toString(), session.getId().toString());
    }

    private static PolicyRequest request(UUID workspaceId, String ownerId, Session session,
                                        String actionClass, String resource) {
        return new PolicyRequest("write_file", List.of(actionClass), List.of(resource),
                ToolShape.STRUCTURED, ownerId, workspaceId.toString(), session.getId().toString());
    }

    private static Set<String> seedActionClasses(String roleName) {
        return SystemGrantPresetCatalog.presetSeeds().stream()
                .filter(seed -> roleName.equals(seed.name()))
                .findFirst()
                .map(seed -> {
                    Set<String> names = new TreeSet<>();
                    seed.atoms().forEach(atom -> names.add(atom.actionClass()));
                    return names;
                })
                .orElseThrow(() -> new AssertionError("missing seed role " + roleName));
    }

    private Set<String> actionClasses(JsonNode permissions) {
        Set<String> names = new TreeSet<>();
        if (permissions != null) {
            permissions.forEach(atom -> names.add(atom.path("actionClass").asText()));
        }
        return names;
    }

    private JsonNode atomsNode(Set<GrantIntersectionEvaluator.PermissionAtom> atoms) {
        ArrayNode node = objectMapper.createArrayNode();
        for (GrantIntersectionEvaluator.PermissionAtom atom : atoms) {
            ObjectNode object = node.addObject();
            object.put("actionClass", atom.actionClass());
            object.put("resource", atom.resource());
        }
        return node;
    }

    private List<String> roleNames(UUID principalId, String scope) {
        List<GrantPresetBinding> rows = bindingRepository
                .findBySubjectTypeAndSubjectIdAndScopeType(
                        GrantPrincipalPathResolver.AGENT_PRINCIPAL, principalId, scope);
        List<String> names = new ArrayList<>();
        for (GrantPresetBinding row : rows) {
            names.add(accessRoleRepository.findById(row.getRoleId())
                    .map(GrantPreset::getName).orElse("?"));
        }
        names.sort(String::compareTo);
        return names;
    }
}
