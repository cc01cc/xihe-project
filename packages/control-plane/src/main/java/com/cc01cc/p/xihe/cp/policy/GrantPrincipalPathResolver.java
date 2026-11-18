package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.chat.ChatRunStatusReadService;
import com.cc01cc.p.xihe.cp.entity.McpInvocation;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.mcp.McpInvocationService;
import com.cc01cc.p.xihe.cp.service.SessionReadService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

/** Resolves stable principal identities for one tool-call authorization snapshot. */
@Component
public class GrantPrincipalPathResolver {

    public static final String USER = "user";
    public static final String AGENT_PRINCIPAL = "agent_principal";

    private static final Logger logger = LoggerFactory.getLogger(GrantPrincipalPathResolver.class);

    // PLAN-0470 (decision #18): authorization reads go through the Session/Chat/MCP
    // owner read services (bounded views) — no cross-domain repositories here.
    private final SessionReadService sessionReadService;
    private final ChatRunStatusReadService chatRunStatusReadService;
    private final McpInvocationService mcpInvocationService;

    public GrantPrincipalPathResolver(SessionReadService sessionReadService,
                                      ChatRunStatusReadService chatRunStatusReadService,
                                      McpInvocationService mcpInvocationService) {
        this.sessionReadService = sessionReadService;
        this.chatRunStatusReadService = chatRunStatusReadService;
        this.mcpInvocationService = mcpInvocationService;
    }

