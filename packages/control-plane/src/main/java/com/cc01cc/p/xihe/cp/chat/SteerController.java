package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.TenantContext;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

/**
 * task-188 MVP⑤ S3: {@code POST /api/v1/sessions/{childSessionId}/steers} — the Lead's mid-run
 * 指挥插话.
 *
 * <p>The wire is the plan's §2.3 shape verbatim: required {@code Idempotency-Key} (1..128),
 * {@code {text, expectedRevision?}}, {@code 202} on enqueue and {@code 200} on an idempotent replay,
 * the body being the EXISTING {@link FollowUpQueueSnapshot} (whose item view now carries
 * {@code sourceKind}/{@code fromSessionId}). No new SSE, no new queue: the steer is an ordinary V49
 * item on the child, tagged by V173 (see {@link SteerService}).</p>
 *
 * <p>Kept as its own controller rather than appended to {@code ChatController}: that class already
 * owns the follow-up/session faces and a large constructor, and a new surface should not force
 * every existing construction site to change. Route registration is all the route-parity gate
 * needs, and the class is a plain {@code @RestController} under the same security config.</p>
 */
@RestController
public class SteerController {

    private final SteerService steers;

    public SteerController(SteerService steers) {
        this.steers = steers;
    }

    @PreAuthorize("isAuthenticated()")
    @PostMapping("/api/v1/sessions/{childSessionId}/steers")
    public ResponseEntity<FollowUpQueueSnapshot> steer(
            @PathVariable String childSessionId,
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
            @RequestBody(required = false) SteerService.SteerRequest request) {
        SteerService.SteerResult result = steers.steer(
                childSessionId, TenantContext.getUserId(), TenantContext.getWorkspaceId(),
                idempotencyKey == null ? null : idempotencyKey.trim(), request);
        return ResponseEntity.status(result.replayed() ? HttpStatus.OK : HttpStatus.ACCEPTED)
                .body(result.snapshot());
    }
}
