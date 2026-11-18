package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.TeamTask;
import com.cc01cc.p.xihe.cp.policy.PolicyEngine;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.TeamTaskRepository;
import com.fasterxml.jackson.databind.JsonNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * task-188 MVP⑤ S2: the shared team-task board (V172).
 *
 * <p>One board per tree: the board key is the tree's root session, established by
 * {@link DelegationChainWalker} on every call — the tree, not the caller's session, is the team.
 * The stored {@code team_root_session_id} on each row is the write-time snapshot; reads
 * recompute the root anyway.</p>
 *
 * <p>All four CP-owned tool faces ({@code team_task_create/list/get/update}) gate on the single
 * {@code TEAM_TASK_MANAGE} atom through the normal grant path (the spawn_agent precedent in
 * {@link AgentSpawnAuthorizationService}); denials are audited and answered 403. Lifecycle is
 * advisory CAS: every mutation carries {@code expectedRevision} and is applied through a guarded
 * {@code WHERE revision = :expected} update — 0 affected rows ⇒ 409 TEAM_TASK_CONFLICT, never a
 * trusted stale read. Authorizations beyond the atom are row-local: claim needs the row unclaimed,
 * complete/reopen/move/update_details need the caller to BE the owner session, reassign needs
 * creator lineage (the creator's session must still walk to this board's root). {@code blocked_by}
 * and {@code write_scopes} are advisory — they never gate transitions; {@code write_scope_warnings}
 * is derived at read time and deliberately not stored.</p>
 */
@Service
public class TeamTaskService {

    private static final Logger logger = LoggerFactory.getLogger(TeamTaskService.class);

    static final int SUBJECT_MAX = 200;
    static final int DESCRIPTION_MAX = 16384;
    static final int SCOPE_ENTRY_MAX = 512;
    static final int SCOPE_LIST_MAX = 50;

    /** wire-ready projection row — the ui-1 ApiTeamTask contract (15 fields, taskRootSessionId included). */
    public record TeamTaskView(
            String taskId,
            String teamRootSessionId,
            long taskNo,
            long revision,
            String subject,
            String description,
            String status,
            boolean ready,
            String ownerSessionId,
            String ownerName,
            List<String> blockedBy,
            List<String> writeScopeWarnings,
            String createdBySessionId,
            java.time.Instant createdAt,
            java.time.Instant updatedAt) {

        /**
         * The canonical 15-field wire projection, shared by every mouth (the UI read controller,
         * the four MCP tool faces) — one builder so the surfaces can never drift apart.
         * Instants serialize as RFC-3339 UTC strings; the two lists are defensively copied.
         */
        public Map<String, Object> toWire() {
            Map<String, Object> row = new HashMap<>();
            row.put("taskId", taskId);
            row.put("teamRootSessionId", teamRootSessionId);
            row.put("taskNo", taskNo);
            row.put("revision", revision);
            row.put("subject", subject);
            row.put("description", description);
            row.put("status", status);
            row.put("ready", ready);
            row.put("ownerSessionId", ownerSessionId);
            row.put("ownerName", ownerName);
            row.put("blockedBy", List.copyOf(blockedBy));
            row.put("writeScopeWarnings", List.copyOf(writeScopeWarnings));
            row.put("createdBySessionId", createdBySessionId);
            row.put("createdAt", createdAt.toString());
            row.put("updatedAt", updatedAt.toString());
            return row;
        }
    }

    private final TeamTaskRepository teamTasks;
    private final SessionRepository sessions;
    private final DelegationChainWalker chainWalker;
    private final PolicyEngine policy;
    private final AuditLogger audit;

    public TeamTaskService(TeamTaskRepository teamTasks, SessionRepository sessions,
                           DelegationChainWalker chainWalker, PolicyEngine policy, AuditLogger audit) {
        this.teamTasks = teamTasks;
        this.sessions = sessions;
        this.chainWalker = chainWalker;
        this.policy = policy;
        this.audit = audit;
    }

    // ---------------------------------------------------------------------------------------------
    // Board resolution — the tree, not the caller's session, is the team.
    // ---------------------------------------------------------------------------------------------

