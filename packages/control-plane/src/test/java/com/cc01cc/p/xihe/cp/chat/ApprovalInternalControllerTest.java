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

/** G3-a C4-approval (task-188 D-1834): the agent-facing approval envelope wire shape (internal read mouth). */
class ApprovalInternalControllerTest {

    private final ApprovalService service = mock(ApprovalService.class);
    private final ApprovalInternalController controller = new ApprovalInternalController(service);

    @Test
    @SuppressWarnings("unchecked")
    void pendingRowSurfacesEnvelopeWithDeadline() {
        when(service.agentWaitingRow("run-1")).thenReturn(Optional.of(
                new ApprovalService.AgentApprovalWaitingView("req-1", "pending",
                        Instant.parse("2026-11-18T01:00:00Z"))));

        ResponseEntity<?> response = controller.waiting("run-1");
        Map<String, Object> body = (Map<String, Object>) response.getBody();
        List<Map<String, Object>> items = (List<Map<String, Object>>) body.get("items");

        assertEquals(1, items.size());
        assertEquals("req-1", items.get(0).get("requestId"));
        assertEquals("pending", items.get(0).get("state"));
        assertEquals("2026-11-18T01:00:00Z", items.get(0).get("expiresAt"));
        assertFalse(items.get(0).containsKey("feedback"),
                "CP 不持久化决策 feedback，键必须省略而不是填空值");
        assertFalse(items.get(0).containsKey("approved"), "信封字段最小化：布尔决策折叠进 state");
        assertFalse(items.get(0).containsKey("tool"), "信封字段最小化：tool/action 永不出本口");
        assertFalse(items.get(0).containsKey("action"));
        assertFalse(items.get(0).containsKey("details"));
    }

    @Test
    @SuppressWarnings("unchecked")
    void approvedRowOmitsDeadlineAndFeedbackKeys() {
        when(service.agentWaitingRow("run-1")).thenReturn(Optional.of(
                new ApprovalService.AgentApprovalWaitingView("req-2", "approved", null)));

        ResponseEntity<?> response = controller.waiting("run-1");
        Map<String, Object> body = (Map<String, Object>) response.getBody();
        List<Map<String, Object>> items = (List<Map<String, Object>>) body.get("items");

        assertEquals(1, items.size());
        assertEquals("req-2", items.get(0).get("requestId"));
        assertEquals("approved", items.get(0).get("state"));
        assertFalse(items.get(0).containsKey("expiresAt"),
                "决策已落定，deadline 不再是事实，键省略");
        assertFalse(items.get(0).containsKey("feedback"));
    }

    @Test
    @SuppressWarnings("unchecked")
    void rejectedRowSurfacesWithoutMutationKeys() {
        when(service.agentWaitingRow("run-1")).thenReturn(Optional.of(
                new ApprovalService.AgentApprovalWaitingView("req-3", "rejected", null)));

        ResponseEntity<?> response = controller.waiting("run-1");
        Map<String, Object> body = (Map<String, Object>) response.getBody();
        List<Map<String, Object>> items = (List<Map<String, Object>>) body.get("items");

        assertEquals(1, items.size());
        assertEquals("rejected", items.get(0).get("state"));
        assertEquals(2, items.get(0).size(), "信封最小化：rejected 行只带 requestId + state");
    }

    @Test
    @SuppressWarnings("unchecked")
    void noRowYieldsEmptyItemList() {
        when(service.agentWaitingRow("run-1")).thenReturn(Optional.empty());

        ResponseEntity<?> response = controller.waiting("run-1");
        Map<String, Object> body = (Map<String, Object>) response.getBody();

        assertEquals("run-1", body.get("runId"));
        assertEquals(List.of(), body.get("items"));
    }
}