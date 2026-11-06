package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.UserQuestion;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.UUID;

/**
 * PLAN-0660 M5-B / T5.10: the three public question routes (user Bearer; <b>no workspace context</b>
 * — the same shape as {@code GET /api/v1/user-events}, contract {@code spec/session/user-channel.md}
 * §4/§5).
 *
 * <h2>Visibility (frozen, do not widen)</h2>
 *
 * <ul>
 *   <li><b>List = addressee only.</b> {@code GET /api/v1/user-questions} returns the questions where
 *       {@code addressee_user_id = caller}. It is <i>not</i> "every question in the sessions I can
 *       see": the list is the asker's inbox and its {@code pendingCount} uses the <b>same</b> filter,
 *       otherwise the badge and the list would disagree.</li>
 *   <li><b>Single read = addressee or session-visible reader.</b> {@code GET /{id}} additionally
 *       accepts the frozen {@code SessionReadAccess} read rule (owner / invited enabled HUMAN
 *       participant). That reader gets the <b>same projection</b> (PLAN-0648 design.md §5.2 "会话可见者
 *       可读投影"; no field-level redaction exists in the contract) but never the answer right.</li>
 *   <li><b>Answer = addressee only.</b> {@code POST /{id}/answer} by anybody else — including a
 *       session-visible reader — is the same {@code 404 QUESTION_NOT_FOUND}.</li>
 *   <li>There is <b>no 403 branch anywhere</b>: "not yours", "session not visible" and "does not
 *       exist" are indistinguishable (spec §5.3).</li>
 * </ul>
 *
 * <h2>Parameters</h2>
 *
 * <ul>
 *   <li>{@code state}: only {@code pending} is accepted today (the route contract in the design is
 *       {@code ?state=pending}). Anything else — including a typo — is {@code 400 INVALID_REQUEST}
 *       rather than being silently ignored, so a client can never believe it filtered.</li>
 *   <li>{@code limit}: default {@value #DEFAULT_LIMIT}, {@code >= 1} required, values above
 *       {@value #MAX_LIMIT} are <b>clamped</b> (not rejected): an oversized page is a client
 *       convenience issue, not a contract violation, and clamping keeps the response shape stable.</li>
 *   <li>{@code id}: a non-UUID id is answered with {@code 404 QUESTION_NOT_FOUND}, not 400 — a
 *       malformed id must not be distinguishable from an id that simply does not exist.</li>
 * </ul>
 */
@RestController
public class UserQuestionController {

    private static final int DEFAULT_LIMIT = 20;
    private static final int MAX_LIMIT = 100;

    private final UserQuestionService service;

    public UserQuestionController(UserQuestionService service) {
        this.service = service;
    }

    /**
     * The caller's own pending questions: {@code {items, pendingCount}} — both from the same filter
     * ({@code addressee_user_id = caller AND state = 'pending'}).
     */
    @PreAuthorize("isAuthenticated()")
    @GetMapping("/api/v1/user-questions")
    public ResponseEntity<?> list(@RequestParam(value = "state", required = false) String state,
                                  @RequestParam(value = "limit", required = false) Integer limit) {
        String userId = caller();
        String effectiveState = (state == null || state.isBlank())
                ? UserQuestion.STATE_PENDING
                : state;
        if (!UserQuestion.STATE_PENDING.equals(effectiveState)) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "state must be pending");
        }
        int size = limitOrDefault(limit);
        // BL-423: one snapshot — a single clock read inside a single transaction — so the badge can
        // never disagree with the items it is rendered next to (deadline boundary, see service).
        UserQuestionService.ProjectionSnapshot snapshot =
                service.findProjectionWithCount(userId, effectiveState, size);
        return ResponseEntity.ok(new UserQuestionViews.UserQuestionListResponse(
                UserQuestionViews.toViews(snapshot.items()), snapshot.pendingCount()));
    }

    /**
     * One question: addressee, or a session-visible reader (read-only projection). Everything else is
     * the uniform 404.
     */
    @PreAuthorize("isAuthenticated()")
    @GetMapping("/api/v1/user-questions/{id}")
    public ResponseEntity<?> get(@PathVariable("id") String id) {
        String userId = caller();
        return ResponseEntity.ok(UserQuestionViews.toView(service.findReadable(questionId(id), userId)));
    }

    /**
     * Answers a pending question. Only the addressee can reach the service; everybody else gets the
     * uniform 404 from {@link UserQuestionService#answer}.
     *
     * <p>Success returns the <b>settled projection</b> ({@code state=answered} plus the
     * {@code settledAt} stamp) rather than an empty body, so the caller can render the final card
     * without a second read. Conflict vocabulary (passed through unchanged): {@code 409
     * QUESTION_ALREADY_SETTLED}, {@code 409 QUESTION_EXPIRED}, {@code 502
     * AGENT_QUESTION_DELIVERY_FAILED} (the answer was not delivered — the question stays pending).</p>
     */
    @PreAuthorize("isAuthenticated()")
    @PostMapping("/api/v1/user-questions/{id}/answer")
    public ResponseEntity<?> answer(@PathVariable("id") String id,
                                    @RequestBody(required = false) AnswerRequest body) {
        String userId = caller();
        String answer = body == null ? null : body.answer();
        UserQuestion answered = service.answer(questionId(id), userId, answer);
        return ResponseEntity.ok(UserQuestionViews.toView(answered));
    }

    /** Answer payload. Nothing else is accepted (extra fields are ignored by Jackson). */
    public record AnswerRequest(String answer) {
    }

    private static String caller() {
        String userId = TenantContext.getUserId();
        if (userId == null || userId.isBlank()) {
            throw new CpApiException(HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED",
                    "Authentication required");
        }
        return userId;
    }

    private static int limitOrDefault(Integer limit) {
        if (limit == null) {
            return DEFAULT_LIMIT;
        }
        if (limit < 1) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "limit must be at least 1");
        }
        return Math.min(limit, MAX_LIMIT);
    }

    private static UUID questionId(String rawId) {
        try {
            return UUID.fromString(rawId);
        } catch (RuntimeException malformed) {
            // Same answer as a missing row: a malformed id must not be a distinguishable oracle.
            throw new CpApiException(HttpStatus.NOT_FOUND, "QUESTION_NOT_FOUND",
                    "User question not found");
        }
    }
}
