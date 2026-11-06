package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.ChatRunProviderRequest;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.repository.ChatRunProviderRequestRepository;
import com.cc01cc.p.xihe.cp.service.SessionService;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.util.Optional;
import java.util.UUID;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * PLAN-0679 T2.3 HTTP contract for {@code GET /api/v1/chat/runs/{runId}/provider-request-fingerprint}.
 *
 * <p>Pins the wire behaviour, not just the service: the same run-trace authorization gate as the
 * 0666 context-fingerprint route (404 unknown / 403 foreign owner / 404 foreign session), the
 * {@code not_captured} absence envelope, the cross-session {@code 409 DIFF_SESSION_MISMATCH}, and
 * that the fingerprint reaches the client as a real document (never a Jackson-2 node echo —
 * PLAN-0633 C1).</p>
 */
class RunProviderRequestFingerprintControllerHttpTest {

    private static final String USER = "user-1";
    private static final String WS = "ws-1";
    private static final String RUN_ID = "00000000-0000-4000-8000-000000000001";
    private static final String AGAINST_ID = "00000000-0000-4000-8000-000000000002";
    private static final String PATH = "/api/v1/chat/runs/{runId}/provider-request-fingerprint";

    private final ChatRunReadService readService = mock(ChatRunReadService.class);
    private final ChatRunProviderRequestRepository repository =
            mock(ChatRunProviderRequestRepository.class);
    // PLAN-0679 T2.3 architecture fix: the controller no longer holds the repository — the row
    // lookup moved into RunProviderRequestReadService. This seam keeps the exact same stub surface
    // (findById), so every wire assertion below is unchanged.
    private final RunProviderRequestReadService providerRequestReadService =
            new RunProviderRequestReadService(repository);
    private final SessionService sessionService = mock(SessionService.class);
    private final ObjectMapper objectMapper = new ObjectMapper();
    private final MockMvc mvc = MockMvcBuilders
            .standaloneSetup(new RunProviderRequestFingerprintController(
                    readService, providerRequestReadService, sessionService))
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

    private ChatRun run(String runId, String sessionId) {
        ChatRun run = mock(ChatRun.class);
        when(run.getId()).thenReturn(UUID.fromString(runId));
        when(run.getSessionId()).thenReturn(sessionId);
        return run;
    }

    private ChatRunProviderRequest row() {
        return rowWithDocument(document("same"));
    }

    private ChatRunProviderRequest rowWithDocument(ObjectNode document) {
        ChatRunProviderRequest row = new ChatRunProviderRequest();
        row.setRunId(UUID.fromString(RUN_ID));
        row.setDispatchAttempt(1);
        row.setProviderStep(1);
        row.setApiTypeId("openai-chat-completions");
        row.setApiTypeVersion(1);
        row.setModel("openai/gpt-5");
        row.setMessageCount(5);
        row.setToolCount(3);
        row.setBytesTotal(22340L);
        ObjectNode histogram = objectMapper.createObjectNode().put("user", 2);
        row.setRoleHistogram(histogram);
        row.setSystemSources(objectMapper.createObjectNode());
        row.setFingerprint(document);
        return row;
    }

    private ObjectNode document(String historyHash) {
        ObjectNode document = objectMapper.createObjectNode();
        document.put("algo", "sha256");
        document.put("dispatchAttempt", 1);
        document.put("providerStep", 1);
        ObjectNode layers = document.putObject("layers");
        layers.putObject("systemTemplate").put("hash", "a").put("bytes", 100);
        layers.putObject("history").put("hash", historyHash).put("bytes", 300).put("count", 3);
        layers.putObject("userInput").put("hash", "b").put("bytes", 40);
        layers.putObject("toolSchema").put("hash", "c").put("bytes", 200).put("count", 3);
        layers.putObject("config").put("hash", "d").put("bytes", 12);
        document.putObject("outbound").put("hash", "e").put("bytes", 652);
        return document;
    }

