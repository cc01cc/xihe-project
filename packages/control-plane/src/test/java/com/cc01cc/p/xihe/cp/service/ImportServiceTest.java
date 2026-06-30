package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class ImportServiceTest {

    private final SessionRepository sessionRepo = mock(SessionRepository.class);
    private final MessageRepository messageRepo = mock(MessageRepository.class);
    private final ObjectMapper objectMapper = new ObjectMapper();
    private final ImportService service = new ImportService(sessionRepo, messageRepo, objectMapper);

    @Test
    void importChats_parsesValidJson() {
        String json = """
            {"chats":[{"id":"s1","title":"Chat 1","createdAt":"2024-01-01T00:00:00Z","messages":[]}]}
            """;
        when(sessionRepo.existsById("s1")).thenReturn(false);
        ImportService.ImportResult result = service.importChats(json, "user-1");
        assertEquals(1, result.getImported());
        assertEquals(0, result.getSkipped());
        assertNull(result.getLastError());
    }

    @Test
    void importChats_skipsDuplicateSession() {
        String json = """
            {"chats":[{"id":"s1","title":"Chat 1","createdAt":"2024-01-01T00:00:00Z","messages":[]}]}
            """;
        when(sessionRepo.existsById("s1")).thenReturn(true);
        ImportService.ImportResult result = service.importChats(json, "user-1");
        assertEquals(0, result.getImported());
        assertEquals(1, result.getSkipped());
    }

    @Test
    void importChats_missingChatsArray_returnsError() {
        String json = "{}";
        ImportService.ImportResult result = service.importChats(json, "user-1");
        assertEquals(0, result.getImported());
        assertNotNull(result.getLastError());
    }

    @Test
    void importChats_invalidJson_returnsError() {
        ImportService.ImportResult result = service.importChats("not json", "user-1");
        assertEquals(0, result.getImported());
        assertNotNull(result.getLastError());
    }

    @Test
    void importChats_parsesMessages() {
        String json = """
            {"chats":[{"id":"s1","title":"Chat 1","createdAt":"2024-01-01T00:00:00Z","messages":[
                {"role":"user","content":"hello","createdAt":"2024-01-01T00:00:00Z"},
                {"role":"assistant","content":"hi","createdAt":"2024-01-01T00:00:01Z"}
            ]}]}
            """;
        when(sessionRepo.existsById("s1")).thenReturn(false);
        ImportService.ImportResult result = service.importChats(json, "user-1");
        assertEquals(1, result.getImported());
        verify(messageRepo, times(2)).save(any());
    }
}
