package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.UserQuestion;
import com.cc01cc.p.xihe.cp.repository.ChatApprovalRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserQuestionRepository;
import com.cc01cc.p.xihe.cp.service.SessionReadAccess;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.domain.PageRequest;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * PLAN-0660 M5-B / T5.9: the question state machine ("the agent is waiting for an answer").
 *
 * <p>Frozen contract: PLAN-0648 design.md §5.2/§6 (merged by D66-12) and
 * {@code spec/session/user-channel.md} §5/§6. CP owns the durable state; the Agent owns the wait
 * deadline. States move forward only: {@code pending -> answered} (the addressee, CAS),
 * {@code pending -> expired} (deadline, or the run reached a terminal status),
 * {@code pending -> cancelled} (the run was cancelled).</p>
 *
 * <h2>Lock order (deliberate, read before changing anything here)</h2>
 *
 * <p>The project's frozen run-level order is <b>Session → Run</b>
 * ({@code ChatRunTerminalService:353}, {@code ChatSubmissionService:769-773},
 * {@code ChatRunCancellationService:180-186}). {@link #recordPending} takes the <b>Run</b> lock only
 * — the second lock of that pair, never Run→Session — which is the same single-lock shape as
 * {@code ChatRunTransportService:59}. It never touches the identity write protocol
 * ({@code instance_owner → role → principal}, D-175/D-180): those locks guard user/role
 * materialisation, this one serialises human-interaction creation <i>for one run</i>.</p>
 *
 * <p>Why a lock is required at all: "one pending human interaction per run" spans
 * {@code approval_requests} and {@code user_questions}, so no database constraint can express it
 * (V128 header; PLAN-0648 §6). The approval write path today
 * ({@code ApprovalService.recordPending}:150) reads the run with an <b>unlocked</b> {@code findById}
 * and takes no run lock, so a check-then-act between the two tables has no serialisation point. The
 * run row is that point: holding it makes the two-table check atomic against every other question
 * creation, and against any future approval claim that follows the same order. If an approval write
 * path ever needs the run lock too, it must take it <b>before</b> touching {@code approval_requests}
 * — same order, no inversion.</p>
 *
 * <p>Check-then-act is therefore allowed <i>inside</i> the locked section only; an unlocked
 * check-then-act over these two tables is exactly the race this design removes.</p>
 *
 * <h2>Minimisation (hard rule)</h2>
 *
 * <p>Question and answer bodies are untrusted text: they never appear in a log line, an audit detail,
 * a problem detail or an SSE payload — only {@code questionId}, the state and the length. The audit
 * row is written for the <b>answer</b> only: {@code audit_logs.user_id} is the acting human, and the
 * creation of a question is agent-initiated (the same reason the approval relay records domain
 * history instead of an audit row).</p>
 */
@Service
public class UserQuestionService {

    private static final Logger logger = LoggerFactory.getLogger(UserQuestionService.class);

    /** PLAN-0648 §6: the write-side prompt limit; a writer rule, deliberately not a DB CHECK. */
    public static final int MAX_PROMPT_LENGTH = 2000;

    /** Default and maximum window of one projection page (the route supplies {@code limit}). */
    private static final int DEFAULT_PROJECTION_LIMIT = 20;
    private static final int MAX_PROJECTION_LIMIT = 100;

    /** Live human-interaction states on the approval side: any of them owns the run's human slot. */
    private static final List<String> APPROVAL_LIVE_STATES =
            List.of("pending", "dispatching", "dispatch_unknown");

    /** The only two settle targets; {@code answered} is reachable only through {@link #answer}. */
    private static final List<String> SETTLE_TARGETS =
            List.of(UserQuestion.STATE_EXPIRED, UserQuestion.STATE_CANCELLED);

    private static final List<String> KNOWN_STATES = List.of(UserQuestion.STATE_PENDING,
            UserQuestion.STATE_ANSWERED, UserQuestion.STATE_EXPIRED, UserQuestion.STATE_CANCELLED);

    /** Terminal ChatRun statuses that mean "the user cancelled" rather than "it finished". */
    private static final List<String> RUN_CANCELLED_STATUSES =
            List.of("cancelled", "cancelling");

    private final UserQuestionRepository questions;
    private final ChatRunRepository runs;
    private final ChatApprovalRepository approvals;
    private final SessionRepository sessions;
    private final UserQuestionAgentClient agentClient;
    private final SessionReadAccess sessionReadAccess;
    private final AuditLogger audit;
    private final TransactionTemplate transactionTemplate;

    public UserQuestionService(UserQuestionRepository questions, ChatRunRepository runs,
            ChatApprovalRepository approvals, SessionRepository sessions,
            UserQuestionAgentClient agentClient, SessionReadAccess sessionReadAccess, AuditLogger audit,
            PlatformTransactionManager transactionManager) {
        this.questions = questions;
        this.runs = runs;
        this.approvals = approvals;
        this.sessions = sessions;
        this.agentClient = agentClient;
        this.sessionReadAccess = sessionReadAccess;
        this.audit = audit;
        this.transactionTemplate = new TransactionTemplate(transactionManager);
    }

    // ---------------------------------------------------------------------------------------
    // creation: recordPending
    // ---------------------------------------------------------------------------------------

    /**
     * Persists the question the Agent relayed and hands back the durable row.
     *
     * <p>Ownership validation mirrors {@code ApprovalService.recordPending}: the event must name the
     * active run, its session, its user and its workspace, otherwise the relay is refused with the
     * same {@code AGENT_EVENT_ID_MISMATCH} shape. Difficulty of any kind (blank/oversize prompt,
     * missing run) fails closed before a row exists.</p>
     *
     * @param expiresAt the {@code askTimed} deadline; {@code null} for a blocking {@code ask}
     * @param askedByParticipantId the asking agent participant, or {@code null} when the caller has none
     */
    @Transactional
    public UserQuestion recordPending(String expectedSessionId, String expectedRunId, String userId,
            String workspaceId, String prompt, Instant expiresAt, UUID askedByParticipantId) {
        String body = requirePrompt(prompt);
        UUID runId = parseRunId(expectedRunId);
        // Lock order: Run only (second lock of the frozen Session → Run pair). See the class javadoc.
        ChatRun run = runs.findByIdForUpdate(runId).orElseThrow(() -> new CpApiException(
                HttpStatus.BAD_GATEWAY, "AGENT_EVENT_ID_MISMATCH",
                "User question references an unknown chat run"));
        requireRunOwnership(run, expectedSessionId, expectedRunId, userId, workspaceId);
        if (run.getParentRunId() != null) {
            logger.info("[LIFECYCLE] service=cp event=run_question_refused runId={} reason=child_run",
                    expectedRunId);
            throw new CpApiException(HttpStatus.CONFLICT, "SUBAGENT_QUESTION_REFUSED",
                    "Only a root run may ask the user; the parent run asks on its behalf");
        }
        // Both tables are read while the run row is locked, so this pair of checks is atomic.
        if (!approvals.findByRunIdAndStateIn(expectedRunId, APPROVAL_LIVE_STATES).isEmpty()) {
            logger.info("[LIFECYCLE] service=cp event=run_question_refused runId={} reason=approval_pending",
                    expectedRunId);
            throw new CpApiException(HttpStatus.CONFLICT, "QUESTION_APPROVAL_PENDING",
                    "A pending approval already owns this run's human interaction");
        }
        if (questions.existsByRunIdAndState(runId, UserQuestion.STATE_PENDING)) {
            logger.info("[LIFECYCLE] service=cp event=run_question_refused runId={} reason=question_pending",
                    expectedRunId);
            throw new CpApiException(HttpStatus.CONFLICT, "QUESTION_ALREADY_PENDING",
                    "This run is already waiting for an answer");
        }
        // v1 addressee is the run owner (PLAN-0648 decision #14: the session owner is the only
        // human a root run may ask). Cross-user asking needs a wider session-visibility decision.
        UserQuestion row = new UserQuestion(UUID.fromString(run.getSessionId()), runId,
                askedByParticipantId, UUID.fromString(run.getUserId()), body, expiresAt);
        UserQuestion saved = questions.save(row);
        // Body excluded on purpose: only the id and the length may leave CP (spec §5.2).
        logger.info("[LIFECYCLE] service=cp event=run_question_asked questionId={} sessionId={}"
                        + " runId={} promptLength={}", saved.getId(), run.getSessionId(),
                expectedRunId, body.length());
        return saved;
    }

    // ---------------------------------------------------------------------------------------
    // the user's answer: one conditional statement decides
    // ---------------------------------------------------------------------------------------

    /**
     * Answers a pending question. Only the addressee may answer; everybody else — including a session
     * reader who can see the question — gets the same 404 as for a nonexistent id, so the endpoint
     * never leaks existence (spec §5.3, T5.10).
     *
     * <p>The CAS carries the deadline predicate, so "expired at the same moment as the answer" can
     * never be recorded as answered. When the CAS loses, the row is re-read (fresh state, bypassing
     * the persistence context) and the caller gets the honest conflict: {@code 409
     * QUESTION_ALREADY_SETTLED} when somebody else settled it, {@code 409 QUESTION_EXPIRED} when the
     * deadline passed (that row is settled to {@code expired} on the way out — lazy settlement, the
     * same shape as the approval expiry path).</p>
     *
     * <p>Ordering (T5.12, claim-then-dispatch with a rollback, mirroring {@code ApprovalService}'s
     * claim-before-deliver shape): the CAS advance and the callback to the waiting Agent happen
     * inside <b>one</b> transaction, so a delivery that the Agent did not accept rolls the advance
     * back and the row stays {@code pending}. Only a 2xx from the Agent makes an answer durable — a
     * failed callback must never fabricate {@code answered}. The answer body travels on that internal
     * call (that is its purpose) but never into a log/audit/problem detail.</p>
     *
     * <p>The losing-CAS path deliberately sits <b>outside</b> that transaction: the lazy expiry there
     * must survive the thrown 409 (inside a transaction it would be rolled back and leave a pending
     * row nobody can answer — the exact bug the PostgreSQL lane caught in T5.9). Same reason the
     * method itself is not {@code @Transactional}: with {@code TransactionTemplate} the transactional
     * scope is explicit at any call site (precedent: {@code ChatRunCancellationService:76},
     * {@code AuthController:121}), and it cannot accidentally cover the 409 branch.</p>
     *
     * <p>Visibility is checked <b>before</b> the body is validated: a non-addressee gets the uniform
     * 404 even when the payload is blank or malformed. Answering a stranger's question can therefore
     * never be used as a body-validation oracle ("400 vs 404"), which is what "same 404, no 403
     * branch" means for this route.</p>
     */
    public UserQuestion answer(UUID questionId, String userId, String answer) {
        UUID addressee = parseUserId(userId);
        Instant now = Instant.now();
        UserQuestion delivered = transactionTemplate.execute(status -> deliverAnswer(
                questionId, userId, addressee, answer, now));
        if (delivered != null) {
            return delivered;
        }
        // CAS lost. findStateById is a scalar projection, so it sees the committed state even though
        // an earlier read of the same row may still be cached in the persistence context.
        String state = questions.findStateById(questionId).orElse(null);
        if (state == null) {
            throw notFound();
        }
        if (!UserQuestion.STATE_PENDING.equals(state)) {
            throw new CpApiException(HttpStatus.CONFLICT, "QUESTION_ALREADY_SETTLED",
                    "This question was already settled");
        }
        // Still pending ⇒ the only predicate that can have failed is the deadline.
        questions.settlePending(questionId, UserQuestion.STATE_EXPIRED, Instant.now());
        logger.info("[LIFECYCLE] service=cp event=run_question_expired questionId={}"
                + " reason=answer_after_deadline", questionId);
        throw new CpApiException(HttpStatus.CONFLICT, "QUESTION_EXPIRED",
                "This question has expired");
    }

    /**
     * The transactional half of {@link #answer}: advance, deliver, audit.
     *
     * @return the answered row, or {@code null} when the CAS lost (nothing was written, so nothing to
     *         roll back and the caller owns the 409 vocabulary)
     */
    private UserQuestion deliverAnswer(UUID questionId, String userId, UUID addressee, String rawAnswer,
            Instant now) {
        UserQuestion row = questions.findById(questionId).orElseThrow(UserQuestionService::notFound);
        if (!addressee.equals(row.getAddresseeUserId())) {
            // 404, never 403: "not yours" and "does not exist" must be indistinguishable here — and
            // this check runs before any body validation, so a stranger never sees a 400.
            throw notFound();
        }
        // Only the addressee reaches this point, so a blank/absent body is now honestly a validation
        // error about *this* caller's request (400), not an existence oracle.
        String body = requireAnswer(rawAnswer);
        if (questions.markAnswered(questionId, body, now) != 1) {
            return null;
        }
        // Fail-closed: if this call throws, the transaction rolls the advance back and the question
        // stays pending for another attempt.
        agentClient.respond(questionId.toString(), row.getSessionId().toString(),
                row.getRunId().toString(), body);
        row.setState(UserQuestion.STATE_ANSWERED);
        row.setAnswer(body);
        row.setSettledAt(now);
        audit.recordDurableChange(userId, null, "user_question_answered", "user_question",
                questionId.toString(), auditDetail(row, body.length()));
        logger.info("[LIFECYCLE] service=cp event=run_question_answered questionId={}"
                        + " sessionId={} runId={} answerLength={}", questionId, row.getSessionId(),
                row.getRunId(), body.length());
        return row;
    }

    // ---------------------------------------------------------------------------------------
    // terminal settle: expired / cancelled
    // ---------------------------------------------------------------------------------------

    /**
     * Settles one pending question as {@code expired} or {@code cancelled}.
     *
     * <p>Idempotent by construction: the update only matches {@code state = 'pending'}, so a repeated
     * call returns 0 and can never overwrite an {@code answered} row (the "terminal states never roll
     * back" invariant).</p>
     *
     * @return 1 when a pending row moved, 0 when there was nothing left to settle
     */
    @Transactional
    public int settle(UUID questionId, String targetState) {
        if (!SETTLE_TARGETS.contains(targetState)) {
            throw new IllegalArgumentException("settle target must be expired or cancelled: " + targetState);
        }
        int changed = questions.settlePending(questionId, targetState, Instant.now());
        if (changed > 0) {
            logSettled(targetState, "questionId=" + questionId, 1);
        }
        return changed;
    }

    /**
     * Run-scoped cleanup for the terminal path: a run that finished leaves no question waiting, and a
     * run that was cancelled turns its pending questions into {@code cancelled} (design: terminal run
     * ⇒ expired, explicit cancellation ⇒ cancelled).
     *
     * <p>Pending rows only, so re-entry from a replay or a duplicate settle is a no-op.</p>
     *
     * @return the number of rows that actually moved
     */
    @Transactional
    public int cancelPendingForTerminalRun(UUID runId, String terminalStatus) {
        if (runId == null) {
            return 0;
        }
        String target = RUN_CANCELLED_STATUSES.contains(terminalStatus)
                ? UserQuestion.STATE_CANCELLED
                : UserQuestion.STATE_EXPIRED;
        int changed = questions.settlePendingForRun(runId, target, Instant.now());
        if (changed > 0) {
            logSettled(target, "runId=" + runId + " terminalStatus=" + terminalStatus, changed);
        }
        return changed;
    }

    // ---------------------------------------------------------------------------------------
    // read faces
    // ---------------------------------------------------------------------------------------

    /**
     * The projection for one addressee: {@code state='pending'} by default, newest first, bounded.
     * The paired count is {@link #pendingCount} — it is derived from rows, never stored.
     */
    @Transactional(readOnly = true)
    public List<UserQuestion> findProjection(String userId, String state, int limit) {
        String effectiveState = (state == null || state.isBlank())
                ? UserQuestion.STATE_PENDING
                : state;
        if (!KNOWN_STATES.contains(effectiveState)) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "state must be one of pending/answered/expired/cancelled");
        }
        int size = limit <= 0 ? DEFAULT_PROJECTION_LIMIT : Math.min(limit, MAX_PROJECTION_LIMIT);
        return questions.findByAddresseeUserIdAndStateOrderByCreatedAtDesc(parseUserId(userId),
                effectiveState, PageRequest.of(0, size));
    }

    /** {@code pendingCount} of the projection for one addressee. */
    @Transactional(readOnly = true)
    public long pendingCount(String userId) {
        return questions.countByAddresseeUserIdAndState(parseUserId(userId),
                UserQuestion.STATE_PENDING);
    }

    /** Addressee-scoped single read; a non-addressee and a missing row are the same 404. */
    @Transactional(readOnly = true)
    public UserQuestion findForAddressee(UUID questionId, String userId) {
        return questions.findByIdAndAddresseeUserId(questionId, parseUserId(userId))
                .orElseThrow(UserQuestionService::notFound);
    }

    /**
     * T5.10 single read for {@code GET /api/v1/user-questions/{id}}: the addressee, <b>or</b> a
     * session-visible reader (owner / invited enabled HUMAN participant — the frozen
     * {@link SessionReadAccess} read rule, so this face agrees with the session read face instead of
     * inventing a second visibility predicate).
     *
     * <p>Everybody else gets the <b>same</b> {@code 404 QUESTION_NOT_FOUND} as a nonexistent id:
     * there is no 403 branch, and a session-level refusal must not become a different code either
     * (otherwise the route leaks that the row exists). The reader is never granted the answer right
     * here — that is {@link #answer}'s addressee-only check.</p>
     */
    @Transactional(readOnly = true)
    public UserQuestion findReadable(UUID questionId, String userId) {
        UserQuestion row = questions.findById(questionId).orElseThrow(UserQuestionService::notFound);
        if (isAddressee(row, userId)) {
            return row;
        }
        if (!isSessionVisible(row, userId)) {
            throw notFound();
        }
        return row;
    }

    /** True when this question is addressed to {@code userId} (the only principal that may answer). */
    public static boolean isAddressee(UserQuestion row, String userId) {
        return row.getAddresseeUserId() != null && userId != null
                && row.getAddresseeUserId().toString().equalsIgnoreCase(userId.trim());
    }

    /**
     * Session-visible = the frozen D1/D1b read rule ({@code SessionReadAccess}), applied to the
     * session the question belongs to. Any refusal (unknown/archived session, missing workspace
     * context) collapses into "not visible" so the caller can answer with one uniform 404.
     */
    private boolean isSessionVisible(UserQuestion row, String userId) {
        if (userId == null || userId.isBlank() || row.getSessionId() == null) {
            return false;
        }
        try {
            var session = sessions.findById(row.getSessionId()).orElse(null);
            if (session == null) {
                return false;
            }
            return sessionReadAccess
                    .resolve(userId, session.getWorkspaceId(), row.getSessionId().toString())
                    .access()
                    .readAllowed();
        } catch (CpApiException notVisible) {
            return false;
        }
    }

    // ---------------------------------------------------------------------------------------
    // validation / logging helpers
    // ---------------------------------------------------------------------------------------

    private static String requirePrompt(String prompt) {
        String body = prompt == null ? "" : prompt.trim();
        if (body.isEmpty()) {
            throw new CpApiException(HttpStatus.BAD_GATEWAY, "AGENT_EVENT_INVALID",
                    "The question is empty");
        }
        if (body.length() > MAX_PROMPT_LENGTH) {
            throw new CpApiException(HttpStatus.BAD_GATEWAY, "AGENT_EVENT_INVALID",
                    "The question exceeds the " + MAX_PROMPT_LENGTH + " character limit");
        }
        return body;
    }

    private static String requireAnswer(String answer) {
        String body = answer == null ? "" : answer.trim();
        if (body.isEmpty()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "answer is required");
        }
        return body;
    }

    private static void requireRunOwnership(ChatRun run, String expectedSessionId,
            String expectedRunId, String userId, String workspaceId) {
        if (!userId.equals(run.getUserId()) || !workspaceId.equals(run.getWorkspaceId())
                || !expectedSessionId.equals(run.getSessionId())) {
            throw new CpApiException(HttpStatus.BAD_GATEWAY, "AGENT_EVENT_ID_MISMATCH",
                    "User question ownership does not match the active chat run");
        }
        if (!expectedRunId.equals(run.getId().toString())) {
            throw new CpApiException(HttpStatus.BAD_GATEWAY, "AGENT_EVENT_ID_MISMATCH",
                    "User question run id does not match the active chat run");
        }
    }

    private static UUID parseRunId(String runId) {
        try {
            return UUID.fromString(runId);
        } catch (RuntimeException invalid) {
            throw new CpApiException(HttpStatus.BAD_GATEWAY, "AGENT_EVENT_ID_MISMATCH",
                    "The user question event carries an invalid runId", invalid);
        }
    }

    private static UUID parseUserId(String userId) {
        try {
            return UUID.fromString(userId);
        } catch (RuntimeException invalid) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "userId is not a uuid", invalid);
        }
    }

    private static CpApiException notFound() {
        return new CpApiException(HttpStatus.NOT_FOUND, "QUESTION_NOT_FOUND",
                "User question not found");
    }

    /** Audit detail: identity + state + length, never the body (spec §5.2). */
    private static String auditDetail(UserQuestion row, int answerLength) {
        return "{\"questionId\":\"" + row.getId() + "\",\"sessionId\":\"" + row.getSessionId()
                + "\",\"state\":\"" + UserQuestion.STATE_ANSWERED + "\",\"answerLength\":"
                + answerLength + "}";
    }

    private static void logSettled(String targetState, String scope, int count) {
        if (UserQuestion.STATE_CANCELLED.equals(targetState)) {
            logger.info("[LIFECYCLE] service=cp event=run_question_cancelled {} count={}", scope, count);
        } else {
            logger.info("[LIFECYCLE] service=cp event=run_question_expired {} count={}", scope, count);
        }
    }

    /** Test/diagnostic seam: the state a fresh read would report, regardless of the JPA cache. */
    @Transactional(readOnly = true)
    public Optional<String> stateOf(UUID questionId) {
        return questions.findStateById(questionId);
    }
}
