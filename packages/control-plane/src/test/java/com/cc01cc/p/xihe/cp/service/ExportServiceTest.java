package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import java.util.Collections;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class ExportServiceTest {

    private final SessionRepository sessionRepo = mock(SessionRepository.class);
    private final MessageRepository messageRepo = mock(MessageRepository.class);
    private final ObjectMapper objectMapper = new ObjectMapper();
    private final ExportService service = new ExportService(sessionRepo, messageRepo, objectMapper);

    @Test
    void exportSettings_returnsJsonWithUserId() {
        String json = service.exportSettings("user-1");
        assertTrue(json.contains("user-1"));
        assertTrue(json.contains("exportedAt"));
        assertTrue(json.contains("version"));
    }

    @Test
    void exportChats_withNoSessions_returnsEmptyChats() {
        when(sessionRepo.findByUserIdAndArchivedFalseOrderByCreatedAtDesc(any()))
            .thenReturn(Collections.emptyList());
        String json = service.exportChats("user-1");
        assertNotNull(json);
        assertFalse(json.isEmpty());
    }

    @Test
    void exportChats_checksRateLimit() {
        when(sessionRepo.findByUserIdAndArchivedFalseOrderByCreatedAtDesc(any()))
            .thenReturn(Collections.emptyList());
        service.exportChats("user-1");
        assertThrows(RuntimeException.class, () -> service.exportChats("user-1"));
    }
}
