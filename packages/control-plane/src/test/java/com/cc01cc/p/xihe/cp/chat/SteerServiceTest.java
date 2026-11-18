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
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.http.HttpStatus;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * task-188 MVP⑤ S3: the steer channel.
 *
 * <p>Pins what a second queue would have silently lost: the Lead gate is a RELATIONSHIP (root
 * ownership, not a role name), the attribution is stamped IN THE SAME transaction as the enqueue
 * (never observable as "queued without attribution"), an idempotent replay does NOT re-stamp, and
 * cross-tenant probing answers 404 rather than 403 (steering must not be an existence oracle).</p>
 */
class SteerServiceTest {

    private static final String USER = "user-lead";
    private static final String WS = "ws-1";
    private static final String OTHER_USER = "user-stranger";
    private static final UUID ROOT_ID = UUID.fromString("11111111-1111-1111-1111-111111111111");
    private static final UUID CHILD_ID = UUID.fromString("22222222-2222-2222-2222-222222222222");
    private static final UUID STRANGER_ROOT_ID =
            UUID.fromString("33333333-3333-3333-3333-333333333333");

    private final SessionRepository sessions = Mockito.mock(SessionRepository.class);
    private final SessionFollowUpItemRepository items = Mockito.mock(SessionFollowUpItemRepository.class);
    private final ChatRunRepository runs = Mockito.mock(ChatRunRepository.class);
    private final DelegationChainWalker walker = Mockito.mock(DelegationChainWalker.class);
    private final FollowUpQueueService queue = Mockito.mock(FollowUpQueueService.class);
    private final AuditLogger audit = Mockito.mock(AuditLogger.class);

    private final SteerService service =
            new SteerService(sessions, items, runs, walker, queue, audit);

    private Session root;
    private Session child;

    @BeforeEach
    void setUp() {
        root = session(ROOT_ID, "tree root", USER);
        child = session(CHILD_ID, "teammate", OTHER_USER);
        lenient().when(sessions.findById(ROOT_ID)).thenReturn(Optional.of(root));
        lenient().when(sessions.findById(CHILD_ID)).thenReturn(Optional.of(child));
        lenient().when(walker.walkFromSession(child))
                .thenReturn(walk(CHILD_ID, ROOT_ID));
        lenient().when(walker.walkFromSession(root))
                .thenReturn(walk(ROOT_ID));
        ChatRun latest = Mockito.mock(ChatRun.class);
        lenient().when(latest.getBranchId())
                .thenReturn("44444444-4444-4444-4444-444444444444");
        lenient().when(runs.findFirstBySessionIdOrderByCreatedAtDescIdDesc(CHILD_ID.toString()))
                .thenReturn(Optional.of(latest));
        // TenantContext is a static holder the real controller path fills; the unit test has to
        // mirror it, otherwise requireTenant refuses before any of the interesting gates run.
    }

    private Session session(UUID id, String title, String owner) {
        Session s = Mockito.mock(Session.class);
        lenient().when(s.getId()).thenReturn(id);
        lenient().when(s.getTitle()).thenReturn(title);
        lenient().when(s.getUserId()).thenReturn(owner);
        lenient().when(s.getWorkspaceId()).thenReturn(WS);
        lenient().when(s.getDeleteRequestedAt()).thenReturn(null);
        return s;
    }

    private DelegationChainWalker.ChainWalk walk(UUID... nearestFirstRootLast) {
        List<DelegationChainWalker.Hop> hops = new java.util.ArrayList<>();
        String edge = DelegationChainWalker.EDGE_NONE;
        for (UUID id : nearestFirstRootLast) {
            hops.add(new DelegationChainWalker.Hop(id, id, edge, "principal-x"));
            edge = DelegationChainWalker.EDGE_SPAWN;
        }
        return new DelegationChainWalker.ChainWalk(List.copyOf(hops), hops.size() - 1,
                java.util.Collections.nCopies(hops.size(), "principal-x"));
    }

    private FollowUpQueueSnapshot snapshot() {
        return new FollowUpQueueSnapshot(CHILD_ID.toString(), "queued", 1,
                FollowUpQueueService.CAPACITY_LIMIT, null, List.of());
    }

    private CpApiException assertProblem(HttpStatus status, String code, Runnable call) {
        CpApiException thrown = assertThrows(CpApiException.class, call::run);
        assertEquals(status, thrown.getStatus());
        assertEquals(code, thrown.getCode());
        return thrown;
    }

