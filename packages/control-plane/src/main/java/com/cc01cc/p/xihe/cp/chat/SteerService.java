package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.SessionFollowUpItem;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.SessionFollowUpItemRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.UUID;

/**
 * task-188 MVP⑤ S3: the steer channel — a Lead's mid-run 指挥插话 to a child Session.
 *
 * <p><b>Reuse, not a second queue</b> (D-1821 默认③): a steer becomes an ordinary V49 FIFO item on
 * the CHILD Session, tagged {@code source_kind='agent_steer'} + {@code from_session_id} = the
 * steering Session (V173). Admission, capacity, settlement, restart recovery and the wake-up event
 * are therefore all the existing ones — this class adds exactly two things: the Lead/tenant
 * authorization gate, and the attribution stamp. There is no second write point to keep in sync
 * (task-128 §4's warning is precisely against building half of each in two places).</p>
 *
 * <p><b>Non-preemptive by construction</b>: an in-flight child run makes the head ineligible
 * (existing {@code anchor_not_terminal}), so the steer waits for the next boundary and is delivered
 * at the child's next admission. It is not an interrupt signal; the docs say so because a reader who
 * assumes otherwise will expect an abort that never comes.</p>
 *
 * <p><b>Lead判定 is a relationship, not a role</b>: the caller must be an ancestor of the child in
 * the same tree — {@code walkFromSession(caller)} ends at the SAME root as the child's, and the
 * caller sits strictly above it. No {@code isInstanceAdmin}-style special case (design §4.2).</p>
 */
@Service
public class SteerService {

    private static final Logger logger = LoggerFactory.getLogger(SteerService.class);

    /** Wire limits (plan §2.3): text 1..8192 characters. */
    static final int TEXT_MAX = 8192;

    public record SteerRequest(String text, Integer expectedRevision) {}

    public record SteerResult(FollowUpQueueSnapshot snapshot, boolean replayed) {}

    private final SessionRepository sessions;
    private final SessionFollowUpItemRepository items;
    private final ChatRunRepository runs;
    private final DelegationChainWalker chainWalker;
    private final FollowUpQueueService queue;
    private final AuditLogger audit;

    public SteerService(SessionRepository sessions, SessionFollowUpItemRepository items,
                        ChatRunRepository runs, DelegationChainWalker chainWalker,
                        FollowUpQueueService queue, AuditLogger audit) {
        this.sessions = sessions;
        this.items = items;
        this.runs = runs;
        this.chainWalker = chainWalker;
        this.queue = queue;
        this.audit = audit;
    }

    /**
     * Enqueues one steer on {@code childSessionId}.
     *
     * <p>Order of checks is deliberate and observable: tenant/session existence (404 — never leak a
     * cross-tenant Session's existence), then Lead relationship (403 STEER_FORBIDDEN), then the
     * queue's own rules (409). Authorization BEFORE the queue-shape answers means an unauthorized
     * caller cannot probe "is this child busy / full" through error codes.</p>
     */
    @Transactional
    public SteerResult steer(String childSessionId, String userId, String workspaceId,
                             String idempotencyKey, SteerRequest request) {
        String key = validateIdempotencyKey(idempotencyKey);
        String text = validateText(request);
        Session child = requireChild(childSessionId, userId, workspaceId);
        String steeringSessionId = requireLead(child, userId);

        // The queue's own gates (capacity, availability, key reuse, branch canonicalization) are
        // deliberately the existing ones — see the class doc. A steer carries no attachments and
        // takes the child's current branch, exactly like a plain follow-up does.
        FollowUpCreateRequest followUp = new FollowUpCreateRequest(
                text, null, currentBranchId(child), "none", null, null, null);
        FollowUpQueueService.EnqueueResult result = queue.enqueue(
                childSessionId, userId, workspaceId, key, followUp);

        if (!result.replayed()) {
            stampAttribution(childSessionId, key, steeringSessionId, request == null ? null
                    : request.expectedRevision());
            audit.recordDurableChange(userId, workspaceId, "steer_enqueued", "session_follow_up_item",
                    childSessionId, "fromSessionId=" + steeringSessionId
                            + " spawnHops=" + spawnHopsOf(child));
            logger.info("[LIFECYCLE] service=cp event=steer_enqueued childSessionId={} "
                            + "fromSessionId={} replayed=false", childSessionId, steeringSessionId);
        }
        return new SteerResult(result.snapshot(), result.replayed());
    }

    /**
     * Stamps the two V173 columns onto the row the queue just wrote. Same transaction, so the row is
     * never observable as "queued without attribution" (the L0 negative case pins this). The row is
     * looked up by (session, idempotencyKey) — the queue's own uniqueness key — not by position.
     */
    private void stampAttribution(String childSessionId, String idempotencyKey,
                                  String steeringSessionId, Integer expectedRevision) {
        SessionFollowUpItem row = items.findBySessionIdAndIdempotencyKey(childSessionId, idempotencyKey)
                .orElseThrow(() -> new IllegalStateException(
                        "steer row vanished between enqueue and attribution stamp"));
        row.setSourceKind(SessionFollowUpItem.SOURCE_AGENT_STEER);
        row.setFromSessionId(steeringSessionId);
        // expectedRevision is ADVISORY (D-1830 / plan §1.2): persisted for the reader, never a gate
        // on the queue — the queue has no revision to compare, and inventing a queue-wide one would
        // be a new mechanism past the inflation gate.
        row.setExpectedRevision(expectedRevision);
        items.save(row);
    }