    private record Board(Session caller, Session root, List<TeamTask> rows) {}

    private Board boardOf(String sessionId) {
        Session caller = sessions.findById(parseUuid(sessionId, "sessionId"))
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "SESSION_NOT_FOUND",
                        "session " + sessionId + " not found"));
        DelegationChainWalker.ChainWalk walk;
        try {
            walk = chainWalker.walkFromSession(caller);
        } catch (DelegationChainWalker.AncestorMissingException broken) {
            // Fail closed on a structurally broken chain; the durable reason is the audit value.
            throw new CpApiException(HttpStatus.CONFLICT, "TEAM_TASK_TREE_BROKEN",
                    broken.reason() + ": " + broken.getMessage());
        }
        Session root = sessions.findById(walk.hops().get(walk.hops().size() - 1).nodeId())
                .orElseThrow(() -> new CpApiException(HttpStatus.CONFLICT, "TEAM_TASK_TREE_BROKEN",
                        "root session vanished during board resolution"));
        List<TeamTask> rows = teamTasks.findByTeamRootSessionIdOrderByTaskNo(root.getId().toString());
        return new Board(caller, root, rows);
    }

    /** The human read face's gate: resolve the board for a session the CALLER may read. */
    @Transactional(readOnly = true)
    public BoardView boardView(String sessionId, String userId) {
        Board board = boardOf(sessionId);
        requireHumanReader(board.root, userId);
        return new BoardView(board.root.getId().toString(),
                board.rows.stream().map(row -> view(board.rows, row)).toList());
    }

    public record BoardView(String teamRootSessionId, List<TeamTaskView> tasks) {}

    @Transactional(readOnly = true)
    public TeamTaskView getForRead(String sessionId, String userId, String taskId) {
        Board board = boardOf(sessionId);
        requireHumanReader(board.root, userId);
        return view(board.rows, requireOnBoard(board, taskId));
    }

    /**
     * Read-face conservatism (D-1821 面板只读裁定): the readable human is the ROOT session's
     * owner — the Lead. Tree members are agent principals (they use the tool faces, not this
     * HTTP mouth); a non-owner human gets 403 even for a session they can read elsewhere, because
     * the board names every teammate's task.
     */
    private void requireHumanReader(Session root, String userId) {
        if (userId == null || !userId.equals(root.getUserId())) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "TEAM_TASK_FORBIDDEN",
                    "only the team root's owner may read the task board");
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Tool face entry points — TEAM_TASK_MANAGE-gated.
    // ---------------------------------------------------------------------------------------------

    @Transactional
    public TeamTaskView create(String tool, String userId, String workspaceId, String sessionId,
                               String subject, String description,
                               List<String> blockedBy, List<String> writeScopes) {
        Board board = authorizedBoard(tool, userId, workspaceId, sessionId);
        requireWorkspace(board.root);
        String trimmed = requireSubject(subject);
        if (description != null && description.length() > DESCRIPTION_MAX) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "description exceeds " + DESCRIPTION_MAX + " chars");
        }
        List<String> blocked = normalizeScopeList(blockedBy, "blockedBy");
        List<String> scopes = normalizeScopeList(writeScopes, "writeScopes");

        TeamTask row = TeamTask.create();
        row.setSubject(trimmed);
        row.setDescription(description);
        row.setBlockedBy(jsonArray(blocked));
        row.setWriteScopes(jsonArray(scopes));
        row.setCreatedBySessionId(board.caller.getId().toString());
        row.setTeamRootSessionId(board.root.getId().toString());
        row.setWorkspaceId(board.root.getWorkspaceId());
        synchronized (board.root.getId().toString().intern()) {
            row.setTaskNo(teamTasks.countByTeamRootSessionId(board.root.getId().toString()) + 1);
            teamTasks.save(row);
        }
        audit.recordDurableChange(userId, workspaceId, "team_task_create", "team_task",
                row.getId().toString(), "taskNo=" + row.getTaskNo() + " subject=" + safeSubject(trimmed));
        logger.info("[LIFECYCLE] service=cp event=team_task_created board={} taskNo={} sessionId={}",
                board.root.getId(), row.getTaskNo(), sessionId);
        return view(teamTasks.findByTeamRootSessionIdOrderByTaskNo(board.root.getId().toString()), row);
    }

    @Transactional(readOnly = true)
    public List<TeamTaskView> list(String tool, String userId, String workspaceId, String sessionId) {
        Board board = authorizedBoard(tool, userId, workspaceId, sessionId);
        return board.rows.stream().map(row -> view(board.rows, row)).toList();
    }

    @Transactional(readOnly = true)
    public TeamTaskView get(String tool, String userId, String workspaceId, String sessionId, String taskId) {
        Board board = authorizedBoard(tool, userId, workspaceId, sessionId);
        return view(board.rows, requireOnBoard(board, taskId));
    }

    /**
     * The six {@code action} verbs of team_task_update: claim / complete / reopen / move /
     * reassign / update_details. {@code expectedRevision} is mandatory and advisory-CAS-checked;
     * a stale value answers 409 TEAM_TASK_CONFLICT (the row is the referee, not the caller).
     */
    @Transactional
    public TeamTaskView update(String tool, String userId, String workspaceId, String sessionId,
                               String taskId, String action, Long expectedRevision,
                               String ownerSessionId, String subject, String description,
                               String status, List<String> blockedBy, List<String> writeScopes) {
        Board board = authorizedBoard(tool, userId, workspaceId, sessionId);
        TeamTask row = requireOnBoard(board, taskId);
        if (TeamTask.STATUS_DELETED.equals(row.getStatus())) {
            throw new CpApiException(HttpStatus.CONFLICT, "TEAM_TASK_CONFLICT",
                    "deleted tasks are immutable except by reopen");
        }
        if (expectedRevision == null || expectedRevision != row.getRevision()) {
            throw new CpApiException(HttpStatus.CONFLICT, "TEAM_TASK_CONFLICT",
                    "expectedRevision does not match the current revision");
        }
        long expected = expectedRevision;
        String callerId = board.caller.getId().toString();
        // One reading of the clock per update; the repository binds it (CURRENT_TIMESTAMP cannot
        // be assigned to an Instant field — see TeamTaskRepository's javadoc).
        java.time.Instant now = java.time.Instant.now();
        int updated;
        switch (action == null ? "" : action) {
            case "claim" -> {
                if (row.getOwnerSessionId() != null) {
                    throw new CpApiException(HttpStatus.CONFLICT, "TEAM_TASK_CONFLICT",
                            "task is already claimed");
                }
                // The caller already proved tree membership (their root == the board root).
                updated = teamTasks.casClaim(row.getId(), expected, callerId,
                        board.caller.getTitle(), now);
            }
            case "complete" -> {
                requireOwner(row, callerId, "complete");
                requireStatus(row, TeamTask.STATUS_IN_PROGRESS, "complete");
                updated = teamTasks.casUpdateStatus(row.getId(), expected, TeamTask.STATUS_COMPLETED, now);
            }
            case "reopen" -> {
                requireOwner(row, callerId, "reopen");
                requireStatus(row, TeamTask.STATUS_COMPLETED, "reopen");
                updated = teamTasks.casUpdateStatus(row.getId(), expected, TeamTask.STATUS_IN_PROGRESS, now);
            }
            case "move" -> {
                requireOwner(row, callerId, "move");
                String target = requireStatusName(status);
                updated = teamTasks.casUpdateStatus(row.getId(), expected, target, now);
            }
            case "reassign" -> {
                requireCreatorLineage(board, row, callerId);
                if (ownerSessionId == null) {
                    updated = teamTasks.casReassign(row.getId(), expected, null, null, now);
                } else {
                    Session target = sessions.findById(parseUuid(ownerSessionId, "ownerSessionId"))
                            .orElseThrow(() -> new CpApiException(HttpStatus.CONFLICT,
                                    "TEAM_TASK_INVALID_TARGET", "target session does not exist"));
                    requireTreeMember(board, target);
                    updated = teamTasks.casReassign(row.getId(), expected,
                            target.getId().toString(), target.getTitle(), now);
                }
            }
            case "update_details" -> {
                requireOwner(row, callerId, "update_details");
                String trimmed = subject == null ? null : requireSubject(subject);
                if (description != null && description.length() > DESCRIPTION_MAX) {
                    throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                            "description exceeds " + DESCRIPTION_MAX + " chars");
                }
                List<String> newBlocked = blockedBy == null ? null : normalizeScopeList(blockedBy, "blockedBy");
                if (newBlocked != null) {
                    validateDependencyClosure(board, row.getId().toString(), newBlocked);
                }
                List<String> newScopes = writeScopes == null ? null : normalizeScopeList(writeScopes, "writeScopes");
                updated = teamTasks.casUpdateDetails(row.getId(), expected,
                        trimmed, description, newBlocked == null ? null : jsonArray(newBlocked),
                        newScopes == null ? null : jsonArray(newScopes), now);
            }
            default -> throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "unknown update action: " + action);
        }
        if (updated == 0) {
            // Lost the CAS race between the pre-check and the guarded UPDATE — the row is the referee.
            throw new CpApiException(HttpStatus.CONFLICT, "TEAM_TASK_CONFLICT",
                    "task changed concurrently; re-read and retry");
        }
        audit.recordDurableChange(userId, workspaceId, "team_task_" + action, "team_task",
                row.getId().toString(), "taskNo=" + row.getTaskNo());
        logger.info("[LIFECYCLE] service=cp event=team_task_updated action={} board={} taskNo={} sessionId={}",
                action, row.getTeamRootSessionId(), row.getTaskNo(), sessionId);
        List<TeamTask> fresh = teamTasks.findByTeamRootSessionIdOrderByTaskNo(board.root.getId().toString());
        TeamTask freshRow = fresh.stream().filter(t -> t.getId().equals(row.getId())).findFirst()
                .orElseThrow(() -> new CpApiException(HttpStatus.CONFLICT, "TEAM_TASK_CONFLICT",
                        "task disappeared mid-update"));
        return view(fresh, freshRow);
    }

    // ---------------------------------------------------------------------------------------------
    // Authorization + row-local rules.
    // ---------------------------------------------------------------------------------------------

    private Board authorizedBoard(String tool, String userId, String workspaceId, String sessionId) {
        Board board = boardOf(sessionId);
        if (!policy.allowsByGrant(policy.loadContext(userId, workspaceId, sessionId), tool, null,
                sessionId, userId, workspaceId, false)) {
            audit.record(sessionId, tool, "authorization_denied", "actionClass=TEAM_TASK_MANAGE");
            throw new CpApiException(HttpStatus.FORBIDDEN, "TEAM_TASK_FORBIDDEN",
                    "an explicit TEAM_TASK_MANAGE grant is required");
        }
        return board;
    }

    private void requireWorkspace(Session root) {
        if (root.getWorkspaceId() == null || root.getWorkspaceId().isBlank()) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "TEAM_TASK_FORBIDDEN",
                    "the team task board lives in workspace trees; this tree has no workspace");
        }
    }

    private void requireOwner(TeamTask row, String callerId, String verb) {
        if (!callerId.equals(row.getOwnerSessionId())) {
            throw new CpApiException(HttpStatus.CONFLICT, "TEAM_TASK_CONFLICT",
                    "only the owner session may " + verb + " this task");
        }
    }

    private void requireCreatorLineage(Board board, TeamTask row, String callerId) {
        if (!callerId.equals(row.getCreatedBySessionId())) {
            throw new CpApiException(HttpStatus.CONFLICT, "TEAM_TASK_CONFLICT",
                    "only the creating session may reassign this task");
        }
        // Creator lineage: the creator's session must still walk to THIS board's root. A task
        // handed down the tree keeps its board; a creator that has since been re-rooted (never in
        // the current model, kept as the guard's reason to exist) loses reassign.
        DelegationChainWalker.ChainWalk walk = chainWalker.walkFromSession(board.caller);
        UUID walkRoot = walk.hops().get(walk.hops().size() - 1).nodeId();
        if (!board.root.getId().equals(walkRoot)) {
            throw new CpApiException(HttpStatus.CONFLICT, "TEAM_TASK_TREE_BROKEN",
                    "the creator session no longer resolves to this board's root");
        }
    }

    private void requireTreeMember(Board board, Session target) {
        DelegationChainWalker.ChainWalk walk;
        try {
            walk = chainWalker.walkFromSession(target);
        } catch (DelegationChainWalker.AncestorMissingException broken) {
            throw new CpApiException(HttpStatus.CONFLICT, "TEAM_TASK_INVALID_TARGET",
                    broken.reason() + ": " + broken.getMessage());
        }
        UUID walkRoot = walk.hops().get(walk.hops().size() - 1).nodeId();
        if (!board.root.getId().equals(walkRoot)) {
            throw new CpApiException(HttpStatus.CONFLICT, "TEAM_TASK_INVALID_TARGET",
                    "reassign target is not a session of this board's tree");
        }
    }

    private void requireStatus(TeamTask row, String expected, String verb) {
        if (!expected.equals(row.getStatus())) {
            throw new CpApiException(HttpStatus.CONFLICT, "TEAM_TASK_CONFLICT",
                    "task must be " + expected + " to " + verb);
        }
    }

    private String requireStatusName(String status) {
        if (!List.of(TeamTask.STATUS_PENDING, TeamTask.STATUS_IN_PROGRESS, TeamTask.STATUS_COMPLETED)
                .contains(status)) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "status must be pending/in_progress/completed");
        }
        return status;
    }

    private TeamTask requireOnBoard(Board board, String taskId) {
        UUID id = parseUuid(taskId, "taskId");
        return board.rows.stream().filter(t -> t.getId().equals(id)).findFirst()
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "TEAM_TASK_NOT_FOUND",
                        "task " + taskId + " is not on this board"));
    }

    // ---------------------------------------------------------------------------------------------
    // Validation + derivation.
    // ---------------------------------------------------------------------------------------------

    private String requireSubject(String subject) {
        if (subject == null || subject.isBlank()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "subject is required");
        }
        if (subject.length() > SUBJECT_MAX) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "subject exceeds " + SUBJECT_MAX + " chars");
        }
        return subject.trim();
    }

    private List<String> normalizeScopeList(List<String> values, String field) {
        if (values == null) {
            return List.of();
        }
        if (values.size() > SCOPE_LIST_MAX) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    field + " exceeds " + SCOPE_LIST_MAX + " entries");
        }
        List<String> out = new ArrayList<>(values.size());
        for (String value : values) {
            if (value == null || value.isBlank() || value.length() > SCOPE_ENTRY_MAX) {
                throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                        field + " entries must be 1.." + SCOPE_ENTRY_MAX + " chars");
            }
            out.add(value.trim());
        }
        return List.copyOf(out);
    }

    /** blockedBy must reference same-board rows and introduce no cycle (self-reachability check). */
    private void validateDependencyClosure(Board board, String taskId, List<String> blockedBy) {
        Map<String, TeamTask> byId = new HashMap<>();
        for (TeamTask row : board.rows) {
            byId.put(row.getId().toString(), row);
        }
        if (blockedBy.contains(taskId)) {
            throw new CpApiException(HttpStatus.CONFLICT, "TEAM_TASK_CYCLE",
                    "a task cannot block itself");
        }
        for (String dep : blockedBy) {
            if (!byId.containsKey(dep)) {
                throw new CpApiException(HttpStatus.NOT_FOUND, "TEAM_TASK_NOT_FOUND",
                        "blockedBy task " + dep + " is not on this board");
            }
        }
        // Would adding taskId → blockedBy edges close a cycle back to taskId? DFS from each new dep.
        Set<String> targetSet = new LinkedHashSet<>(blockedBy);
        Deque<String> stack = new ArrayDeque<>(targetSet);
        Set<String> seen = new HashSet<>();
        while (!stack.isEmpty()) {
            String current = stack.pop();
            if (!seen.add(current)) {
                continue;
            }
            if (current.equals(taskId)) {
                throw new CpApiException(HttpStatus.CONFLICT, "TEAM_TASK_CYCLE",
                        "blockedBy would close a dependency cycle");
            }
            TeamTask node = byId.get(current);
            if (node != null && node.getBlockedBy() != null) {
                node.getBlockedBy().forEach(item -> {
                    if (item.isTextual()) {
                        stack.push(item.asText());
                    }
                });
            }
        }
    }

    /** ready = no unfinished dependency. write_scope_warnings derived from advisory scope overlap. */
    private TeamTaskView view(List<TeamTask> board, TeamTask row) {
        Set<String> unfinished = new HashSet<>();
        for (TeamTask other : board) {
            if (!TeamTask.STATUS_COMPLETED.equals(other.getStatus())
                    && !TeamTask.STATUS_DELETED.equals(other.getStatus())) {
                unfinished.add(other.getId().toString());
            }
        }
        boolean ready = !TeamTask.STATUS_COMPLETED.equals(row.getStatus())
                && !TeamTask.STATUS_DELETED.equals(row.getStatus());
        if (ready && row.getBlockedBy() != null) {
            for (JsonNode dep : row.getBlockedBy()) {
                if (dep.isTextual() && unfinished.contains(dep.asText())) {
                    ready = false;
                    break;
                }
            }
        }
        return new TeamTaskView(
                row.getId().toString(),
                row.getTeamRootSessionId(),
                row.getTaskNo(),
                row.getRevision(),
                row.getSubject(),
                row.getDescription(),
                row.getStatus(),
                ready,
                row.getOwnerSessionId(),
                row.getOwnerName(),
                toStringList(row.getBlockedBy()),
                deriveWarnings(board, row),
                row.getCreatedBySessionId(),
                row.getCreatedAt(),
                row.getUpdatedAt());
    }

    /** Advisory overlap warnings: a non-terminal task whose writeScopes overlap this row's. */
    private List<String> deriveWarnings(List<TeamTask> board, TeamTask row) {
        List<String> scopes = toStringList(row.getWriteScopes());
        if (scopes.isEmpty()) {
            return List.of();
        }
        List<String> warnings = new ArrayList<>();
        for (TeamTask other : board) {
            if (other.getId().equals(row.getId())
                    || TeamTask.STATUS_COMPLETED.equals(other.getStatus())
                    || TeamTask.STATUS_DELETED.equals(other.getStatus())) {
                continue;
            }
            for (String otherScope : toStringList(other.getWriteScopes())) {
                for (String scope : scopes) {
                    if (overlaps(scope, otherScope)) {
                        warnings.add("write scope '" + scope + "' overlaps task-" + other.getTaskNo()
                                + " ('" + otherScope + "')");
                    }
                }
            }
        }
        return List.copyOf(warnings);
    }

    /** Prefix overlap on normalized '/'-separated paths; exact equality overlaps too. */
    private boolean overlaps(String a, String b) {
        String na = normalizePath(a);
        String nb = normalizePath(b);
        return na.equals(nb) || na.startsWith(nb + "/") || nb.startsWith(na + "/");
    }

    private String normalizePath(String scope) {
        return scope.replace('\\', '/').replaceAll("/+$", "").toLowerCase(java.util.Locale.ROOT);
    }

    private List<String> toStringList(JsonNode node) {
        if (node == null || !node.isArray()) {
            return List.of();
        }
        List<String> out = new ArrayList<>(node.size());
        node.forEach(item -> {
            if (item.isTextual()) {
                out.add(item.asText());
            }
        });
        return List.copyOf(out);
    }

    private JsonNode jsonArray(List<String> values) {
        return com.fasterxml.jackson.databind.node.JsonNodeFactory.instance
                .arrayNode().addAll(values.stream()
                        .map(com.fasterxml.jackson.databind.node.JsonNodeFactory.instance::textNode)
                        .toList());
    }

    private UUID parseUuid(String value, String field) {
        try {
            return UUID.fromString(value);
        } catch (RuntimeException invalid) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    field + " must be a uuid");
        }
    }

    private String safeSubject(String subject) {
        return subject.length() > 120 ? subject.substring(0, 120) : subject;
    }
}