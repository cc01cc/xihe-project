package com.cc01cc.p.xihe.cp.skill;

import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.policy.RequesterAuthority;
import com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * PLAN-0651 M3 T3.2 (A24–A29 → N5 {@code MANAGE_SKILL_LIBRARY}): locks the guard's new judgement.
 *
 * <p>Why this test did not exist before: the guard answered {@code cap:instance:admin}, which every
 * ADMIN integration fixture already satisfied, so a dedicated unit test would have re-asserted the
 * same capability. The atom judgement has two distinct edges that need pinning:</p>
 * <ul>
 *   <li>the instance bypass is evaluated at <b>instance scope only</b> ({@code workspaceId = null}) —
 *       a workspace-scoped N5 must not authorize the instance library;</li>
 *   <li>the workspace tier keeps the <b>retained role judgement</b> ({@code canManageWorkspace},
 *       OWNER-only per D51-28), not the atom alone.</li>
 * </ul>
 */
class SkillAccessGuardTest {

    private static final UUID ACTOR = UUID.fromString("00000000-0000-4000-8000-00000000aa01");
    private static final UUID WORKSPACE = UUID.fromString("00000000-0000-4000-8000-00000000bb01");

    private WorkspaceService workspaceService;
    private RequesterAuthority requesterAuthority;
    private SkillAccessGuard guard;

    @BeforeEach
    void setUp() {
        workspaceService = mock(WorkspaceService.class);
        requesterAuthority = mock(RequesterAuthority.class);
        guard = new SkillAccessGuard(workspaceService, requesterAuthority);
        TenantContext.setUserId(ACTOR.toString());
    }

    @AfterEach
    void tearDown() {
        TenantContext.clear();
    }

    @Test
    void instanceLibraryManagerIsTheN5AtomAtInstanceScope() {
        when(requesterAuthority.holdsActionAtom(ACTOR, ToolFaceRegistry.ACTION_MANAGE_SKILL_LIBRARY,
                null)).thenReturn(true);

        assertTrue(guard.canManageInstanceLibrary());
        verify(requesterAuthority).holdsActionAtom(eq(ACTOR),
                eq(ToolFaceRegistry.ACTION_MANAGE_SKILL_LIBRARY), isNull());
    }

    @Test
    void missingN5AtomDeniesTheInstanceLibraryEvenForAWorkspaceOwner() {
        when(requesterAuthority.holdsActionAtom(ACTOR, ToolFaceRegistry.ACTION_MANAGE_SKILL_LIBRARY,
                null)).thenReturn(false);
        when(workspaceService.resolveWorkspaceRole(WORKSPACE.toString(), ACTOR.toString()))
                .thenReturn("OWNER");

        assertFalse(guard.canManageInstanceLibrary(), "workspace scope must not leak into instance");
        assertFalse(guard.canWriteDefinitionScope(Skill.DEFINITION_SCOPE_INSTANCE, null));
    }

    @Test
    void workspaceLibraryKeepsTheOwnerOnlyRoleJudgement() {
        when(requesterAuthority.holdsActionAtom(ACTOR, ToolFaceRegistry.ACTION_MANAGE_SKILL_LIBRARY,
                null)).thenReturn(false);
        when(workspaceService.resolveWorkspaceRole(WORKSPACE.toString(), ACTOR.toString()))
                .thenReturn("EDITOR");
        assertFalse(guard.canWriteDefinitionScope(Skill.DEFINITION_SCOPE_WORKSPACE, WORKSPACE),
                "EDITOR is not a workspace-library manager (D51-28 retained role judgement)");

        when(workspaceService.resolveWorkspaceRole(WORKSPACE.toString(), ACTOR.toString()))
                .thenReturn("OWNER");
        assertTrue(guard.canWriteDefinitionScope(Skill.DEFINITION_SCOPE_WORKSPACE, WORKSPACE));

        when(requesterAuthority.holdsActionAtom(ACTOR, ToolFaceRegistry.ACTION_MANAGE_SKILL_LIBRARY,
                null)).thenReturn(true);
        assertTrue(guard.canWriteDefinitionScope(Skill.DEFINITION_SCOPE_WORKSPACE, WORKSPACE),
                "an instance N5 holder is the historical instance-admin bypass");
    }

    @Test
    void noAuthenticatedActorMeansNoLibraryRight() {
        TenantContext.clear();
        assertFalse(guard.canManageInstanceLibrary());
        assertFalse(guard.canWriteDefinitionScope(Skill.DEFINITION_SCOPE_INSTANCE, null));
    }
}