    @Test
    void invalidUuidIs404BeforeAnyLookup() throws Exception {
        mvc.perform(get(PATH, "not-a-uuid"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("RUN_NOT_FOUND"));
    }

    @Test
    void unknownRunIs404AndForeignOwnerIs403() throws Exception {
        when(readService.requireOwnedRun(any(), eq(USER), eq(WS)))
                .thenThrow(new CpApiException(HttpStatus.NOT_FOUND, "RUN_NOT_FOUND", "Chat run not found"));
        mvc.perform(get(PATH, RUN_ID))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("RUN_NOT_FOUND"));

        when(readService.requireOwnedRun(any(), eq(USER), eq(WS)))
                .thenThrow(new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN", "not owner"));
        mvc.perform(get(PATH, RUN_ID))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("FORBIDDEN"));
    }

    @Test
    void missingRowIsReportedAsNotCapturedNotDisabled() throws Exception {
        ChatRun ownedRun = run(RUN_ID, "session-1");
        when(readService.requireOwnedRun(any(), eq(USER), eq(WS))).thenReturn(ownedRun);
        when(sessionService.requireCurrent(anyString(), eq(USER), eq(WS))).thenReturn(mock(Session.class));
        when(repository.findById(UUID.fromString(RUN_ID))).thenReturn(Optional.empty());

        mvc.perform(get(PATH, RUN_ID))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.runId").value(RUN_ID))
                .andExpect(jsonPath("$.available").value(false))
                .andExpect(jsonPath("$.reason").value("not_captured"))
                .andExpect(jsonPath("$.fingerprint").doesNotExist());
    }

    @Test
    void capturedRowReturnsTheDocumentAndRequestMetadata() throws Exception {
        ChatRun ownedRun = run(RUN_ID, "session-1");
        when(readService.requireOwnedRun(any(), eq(USER), eq(WS))).thenReturn(ownedRun);
        when(sessionService.requireCurrent(anyString(), eq(USER), eq(WS))).thenReturn(mock(Session.class));
        when(repository.findById(UUID.fromString(RUN_ID))).thenReturn(Optional.of(row()));

        mvc.perform(get(PATH, RUN_ID))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.available").value(true))
                .andExpect(jsonPath("$.fingerprint.algo").value("sha256"))
                .andExpect(jsonPath("$.fingerprint.layers.history.count").value(3))
                .andExpect(jsonPath("$.request.model").value("openai/gpt-5"))
                .andExpect(jsonPath("$.request.messageCount").value(5));
    }

    @Test
    void diffAgainstAnotherRunInTheSameSessionReportsLayerVerdicts() throws Exception {
        ChatRun currentRun = run(RUN_ID, "session-1");
        ChatRun baselineRun = run(AGAINST_ID, "session-1");
        when(readService.requireOwnedRun(any(), eq(USER), eq(WS)))
                .thenReturn(currentRun, baselineRun);
        when(sessionService.requireCurrent(anyString(), eq(USER), eq(WS))).thenReturn(mock(Session.class));
        when(repository.findById(UUID.fromString(RUN_ID))).thenReturn(Optional.of(row()));
        when(repository.findById(UUID.fromString(AGAINST_ID)))
                .thenReturn(Optional.of(rowWithDocument(document("different"))));

        mvc.perform(get(PATH, RUN_ID).param("against", AGAINST_ID))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("comparable"))
                .andExpect(jsonPath("$.layers.history.status").value("changed(sameShape)"))
                .andExpect(jsonPath("$.layers.systemTemplate.status").value("unchanged"))
                .andExpect(jsonPath("$.current.model").value("openai/gpt-5"))
                .andExpect(jsonPath("$.against.model").value("openai/gpt-5"));
    }

    @Test
    void diffAcrossSessionsIs409() throws Exception {
        ChatRun currentRun = run(RUN_ID, "session-1");
        ChatRun baselineRun = run(AGAINST_ID, "session-2");
        when(readService.requireOwnedRun(any(), eq(USER), eq(WS)))
                .thenReturn(currentRun, baselineRun);
        when(sessionService.requireCurrent(anyString(), eq(USER), eq(WS))).thenReturn(mock(Session.class));

        mvc.perform(get(PATH, RUN_ID).param("against", AGAINST_ID))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("DIFF_SESSION_MISMATCH"));
    }
}
