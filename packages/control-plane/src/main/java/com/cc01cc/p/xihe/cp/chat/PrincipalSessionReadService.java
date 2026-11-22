package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.SessionParticipant;
import com.cc01cc.p.xihe.cp.repository.SessionParticipantRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.service.WorkspaceMemberService;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * task-19: the <b>agent-principal</b> read face behind "every conversation this subject takes part
 * in".
 *
 * <p><b>Why this cannot be a client-side filter.</b> {@code GET /api/v1/sessions} answers the
 * CALLER's visible set (owner, or an enabled HUMAN participant; archived excluded —
 * {@code SessionRepository#findReadableByWorkspaceIdAndActor}), and that set never contains a
 * colleague's conversation. Filtering it by {@code SessionSummary.agentPrincipalId} (the PRIMARY
 * row) would therefore (a) silently under-report and (b) miss MEMBER/GUARD rows by construction.
 * The same reasoning the {@code spawn-sessions} face froze for delegated children applies here.</p>
 *
 * <p><b>Source of truth.</b> {@code session_participants} — V92 calls it "the durable shape of who
 * is in this conversation". {@code (principal_kind='AGENT', principal_id)} with <b>no role
 * predicate</b> is exactly "as any participant", which is why PRIMARY, MEMBER and GUARD all land
 * here. {@code chat_runs.agent_principal_id} is <b>not</b> used: it only exists once the subject
 * actually ran, so a member or guard that never spoke would vanish (and a second attribution source
 * would raise "which one wins" — D-215).</p>
 *
 * <p><b>Two independent invariants</b> (same ruling as task-134 / D-1785):</p>
 * <ul>
 *   <li><b>Count</b> — every row of the cohort, never filtered by read visibility and never capped
 *       by {@code limit}; otherwise the number under-reports in a multi-member Workspace.</li>
 *   <li><b>Content</b> — {@code title} is projected only for a Session the caller may read (owner,
 *       or an enabled HUMAN participant; PLAN-0668 D1b keeps managers out of content read). An
 *       unreadable row answers {@code title:null, readable:false} and is still counted.</li>
 * </ul>
 *
 * <p><b>Both counts and the page come from ONE materialized cohort</b>: the three role reads are
 * merged once (disjoint by {@code uq_session_participants_principal}), the Sessions are loaded once,
 * and the counts are taken over that list before the {@code limit} slice — a row created between two
 * queries can never make the response contradict itself.</p>
 *
 * <p><b>Scope</b>: one authorizing Workspace. Rows outside it, archived rows unless
 * {@code includeArchived}, and participant rows that were disabled ({@code disabled_at}) are
 * excluded. Workspace-less Sessions are out of this face by construction: the workspace is the
 * authorization context, exactly like the V107 memory face.</p>
 *
 * <p>Read-only: no durable write, no SSE, no migration.</p>
 */
@Service
public class PrincipalSessionReadService {

    /** Row-cap default/maximum; the counts are never capped. */
    public static final int DEFAULT_LIMIT = 100;
    public static final int MAX_LIMIT = 500;

    /** The three participant roles in wire order; also the per-role count keys. */
    private static final String[] ROLES = {
            SessionParticipant.ROLE_PRIMARY,
            SessionParticipant.ROLE_MEMBER,
            SessionParticipant.ROLE_GUARD,
    };

    private final SessionRepository sessions;
    private final SessionParticipantRepository participants;
    private final WorkspaceMemberService memberService;

    public PrincipalSessionReadService(SessionRepository sessions,
                                       SessionParticipantRepository participants,
                                       WorkspaceMemberService memberService) {
        this.sessions = sessions;
        this.participants = participants;
        this.memberService = memberService;
    }

    /** One cohort member: the Session plus the role the subject holds in it. */
    private record Candidate(Session session, String role) {
    }

    /** One row as the wire sees it (title already redacted when unreadable). */
    public record Row(UUID id, String title, boolean readable, boolean archived, String role,
                      String kind, UUID spawnedFromSessionId, Instant spawnedAt, Instant createdAt,
                      Instant updatedAt) {
    }

    /** Per-role counts over the full cohort. {@code all} is never capped by {@code limit}. */
    public record Counts(int all, int primary, int member, int guard) {
    }

    /** Frozen response envelope. */
    public record Response(UUID workspaceId, UUID principalId, boolean includeArchived, Counts counts,
                           List<Row> sessions, boolean truncated, int limit) {
        public Response {
            sessions = List.copyOf(sessions);
        }
    }

