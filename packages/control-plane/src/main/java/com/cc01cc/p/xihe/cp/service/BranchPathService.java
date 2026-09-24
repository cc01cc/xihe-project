package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Message;
import com.cc01cc.p.xihe.cp.entity.MessageRole;
import com.cc01cc.p.xihe.cp.entity.RootBranchBinder;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;
import com.cc01cc.p.xihe.cp.repository.SessionBranchRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import javax.sql.DataSource;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/**
 * PLAN-0410 T1.2/T1.4: branch path resolution and anchor cursor validation.
 *
 * <p>All entry points are fail-closed: an unknown/forged branch id, a branch of
 * another Session, a broken parent chain, an anchor that cannot be mapped to a
 * trusted cursor, or a correlation id that does not resolve to a ChatRun of
 * the same Session raises an explicit {@link CpApiException} — never a silent
 * fallback to the Session root.
 *
 * <p>Cursor formula (spec §2, review round-13): anchor on a {@code 'USER'}
 * message resolves to the sequence of that Run's single {@code prompt.admitted}
 * event; anchor on an {@code 'ASSISTANT'} message resolves to the max sequence
 * of that Run's correlated ContextEvents. The anchor Run must be terminal; the
 * Session may hold other active Runs without invalidating the anchor.
 */
@Service
public class BranchPathService {

    /** Mirrors ChatController/RunCheckpointService terminal vocabulary. */
    private static final Set<String> TERMINAL_RUN_STATUSES = Set.of(
            "succeeded", "failed", "partial", "ambiguous", "cancelled");

    private static final int MAX_PATH_DEPTH = 512;

    private final JdbcTemplate jdbcTemplate;
    private final SessionRepository sessionRepository;
    private final MessageRepository messageRepository;
    private final ChatRunRepository chatRunRepository;
    private final SessionBranchRepository sessionBranchRepository;

    public BranchPathService(DataSource dataSource,
                             SessionRepository sessionRepository,
                             MessageRepository messageRepository,
                             ChatRunRepository chatRunRepository,
                             SessionBranchRepository sessionBranchRepository) {
        this.jdbcTemplate = new JdbcTemplate(dataSource);
        this.sessionRepository = sessionRepository;
        this.messageRepository = messageRepository;
        this.chatRunRepository = chatRunRepository;
        this.sessionBranchRepository = sessionBranchRepository;
        RootBranchBinder.register(this::ensureRootBranchId);
    }

