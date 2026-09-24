package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;
import com.cc01cc.p.xihe.cp.policy.GrantDefaultService;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionStatus;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class ImportServiceTest {

    private final SessionRepository sessionRepo = mock(SessionRepository.class);
    private final MessageRepository messageRepo = mock(MessageRepository.class);
    private final GrantDefaultService grantDefaultService = mock(GrantDefaultService.class);
    private final ObjectMapper objectMapper = new ObjectMapper();
    private final PlatformTransactionManager transactionManager = mock(PlatformTransactionManager.class);
    private final ImportService service = createService();

    private ImportService createService() {
        when(transactionManager.getTransaction(any())).thenReturn(mock(TransactionStatus.class));
        return new ImportService(sessionRepo, messageRepo, objectMapper, grantDefaultService, transactionManager);
    }

    @Test
    void importChats_parsesValidJson() {
        String json = """
            {"chats":[{"id":"99999999-9999-9999-9999-999999999999","title":"Chat 1","createdAt":"2024-01-01T00:00:00Z","messages":[]}]}
            """;
        when(sessionRepo.existsById(java.util.UUID.fromString("99999999-9999-9999-9999-999999999999"))).thenReturn(false);
        when(sessionRepo.save(any(Session.class))).thenAnswer(invocation -> invocation.getArgument(0));
        ImportService.ImportResult result = service.importChats(json, "user-1", "workspace-1");
        assertEquals(1, result.getImported());
        assertEquals(0, result.getSkipped());
        assertNull(result.getLastError());
        verify(grantDefaultService).ensureAgentSessionDefault(any(Session.class));
        verify(sessionRepo).save(argThat(session -> "workspace-1".equals(session.getWorkspaceId())));
    }

    @Test
    void importChats_skipsDuplicateSession() {
        String json = """
            {"chats":[{"id":"99999999-9999-9999-9999-999999999999","title":"Chat 1","createdAt":"2024-01-01T00:00:00Z","messages":[]}]}
            """;
        when(sessionRepo.existsById(java.util.UUID.fromString("99999999-9999-9999-9999-999999999999"))).thenReturn(true);
        ImportService.ImportResult result = service.importChats(json, "user-1", "workspace-1");
        assertEquals(0, result.getImported());
        assertEquals(1, result.getSkipped());
    }

    @Test
    void importChats_missingChatsArray_returnsError() {
        String json = "{}";
        ImportService.ImportResult result = service.importChats(json, "user-1", "workspace-1");
        assertEquals(0, result.getImported());
        assertNotNull(result.getLastError());
    }

    @Test
    void importChats_invalidJson_returnsError() {
        ImportService.ImportResult result = service.importChats("not json", "user-1", "workspace-1");
        assertEquals(0, result.getImported());
        assertNotNull(result.getLastError());
    }

    @Test
    void importChats_parsesMessages() {
        String json = """
            {"chats":[{"id":"99999999-9999-9999-9999-999999999999","title":"Chat 1","createdAt":"2024-01-01T00:00:00Z","messages":[
                {"role":"user","content":"hello","createdAt":"2024-01-01T00:00:00Z"},
                {"role":"assistant","content":"hi","createdAt":"2024-01-01T00:00:01Z"}
            ]}]}
            """;
        when(sessionRepo.existsById(java.util.UUID.fromString("99999999-9999-9999-9999-999999999999"))).thenReturn(false);
        ImportService.ImportResult result = service.importChats(json, "user-1", "workspace-1");
        assertEquals(1, result.getImported());
        verify(messageRepo, times(2)).save(any());
    }

    @Test
    void importChats_commitsEachChatAndRollsBackOnlyTheFailedChat() {
        String json = """
                {"chats":[
                  {"id":"99999999-9999-9999-9999-999999999991","title":"Good","createdAt":"2024-01-01T00:00:00Z","messages":[]},
                  {"id":"99999999-9999-9999-9999-999999999992","title":"Bad","createdAt":"2024-01-01T00:00:00Z","messages":[
                    {"role":"unknown","content":"bad role","createdAt":"2024-01-01T00:00:00Z"}
                  ]}
                ]}
                """;
        when(sessionRepo.existsById(any())).thenReturn(false);
        when(sessionRepo.save(any(Session.class))).thenAnswer(invocation -> invocation.getArgument(0));

        ImportService.ImportResult result = service.importChats(json, "user-1", "workspace-1");

        assertEquals(1, result.getImported());
        assertEquals(0, result.getSkipped());
        assertTrue(result.getLastError().contains("99999999-9999-9999-9999-999999999992"));
        verify(transactionManager, times(1)).commit(any());
        verify(transactionManager, times(1)).rollback(any());
    }
}
