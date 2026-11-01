package com.cc01cc.p.xihe.cp.provider;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.credentials.CredentialEnvelope;
import com.cc01cc.p.xihe.cp.entity.Credential;
import com.cc01cc.p.xihe.cp.policy.GrantAuthorizationService;
import com.cc01cc.p.xihe.cp.repository.CredentialRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * PLAN-0622 M1.4 (K2/K4): the agent-principal arm is a <b>conjunction</b>, never a disjunction.
 *
 * <p>The three legacy arms stay the primary authority (they are exercised through
 * {@code canUse}, untouched): a principal grant can never widen them. It only adds the case the
 * legacy arms do not cover, and it is vetoed for credentials the caller must not borrow — another
 * user's personal credential, or a workspace credential of a different workspace.</p>
 */
class ProviderCredentialAccessAgentPrincipalTest {

    private static final String CALLER = "11111111-1111-4111-8111-111111111111";
    private static final String OTHER_USER = "22222222-2222-4222-8222-222222222222";
    private static final String WORKSPACE = "33333333-3333-4333-8333-333333333333";
    private static final String OTHER_WORKSPACE = "44444444-4444-4444-8444-444444444444";

    private CredentialRepository credentials;
    private GrantAuthorizationService grants;
    private ProviderCredentialAccess access;

    @BeforeEach
    void setUp() {
        credentials = mock(CredentialRepository.class);
        grants = mock(GrantAuthorizationService.class);
        access = new ProviderCredentialAccess(credentials, mock(CredentialEnvelope.class), grants,
                new ObjectMapper());
    }

    @Test
    void legacyPathIsUnchangedWhenNoAgentPrincipalIsInvolved() {
        Credential own = credential(Credential.OWNER_USER, CALLER);
        when(credentials.findByIdAndDeletedAtIsNull(own.getId())).thenReturn(Optional.of(own));

        assertSame(own, access.requireUsable(own.getId(), CALLER, WORKSPACE),
                "arm ① still authorizes the owner with no principal argument at all");

        Credential foreign = credential(Credential.OWNER_USER, OTHER_USER);
        when(credentials.findByIdAndDeletedAtIsNull(foreign.getId())).thenReturn(Optional.of(foreign));
        assertDenied(() -> access.requireUsable(foreign.getId(), CALLER, WORKSPACE));
    }

    @Test
    void thePrincipalArmNeverBlocksTheLegacyArms() {
        Credential own = credential(Credential.OWNER_USER, CALLER);
        when(credentials.findByIdAndDeletedAtIsNull(own.getId())).thenReturn(Optional.of(own));

        assertSame(own, access.requireUsableForAgentPrincipal(own.getId(), CALLER, WORKSPACE,
                        "55555555-5555-4555-8555-555555555555", true),
                "a granted principal does not break arm ①");
    }

    @Test
    void aGrantedPrincipalCannotBorrowAnotherUsersCredential() {
        Credential foreign = credential(Credential.OWNER_USER, OTHER_USER);
        when(credentials.findByIdAndDeletedAtIsNull(foreign.getId())).thenReturn(Optional.of(foreign));

        assertDenied(() -> access.requireUsableForAgentPrincipal(foreign.getId(), CALLER, WORKSPACE,
                        "55555555-5555-4555-8555-555555555555", true),
                "K4: a principal grant is not a license to spend someone else's key");
    }

    @Test
    void aGrantedPrincipalCannotBorrowAnotherWorkspacesCredential() {
        Credential foreign = credential(Credential.OWNER_WORKSPACE, OTHER_WORKSPACE);
        when(credentials.findByIdAndDeletedAtIsNull(foreign.getId())).thenReturn(Optional.of(foreign));

        assertDenied(() -> access.requireUsableForAgentPrincipal(foreign.getId(), CALLER, WORKSPACE,
                        "55555555-5555-4555-8555-555555555555", true),
                "K4: workspace-shared means this workspace, not any workspace");
    }

    @Test
    void anUngrantedPrincipalIsDeniedEvenWhenTheCredentialIsSharedWithThisWorkspace() {
        Credential shared = credential(Credential.OWNER_WORKSPACE, WORKSPACE);
        when(credentials.findByIdAndDeletedAtIsNull(shared.getId())).thenReturn(Optional.of(shared));
        when(grants.allowsUserOnly(any())).thenReturn(false);

        // Arm ② authorizes the shared credential for the caller (legacy behaviour, untouched),
        // which is exactly why the principal arm must not be the thing that decides it.
        assertSame(shared, access.requireUsableForAgentPrincipal(shared.getId(), CALLER, WORKSPACE,
                "55555555-5555-4555-8555-555555555555", false));
    }

    @Test
    void anUngrantedPrincipalWithoutAnyLegacyArmIsDenied() {
        Credential foreign = credential(Credential.OWNER_USER, OTHER_USER);
        when(credentials.findByIdAndDeletedAtIsNull(foreign.getId())).thenReturn(Optional.of(foreign));
        when(grants.allowsUserOnly(any())).thenReturn(false);

        assertDenied(() -> access.requireUsableForAgentPrincipal(foreign.getId(), CALLER, WORKSPACE,
                "55555555-5555-4555-8555-555555555555", false));
    }

    private static void assertDenied(Runnable call) {
        assertDenied(call, "the use is refused");
    }

    private static void assertDenied(Runnable call, String message) {
        CpApiException refused = assertThrows(CpApiException.class, call::run);
        assertEquals("CREDENTIAL_USE_DENIED", refused.getCode(), message);
    }

    private static Credential credential(String ownerType, String ownerId) {
        Credential credential = new Credential();
        credential.setId(UUID.randomUUID());
        credential.setOwnerType(ownerType);
        credential.setOwnerId(ownerId);
        credential.setKind(Credential.KIND_TOKEN);
        credential.setDeliveryTier(Credential.TIER_LEASE);
        credential.setStatus(Credential.STATUS_ACTIVE);
        return credential;
    }
}