    /**
     * Resolves the permission path of one Session: <b>its identity</b> (the leaf principal, i.e. the
     * Session's own PRIMARY participant) plus the <b>ordered Session chain</b> whose frozen caps
     * bound that identity.
     *
     * <h2>D-1865 (task-23): the chain is a scope + lineage check, not an identity check</h2>
     * Every node must (a) belong to the same user and Workspace, (b) resolve to a real principal,
     * and (c) have complete, acyclic {@code spawned_from} lineage. It must <b>not</b> be the same
     * principal on every hop: a cross-principal chain is a normal product shape, not malformed data.
     * Human delegation (PLAN-0655 {@code POST /sessions/{id}/delegation-spawn}) stamps the child
     * Session's PRIMARY with the delegated-to principal while the parent keeps its own
     * ({@code ChatSubmissionService.createDelegation}); an Agent may likewise hand work to another
     * Agent, whose sub-conversation inherits the provenance chain but not the identity.
     * Whole-chain equality made every such child fail closed here with
     * {@link IllegalArgumentException}, which {@code ChatSubmissionService.bindOrValidateAgentSession}
     * masks as 403 {@code AGENT_PRINCIPAL_MISSING} - a code that contradicts the fact on disk (the
     * child does have a PRIMARY participant and an active Workspace binding).
     *
     * <h2>Why relaxing equality cannot escalate</h2>
     * The returned identity is still the <b>leaf's own</b> principal, so nothing here lets a caller
     * act as an ancestor. The ceiling is unchanged too: this method returns the whole path exactly
     * so that {@code GrantAuthorizationService.allows} can intersect leaf grants, the leaf's
     * Workspace binding cap and <b>every</b> Session snapshot on the path. Attaching a Session under
     * a foreign ancestor can therefore only ever <em>add</em> a ceiling, never remove one, while the
     * two tenant clauses (user, Workspace) still fail closed - as do a missing node principal, a
     * broken lineage row and a cycle.
     *
     * <p>Every existing producer still writes single-principal chains (spawn copies the parent
     * Run's principal, fork copies the source PRIMARY, create is a root), so for those chains the
     * accepted set is identical before and after: "equals the leaf" and "is present" are the same
     * predicate when the chain carries exactly one principal.</p>
     */
    public AgentPath resolveAgent(String userId, String workspaceId, String sessionId) {
        UUID userUuid = parseUuid(userId);
        UUID workspaceUuid = parseUuid(workspaceId);
        SessionReadService.SessionPathView current = sessionReadService.findById(parseUuid(sessionId))
                .orElseThrow(() -> invalidPath("session-missing", sessionId));
        // Identity is the leaf's own principal; a leaf without a PRIMARY participant has no identity
        // and stays fail closed (that is the genuine AGENT_PRINCIPAL_MISSING case).
        if (!hasResolvedPrincipal(current)) {
            throw invalidPath("leaf-principal-missing", sessionId);
        }
        UUID agentPrincipalId = parseUuid(current.agentPrincipalId());
        List<SessionReadService.SessionPathView> reverseSessionPath = new ArrayList<>();
        Set<UUID> visited = new HashSet<>();

        while (true) {
            UUID currentId = current.id();
            if (!userUuid.equals(parseUuid(current.userId()))
                    || !workspaceUuid.equals(parseUuid(current.workspaceId()))) {
                throw invalidPath("chain-scope-mismatch", sessionId);
            }
            // D-1865: an ancestor must still HAVE a resolved identity (a roster without PRIMARY is
            // malformed), but it must no longer EQUAL the leaf's identity.
            if (!hasResolvedPrincipal(current)) {
                throw invalidPath("chain-node-principal-missing", sessionId, "node=" + currentId);
            }
            if (!visited.add(currentId)) {
                throw invalidPath("chain-cycle", sessionId);
            }
            reverseSessionPath.add(current);

            UUID parentSessionId = current.spawnedFromSessionId();
            UUID parentRunId = current.spawnedFromRunId();
            boolean hasParent = parentSessionId != null || parentRunId != null || current.spawnedAt() != null;
            String kind = current.kind();

            if (kind == null) {
                if (hasParent) {
                    throw invalidPath("root-node-carries-parent-links", sessionId);
                }
                break;
            }
            if (!hasParent || parentSessionId == null || parentRunId == null || current.spawnedAt() == null) {
                throw invalidPath("lineage-incomplete", sessionId);
            }
            if (!Session.KIND_FORK.equals(kind) && !Session.KIND_SPAWN.equals(kind)) {
                throw invalidPath("unknown-kind", sessionId, "kind=" + kind);
            }

            if (Session.KIND_FORK.equals(kind)) {
                // Fork is a new permission root. Validate live lineage when both
                // source rows remain, but source deletion must not invalidate the child.
                SessionReadService.SessionPathView parent = sessionReadService.findById(parentSessionId).orElse(null);
                ChatRunStatusReadService.ChatRunStatusView parentRun = chatRunStatusReadService.findById(parentRunId).orElse(null);
                if ((parent == null) != (parentRun == null)) {
                    throw invalidPath("fork-source-half-present", sessionId);
                }
                if (parent != null && (!parentSessionId.toString().equals(parentRun.sessionId())
                        || !userId.equals(parentRun.userId())
                        || !workspaceId.equals(parentRun.workspaceId())
                        || !userUuid.equals(parseUuid(parent.userId()))
                        || !workspaceUuid.equals(parseUuid(parent.workspaceId()))
                        || !hasResolvedPrincipal(parent))) {
                    throw invalidPath("fork-source-lineage-invalid", sessionId);
                }
                break;
            }

            SessionReadService.SessionPathView parent = sessionReadService.findById(parentSessionId)
                    .orElseThrow(() -> invalidPath("spawn-parent-session-missing", sessionId));
            ChatRunStatusReadService.ChatRunStatusView parentRun = chatRunStatusReadService.findById(parentRunId)
                    .orElseThrow(() -> invalidPath("spawn-parent-run-missing", sessionId));
            if (!parentSessionId.toString().equals(parentRun.sessionId())
                    || !userId.equals(parentRun.userId())
                    || !workspaceId.equals(parentRun.workspaceId())
                    || !userUuid.equals(parseUuid(parent.userId()))
                    || !workspaceUuid.equals(parseUuid(parent.workspaceId()))
                    || !hasResolvedPrincipal(parent)) {
                throw invalidPath("spawn-parent-lineage-invalid", sessionId);
            }
            current = parent;
        }

        Collections.reverse(reverseSessionPath);
        return new AgentPath(agentPrincipalId, List.copyOf(reverseSessionPath));
    }

