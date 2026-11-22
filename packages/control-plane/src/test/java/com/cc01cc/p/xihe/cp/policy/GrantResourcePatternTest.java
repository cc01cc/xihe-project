package com.cc01cc.p.xihe.cp.policy;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * task-830: the grant write face reads the {@link ResourceNamespaces} registry. The three refusals
 * that used to be implicit (anything not {@code fs:} simply fell through to the workspace-prefix
 * rule) now have distinct 400 reasons, and {@code phys:} is pinned as never-storable.
 */
class GrantResourcePatternTest {

    private static final UUID WORKSPACE_ID = UUID.fromString("11111111-1111-4111-8111-111111111111");

    private final WorkspaceRepository workspaces = mock(WorkspaceRepository.class);
    private final RequesterAuthority requester = mock(RequesterAuthority.class);
    private final GrantResourcePattern patterns = new GrantResourcePattern(workspaces, requester);

    @BeforeEach
    void anExistingWorkspace() {
        when(workspaces.findByIdAndDeletedAtIsNull(any(UUID.class)))
                .thenReturn(Optional.of(mock(Workspace.class)));
    }

    @Test
    void evaluatingPhysIsNeverStoredInAGrant() {
        CpApiException refusal = refused(atom("read"), "phys:/h/ws/src");
        assertTrue(refusal.getMessage().contains("evaluation-time"), refusal.getMessage());
        assertEquals(ResourceNamespaces.Grantability.EVALUATION_ONLY,
                ResourceNamespaces.grantabilityOf("phys:/h/ws/src"),
                "the registry classifies phys as evaluation-only, not grantable");
    }

    @Test
    void workspaceAndSessionAreVisibilityContextNotGrantResources() {
        assertTrue(refused(atom("read"), "workspace:" + WORKSPACE_ID).getMessage()
                .contains("visibility context"));
        assertTrue(refused(atom("read"), "session:" + UUID.randomUUID()).getMessage()
                .contains("visibility context"));
    }

    @Test
    void anUnknownNamespaceFailsClosedAndSaysWhatIsRegistered() {
        CpApiException refusal = refused(atom("read"), "mystery:" + WORKSPACE_ID);
        assertTrue(refusal.getMessage().contains("unknown resource namespace"), refusal.getMessage());
        assertTrue(refusal.getMessage().contains("fs/phys/credential/skill"), refusal.getMessage());
    }

    @Test
    void theLegacyFsPrefixStillWorksAndIsCanonicalized() {
        String resolved = patterns.resolve(atom("read"), "fs:" + WORKSPACE_ID + "/src/app/");
        assertEquals("fs:" + WORKSPACE_ID + "/src/app", resolved);
        assertEquals("fs:" + WORKSPACE_ID, patterns.resolve(atom("read"), "fs:" + WORKSPACE_ID),
                "the legacy single-segment fs: key is still accepted");
    }

    @Test
    void wildcardAndBlankKeepTheCanonicalResource() {
        assertEquals("*", patterns.resolve(atom("read"), null));
        assertEquals("*", patterns.resolve(atom("read"), "  "));
        assertEquals("*", patterns.resolve(atom("read"), "*"));
        assertEquals("credential:*", patterns.resolve(atom("credential_manage"), "credential:*"));
        assertEquals("credential:" + WORKSPACE_ID,
                patterns.resolve(atom("credential_manage"), "credential:" + WORKSPACE_ID));
    }

    @Test
    void capabilityAtomsNeverCarryAResourceIncludingWorkspaceAdmin() {
        assertTrue(refused(atom("workspace:admin"), "fs:" + WORKSPACE_ID + "/src").getMessage()
                .contains("capability atom"));
        assertTrue(refused(atom("instance:admin"), "workspace:" + WORKSPACE_ID).getMessage()
                .contains("capability atom"));
        assertEquals("*", patterns.resolve(atom("workspace:admin"), null),
                "an omitted resource still resolves to the canonical wildcard");
    }

    @Test
    void instanceOnlyAtomsCannotBeNarrowedByAWorkspacePath() {
        assertTrue(refused(atom("MANAGE_ROLES"), "fs:" + WORKSPACE_ID + "/src").getMessage()
                .contains("instance-scoped"));
    }

    @Test
    void aCredentialPartialGlobIsNotPartOfTheNamespace() {
        assertTrue(refused(atom("credential_use"), "credential:ab*").getMessage()
                .contains("credential:* or credential:<uuid>"));
    }

    private CpApiException refused(PermissionAtomCatalog.Atom atom, String resource) {
        CpApiException failure = assertThrows(CpApiException.class,
                () -> patterns.resolve(atom, resource));
        assertEquals(GrantResourcePattern.CODE_INVALID, failure.getCode(), failure.getMessage());
        return failure;
    }

    private static PermissionAtomCatalog.Atom atom(String name) {
        return PermissionAtomCatalog.atom(name);
    }
}
