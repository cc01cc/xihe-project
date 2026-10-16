package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.TenantContext;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import tools.jackson.databind.json.JsonMapper;

import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class ChatRunContinuationControllerTest {
    @Mock private ChatRunContinuationService continuations;

    @AfterEach
    void clearTenant() {
        TenantContext.clear();
    }

    @Test
    void publicResponseContainsOnlyChildRunIdAndMode() throws Exception {
        String userId = UUID.randomUUID().toString();
        String workspaceId = UUID.randomUUID().toString();
        String sourceRunId = UUID.randomUUID().toString();
        String childRunId = UUID.randomUUID().toString();
        TenantContext.setUserId(userId);
        TenantContext.setWorkspaceId(workspaceId);

        ChatRunContinuationRequest request =
                new ChatRunContinuationRequest(ChatRunContinuationRequest.RESUME_PENDING, null);
        when(continuations.continueRun(sourceRunId, userId, workspaceId, "key", request))
                .thenReturn(new ChatRunContinuationService.ContinuationResult(
                        childRunId, request.mode(), "accepted", false,
                        UUID.randomUUID().toString(), UUID.randomUUID().toString(),
                        "private-checkpoint", 42L, UUID.randomUUID().toString()));

        ResponseEntity<Map<String, Object>> response = new ChatRunContinuationController(continuations)
                .continueRun(sourceRunId, "key",
                        JsonMapper.builder().build().readTree("{\"mode\":\"resume_pending\"}"));

        assertEquals(HttpStatus.ACCEPTED, response.getStatusCode());
        assertEquals(Map.of("runId", childRunId, "mode", "resume_pending"), response.getBody());
        assertFalse(response.getBody().containsKey("lineageId"));
        assertFalse(response.getBody().containsKey("checkpointId"));
        assertFalse(response.getBody().containsKey("completedToolCallIds"));
        verify(continuations).continueRun(sourceRunId, userId, workspaceId, "key", request);
    }
}
