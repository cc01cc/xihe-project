package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.TenantContext;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * task-188 MVP⑤ S2: the read-only team-task board projection (the UI TeamBoardPanel's read mouth).
 *
 * <p>Two GETs, zero writes (D-1821 面板只读裁定 — claim/reassign/steer travel the existing command
 * surfaces: agent tool faces, approvals, the steer endpoint). The wire row is the ui-1
 * {@code ApiTeamTask} contract — 15 fields including {@code teamRootSessionId}, the UI's N4
 * "not my team's task" filter key; deleted rows are included (tombstones) and the UI layers its
 * own filter on top. Promptless by construction: no field of this projection carries body text
 * beyond the task's own subject/description.</p>
 */
@RestController
public class TeamTaskController {

    private final TeamTaskService teamTasks;

    public TeamTaskController(TeamTaskService teamTasks) {
        this.teamTasks = teamTasks;
    }

    /** The whole board of the tree that owns {@code sessionId}, tombstones included. */
    @PreAuthorize("isAuthenticated()")
    @GetMapping("/api/v1/sessions/{sessionId}/team-tasks")
    public ResponseEntity<Map<String, Object>> board(@PathVariable String sessionId) {
        TeamTaskService.BoardView view =
                teamTasks.boardView(sessionId, TenantContext.getUserId());
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("sessionId", sessionId);
        body.put("teamRootSessionId", view.teamRootSessionId());
        body.put("tasks", view.tasks().stream().map(this::row).toList());
        return ResponseEntity.ok(body);
    }

    /** One card of that board (the UI consumes the list row's expansion instead — kept for API
     *  completeness; same wire shape). */
    @PreAuthorize("isAuthenticated()")
    @GetMapping("/api/v1/sessions/{sessionId}/team-tasks/{taskId}")
    public ResponseEntity<Map<String, Object>> one(
            @PathVariable String sessionId, @PathVariable String taskId) {
        TeamTaskService.TeamTaskView task =
                teamTasks.getForRead(sessionId, TenantContext.getUserId(), taskId);
        return ResponseEntity.ok(row(task));
    }

    // The projection itself lives on the record (TeamTaskView.toWire) so the UI mouth and the
    // four MCP tool faces share one canonical 15-field builder.
    private Map<String, Object> row(TeamTaskService.TeamTaskView task) {
        return task.toWire();
    }
}