    private Session requireChild(String sessionId, String userId, String workspaceId) {
        requireTenant(userId, workspaceId);
        Session child = sessions.findById(parseUuid(sessionId, "sessionId"))
                .orElseThrow(() -> notFound("SESSION_NOT_FOUND", "Session not found"));
        if (child.getDeleteRequestedAt() != null) {
            throw conflict("SESSION_DELETING", "Session is being deleted");
        }
        if (workspaceId.equals(child.getWorkspaceId()) || userId.equals(child.getUserId())) {
            // Same workspace membership OR the caller owns the child — the follow-up tenant gate's
            // own shape (FollowUpQueueService's lockAuthorizedSession). A stranger's Session answers
            // 404, never 403: steering must not be an existence oracle across tenants.
            return child;
        }
        throw notFound("SESSION_NOT_FOUND", "Session not found");
    }

    /**
     * The Lead test — a RELATIONSHIP, not a role check (design §4.2: no isInstanceAdmin special case).
     *
     * <p>The steer channel is the HUMAN command channel: a steer comes from a person, and the person
     * who owns the tree is the tree's root Session owner. So the test is exactly "walk from the child
     * to its root and ask whether the caller owns that root" — a teammate's sibling shares the root
     * <b>and</b> the same owner, which is intended: the team is one owner's tree. Someone else's tree
     * has a different root owner and is refused; a broken chain fails closed rather than guessing
     * (the shared AncestorMissingException discipline the budget/wake gates already use).</p>
     *
     * <p>Returns the steering Session id — the root — which is what the attribution column records.
     * That is deliberately the root and not "the caller's session": the caller is a human with a
     * userId, not a Session, and naming the Board/Lead Session makes the badge say the true thing.</p>
     */
    private String requireLead(Session child, String userId) {
        DelegationChainWalker.ChainWalk childWalk;
        try {
            childWalk = chainWalker.walkFromSession(child);
        } catch (DelegationChainWalker.AncestorMissingException broken) {
            throw forbidden("this Session's delegation chain is broken: " + broken.reason());
        }
        UUID rootId = childWalk.hops().get(childWalk.hops().size() - 1).nodeId();
        Session root = sessions.findById(rootId)
                .orElseThrow(() -> forbidden("the tree root vanished during the Lead check"));
        if (!userId.equals(root.getUserId())) {
            throw forbidden("only the team root's owner may steer a Session of this tree");
        }
        return root.getId().toString();
    }

    private int spawnHopsOf(Session session) {
        try {
            return chainWalker.walkFromSession(session).spawnHops();
        } catch (DelegationChainWalker.AncestorMissingException broken) {
            return 0;
        }
    }

    private String currentBranchId(Session child) {
        ChatRun latest = runs.findFirstBySessionIdOrderByCreatedAtDescIdDesc(child.getId().toString())
                .orElse(null);
        if (latest != null && latest.getBranchId() != null) {
            return latest.getBranchId().toString();
        }
        throw conflict("FOLLOW_UP_NOT_AVAILABLE",
                "This Session has no branch to attach a steer to");
    }

    private static String validateIdempotencyKey(String key) {
        if (key == null || key.isBlank() || key.length() > 128) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "Idempotency-Key must contain 1 to 128 characters");
        }
        return key.trim();
    }

    private static String validateText(SteerRequest request) {
        if (request == null || request.text() == null || request.text().isBlank()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "text is required");
        }
        if (request.text().length() > TEXT_MAX) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "text must be at most " + TEXT_MAX + " characters");
        }
        return request.text();
    }

    private static void requireTenant(String userId, String workspaceId) {
        if (userId == null || workspaceId == null
                || !userId.equals(TenantContext.getUserId())
                || !workspaceId.equals(TenantContext.getWorkspaceId())) {
            throw notFound("SESSION_NOT_FOUND", "Session not found");
        }
    }

    private static UUID parseUuid(String value, String field) {
        try {
            return UUID.fromString(value);
        } catch (RuntimeException invalid) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", field + " must be a UUID");
        }
    }

    private static CpApiException conflict(String code, String detail) {
        return new CpApiException(HttpStatus.CONFLICT, code, detail);
    }

    private static CpApiException notFound(String code, String detail) {
        return new CpApiException(HttpStatus.NOT_FOUND, code, detail);
    }

    private static CpApiException forbidden(String detail) {
        return new CpApiException(HttpStatus.FORBIDDEN, "STEER_FORBIDDEN", detail);
    }
}