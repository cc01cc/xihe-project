package com.cc01cc.p.xihe.cp.skill;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import java.util.UUID;

/**
 * PLAN-0628 M1: the one place that answers "who is calling and what may they touch".
 *
 * <p>Why this exists as a service rather than inline in the controllers (beyond
 * {@code CpArchitectureTest.controllersDoNotDependOnRepositories}): <b>a controller must never
 * assert a right it has not resolved.</b> The first draft of {@code SkillBindingController.delete}
 * passed a blanket "manages every workspace" flag to save one query, which would have let any
 * authenticated caller delete any workspace-scoped binding. Centralising the resolution means the
 * controllers can only pass answers, never assumptions.</p>
 */
@Service
public class SkillAccessGuard {

    private final WorkspaceService workspaceService;
    private final com.cc01cc.p.xihe.cp.policy.RequesterAuthority requesterAuthority;

    public SkillAccessGuard(WorkspaceService workspaceService,
                            com.cc01cc.p.xihe.cp.policy.RequesterAuthority requesterAuthority) {
        this.workspaceService = workspaceService;
        this.requesterAuthority = requesterAuthority;
    }

    /** The authenticated actor id, or 401 when the request carries none. */
    public String requireActor() {
        String actor = TenantContext.getUserId();
        if (actor == null || actor.isBlank()) {
            throw new CpApiException(HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED",
                    "Authentication required");
        }
        return actor;
    }

    /**
     * PLAN-0651 M3 T3.2 (A24–A29 → N5 {@code MANAGE_SKILL_LIBRARY}): the instance-library manager.
     *
     * <p>This used to be {@code cap:instance:admin} (a capability projection). The atom check is
     * scoped to <b>instance rows only</b> ({@code workspaceId = null}) on purpose: a workspace-scoped
     * N5 row belongs to the workspace-library branch below and must not leak into the instance
     * library. Default sets keep the observable behaviour: SUPER_ADMIN/ADMIN hold N5 at instance
     * scope; WS_OWNER holds it at workspace scope (reached through {@link #canManageWorkspace}).
     * Refusal shape is unchanged: the call sites still answer 403 {@code SKILL_IMPORT_FORBIDDEN} /
     * {@code SKILL_BINDING_FORBIDDEN}.</p>
     */
    public boolean canManageInstanceLibrary() {
        String actor = TenantContext.getUserId();
        if (actor == null || actor.isBlank()) {
            return false;
        }
        try {
            return requesterAuthority.holdsActionAtom(UUID.fromString(actor),
                    com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry.ACTION_MANAGE_SKILL_LIBRARY, null);
        } catch (IllegalArgumentException invalidSubject) {
            return false;
        }
    }

    /** Any membership of the workspace is enough to see its private definitions. */
    public boolean canSeeWorkspace(UUID workspaceId) {
        return workspaceId != null
                && workspaceService.resolveWorkspaceRole(workspaceId.toString(), requireActor()) != null;
    }

    /** The personal layer is visible to its owner only (never to another caller, never 403). */
    public boolean isPersonalOwner(UUID ownerUserId) {
        return ownerUserId != null && ownerUserId.toString().equals(TenantContext.getUserId());
    }

    /**
     * V156: the personal layer's write atom, held at instance scope ({@code workspaceId = null}).
     * Granted by default to every account through the USER role, so this is a shape check rather
     * than a privilege gate — revoking it makes personal writes 403 while personal <b>reads</b>
     * stay open (P-189-3: the two are deliberately separate decisions).
     */
    public boolean canWritePersonalLibrary() {
        String actor = TenantContext.getUserId();
        if (actor == null || actor.isBlank()) {
            return false;
        }
        try {
            return requesterAuthority.holdsActionAtom(UUID.fromString(actor),
                    com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry.ACTION_MANAGE_PERSONAL_SKILLS, null);
        } catch (IllegalArgumentException invalidSubject) {
            return false;
        }
    }

    public boolean canManageWorkspace(UUID workspaceId) {
        return workspaceId != null && com.cc01cc.p.xihe.cp.entity.WorkspaceRole.canManage(
                workspaceService.resolveWorkspaceRole(workspaceId.toString(), requireActor()));
    }

    /**
     * Write rights for one definition scope: instance library ⇒ N5 instance, personal ⇒
     * {@code MANAGE_PERSONAL_SKILLS}, workspace ⇒ instance admin or workspace manager.
     *
     * <p><b>I-9 (task-222): the personal write face's refusal is audited here, at the decision point.</b>
     * There is no "log something" vagueness in it: the line is the canonical
     * {@code [POLICY] event=action_atom_denied atom=MANAGE_PERSONAL_SKILLS subject=<uuid>
     * workspaceId=- source=<none|sources>} WARN emitted by {@link RequesterAuthority#logActionAtomDenied}
     * (PLAN-0651 T1.5 stream). Its four fields are the closed vocabulary — the atom answers "按哪条
     * 原子", {@code subject} answers "谁被拒", {@code source} answers "他到底有没有被授予这条" — and
     * per T1.5 B4 it stays in the log stream and <b>never</b> goes to {@code audit_logs}: a denial is
     * an atom-layer event, and audit rows must not carry a resource string or content fragment.
     * Logging only on the refusal branch keeps the granted path silent.</p>
     */
    public boolean canWriteDefinitionScope(String definitionScopeType, UUID definitionScopeId) {
        if (Skill.DEFINITION_SCOPE_INSTANCE.equals(definitionScopeType)) {
            return canManageInstanceLibrary();
        }
        if (Skill.DEFINITION_SCOPE_USER.equals(definitionScopeType)) {
            if (canWritePersonalLibrary()) {
                return true;
            }
            logPersonalWriteDenied();
            return false;
        }
        return canManageInstanceLibrary() || canManageWorkspace(definitionScopeId);
    }

    /**
     * I-9: one canonical deny line per refused personal write. Deliberately separate from
     * {@link #canWritePersonalLibrary()} (a pure probe): only a write decision that actually refuses
     * may write to the deny stream, otherwise a read-side shape check would pollute the audit
     * signal. A non-uuid actor degrades to {@code subject=-} — the stream vocabulary, not an
     * exception (a 401 happens before this path in practice).
     */
    private void logPersonalWriteDenied() {
        String actor = TenantContext.getUserId();
        UUID subject = null;
        if (actor != null && !actor.isBlank()) {
            try {
                subject = UUID.fromString(actor);
            } catch (IllegalArgumentException notAnUuid) {
                subject = null;
            }
        }
        requesterAuthority.logActionAtomDenied(
                com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry.ACTION_MANAGE_PERSONAL_SKILLS,
                subject, null);
    }
}
