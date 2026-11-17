package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.chat.ChatRunCancellationService;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.SessionParticipant;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.SessionParticipantRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * task-134 (D-1785): the <b>workspace-level</b> read face behind "how many child sessions has this
 * Agent been delegated".
 *
 * <p><b>Why the count cannot live in the UI.</b> The session list is the CALLER's visible set —
 * owner, or an enabled HUMAN participant, archived excluded ({@code SessionRepository:25-39},
 * {@code SessionReadAccess:32-41}). In a multi-member workspace the sessions an Agent produced while
 * a colleague was chatting are therefore absent from that list, so a client-side filter over
 * {@code GET /api/v1/sessions} silently under-reports. This service answers from the workspace side
 * instead: attribution is the child's <b>PRIMARY</b> participant
 * ({@code ChatSubmissionService:582-614, 743-765}), never the caller's visibility.</p>
 *
 * <p><b>Two independent invariants (Lead ruling 2026-11-17, tightening #1).</b> The count face and
 * the content face must NOT share one decision: merging them means any future relaxation on either
 * side silently relaxes the other. So:</p>
 *
 * <ul>
 *   <li><b>Count</b> — every delegated child in this workspace, whole descendant cone flattened, no
 *       read-visibility filter. Honest by construction.</li>
 *   <li><b>Content</b> — {@code title} is projected only for a row the caller may read (owner, or an
 *       enabled HUMAN participant; PLAN-0668 D1b keeps managers out of content read); an unreadable
 *       row answers {@code title: null, readable: false} and is still counted.</li>
 * </ul>
 *
 * <p><b>One snapshot (tightening #2).</b> {@code counts.all} and {@code counts.direct} come from ONE
 * materialized cohort and ONE traversal of it — never two queries. Two queries could see a child
 * created between them and report {@code direct > all} inside the same response.</p>
 *
 * <p><b>Depth.</b> {@code depth(s) = 1 + (parent is a spawn session ? depth(parent) : 0)}, i.e. the
 * number of spawn edges from the topmost non-delegated session. Depth 1 = delegated straight from a
 * normal conversation. The chain is walked over a batched ancestor closure (PK lookups) with a hard
 * {@link #MAX_DEPTH} cap, so corrupt or cyclic ancestry degrades to a bounded number, never a 500.</p>
 *
 * <p>Read-only: no durable write, no SSE, no migration. Attribution has no run-stamp fallback on
 * purpose (D-215: pre-launch data carries no migration baggage, and a second attribution source
 * raises "which one wins" without adding an honest row).</p>
 */
@Service
public class AgentSpawnSessionReadService {

    /** Whole descendant cone flattened (default: the honest aggregate the UI shows). */
    public static final String DEPTH_ALL = "all";
    /** Only {@code depth == 1} rows (the drill-down arm; counts still carry both). */
    public static final String DEPTH_DIRECT = "direct";

    /** Row-cap default/maximum; the counts are never capped. */
    public static final int DEFAULT_LIMIT = 100;
    public static final int MAX_LIMIT = 500;

    /** Ancestry walk bound (delegation maxDepth defaults to 3; this is a corruption guard). */
    public static final int MAX_DEPTH = 32;

    private final SessionRepository sessions;
    private final SessionParticipantRepository participants;
    private final ChatRunRepository chatRuns;
    private final WorkspaceMemberService memberService;

    public AgentSpawnSessionReadService(SessionRepository sessions,
                                        SessionParticipantRepository participants,
                                        ChatRunRepository chatRuns,
                                        WorkspaceMemberService memberService) {
        this.sessions = sessions;
        this.participants = participants;
        this.chatRuns = chatRuns;
        this.memberService = memberService;
    }

    /** One delegated child session as the wire sees it (content already redacted when unreadable). */
    public record Row(UUID id, UUID parentSessionId, int depth, boolean direct, boolean readable,
                      String title, boolean archived, String runStatus, boolean active,
                      Instant spawnedAt) {
    }

    /** The honest counts: one materialized cohort, one traversal. */
    public record Counts(int all, int direct) {
    }

    /** Frozen response envelope. */
    public record Response(UUID workspaceId, UUID principalId, String depth, boolean includeArchived,
                           Counts counts, List<Row> sessions, boolean truncated, int limit) {
        public Response {
            sessions = List.copyOf(sessions);
        }
    }

    /** One cohort member with its resolved nesting level (the single traversal's output). */
    private record Candidate(Session session, int depth) {
    }

    /**
     * Resolve the delegated-child view for one (workspace, Agent principal) pair.
     *
     * <p>Authorization is the member roster's gate ({@link WorkspaceMemberService#requireRosterRead}):
     * OWNER/EDITOR, or the instance-scope {@code MANAGE_WORKSPACE_MEMBERS} atom; a VIEWER answers 403.
     * The gate is expressed once, in the roster's own service — never re-stated here.</p>
     *
     * <p>An unknown or unbound principal answers an empty cohort with zero counts rather than 404: the
     * response is a workspace-scoped aggregate carrying no subject content, so "no delegations" and
     * "no such principal" stay deliberately indistinguishable (this face is not an existence oracle,
     * and a 404 would also turn "this agent has never delegated" into a UI error).</p>
     */
    @Transactional(readOnly = true)
    public Response read(String actorUserId, UUID workspaceId, UUID principalId, String depthParam,
                         boolean includeArchived, Integer limitParam) {
        String depth = normalizeDepth(depthParam);
        int limit = normalizeLimit(limitParam);
        memberService.requireRosterRead(workspaceId == null ? null : workspaceId.toString(), actorUserId);

        List<Session> cohort = loadCohort(workspaceId, principalId, includeArchived);
        if (cohort.isEmpty()) {
            return new Response(workspaceId, principalId, depth, includeArchived,
                    new Counts(0, 0), List.of(), false, limit);
        }

        // ONE traversal: the same candidate list feeds the counts AND the projected rows.
        List<Candidate> candidates = resolveDepths(cohort);
        int direct = 0;
        for (Candidate candidate : candidates) {
            if (candidate.depth() == 1) {
                direct++;
            }
        }
        Counts counts = new Counts(candidates.size(), direct);

        List<Candidate> selected = new ArrayList<>();
        for (Candidate candidate : candidates) {
            if (DEPTH_DIRECT.equals(depth) && candidate.depth() != 1) {
                continue;
            }
            selected.add(candidate);
        }
        selected.sort(CANDIDATE_ORDER);
        boolean truncated = selected.size() > limit;
        List<Candidate> page = truncated ? List.copyOf(selected.subList(0, limit))
                : List.copyOf(selected);

        Map<UUID, Session> cohortById = new HashMap<>();
        for (Session session : cohort) {
            cohortById.put(session.getId(), session);
        }
        // Content face: a SEPARATE resolution (owner / invited HUMAN) — never the count's predicate.
        Set<UUID> readable = readableSessionIds(actorUserId, page, cohortById);
        Map<UUID, String> activeStatus = activeRunStatus(page);

        List<Row> rows = new ArrayList<>(page.size());
        for (Candidate candidate : page) {
            Session session = candidate.session();
            boolean canRead = readable.contains(session.getId());
            String status = activeStatus.get(session.getId());
            rows.add(new Row(session.getId(), session.getSpawnedFromSessionId(), candidate.depth(),
                    candidate.depth() == 1, canRead, canRead ? session.getTitle() : null,
                    session.isArchived(), status, status != null, session.getSpawnedAt()));
        }
        return new Response(workspaceId, principalId, depth, includeArchived, counts, rows,
                truncated, limit);
    }

    /** Newest spawned first; a null spawnedAt (legacy) sorts last; id breaks ties deterministically. */
    private static final Comparator<Candidate> CANDIDATE_ORDER = Comparator
            .comparing((Candidate candidate) -> candidate.session().getSpawnedAt() == null
                    ? Instant.EPOCH : candidate.session().getSpawnedAt())
            .reversed()
            .thenComparing(candidate -> candidate.session().getId().toString(),
                    Comparator.reverseOrder());

    private List<Session> loadCohort(UUID workspaceId, UUID principalId, boolean includeArchived) {
        if (workspaceId == null || principalId == null) {
            return List.of();
        }
        List<SessionParticipant> primaries = participants.findByPrincipalKindAndPrincipalIdAndRole(
                SessionParticipant.KIND_AGENT, principalId, SessionParticipant.ROLE_PRIMARY);
        if (primaries.isEmpty()) {
            return List.of();
        }
        Set<UUID> candidateIds = new LinkedHashSet<>();
        for (SessionParticipant primary : primaries) {
            if (primary.getSessionId() != null) {
                candidateIds.add(primary.getSessionId());
            }
        }
        if (candidateIds.isEmpty()) {
            return List.of();
        }
        // Snapshot read: the cohort is materialized once and never re-queried (tightening #2).
        String workspace = workspaceId.toString();
        List<Session> cohort = new ArrayList<>();
        for (Session session : sessions.findAllById(candidateIds)) {
            if (!workspace.equals(session.getWorkspaceId())) {
                continue;
            }
            if (!Session.KIND_SPAWN.equals(session.getKind())) {
                continue;
            }
            if (!includeArchived && session.isArchived()) {
                continue;
            }
            cohort.add(session);
        }
        return cohort;
    }

    /** Resolve every cohort member's nesting level in one pass over one batched ancestor closure. */
    private List<Candidate> resolveDepths(List<Session> cohort) {
        Map<UUID, Session> ancestry = loadAncestry(cohort);
        List<Candidate> candidates = new ArrayList<>(cohort.size());
        for (Session session : cohort) {
            candidates.add(new Candidate(session, depthOf(session, ancestry)));
        }
        return candidates;
    }

    /**
     * Batched ancestor closure for the cohort: PK lookups only, one round per nesting level (a
     * delegated cone is shallow by construction; {@link #MAX_DEPTH} bounds a corrupt chain).
     */
    private Map<UUID, Session> loadAncestry(List<Session> cohort) {
        Map<UUID, Session> byId = new HashMap<>();
        for (Session session : cohort) {
            byId.put(session.getId(), session);
        }
        Set<UUID> toLoad = new HashSet<>();
        for (Session session : cohort) {
            UUID parent = session.getSpawnedFromSessionId();
            if (parent != null && !byId.containsKey(parent)) {
                toLoad.add(parent);
            }
        }
        int rounds = 0;
        while (!toLoad.isEmpty() && rounds < MAX_DEPTH) {
            rounds++;
            List<Session> batch = sessions.findAllById(toLoad);
            Set<UUID> next = new HashSet<>();
            for (Session ancestor : batch) {
                byId.put(ancestor.getId(), ancestor);
            }
            for (Session ancestor : batch) {
                if (!Session.KIND_SPAWN.equals(ancestor.getKind())) {
                    continue;
                }
                UUID parent = ancestor.getSpawnedFromSessionId();
                if (parent != null && !byId.containsKey(parent)) {
                    next.add(parent);
                }
            }
            toLoad = next;
        }
        return byId;
    }

    /**
     * Spawn-nesting level: count while the ancestor is itself a spawn session. A missing ancestor
     * (deleted parent) or a cyclic chain stops at the bound instead of failing the request.
     */
    private int depthOf(Session session, Map<UUID, Session> ancestry) {
        int depth = 1;
        Set<UUID> seen = new HashSet<>();
        UUID parentId = session.getSpawnedFromSessionId();
        while (parentId != null && seen.add(parentId) && depth < MAX_DEPTH) {
            Session parent = ancestry.get(parentId);
            if (parent == null || !Session.KIND_SPAWN.equals(parent.getKind())) {
                break;
            }
            depth++;
            parentId = parent.getSpawnedFromSessionId();
        }
        return depth;
    }

    /**
     * The content face (PLAN-0668 D1b): owner, or an enabled HUMAN participant. Managers are absent on
     * purpose — reading the workspace roster must not become reading every conversation's title.
     */
    private Set<UUID> readableSessionIds(String actorUserId, List<Candidate> page,
                                         Map<UUID, Session> cohortById) {
        if (page.isEmpty()) {
            return Set.of();
        }
        UUID actor = parseUuidOrNull(actorUserId);
        if (actor == null) {
            return Set.of();
        }
        Set<UUID> readable = new HashSet<>();
        List<UUID> ids = new ArrayList<>(page.size());
        for (Candidate candidate : page) {
            UUID sessionId = candidate.session().getId();
            ids.add(sessionId);
            Session session = cohortById.get(sessionId);
            if (session != null && actor.toString().equals(session.getUserId())) {
                readable.add(sessionId);
            }
        }
        List<SessionParticipant> invited =
                participants.findBySessionIdInAndPrincipalKindAndPrincipalIdAndDisabledAtIsNull(
                        ids, SessionParticipant.KIND_HUMAN, actor);
        for (SessionParticipant participant : invited) {
            readable.add(participant.getSessionId());
        }
        return readable;
    }

    /** Newest non-terminal Run per shown session — the "is it still running" arm of the row. */
    private Map<UUID, String> activeRunStatus(List<Candidate> page) {
        if (page.isEmpty()) {
            return Map.of();
        }
        List<String> sessionIds = new ArrayList<>(page.size());
        for (Candidate candidate : page) {
            sessionIds.add(candidate.session().getId().toString());
        }
        List<ChatRun> runs = chatRuns.findBySessionIdInAndStatusIn(sessionIds,
                ChatRunCancellationService.NON_TERMINAL_STATUSES);
        Map<UUID, ChatRun> newest = new HashMap<>();
        for (ChatRun run : runs) {
            UUID sessionId = parseUuidOrNull(run.getSessionId());
            if (sessionId == null) {
                continue;
            }
            ChatRun current = newest.get(sessionId);
            if (current == null || isNewer(run, current)) {
                newest.put(sessionId, run);
            }
        }
        Map<UUID, String> status = new HashMap<>();
        newest.forEach((sessionId, run) -> status.put(sessionId, run.getStatus()));
        return status;
    }

    private static boolean isNewer(ChatRun candidate, ChatRun current) {
        Instant left = candidate.getCreatedAt();
        Instant right = current.getCreatedAt();
        if (left == null) {
            return false;
        }
        if (right == null) {
            return true;
        }
        return left.isAfter(right);
    }

    private static UUID parseUuidOrNull(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        try {
            return UUID.fromString(value.trim());
        } catch (IllegalArgumentException malformed) {
            return null;
        }
    }

    private static String normalizeDepth(String value) {
        if (value == null || value.isBlank()) {
            return DEPTH_ALL;
        }
        if (DEPTH_ALL.equals(value) || DEPTH_DIRECT.equals(value)) {
            return value;
        }
        throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                "depth must be all or direct");
    }

    private static int normalizeLimit(Integer value) {
        if (value == null) {
            return DEFAULT_LIMIT;
        }
        if (value < 1 || value > MAX_LIMIT) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "limit must be between 1 and " + MAX_LIMIT);
        }
        return value;
    }
}
