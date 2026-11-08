package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.ConversationThread;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.ConversationThreadRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * PLAN-0646 MVP (D-671): the minimal conversation-thread seam.
 *
 * <p>MVP decisions are deliberate and narrow:</p>
 * <ul>
 *   <li>{@code user} scope is readable by its creator and nobody else (no workspace-wide widening);</li>
 *   <li>{@code agent} scope is readable by the agent principal's owner; the agent runtime identity itself
 *       remains on the internal face (full thread semantics deferred with V4/V5);</li>
 *   <li>{@code workspace} scope is accepted by the DB CHECK but every read/write fails closed with
 *       {@code THREAD_SCOPE_UNRESOLVED} — capability-driven audience is V4, deferred.</li>
 * </ul>
 *
 * <p>Attach is owner-only ({@code THREAD_WRITE_FORBIDDEN} otherwise), idempotent for the same thread
 * (200, {@code changed=false}) and overwrites a previous thread without cascading anything (D-671 #3).</p>
 */
@Service
public class ThreadAccessService {

    private static final Set<String> SCOPES = Set.of(
            ConversationThread.SCOPE_USER,
            ConversationThread.SCOPE_AGENT,
            ConversationThread.SCOPE_WORKSPACE);

    private final ConversationThreadRepository threads;
    private final SessionRepository sessions;
    private final AgentPrincipalRepository principals;

    public ThreadAccessService(ConversationThreadRepository threads,
                               SessionRepository sessions,
                               AgentPrincipalRepository principals) {
        this.threads = threads;
        this.sessions = sessions;
        this.principals = principals;
    }

    @Transactional
    public ConversationThread create(String actorUserId, String scopeType, UUID scopeId, String title) {
        UUID actor = parseActor(actorUserId);
        if (scopeType == null || !SCOPES.contains(scopeType)) {
            throw invalid("scopeType must be one of user|agent|workspace");
        }
        if (ConversationThread.SCOPE_WORKSPACE.equals(scopeType)) {
            throw unresolved("workspace scope is not resolvable in the MVP");
        }
        if (scopeId == null) {
            throw invalid("scopeId is required");
        }
        if (ConversationThread.SCOPE_USER.equals(scopeType)) {
            if (!actor.equals(scopeId)) {
                throw forbidden("Only the current user can scope a thread to themselves");
            }
        } else {
            requireOwnedAgent(actor, scopeId);
        }
        ConversationThread thread = new ConversationThread();
        thread.setScopeType(scopeType);
        thread.setScopeId(scopeId);
        thread.setCreatedByUserId(actor);
        thread.setTitle(title);
        return threads.save(thread);
    }

    @Transactional(readOnly = true)
    public ConversationThread requireReadable(String actorUserId, UUID threadId) {
        ConversationThread thread = threads.findById(threadId)
                .orElseThrow(() -> notFound());
        UUID actor = parseActor(actorUserId);
        switch (thread.getScopeType()) {
            case ConversationThread.SCOPE_USER -> {
                if (!actor.equals(thread.getCreatedByUserId())) {
                    throw notFound();
                }
            }
            case ConversationThread.SCOPE_AGENT -> {
                if (!ownsAgent(actor, thread.getScopeId())) {
                    throw notFound();
                }
            }
            case ConversationThread.SCOPE_WORKSPACE -> throw unresolved("workspace scope is not resolvable in the MVP");
            default -> throw unresolved("unknown thread scope");
        }
        return thread;
    }

    /**
     * Attach one session to a thread. The response carries {@code changed} so the wire can distinguish
     * a first attach from the idempotent no-op (D-671 #3: same thread twice is 200, never 409).
     */
    @Transactional
    public AttachResult attach(String actorUserId, UUID threadId, UUID sessionId) {
        ConversationThread thread = requireReadable(actorUserId, threadId);
        UUID actor = parseActor(actorUserId);
        Session session = sessions.findById(sessionId)
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "SESSION_NOT_FOUND",
                        "Session not found"));
        if (!actor.toString().equals(session.getUserId())) {
            throw forbidden("Only the session owner can attach it to a thread");
        }
        UUID previous = session.getConversationThreadId();
        boolean changed = previous == null || !previous.equals(threadId);
        if (changed) {
            session.setConversationThreadId(threadId);
            sessions.save(session);
        }
        return new AttachResult(thread, sessionId, changed);
    }

    /**
     * PLAN-0647 D-678 #3: the equivalent of the 0646 {@code requireWritable} name (deliberately not a
     * missing capability — 0646 is already queued). Owner semantics are the SAME as {@code attach()}:
     * only the thread's creator may write to it; everyone else gets {@code THREAD_WRITE_FORBIDDEN}.
     * A non-readable thread stays 404/403 from {@link #requireReadable} so no oracle is added.
     */
    @Transactional(readOnly = true)
    public ConversationThread assertWritable(UUID threadId, String principalId) {
        ConversationThread thread = requireReadable(principalId, threadId);
        if (!thread.getCreatedByUserId().equals(parseActor(principalId))) {
            throw forbidden("Only the thread creator can write to it");
        }
        return thread;
    }

    @Transactional(readOnly = true)
    public Map<String, Object> view(ConversationThread thread) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("id", thread.getId().toString());
        body.put("scopeType", thread.getScopeType());
        body.put("scopeId", thread.getScopeId().toString());
        body.put("title", thread.getTitle());
        body.put("createdByUserId", thread.getCreatedByUserId().toString());
        body.put("createdAt", thread.getCreatedAt().toString());
        body.put("updatedAt", thread.getUpdatedAt().toString());
        List<Map<String, Object>> rows = sessions
                .findByConversationThreadIdOrderByCreatedAtAsc(thread.getId()).stream()
                .map(session -> {
                    Map<String, Object> row = new LinkedHashMap<>();
                    row.put("id", session.getId().toString());
                    row.put("title", session.getTitle());
                    row.put("workspaceId", session.getWorkspaceId());
                    row.put("userId", session.getUserId());
                    row.put("createdAt", session.getCreatedAt() == null ? null : session.getCreatedAt().toString());
                    return row;
                })
                .toList();
        body.put("sessions", rows);
        return body;
    }

    private void requireOwnedAgent(UUID actor, UUID agentPrincipalId) {
        AgentPrincipal principal = principals.findById(agentPrincipalId)
                .orElseThrow(() -> invalid("scopeId does not name an agent principal"));
        if (principal.getDisabledAt() != null || !owns(actor, principal)) {
            throw forbidden("Only the owner of the agent principal can scope a thread to it");
        }
    }

    private boolean ownsAgent(UUID actor, UUID agentPrincipalId) {
        return principals.findById(agentPrincipalId)
                .map(principal -> principal.getDisabledAt() == null && owns(actor, principal))
                .orElse(false);
    }

    private static boolean owns(UUID actor, AgentPrincipal principal) {
        if (principal.getOwnerUserId() != null) {
            return principal.getOwnerUserId().equals(actor);
        }
        return actor.toString().equals(principal.getCreatedByUserId());
    }

    private static UUID parseActor(String actorUserId) {
        try {
            return UUID.fromString(actorUserId);
        } catch (RuntimeException e) {
            throw new CpApiException(HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED",
                    "Authenticated user is required");
        }
    }

    private static CpApiException invalid(String detail) {
        return new CpApiException(HttpStatus.BAD_REQUEST, "THREAD_SCOPE_INVALID", detail);
    }

    private static CpApiException notFound() {
        return new CpApiException(HttpStatus.NOT_FOUND, "THREAD_NOT_FOUND", "Conversation thread not found");
    }

    private static CpApiException forbidden(String detail) {
        return new CpApiException(HttpStatus.FORBIDDEN, "THREAD_WRITE_FORBIDDEN", detail);
    }

    private static CpApiException unresolved(String detail) {
        return new CpApiException(HttpStatus.FORBIDDEN, "THREAD_SCOPE_UNRESOLVED", detail);
    }

    public record AttachResult(ConversationThread thread, UUID sessionId, boolean changed) {}
}