    /** Mirror what the interceptor fills in per request; the static holder is per-thread. */
    private void tenant(String userId, String workspaceId) {
        TenantContext.setUserId(userId);
        TenantContext.setWorkspaceId(workspaceId);
    }

    @org.junit.jupiter.api.AfterEach
    void clearTenant() {
        TenantContext.clear();
    }

    @Test
    void aSteerFromTheRootOwnerEnqueuesAndStampsAttribution() {
        tenant(USER, WS);
        when(queue.enqueue(eq(CHILD_ID.toString()), eq(USER), eq(WS), eq("key-1"), any()))
                .thenReturn(new FollowUpQueueService.EnqueueResult(snapshot(), false));
        SessionFollowUpItem row = SessionFollowUpItem.create();
        row.setId(UUID.randomUUID());
        row.setSessionId(CHILD_ID.toString());
        row.setIdempotencyKey("key-1");
        when(items.findBySessionIdAndIdempotencyKey(CHILD_ID.toString(), "key-1"))
                .thenReturn(Optional.of(row));

        SteerService.SteerResult result = service.steer(CHILD_ID.toString(), USER, WS, "key-1",
                new SteerService.SteerRequest("hold the merge until verify", 3));

        assertTrue(!result.replayed());
        assertEquals(SessionFollowUpItem.SOURCE_AGENT_STEER, row.getSourceKind(),
                "attribution is stamped in the same transaction as the enqueue");
        assertEquals(ROOT_ID.toString(), row.getFromSessionId(), "the steering session is the root");
        assertEquals(3, row.getExpectedRevision(),
                "expectedRevision is persisted as ADVISORY (D-1830), never a gate");
        verify(items).save(row);
        verify(audit).recordDurableChange(eq(USER), eq(WS), eq("steer_enqueued"),
                eq("session_follow_up_item"), eq(CHILD_ID.toString()), anyString());
    }

    @Test
    void anIdempotentReplayDoesNotReStamp() {
        // A replay answers 200 with the same snapshot; nothing is written a second time.
        tenant(USER, WS);
        when(queue.enqueue(anyString(), anyString(), anyString(), anyString(), any()))
                .thenReturn(new FollowUpQueueService.EnqueueResult(snapshot(), true));

        SteerService.SteerResult result = service.steer(CHILD_ID.toString(), USER, WS, "key-1",
                new SteerService.SteerRequest("again", null));

        assertTrue(result.replayed());
        verify(items, never()).save(any());
        verify(audit, never()).recordDurableChange(any(), any(), any(), any(), any(), any());
    }

    @Test
    void aSteerFromSomebodyElsesTreeIsForbidden() {
        // The child is reachable for this caller (same workspace, so requireChild passes) but the
        // tree's ROOT belongs to USER — the gate that answers is the relationship, not the tenant.
        tenant(OTHER_USER, WS);
        assertProblem(HttpStatus.FORBIDDEN, "STEER_FORBIDDEN",
                () -> service.steer(CHILD_ID.toString(), OTHER_USER, WS, "key-2",
                        new SteerService.SteerRequest("let me in", null)));
        verify(queue, never()).enqueue(anyString(), anyString(), anyString(), anyString(), any());
    }

    @Test
    void anUnknownChildSessionIsNotFoundRatherThanForbidden() {
        tenant(USER, WS);
        when(sessions.findById(CHILD_ID)).thenReturn(Optional.empty());
        assertProblem(HttpStatus.NOT_FOUND, "SESSION_NOT_FOUND",
                () -> service.steer(CHILD_ID.toString(), USER, WS, "key-3",
                        new SteerService.SteerRequest("hello", null)));
        verify(queue, never()).enqueue(anyString(), anyString(), anyString(), anyString(), any());
    }

    @Test
    void aRequestWhoseTenantContextDisagreesWithTheClaimedTenantIsNotFound() {
        // The interceptor establishes the tenant; when the caller's claim disagrees with it, the
        // request never gets to look at a Session at all. Answering 404 (not 403) keeps the
        // cross-tenant answer indistinguishable from a genuinely missing Session.
        tenant(USER, WS);
        assertProblem(HttpStatus.NOT_FOUND, "SESSION_NOT_FOUND",
                () -> service.steer(CHILD_ID.toString(), USER, "ws-other", "key-10",
                        new SteerService.SteerRequest("hello", null)));
        verify(sessions, never()).findById(any());
    }

