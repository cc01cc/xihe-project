package com.cc01cc.p.xihe.cp.context;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.context.service.ContextAccessService;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.http.HttpStatus;

class ContextAccessServiceTest {

    private static final UUID SESSION_ID = UUID.fromString("10000000-0000-4000-8000-000000000001");
    private static final UUID USER_ID = UUID.fromString("10000000-0000-4000-8000-000000000002");
    private static final UUID WORKSPACE_ID = UUID.fromString("10000000-0000-4000-8000-000000000003");

    private final SessionRepository sessions = mock(SessionRepository.class);
    private final WorkspaceUserRepository members = mock(WorkspaceUserRepository.class);
    private final ContextAccessService service = new ContextAccessService(sessions, members);

    @BeforeEach
    void clearInitialContext() {
        TenantContext.clear();
    }

    @AfterEach
    void clearContext() {
        TenantContext.clear();
    }

    @Test
    void tenantContextTakesPriorityWithoutSessionOrOwnerLookup() {
        TenantContext.setUserId(USER_ID.toString());
        TenantContext.setWorkspaceId(WORKSPACE_ID.toString());
        when(members.findByIdWorkspaceIdAndIdUserId(WORKSPACE_ID, USER_ID))
                .thenReturn(Optional.of(new WorkspaceUser()));

        assertThat(service.resolveUserId("not-a-uuid")).isEqualTo(USER_ID.toString());
        assertThat(service.resolveWorkspaceId("not-a-uuid")).isEqualTo(WORKSPACE_ID.toString());
        assertThat(service.verifyAccess("not-a-uuid")).isTrue();
        verifyNoInteractions(sessions);
        var order = inOrder(members);
        order.verify(members).findByIdWorkspaceIdAndIdUserId(WORKSPACE_ID, USER_ID);
        order.verifyNoMoreInteractions();
    }

    @ParameterizedTest
    @ValueSource(booleans = {true, false})
    void internalSessionMetadataChecksMembershipAfterSeparateOrderedLookups(boolean member) {
        var userRead = mock(Session.class);
        var workspaceRead = mock(Session.class);
        when(userRead.getUserId()).thenReturn(USER_ID.toString());
        when(workspaceRead.getWorkspaceId()).thenReturn(WORKSPACE_ID.toString());
        when(sessions.findById(SESSION_ID))
                .thenReturn(Optional.of(userRead), Optional.of(workspaceRead));
        when(members.findByIdWorkspaceIdAndIdUserId(WORKSPACE_ID, USER_ID))
                .thenReturn(member ? Optional.of(new WorkspaceUser()) : Optional.empty());

        assertThat(service.verifyAccess(SESSION_ID.toString())).isEqualTo(member);

        var order = inOrder(sessions, userRead, workspaceRead, members);
        order.verify(sessions).findById(SESSION_ID);
        order.verify(userRead).getUserId();
        order.verify(sessions).findById(SESSION_ID);
        order.verify(workspaceRead).getWorkspaceId();
        order.verify(members).findByIdWorkspaceIdAndIdUserId(WORKSPACE_ID, USER_ID);
        order.verifyNoMoreInteractions();
    }

    @Test
    void unknownSessionStillPerformsBothLookupsAndDeniesAccess() {
        when(sessions.findById(SESSION_ID)).thenReturn(Optional.empty());

        assertThat(service.verifyAccess(SESSION_ID.toString())).isFalse();

        var order = inOrder(sessions);
        order.verify(sessions, times(2)).findById(SESSION_ID);
        order.verifyNoMoreInteractions();
        verifyNoInteractions(members);
    }

    @ParameterizedTest
    @ValueSource(booleans = {true, false})
    void nullableSessionContextDeniesAccessWithoutMembershipLookup(boolean missingUser) {
        var session = new Session(missingUser ? WORKSPACE_ID.toString() : null,
                missingUser ? null : USER_ID.toString(), "missing context");
        when(sessions.findById(SESSION_ID)).thenReturn(Optional.of(session));

        assertThat(service.verifyAccess(SESSION_ID.toString())).isFalse();

        var order = inOrder(sessions);
        order.verify(sessions, times(2)).findById(SESSION_ID);
        order.verifyNoMoreInteractions();
        verifyNoInteractions(members);
    }

    @Test
    void tenantUserDoesNotRequireSessionOwnership() {
        TenantContext.setUserId(USER_ID.toString());
        var otherOwner = UUID.fromString("10000000-0000-4000-8000-000000000004");
        when(sessions.findById(SESSION_ID)).thenReturn(Optional.of(
                new Session(WORKSPACE_ID.toString(), otherOwner.toString(), "other owner")));
        when(members.findByIdWorkspaceIdAndIdUserId(WORKSPACE_ID, USER_ID))
                .thenReturn(Optional.of(new WorkspaceUser()));

        assertThat(service.verifyAccess(SESSION_ID.toString())).isTrue();

        var order = inOrder(sessions, members);
        order.verify(sessions).findById(SESSION_ID);
        order.verify(members).findByIdWorkspaceIdAndIdUserId(WORKSPACE_ID, USER_ID);
        order.verifyNoMoreInteractions();
    }

