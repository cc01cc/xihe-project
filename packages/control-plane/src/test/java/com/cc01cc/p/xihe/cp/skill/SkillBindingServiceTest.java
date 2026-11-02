package com.cc01cc.p.xihe.cp.skill;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgentId;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import org.junit.jupiter.api.Test;

import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * PLAN-0628 M1 (D28-14): the binding writer's rules.
 *
 * <p>Four families are pinned: the 2×2 vocabulary shape, definition-visibility (a workspace-private
 * skill must not be bindable outside its workspace), subject validity (missing/disabled/non-member),
 * and the authorization matrix (instance tier ⇒ instance admin; workspace tier ⇒ admin or manager;
 * binding <i>another</i> user ⇒ admin).</p>
 */
class SkillBindingServiceTest {

    private static final UUID ADMIN = UUID.randomUUID();
    private static final UUID MANAGER = UUID.randomUUID();
    private static final UUID PLAIN = UUID.randomUUID();
    private static final UUID WORKSPACE = UUID.randomUUID();

    private final SkillRepository skills = mock(SkillRepository.class);
    private final SkillBindingRepository bindings = mock(SkillBindingRepository.class);
    private final UserRepository users = mock(UserRepository.class);
    private final AgentPrincipalRepository principals = mock(AgentPrincipalRepository.class);
    private final WorkspaceAgentRepository members = mock(WorkspaceAgentRepository.class);
    private final SkillBindingService service = new SkillBindingService(
            skills, bindings, users, principals, members);

    private static final SkillBindingService.Caller INSTANCE_ADMIN =
            new SkillBindingService.Caller(ADMIN, true, true);
    private static final SkillBindingService.Caller WORKSPACE_MANAGER =
            new SkillBindingService.Caller(MANAGER, false, true);
    private static final SkillBindingService.Caller NOBODY =
            new SkillBindingService.Caller(PLAIN, false, false);

    private Skill skill(String definitionScopeType, UUID definitionScopeId) {
        Skill skill = new Skill();
        skill.setId(UUID.randomUUID());
        skill.setName("writing");
        skill.setDefinitionScopeType(definitionScopeType);
        skill.setDefinitionScopeId(definitionScopeId);
        when(skills.findById(skill.getId())).thenReturn(Optional.of(skill));
        return skill;
    }

    private static String code(Runnable action) {
        return assertThrows(CpApiException.class, action::run).getCode();
    }

    @Test
    void instanceTierRequiresAnInstanceAdmin() {
        Skill skill = skill(Skill.DEFINITION_SCOPE_INSTANCE, null);

        assertEquals(SkillBindingService.ERR_FORBIDDEN, code(() -> service.bind(
                new SkillBindingService.BindCommand(skill.getId(), SkillBinding.SUBJECT_USER, PLAIN,
                        SkillBinding.SCOPE_INSTANCE, null), NOBODY)));
        // A workspace manager is still not an instance admin.
        assertEquals(SkillBindingService.ERR_FORBIDDEN, code(() -> service.bind(
                new SkillBindingService.BindCommand(skill.getId(), SkillBinding.SUBJECT_USER, MANAGER,
                        SkillBinding.SCOPE_INSTANCE, null), WORKSPACE_MANAGER)));
    }

    @Test
    void bindingAnotherUserRequiresAnAdminButBindingYourselfDoesNot() {
        Skill skill = skill(Skill.DEFINITION_SCOPE_INSTANCE, null);
        when(users.findById(any())).thenReturn(Optional.of(mock(User.class)));
        when(bindings.save(any(SkillBinding.class))).thenAnswer(i -> i.getArgument(0));

        // Self-bind at workspace tier: allowed for a workspace manager.
        assertTrue(service.bind(new SkillBindingService.BindCommand(skill.getId(),
                SkillBinding.SUBJECT_USER, MANAGER, SkillBinding.SCOPE_WORKSPACE, WORKSPACE),
                WORKSPACE_MANAGER) != null);

        // Binding a different user at the same tier: refused.
        assertEquals(SkillBindingService.ERR_FORBIDDEN, code(() -> service.bind(
                new SkillBindingService.BindCommand(skill.getId(), SkillBinding.SUBJECT_USER, PLAIN,
                        SkillBinding.SCOPE_WORKSPACE, WORKSPACE), WORKSPACE_MANAGER)));
    }

    @Test
    void aWorkspacePrivateDefinitionCannotBeBoundElsewhere() {
        UUID ownWorkspace = UUID.randomUUID();
        Skill skill = skill(Skill.DEFINITION_SCOPE_WORKSPACE, ownWorkspace);
        when(users.findById(any())).thenReturn(Optional.of(mock(User.class)));

        // Binding it inside another workspace leaks a private definition.
        assertEquals(SkillBindingService.ERR_DEFINITION_OUT_OF_SCOPE, code(() -> service.bind(
                new SkillBindingService.BindCommand(skill.getId(), SkillBinding.SUBJECT_USER, ADMIN,
                        SkillBinding.SCOPE_WORKSPACE, WORKSPACE), INSTANCE_ADMIN)));
        // …and the instance tier would leak it everywhere.
        assertEquals(SkillBindingService.ERR_DEFINITION_OUT_OF_SCOPE, code(() -> service.bind(
                new SkillBindingService.BindCommand(skill.getId(), SkillBinding.SUBJECT_USER, ADMIN,
                        SkillBinding.SCOPE_INSTANCE, null), INSTANCE_ADMIN)));
    }