    /**
     * Resolve one Agent principal's participating Sessions in one Workspace.
     *
     * <p>Authorization is the workspace roster's gate ({@link WorkspaceMemberService#requireRosterRead}):
     * OWNER/EDITOR, or the instance-scope {@code MANAGE_WORKSPACE_MEMBERS} atom; a VIEWER answers 403
     * WORKSPACE_FORBIDDEN. The gate is expressed once, in the roster's own service — never re-stated
     * here. It is the same gate the delegated-child face uses, because this response also exposes
     * roster-adjacent facts about other members' conversations.</p>
     *
     * <p>An unknown or unbound principal answers an empty cohort with zero counts rather than 404:
     * the response is a workspace-scoped aggregate whose subject-level content is already gated per
     * row, so this face is not an existence oracle and "never participated" is not a UI error.</p>
     */
    @Transactional(readOnly = true)
    public Response read(String actorUserId, UUID workspaceId, UUID principalId,
                         boolean includeArchived, Integer limitParam) {
        int limit = normalizeLimit(limitParam);
        memberService.requireRosterRead(workspaceId == null ? null : workspaceId.toString(),
                actorUserId);

        List<Candidate> cohort = loadCohort(workspaceId, principalId, includeArchived);
        Counts counts = count(cohort);
        if (cohort.isEmpty()) {
            return new Response(workspaceId, principalId, includeArchived, counts, List.of(),
                    false, limit);
        }

        List<Candidate> ordered = new ArrayList<>(cohort);
        ordered.sort(CANDIDATE_ORDER);
        boolean truncated = ordered.size() > limit;
        List<Candidate> page = truncated ? List.copyOf(ordered.subList(0, limit))
                : List.copyOf(ordered);

        Set<UUID> readable = readableSessionIds(actorUserId, page);
        List<Row> rows = new ArrayList<>(page.size());
        for (Candidate candidate : page) {
            Session session = candidate.session();
            boolean canRead = readable.contains(session.getId());
            rows.add(new Row(session.getId(), canRead ? session.getTitle() : null, canRead,
                    session.isArchived(), candidate.role(), session.getKind(),
                    session.getSpawnedFromSessionId(), session.getSpawnedAt(),
                    session.getCreatedAt(), session.getUpdatedAt()));
        }
        return new Response(workspaceId, principalId, includeArchived, counts, rows, truncated, limit);
    }

    /** Newest Session first; a null createdAt (legacy) sorts last; id breaks ties deterministically. */
    private static final Comparator<Candidate> CANDIDATE_ORDER = Comparator
            .comparing((Candidate candidate) -> candidate.session().getCreatedAt() == null
                    ? Instant.EPOCH : candidate.session().getCreatedAt())
            .reversed()
            .thenComparing(candidate -> candidate.session().getId().toString(),
                    Comparator.reverseOrder());

    /**
     * Materialize the cohort once: one participant read per role (each served by
     * {@code idx_session_participants_principal}), then one batched Session load.
     *
     * <p>The three role results cannot overlap: {@code uq_session_participants_principal} is
     * {@code (session_id, principal_kind, principal_id)}, so one subject holds at most one row per
     * Session. The merge still keys by Session id and keeps the first role, so a corrupt duplicate
     * degrades to one row instead of double-counting.</p>
     */
    private List<Candidate> loadCohort(UUID workspaceId, UUID principalId, boolean includeArchived) {
        if (workspaceId == null || principalId == null) {
            return List.of();
        }
        Map<UUID, String> roleBySession = new LinkedHashMap<>();
        for (String role : ROLES) {
            for (SessionParticipant participant : participants.findByPrincipalKindAndPrincipalIdAndRole(
                    SessionParticipant.KIND_AGENT, principalId, role)) {
                if (participant.getSessionId() != null && participant.getDisabledAt() == null) {
                    roleBySession.putIfAbsent(participant.getSessionId(), role);
                }
            }
        }
        if (roleBySession.isEmpty()) {
            return List.of();
        }
        String workspace = workspaceId.toString();
        List<Candidate> cohort = new ArrayList<>(roleBySession.size());
        for (Session session : sessions.findAllById(roleBySession.keySet())) {
            if (!workspace.equals(session.getWorkspaceId())) {
                continue;
            }
            if (!includeArchived && session.isArchived()) {
                continue;
            }
            cohort.add(new Candidate(session, roleBySession.get(session.getId())));
        }
        return cohort;
    }

    /** Counts over the already-materialized cohort (no second query, never capped by limit). */
    private static Counts count(List<Candidate> cohort) {
        int primary = 0;
        int member = 0;
        int guard = 0;
        for (Candidate candidate : cohort) {
            switch (candidate.role()) {
                case SessionParticipant.ROLE_PRIMARY -> primary++;
                case SessionParticipant.ROLE_MEMBER -> member++;
                case SessionParticipant.ROLE_GUARD -> guard++;
                default -> { }
            }
        }
        return new Counts(cohort.size(), primary, member, guard);
    }

    /**
     * The content face (PLAN-0668 D1b): owner, or an enabled HUMAN participant. Managers are absent
     * on purpose — reading the roster must not become reading every conversation's title.
     */
    private Set<UUID> readableSessionIds(String actorUserId, List<Candidate> page) {
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
            Session session = candidate.session();
            ids.add(session.getId());
            if (actor.toString().equals(session.getUserId())) {
                readable.add(session.getId());
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

    static int normalizeLimit(Integer value) {
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