    /**
     * Returns the Session root Branch id, creating the root row when missing.
     * Read happens first so existing Sessions never take the write path (the
     * entity callbacks call this inside persist transactions).
     */
    public String ensureRootBranchId(String sessionId) {
        if (sessionId == null || sessionId.isBlank()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "sessionId is required to resolve the root branch");
        }
        String existing = findRootBranchId(sessionId);
        if (existing != null) {
            return existing;
        }
        String branchId = UUID.randomUUID().toString();
        try {
            jdbcTemplate.update(
                    "INSERT INTO session_branches (id, session_id, parent_branch_id, "
                            + "fork_point_message_id, fork_point_run_id, fork_point_sequence, "
                            + "idempotency_key, request_hash, created_at) "
                            + "VALUES (CAST(? AS UUID), CAST(? AS UUID), NULL, NULL, NULL, NULL, "
                            + "NULL, NULL, CURRENT_TIMESTAMP)",
                    branchId, sessionId);
        } catch (RuntimeException insertFailure) {
            String raced = findRootBranchId(sessionId);
            if (raced != null) {
                return raced;
            }
            throw insertFailure;
        }
        return branchId;
    }

    /**
     * Walks {@code branchId} up to the root inside {@code sessionId}; returns
     * the root branch id. Forged ids, cross-Session branches and broken or
     * cyclic parent chains all fail closed.
     */
    public String resolvePath(String sessionId, String branchId) {
        requireText(sessionId, "sessionId");
        requireText(branchId, "branchId");
        Set<String> visited = new HashSet<>();
        String current = branchId;
        int depth = 0;
        while (true) {
            if (!visited.add(current)) {
                throw new CpApiException(HttpStatus.NOT_FOUND, "BRANCH_PATH_BROKEN",
                        "Branch parent chain does not reach a root");
            }
            if (++depth > MAX_PATH_DEPTH) {
                throw new CpApiException(HttpStatus.NOT_FOUND, "BRANCH_PATH_BROKEN",
                        "Branch parent chain exceeds the maximum depth");
            }
            UUID branchUuid;
            try {
                branchUuid = UUID.fromString(current);
            } catch (IllegalArgumentException e) {
                throw new CpApiException(HttpStatus.NOT_FOUND, "BRANCH_NOT_FOUND",
                        "Branch does not exist in this Session");
            }
            var branch = sessionBranchRepository.findById(branchUuid)
                    .orElseThrow(() -> new CpApiException(
                            HttpStatus.NOT_FOUND, "BRANCH_NOT_FOUND",
                            "Branch does not exist in this Session"));
            if (!sessionId.equals(branch.getSessionId())) {
                throw new CpApiException(HttpStatus.NOT_FOUND, "BRANCH_CROSS_SESSION",
                        "Branch belongs to a different Session");
            }
            if (branch.getParentBranchId() == null || branch.getParentBranchId().isBlank()) {
                return branch.getId().toString();
            }
            current = branch.getParentBranchId();
        }
    }

    /**
     * Resolves the fork anchor for a canonical {@code anchorMessageId}
     * (PLAN-0409 contract): same Session, optional Workspace match, role
     * {@code 'USER'}/{@code 'ASSISTANT'}, Run terminal, and a trusted cursor.
     *
     * <p>Does NOT reject the anchor because the Session has another active Run
     * (spec §5 / round-13); only the anchor Run itself must be terminal.
     */
    public AnchorResolution resolveAnchor(String sessionId, String workspaceId, String anchorMessageId) {
        requireText(sessionId, "sessionId");
        requireText(workspaceId, "workspaceId");
        requireText(anchorMessageId, "anchorMessageId");

        Session session = sessionRepository.findById(parseUuid(sessionId, "SESSION_NOT_FOUND",
                        "Session not found"))
                .orElseThrow(() -> new CpApiException(
                        HttpStatus.NOT_FOUND, "SESSION_NOT_FOUND", "Session not found"));
        if (!workspaceId.equals(session.getWorkspaceId())) {
            // Same 404 as an unknown Session: never reveal that the Session
            // exists inside another Workspace.
            throw new CpApiException(HttpStatus.NOT_FOUND, "SESSION_NOT_FOUND", "Session not found");
        }

        Message message = messageRepository.findById(parseUuid(anchorMessageId,
                        "BRANCH_ANCHOR_NOT_FOUND", "Anchor message not found"))
                .orElseThrow(() -> new CpApiException(
                        HttpStatus.NOT_FOUND, "BRANCH_ANCHOR_NOT_FOUND", "Anchor message not found"));
        if (!sessionId.equals(message.getSessionId())) {
            throw new CpApiException(HttpStatus.NOT_FOUND, "BRANCH_ANCHOR_NOT_FOUND",
                    "Anchor message not found");
        }
        MessageRole role = message.getRole();
        if (role != MessageRole.USER && role != MessageRole.ASSISTANT) {
            throw new CpApiException(HttpStatus.CONFLICT, "BRANCH_ANCHOR_ROLE_UNSUPPORTED",
                    "Anchor message must be a USER or ASSISTANT message");
        }
        if (message.getRunId() == null || message.getRunId().isBlank()) {
            // Legacy/import content without a Run cannot produce a cursor.
            throw new CpApiException(HttpStatus.CONFLICT, "BRANCH_ANCHOR_UNAVAILABLE",
                    "Anchor message has no trusted cursor");
        }

        ChatRun run = chatRunRepository.findById(parseUuid(message.getRunId(),
                        "RUN_NOT_FOUND", "Anchor run not found"))
                .orElseThrow(() -> new CpApiException(
                        HttpStatus.NOT_FOUND, "RUN_NOT_FOUND", "Anchor run not found"));
        if (!sessionId.equals(run.getSessionId())) {
            throw new CpApiException(HttpStatus.NOT_FOUND, "RUN_NOT_FOUND", "Anchor run not found");
        }
        if (run.getBranchId() == null || run.getBranchId().isBlank()
                || !run.getBranchId().equals(message.getBranchId())) {
            throw new CpApiException(HttpStatus.CONFLICT, "BRANCH_ANCHOR_INVALID",
                    "Anchor message and run disagree on the branch");
        }
        if (!TERMINAL_RUN_STATUSES.contains(run.getStatus())) {
            throw new CpApiException(HttpStatus.CONFLICT, "BRANCH_ANCHOR_RUN_ACTIVE",
                    "Anchor run is not terminal");
        }

        // The anchor's own branch must resolve inside this Session (current
        // path requirement); a forged/moved branch fails closed here.
        resolvePath(sessionId, message.getBranchId());

        long cursor = resolveAnchorCursor(sessionId, message, run);
        return new AnchorResolution(message.getBranchId(), message.getId().toString(),
                run.getId().toString(), cursor);
    }

    /**
     * Derives the branch for a run-scoped ContextEvent from
     * {@code correlation_id=runId}: the Run must exist inside the same Session
     * and already carry a branch (T1.4 double verification).
     */
    public String deriveBranchForRun(String sessionId, String runId) {
        requireText(sessionId, "sessionId");
        requireText(runId, "correlation_id");
        ChatRun run = chatRunRepository.findById(parseUuid(runId,
                        "RUN_NOT_FOUND", "correlation_id does not resolve to a Run"))
                .orElseThrow(() -> new CpApiException(
                        HttpStatus.NOT_FOUND, "RUN_NOT_FOUND",
                        "correlation_id does not resolve to a Run in this Session"));
        if (!sessionId.equals(run.getSessionId())) {
            throw new CpApiException(HttpStatus.NOT_FOUND, "RUN_NOT_FOUND",
                    "correlation_id does not resolve to a Run in this Session");
        }
        if (run.getBranchId() == null || run.getBranchId().isBlank()) {
            throw new CpApiException(HttpStatus.CONFLICT, "RUN_BRANCH_UNAVAILABLE",
                    "Run has no durable branch binding");
        }
        return run.getBranchId();
    }

    private long resolveAnchorCursor(String sessionId, Message message, ChatRun run) {
        if (message.getRole() == MessageRole.USER) {
            List<Long> admitted = jdbcTemplate.queryForList(
                    "SELECT sequence FROM context_events "
                            + "WHERE session_id = CAST(? AS UUID) AND correlation_id = ? "
                            + "AND event_type = 'prompt.admitted' ORDER BY sequence",
                    Long.class, sessionId, run.getId().toString());
            if (admitted.size() != 1) {
                throw new CpApiException(HttpStatus.CONFLICT, "BRANCH_ANCHOR_UNAVAILABLE",
                        "Anchor run has no unique prompt.admitted cursor");
            }
            return admitted.get(0);
        }
        Long maxCorrelated = jdbcTemplate.queryForObject(
                "SELECT MAX(sequence) FROM context_events "
                        + "WHERE session_id = CAST(? AS UUID) AND correlation_id = ?",
                Long.class, sessionId, run.getId().toString());
        if (maxCorrelated == null || maxCorrelated <= 0) {
            throw new CpApiException(HttpStatus.CONFLICT, "BRANCH_ANCHOR_UNAVAILABLE",
                    "Anchor run has no correlated event cursor");
        }
        return maxCorrelated;
    }

    private String findRootBranchId(String sessionId) {
        List<String> ids = jdbcTemplate.query(
                "SELECT id FROM session_branches "
                        + "WHERE session_id = CAST(? AS UUID) AND parent_branch_id IS NULL",
                (rs, rowNum) -> rs.getString(1), sessionId);
        return ids.isEmpty() ? null : ids.get(0);
    }

    private static UUID parseUuid(String value, String code, String detail) {
        try {
            return UUID.fromString(value);
        } catch (IllegalArgumentException e) {
            throw new CpApiException(HttpStatus.NOT_FOUND, code, detail, e);
        }
    }

    private static void requireText(String value, String field) {
        if (value == null || value.isBlank()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    field + " is required");
        }
    }

    /** message/run/sequence triple fixed inside the Branch creation transaction. */
    public record AnchorResolution(String branchId, String messageId, String runId, long cursor) {
    }
}
