package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.policy.RequesterAuthority;
import com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.util.UUID;

/**
 * BL-345 (user ruling 2026-11-06): the one gate for writing agent memory.
 *
 * <p>Two atoms, with a fixed <b>negative priority</b>:</p>
 * <ol>
 *   <li>{@code MEMORY_WRITE} = "write <b>any</b> subject" (SUPER_ADMIN + workspace administrators).
 *       It is checked <b>first</b> and needs no ownership lookup — a subject that may write anything
 *       does not need the self atom.</li>
 *   <li>{@code MEMORY_WRITE_SELF} = "write a principal the actor <b>owns</b>" (default for
 *       USER/ADMIN/WS_*). The atom answers "may this actor write its own subjects"; the ownership
 *       relation itself comes from persisted principal rows
 *       ({@link AgentPrincipalService#isOwnedBy(UUID, UUID)}), never from a role name.</li>
 * </ol>
 *
 * <p>The workspace visibility gate (the read face's 404) still runs after the atom decision, so a
 * caller without either atom learns nothing about which principals exist.</p>
 *
 * <p>When the self atom is what authorized the call, a durable audit row
 * {@code authorization_atom_hit} records the atom and the grant source(s) that carried it
 * (role/direct/…), which is the "atom → grant provenance" trail.</p>
 */
@Component
public class AgentMemoryWriteAuthorizer {

    private final RequesterAuthority requesterAuthority;
    private final AgentPrincipalService agentPrincipalService;
    private final AuditLogger auditLogger;

    public AgentMemoryWriteAuthorizer(RequesterAuthority requesterAuthority,
                                      AgentPrincipalService agentPrincipalService,
                                      AuditLogger auditLogger) {
        this.requesterAuthority = requesterAuthority;
        this.agentPrincipalService = agentPrincipalService;
        this.auditLogger = auditLogger;
    }

    @Transactional
    public void require(UUID workspace, UUID principal) {
        String actor = TenantContext.getUserId();
        if (actor == null || actor.isBlank()) {
            throw new CpApiException(HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED",
                    "Authentication required");
        }
        UUID subject = requesterAuthority.currentSubjectId();
        boolean any = subject != null && requesterAuthority.holdsActionAtom(subject,
                ToolFaceRegistry.ACTION_MEMORY_WRITE, workspace);
        if (!any) {
            boolean self = subject != null
                    && requesterAuthority.holdsActionAtom(subject,
                            ToolFaceRegistry.ACTION_MEMORY_WRITE_SELF, workspace)
                    && agentPrincipalService.isOwnedBy(principal, subject);
            if (!self) {
                throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                        "MEMORY_WRITE or MEMORY_WRITE_SELF (for a principal you own) is required "
                                + "to write agent memory in this workspace");
            }
            auditSelfHit(workspace, principal, subject);
        }
        boolean visible = agentPrincipalService.listWorkspaceAgents(actor, workspace).stream()
                .anyMatch(view -> view.principalId().equals(principal));
        if (!visible) {
            throw new CpApiException(HttpStatus.NOT_FOUND, "AGENT_PRINCIPAL_NOT_FOUND",
                    "Agent principal not found");
        }
    }

    private void auditSelfHit(UUID workspace, UUID principal, UUID subject) {
        String sources = String.join(",",
                requesterAuthority.atomSources(subject, ToolFaceRegistry.ACTION_MEMORY_WRITE_SELF,
                        workspace));
        auditLogger.recordDurableChange(subject.toString(), workspace.toString(),
                "authorization_atom_hit", "agent_principal", principal.toString(),
                "atom=MEMORY_WRITE_SELF grantSource=" + (sources.isEmpty() ? "unknown" : sources)
                        + " ownedBy=" + subject);
    }
}
