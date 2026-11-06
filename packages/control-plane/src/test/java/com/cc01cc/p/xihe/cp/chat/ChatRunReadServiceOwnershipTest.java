package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunTransportAttemptRepository;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;
import org.junit.jupiter.api.Test;

import java.util.Optional;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * BL-370 S1: the controller-facing read methods of {@link ChatRunReadService}.
 *
 * <p>The important contract is the frozen 404-before-403 order: an unknown run must be
 * RUN_NOT_FOUND even when the caller is not its owner, and only an existing run may produce
 * FORBIDDEN. Controllers used to implement this inline; a regression here would turn a
 * cross-tenant probe into a 403-vs-404 oracle.
 */
class ChatRunReadServiceOwnershipTest {

    private static final UUID RUN_UUID = UUID.randomUUID();
    private static final String RUN_ID = RUN_UUID.toString();
    private static final String USER_ID = "user-1";
    private static final String WORKSPACE_ID = "ws-1";

    private final ChatRunRepository runs = mock(ChatRunRepository.class);
    private final ChatRunTransportAttemptRepository attempts = mock(ChatRunTransportAttemptRepository.class);
    private final ChatRunReadService service =
            new ChatRunReadService(runs, attempts, mock(ApprovalService.class), mock(MessageRepository.class));

    private ChatRun runOwnedBy(String userId, String workspaceId) {
        ChatRun run = mock(ChatRun.class);
        when(run.getId()).thenReturn(RUN_UUID);
        when(run.getUserId()).thenReturn(userId);
        when(run.getWorkspaceId()).thenReturn(workspaceId);
        return run;
    }

    @Test
    void unknownRunIs404EvenForANonOwner() {
        when(runs.findById(RUN_UUID)).thenReturn(Optional.empty());
        CpApiException error = assertThrows(CpApiException.class,
                () -> service.requireOwnedRun(RUN_UUID, "stranger", "other-ws"));
        assertEquals(404, error.getStatus().value());
        assertEquals("RUN_NOT_FOUND", error.getCode());
    }

    @Test
    void existingRunWithAnotherOwnerIs403() {
        ChatRun otherOwner = runOwnedBy("someone-else", WORKSPACE_ID);
        when(runs.findById(RUN_UUID)).thenReturn(Optional.of(otherOwner));
        CpApiException error = assertThrows(CpApiException.class,
                () -> service.requireOwnedRun(RUN_UUID, USER_ID, WORKSPACE_ID));
        assertEquals(403, error.getStatus().value());
        assertEquals("FORBIDDEN", error.getCode());
    }

    @Test
    void existingRunWithAnotherWorkspaceIs403() {
        ChatRun otherWorkspace = runOwnedBy(USER_ID, "another-ws");
        when(runs.findById(RUN_UUID)).thenReturn(Optional.of(otherWorkspace));
        CpApiException error = assertThrows(CpApiException.class,
                () -> service.requireOwnedRun(RUN_UUID, USER_ID, WORKSPACE_ID));
        assertEquals(403, error.getStatus().value());
    }

    @Test
    void ownerGetsTheRunBack() {
        ChatRun owned = runOwnedBy(USER_ID, WORKSPACE_ID);
        when(runs.findById(RUN_UUID)).thenReturn(Optional.of(owned));
        assertThat(service.requireOwnedRun(RUN_UUID, USER_ID, WORKSPACE_ID)).isSameAs(owned);
    }

    @Test
    void latestRunForSessionDelegatesAndReturnsNullWhenAbsent() {
        ChatRun latest = runOwnedBy(USER_ID, WORKSPACE_ID);
        when(runs.findFirstBySessionIdOrderByCreatedAtDescIdDesc("s-1")).thenReturn(Optional.of(latest));
        when(runs.findFirstBySessionIdOrderByCreatedAtDescIdDesc("s-empty")).thenReturn(Optional.empty());
        assertThat(service.latestRunForSession("s-1")).isSameAs(latest);
        assertThat(service.latestRunForSession("s-empty")).isNull();
    }

    @Test
    void hasTransportAttemptIsTheOnlyDispatchProbeControllersNeed() {
        when(attempts.existsByRunId(RUN_ID)).thenReturn(true);
        assertThat(service.hasTransportAttempt(RUN_ID)).isTrue();
    }
}