    @Test
    void tenantWorkspaceOnlyResolvesSessionUser() {
        TenantContext.setWorkspaceId(WORKSPACE_ID.toString());
        when(sessions.findById(SESSION_ID)).thenReturn(Optional.of(
                new Session(null, USER_ID.toString(), "user context")));
        when(members.findByIdWorkspaceIdAndIdUserId(WORKSPACE_ID, USER_ID))
                .thenReturn(Optional.of(new WorkspaceUser()));

        assertThat(service.verifyAccess(SESSION_ID.toString())).isTrue();

        var order = inOrder(sessions, members);
        order.verify(sessions).findById(SESSION_ID);
        order.verify(members).findByIdWorkspaceIdAndIdUserId(WORKSPACE_ID, USER_ID);
        order.verifyNoMoreInteractions();
    }

    @Test
    void invalidSessionUuidRetainsExistingException() {
        assertThatThrownBy(() -> service.resolveUserId("not-a-uuid"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> service.resolveWorkspaceId("not-a-uuid"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> service.verifyAccess("not-a-uuid"))
                .isInstanceOf(IllegalArgumentException.class);
        verifyNoInteractions(sessions, members);
    }

    @ParameterizedTest
    @ValueSource(booleans = {true, false})
    void invalidResolvedUuidRetainsExistingException(boolean invalidUser) {
        TenantContext.setUserId(invalidUser ? "not-a-uuid" : USER_ID.toString());
        TenantContext.setWorkspaceId(invalidUser ? WORKSPACE_ID.toString() : "not-a-uuid");

        assertThatThrownBy(() -> service.verifyAccess(SESSION_ID.toString()))
                .isInstanceOf(IllegalArgumentException.class);
        verifyNoInteractions(sessions, members);
    }

    @Test
    void publicAccessRequiresTenantContextBeforeAnyLookup() {
        assertThat(service.checkPublicAccess(null, WORKSPACE_ID.toString(), SESSION_ID.toString()))
                .isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(service.checkPublicAccess(USER_ID.toString(), null, SESSION_ID.toString()))
                .isEqualTo(HttpStatus.UNAUTHORIZED);
        verifyNoInteractions(sessions, members);
    }

    @Test
    void publicAccessReturnsNotFoundWhenSessionMissing() {
        when(sessions.findById(SESSION_ID)).thenReturn(Optional.empty());

        assertThat(service.checkPublicAccess(USER_ID.toString(), WORKSPACE_ID.toString(),
                SESSION_ID.toString())).isEqualTo(HttpStatus.NOT_FOUND);

        verifyNoInteractions(members);
    }

    @ParameterizedTest
    @ValueSource(booleans = {true, false})
    void publicAccessReturnsNotFoundWhenOwnerOrWorkspaceDiffers(boolean differentOwner) {
        var otherOwner = UUID.fromString("10000000-0000-4000-8000-000000000004");
        var otherWorkspace = UUID.fromString("10000000-0000-4000-8000-000000000005");
        when(sessions.findById(SESSION_ID)).thenReturn(Optional.of(new Session(
                differentOwner ? WORKSPACE_ID.toString() : otherWorkspace.toString(),
                differentOwner ? otherOwner.toString() : USER_ID.toString(),
                "mismatched session")));

        assertThat(service.checkPublicAccess(USER_ID.toString(), WORKSPACE_ID.toString(),
                SESSION_ID.toString())).isEqualTo(HttpStatus.NOT_FOUND);

        verifyNoInteractions(members);
    }

    @ParameterizedTest
    @ValueSource(booleans = {true, false})
    void publicAccessChecksMembershipOnlyAfterOwnershipAndWorkspaceMatch(boolean member) {
        when(sessions.findById(SESSION_ID)).thenReturn(Optional.of(
                new Session(WORKSPACE_ID.toString(), USER_ID.toString(), "owned session")));
        when(members.findByIdWorkspaceIdAndIdUserId(WORKSPACE_ID, USER_ID))
                .thenReturn(member ? Optional.of(new WorkspaceUser()) : Optional.empty());

        assertThat(service.checkPublicAccess(USER_ID.toString(), WORKSPACE_ID.toString(),
                SESSION_ID.toString())).isEqualTo(member ? HttpStatus.OK : HttpStatus.FORBIDDEN);

        var order = inOrder(sessions, members);
        order.verify(sessions).findById(SESSION_ID);
        order.verify(members).findByIdWorkspaceIdAndIdUserId(WORKSPACE_ID, USER_ID);
        order.verifyNoMoreInteractions();
    }

    @Test
    void publicAccessRetainsInvalidSessionUuidException() {
        assertThatThrownBy(() -> service.checkPublicAccess(
                USER_ID.toString(), WORKSPACE_ID.toString(), "not-a-uuid"))
                .isInstanceOf(IllegalArgumentException.class);
        verifyNoInteractions(sessions, members);
    }
}
