package com.cc01cc.p.xihe.cp.chat;

import org.junit.jupiter.api.Test;
import org.springframework.http.ResponseEntity;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/** G3-a C4: the agent-facing envelope wire shape (internal read mouth). */
class UserQuestionInternalControllerTest {

    private final UserQuestionService service = mock(UserQuestionService.class);
    private final UserQuestionInternalController controller = new UserQuestionInternalController(service);

    @Test
    @SuppressWarnings("unchecked")
    void answeredRowSurfacesTheEnvelopeWithAnswer() {
        when(service.agentWaitingRow("run-1")).thenReturn(Optional.of(
                new UserQuestionService.AgentWaitingView("q-1", "answered", "the answer",
                        Instant.parse("2026-11-18T01:00:00Z"))));

        ResponseEntity<?> response = controller.waiting("run-1");
        Map<String, Object> body = (Map<String, Object>) response.getBody();
        List<Map<String, Object>> items = (List<Map<String, Object>>) body.get("items");

        assertEquals(1, items.size());
        assertEquals("q-1", items.get(0).get("questionId"));
        assertEquals("answered", items.get(0).get("state"));
        assertEquals("the answer", items.get(0).get("answer"));
        assertEquals("2026-11-18T01:00:00Z", items.get(0).get("expiresAt"));
        assertFalse(items.get(0).containsKey("prompt"), "prompt 永不出 CP（spec §5.2）");
    }

    @Test
    @SuppressWarnings("unchecked")
    void pendingRowOmitsTheAnswerKey() {
        when(service.agentWaitingRow("run-1")).thenReturn(Optional.of(
                new UserQuestionService.AgentWaitingView("q-2", "pending", null, null)));

        ResponseEntity<?> response = controller.waiting("run-1");
        Map<String, Object> body = (Map<String, Object>) response.getBody();
        List<Map<String, Object>> items = (List<Map<String, Object>>) body.get("items");

        assertEquals(1, items.size());
        assertFalse(items.get(0).containsKey("answer"), "pending ⇒ 无 answer 键（省略即语义，不伪造空串）");
        assertFalse(items.get(0).containsKey("expiresAt"));
    }

    @Test
    @SuppressWarnings("unchecked")
    void noWaitingRowYieldsAnEmptyItemList() {
        when(service.agentWaitingRow("run-1")).thenReturn(Optional.empty());

        ResponseEntity<?> response = controller.waiting("run-1");
        Map<String, Object> body = (Map<String, Object>) response.getBody();

        assertEquals("run-1", body.get("runId"));
        assertEquals(List.of(), body.get("items"));
    }
}