    @Test
    void authorizationRunsBeforeTheQueueRulesSoErrorsAreNotABusyOracle() {
        // Ordering invariant: an unauthorized caller must NOT be able to tell "this child is
        // full" from "this child is idle" via the error code. The queue would answer
        // FOLLOW_UP_QUEUE_FULL here; the Lead gate must fire first and answer STEER_FORBIDDEN.
        tenant(OTHER_USER, WS);
        when(queue.enqueue(anyString(), anyString(), anyString(), anyString(), any()))
                .thenThrow(new CpApiException(HttpStatus.CONFLICT, "FOLLOW_UP_QUEUE_FULL", "full"));
        assertProblem(HttpStatus.FORBIDDEN, "STEER_FORBIDDEN",
                () -> service.steer(CHILD_ID.toString(), OTHER_USER, WS, "key-11",
                        new SteerService.SteerRequest("probe", null)));
        verify(queue, never()).enqueue(anyString(), anyString(), anyString(), anyString(), any());
        verify(items, never()).save(any());
    }

    @Test
    void aCrossTenantChildIsAlsoANotFound() {
        // A caller whose workspace does not match and who does not own the child must not be able
        // to tell "exists elsewhere" from "does not exist" — that is the anti-oracle rule.
        tenant(USER, "ws-other");
        assertProblem(HttpStatus.NOT_FOUND, "SESSION_NOT_FOUND",
                () -> service.steer(CHILD_ID.toString(), USER, "ws-other", "key-4",
                        new SteerService.SteerRequest("hello", null)));
    }

    @Test
    void blankOrOversizedWireFieldsAreValidationErrors() {
        tenant(USER, WS);
        assertProblem(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                () -> service.steer(CHILD_ID.toString(), USER, WS, "  ",
                        new SteerService.SteerRequest("hello", null)));
        assertProblem(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                () -> service.steer(CHILD_ID.toString(), USER, WS, "k".repeat(129),
                        new SteerService.SteerRequest("hello", null)));
        assertProblem(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                () -> service.steer(CHILD_ID.toString(), USER, WS, "key-5",
                        new SteerService.SteerRequest("  ", null)));
        assertProblem(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                () -> service.steer(CHILD_ID.toString(), USER, WS, "key-6",
                        new SteerService.SteerRequest("x".repeat(8193), null)));
        assertProblem(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                () -> service.steer("not-a-uuid", USER, WS, "key-7",
                        new SteerService.SteerRequest("hello", null)));
        verify(queue, never()).enqueue(anyString(), anyString(), anyString(), anyString(), any());
    }

    @Test
    void theQueueRulesPassThroughUntouched() {
        // Capacity / availability / key reuse belong to the V49 queue; the steer channel must not
        // reinterpret them into steer-specific codes (a second vocabulary would drift).
        tenant(USER, WS);
        CpApiException full = new CpApiException(HttpStatus.CONFLICT, "FOLLOW_UP_QUEUE_FULL", "full");
        when(queue.enqueue(anyString(), anyString(), anyString(), anyString(), any())).thenThrow(full);
        CpApiException thrown = assertThrows(CpApiException.class,
                () -> service.steer(CHILD_ID.toString(), USER, WS, "key-8",
                        new SteerService.SteerRequest("hello", null)));
        assertEquals("FOLLOW_UP_QUEUE_FULL", thrown.getCode());
        verify(items, never()).save(any());
    }

    @Test
    void aChildWithoutABranchIsRefusedLikeAnIdleFollowUp() {
        tenant(USER, WS);
        when(runs.findFirstBySessionIdOrderByCreatedAtDescIdDesc(CHILD_ID.toString()))
                .thenReturn(Optional.empty());
        assertProblem(HttpStatus.CONFLICT, "FOLLOW_UP_NOT_AVAILABLE",
                () -> service.steer(CHILD_ID.toString(), USER, WS, "key-9",
                        new SteerService.SteerRequest("hello", null)));
        verify(queue, never()).enqueue(anyString(), anyString(), anyString(), anyString(), any());
    }

    @Test
    void textLimitsAreExactlyTheWireContract() {
        assertEquals(8192, SteerService.TEXT_MAX, "the OpenAPI maxLength and this constant agree");
    }
}