    /**
     * PLAN-0463 T1.3 → PLAN-0464 T2.2 (sole path): validate one Agent tool call
     * against the MCP execution domain — {@code ChatRun lease + invocation
     * active + scope}. Empty means no invocation row governs this
     * {@code (runId, toolCallId)} yet and the caller fails closed; when an
     * invocation <em>does</em> exist its verdict is final.
     *
     * <p>D-1865: the path clause here is the <b>same</b> {@link #resolveAgent} the submission gate
     * calls, so the tool boundary admits a cross-principal delegated child for exactly the same
     * reason the create gate does. Relaxing only the submission side would leave every tool call
     * inside such a child Session denied here.</p>
     */
    @Transactional(readOnly = true, isolation = Isolation.READ_COMMITTED, propagation = Propagation.REQUIRES_NEW)
    public Optional<Boolean> validateAgentInvocationContext(String userId, String workspaceId,
                                                            String sessionId, String runId,
                                                            String toolCallId, String toolName) {
        UUID runUuid = parseOptionalUuid(runId);
        UUID toolCallUuid = parseOptionalUuid(toolCallId);
        if (runUuid == null || toolCallUuid == null) {
            return Optional.empty();
        }
        McpInvocationService.InvocationContextView invocation = mcpInvocationService
                .findAgentInvocationContext(runUuid.toString(), toolCallUuid.toString())
                .orElse(null);
        if (invocation == null) {
            return Optional.empty();
        }

        UUID userUuid = parseUuid(userId);
        UUID workspaceUuid = parseUuid(workspaceId);
        UUID sessionUuid = parseUuid(sessionId);

        ChatRunStatusReadService.ChatRunStatusView run = chatRunStatusReadService.findById(runUuid)
                .orElseThrow(() -> invalidPath("run-missing", sessionId));
        if (!ChatRunStatusReadService.isActiveLeaseStatus(run.status())
                || !sessionUuid.equals(parseUuid(run.sessionId()))
                || !userUuid.equals(parseUuid(run.userId()))
                || !workspaceUuid.equals(parseUuid(run.workspaceId()))) {
            throw invalidPath("run-lease-or-scope-invalid", sessionId);
        }
        if (!McpInvocation.STATUS_ACTIVE.equals(invocation.status())
                || !sessionUuid.equals(parseUuid(invocation.sessionId()))
                || !userUuid.equals(parseUuid(invocation.userId()))
                || !workspaceUuid.equals(parseUuid(invocation.workspaceId()))
                || !runUuid.equals(parseUuid(invocation.runId()))
                || (toolName != null && !toolName.equals(invocation.toolName()))) {
            throw invalidPath("invocation-scope-invalid", sessionId);
        }

        resolveAgent(userId, workspaceId, sessionId);
        return Optional.of(Boolean.TRUE);
    }

    /**
     * D-1865: a chain node's identity must resolve, but it is no longer compared with any other
     * node's. {@code null} (a roster without PRIMARY) or an unparsable value is malformed, so false.
     */
    private static boolean hasResolvedPrincipal(SessionReadService.SessionPathView node) {
        try {
            return node.agentPrincipalId() != null && UUID.fromString(node.agentPrincipalId()) != null;
        } catch (RuntimeException e) {
            return false;
        }
    }

    private static UUID parseUuid(String value) {
        try {
            return UUID.fromString(value);
        } catch (RuntimeException e) {
            throw invalidPath("uuid-unparsable");
        }
    }

    /** Absent/unparsable correlation key ⇒ {@code null} (no invocation context). */
    private static UUID parseOptionalUuid(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        try {
            return UUID.fromString(value.trim());
        } catch (RuntimeException e) {
            return null;
        }
    }

    /**
     * D-1865: this class used to fail closed with a bare {@link IllegalArgumentException} and no log
     * at all, so every caller that masks it - the submission 403 {@code AGENT_PRINCIPAL_MISSING},
     * the tool-boundary deny - hid which clause actually broke. That silence is why the
     * cross-principal defect could not be localised from the outside. Every fail-closed decision now
     * names its clause here, the single point they all pass through. The exception message stays
     * byte-identical: callers key their own WARN on it.
     */
    private static IllegalArgumentException invalidPath(String reason) {
        return invalidPath(reason, null, null);
    }

    private static IllegalArgumentException invalidPath(String reason, String sessionId) {
        return invalidPath(reason, sessionId, null);
    }

    private static IllegalArgumentException invalidPath(String reason, String sessionId, String detail) {
        logger.warn("[POLICY] event=principal_path_invalid reason={} sessionId={}{}",
                reason, sessionId, detail == null ? "" : " " + detail);
        return new IllegalArgumentException("Session principal path is invalid");
    }

    public record AgentPath(UUID principalId, List<SessionReadService.SessionPathView> sessionPath) {}
}
