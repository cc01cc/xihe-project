package com.cc01cc.p.xihe.cp.chat;

import org.junit.jupiter.api.Test;
import org.springframework.http.ResponseEntity;

import java.time.Instant;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/** task-188 MVP⑤ S2: the read-face wire shape — the ui-1 ApiTeamTask contract, field for field. */
class TeamTaskControllerTest {

    private final TeamTaskService service = mock(TeamTaskService.class);
    private final TeamTaskController controller = new TeamTaskController(service);

    private TeamTaskService.TeamTaskView view(long taskNo, String status, boolean ready) {
        return new TeamTaskService.TeamTaskView(
                "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa" + taskNo,
                "11111111-1111-1111-1111-111111111111",
                taskNo,
                3,
                "subject " + taskNo,
                null,
                status,
                ready,
                null,
                null,
                List.of(),
                List.of(),
                "22222222-2222-2222-2222-222222222222",
                Instant.parse("2026-11-18T01:00:00Z"),
                Instant.parse("2026-11-18T02:00:00Z"));
    }

    @Test
    @SuppressWarnings("unchecked")
    void boardEnvelopeCarriesTheRootKeyAndExactlyTheFifteenFieldRows() {
        when(service.boardView("s-1", null)).thenReturn(
                new TeamTaskService.BoardView("11111111-1111-1111-1111-111111111111",
                        List.of(view(1, "pending", true), view(2, "deleted", false))));

        ResponseEntity<Map<String, Object>> response = controller.board("s-1");
        Map<String, Object> body = response.getBody();
        assertEquals("s-1", body.get("sessionId"));
        assertEquals("11111111-1111-1111-1111-111111111111", body.get("teamRootSessionId"));
        List<Map<String, Object>> rows = (List<Map<String, Object>>) body.get("tasks");
        assertEquals(2, rows.size(), "tombstones ride along — the UI filters, the server does not");

        Map<String, Object> row = rows.get(0);
        assertEquals(15, row.size(), "exactly the ApiTeamTask field set — no more, no less");
        assertEquals(1L, row.get("taskNo"));
        assertEquals(3L, row.get("revision"));
        assertEquals("pending", row.get("status"));
        assertEquals(true, row.get("ready"));
        assertEquals("subject 1", row.get("subject"));
        assertFalse(row.containsKey("writeScopes"), "stored scopes never leave the server — only derived warnings");
        assertFalse(row.containsKey("prompt"), "promptless invariant (spec §5.2)");
        assertEquals(List.of(), row.get("blockedBy"));
        assertEquals(List.of(), row.get("writeScopeWarnings"));
        assertEquals("2026-11-18T01:00:00Z", row.get("createdAt"));
        assertEquals("2026-11-18T02:00:00Z", row.get("updatedAt"));
        assertEquals("deleted", rows.get(1).get("status"));
    }

    @Test
    @SuppressWarnings("unchecked")
    void singleCardAnswersTheSameRowShape() {
        when(service.getForRead("s-1", null, "t-9"))
                .thenReturn(view(9, "in_progress", true));

        Map<String, Object> row = (Map<String, Object>) controller.one("s-1", "t-9").getBody();
        assertEquals(15, row.size());
        assertEquals("in_progress", row.get("status"));
        assertEquals("11111111-1111-1111-1111-111111111111", row.get("teamRootSessionId"));
    }
}
