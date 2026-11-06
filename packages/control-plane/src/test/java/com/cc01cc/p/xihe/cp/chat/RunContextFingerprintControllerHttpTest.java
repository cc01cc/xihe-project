package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.service.SessionService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * BL-370 S1 follow-up: the S1 refactor moved the 404-vs-403 decision out of this controller, and
 * there was **no HTTP-level test** for the route at all. These tests pin the wire contract, not just
 * the service: status code *and* Problem Details {@code code} (a matching status with the wrong code
 * is indistinguishable from unfixed for a client).
 */
class RunContextFingerprintControllerHttpTest {

    private static final String USER = "user-1";
    private static final String WS = "ws-1";
    private static final String RUN_ID = "00000000-0000-4000-8000-000000000001";

    private final ChatRunReadService readService = mock(ChatRunReadService.class);
    private final SessionService sessionService = mock(SessionService.class);
    private final MockMvc mvc = MockMvcBuilders
            .standaloneSetup(new RunContextFingerprintController(
                    readService, sessionService, new ObjectMapper()))
            .build();

    @BeforeEach
    void tenant() {
        TenantContext.setUserId(USER);
        TenantContext.setWorkspaceId(WS);
    }

    @AfterEach
    void clearTenant() {
        TenantContext.clear();
    }

    private ChatRun run() {
        ChatRun run = mock(ChatRun.class);
        when(run.getId()).thenReturn(java.util.UUID.fromString(RUN_ID));
        when(run.getSessionId()).thenReturn("session-1");
        return run;
    }

    private void expectProblem(String runId, HttpStatus status, String code) throws Exception {
        mvc.perform(get("/api/v1/chat/runs/{runId}/context-fingerprint", runId))
                .andExpect(status().is(status.value()))
                .andExpect(jsonPath("$.code").value(code));
    }

    @Test
    void invalidUuidIs404BeforeAnyLookup() throws Exception {
        expectProblem("not-a-uuid", HttpStatus.NOT_FOUND, "RUN_NOT_FOUND");
    }

    @Test
    void unknownRunIs404EvenWhenTheCallerIsNotItsOwner() throws Exception {
        // The service enforces the order; this test pins the HTTP result of that order.
        when(readService.requireOwnedRun(any(), eq(USER), eq(WS)))
                .thenThrow(new CpApiException(HttpStatus.NOT_FOUND, "RUN_NOT_FOUND", "Chat run not found"));
        expectProblem(RUN_ID, HttpStatus.NOT_FOUND, "RUN_NOT_FOUND");
    }

    @Test
    void existingRunWithAnotherOwnerIs403WithForbiddenCode() throws Exception {
        when(readService.requireOwnedRun(any(), eq(USER), eq(WS)))
                .thenThrow(new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                        "Chat run does not belong to current user/workspace"));
        expectProblem(RUN_ID, HttpStatus.FORBIDDEN, "FORBIDDEN");
    }

    @Test
    void ownerRunWithSessionNotOwnedIsSessionNotFound() throws Exception {
        ChatRun ownedRun = run();
        when(readService.requireOwnedRun(any(), eq(USER), eq(WS))).thenReturn(ownedRun);
        when(sessionService.requireCurrent("session-1", USER, WS))
                .thenThrow(new CpApiException(HttpStatus.NOT_FOUND, "SESSION_NOT_FOUND", "Session not found"));
        expectProblem(RUN_ID, HttpStatus.NOT_FOUND, "SESSION_NOT_FOUND");
    }

    @Test
    void noDocumentAndNoAttemptIsNotDispatched() throws Exception {
        ChatRun ownedRun = run();
        when(readService.requireOwnedRun(any(), eq(USER), eq(WS))).thenReturn(ownedRun);
        when(sessionService.requireCurrent(anyString(), eq(USER), eq(WS))).thenReturn(mock(Session.class));
        when(readService.hasTransportAttempt(RUN_ID)).thenReturn(false);
        mvc.perform(get("/api/v1/chat/runs/{runId}/context-fingerprint", RUN_ID))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.available").value(false))
                .andExpect(jsonPath("$.reason").value("not_dispatched"));
    }
}