    @Test
    void missingOrDeletedUsersAreRefused() {
        Skill skill = skill(Skill.DEFINITION_SCOPE_INSTANCE, null);
        when(users.findById(any())).thenReturn(Optional.empty());

        assertEquals(SkillBindingService.ERR_SUBJECT_INVALID, code(() -> service.bind(
                new SkillBindingService.BindCommand(skill.getId(), SkillBinding.SUBJECT_USER, ADMIN,
                        SkillBinding.SCOPE_INSTANCE, null), INSTANCE_ADMIN)));
    }

    @Test
    void disabledPrincipalsAndNonMembersAreRefused() {
        Skill skill = skill(Skill.DEFINITION_SCOPE_INSTANCE, null);
        AgentPrincipal disabled = mock(AgentPrincipal.class);
        when(disabled.getDisabledAt()).thenReturn(java.time.Instant.now());
        when(principals.findById(any())).thenReturn(Optional.of(disabled));

        assertEquals(SkillBindingService.ERR_SUBJECT_INVALID, code(() -> service.bind(
                new SkillBindingService.BindCommand(skill.getId(),
                        SkillBinding.SUBJECT_AGENT_PRINCIPAL, UUID.randomUUID(),
                        SkillBinding.SCOPE_INSTANCE, null), INSTANCE_ADMIN)));

        AgentPrincipal live = mock(AgentPrincipal.class);
        when(principals.findById(any())).thenReturn(Optional.of(live));
        when(members.findById(any(WorkspaceAgentId.class))).thenReturn(Optional.empty());

        // A workspace-tier principal binding requires membership of that workspace.
        assertEquals(SkillBindingService.ERR_SUBJECT_INVALID, code(() -> service.bind(
                new SkillBindingService.BindCommand(skill.getId(),
                        SkillBinding.SUBJECT_AGENT_PRINCIPAL, UUID.randomUUID(),
                        SkillBinding.SCOPE_WORKSPACE, WORKSPACE), INSTANCE_ADMIN)));
    }

    @Test
    void aDuplicateBindingIsA409() {
        Skill skill = skill(Skill.DEFINITION_SCOPE_INSTANCE, null);
        when(users.findById(any())).thenReturn(Optional.of(mock(User.class)));
        when(bindings.countExact(any(), any(), any(), any(), any())).thenReturn(1L);

        CpApiException conflict = assertThrows(CpApiException.class, () -> service.bind(
                new SkillBindingService.BindCommand(skill.getId(), SkillBinding.SUBJECT_USER, ADMIN,
                        SkillBinding.SCOPE_INSTANCE, null), INSTANCE_ADMIN));
        assertEquals(SkillBindingService.ERR_BINDING_EXISTS, conflict.getCode());
        assertEquals(409, conflict.getStatus().value());
    }

    @Test
    void theVocabularyShapeIsChecked() {
        Skill skill = skill(Skill.DEFINITION_SCOPE_INSTANCE, null);

        // workspace scope without an id, instance scope with one, unknown subject/scope.
        assertEquals(SkillBindingService.ERR_INVALID_SCOPE, code(() -> service.bind(
                new SkillBindingService.BindCommand(skill.getId(), SkillBinding.SUBJECT_USER, ADMIN,
                        SkillBinding.SCOPE_WORKSPACE, null), INSTANCE_ADMIN)));
        assertEquals(SkillBindingService.ERR_INVALID_SCOPE, code(() -> service.bind(
                new SkillBindingService.BindCommand(skill.getId(), SkillBinding.SUBJECT_USER, ADMIN,
                        SkillBinding.SCOPE_INSTANCE, WORKSPACE), INSTANCE_ADMIN)));
        assertEquals(SkillBindingService.ERR_INVALID_SCOPE, code(() -> service.bind(
                new SkillBindingService.BindCommand(skill.getId(), "instance", ADMIN,
                        SkillBinding.SCOPE_INSTANCE, null), INSTANCE_ADMIN)));
    }

    @Test
    void anUnknownSkillIs404() {
        when(skills.findById(any())).thenReturn(Optional.empty());

        CpApiException missing = assertThrows(CpApiException.class, () -> service.bind(
                new SkillBindingService.BindCommand(UUID.randomUUID(), SkillBinding.SUBJECT_USER,
                        ADMIN, SkillBinding.SCOPE_INSTANCE, null), INSTANCE_ADMIN));
        assertEquals(SkillBindingService.ERR_SKILL_NOT_FOUND, missing.getCode());
        assertEquals(404, missing.getStatus().value());
    }

    @Test
    void unbindingAnUnknownRowIs404() {
        when(bindings.findById(any())).thenReturn(Optional.empty());

        assertEquals(SkillBindingService.ERR_BINDING_NOT_FOUND,
                code(() -> service.unbind(UUID.randomUUID(), INSTANCE_ADMIN)));
    }

    @Test
    void aWorkspaceAgentMembershipRowIsEnoughForAPrincipalBinding() {
        Skill skill = skill(Skill.DEFINITION_SCOPE_INSTANCE, null);
        AgentPrincipal live = mock(AgentPrincipal.class);
        when(principals.findById(any())).thenReturn(Optional.of(live));
        when(members.findById(any(WorkspaceAgentId.class))).thenReturn(Optional.of(mock(WorkspaceAgent.class)));
        when(bindings.save(any(SkillBinding.class))).thenAnswer(i -> i.getArgument(0));

        SkillBinding binding = service.bind(new SkillBindingService.BindCommand(skill.getId(),
                SkillBinding.SUBJECT_AGENT_PRINCIPAL, UUID.randomUUID(),
                SkillBinding.SCOPE_WORKSPACE, WORKSPACE), INSTANCE_ADMIN);

        assertEquals(SkillBinding.SUBJECT_AGENT_PRINCIPAL, binding.getSubjectType());
        assertEquals(WORKSPACE, binding.getScopeId());
        assertEquals(ADMIN, binding.getCreatedByUserId());
    }
}
