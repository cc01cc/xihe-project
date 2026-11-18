package com.cc01cc.p.xihe.cp.chat;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Internal service-Bearer read face: the session roster as the AGENT sees it (task-40 §3 第二批).
 *
 * <p>Why this face exists: the hand-off face accepts display names, and the model may only use names
 * it actually read. Reading them here (run-scoped, actor = the run row) keeps name resolution in CP
 * instead of putting a roster snapshot into the prompt — a snapshot would move resolution into the
 * prompt and rot the day the model or the copy changes.</p>
 *
 * <p>Wire: GET /internal/v1/chat/runs/{runId}/participants →
 * <code>{runId, sessionId, participants:[{participantId, displayName, principalKind, role,
 * respondPolicy, disabled}]}</code>. {@code displayName} is exactly what {@code MentionParser}
 * resolves against ({@code SessionParticipantService.list}); disabled rows are included with
 * {@code disabled=true} so the caller can see why a name is not a target instead of guessing.
 * Errors: 404 HANDOFF_RUN_NOT_FOUND (same token as the hand-off face).</p>
 */
@RestController
@RequestMapping("/internal/v1/chat/runs/{runId}/participants")
public class ChatRunRosterInternalController {

    private final AgentHandoffService agentHandoffService;

    public ChatRunRosterInternalController(AgentHandoffService agentHandoffService) {
        this.agentHandoffService = agentHandoffService;
    }

    @GetMapping
    public ResponseEntity<?> roster(@PathVariable String runId) {
        List<AgentHandoffService.RosterPeer> peers = agentHandoffService.roster(runId);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("runId", runId);
        body.put("participants", peers);
        return ResponseEntity.ok(body);
    }
}
