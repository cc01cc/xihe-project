package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.Credential;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import java.util.UUID;

/**
 * DSD-1519 ① (task-142): the single ownership authority for the credential read faces.
 *
 * <p>Before this class the four read faces answered two different questions with two different
 * gates — {@code references} asked for the management atom only, {@code events} asked for owner
 * visibility only, {@code reveal} asked for the reveal atom only and {@code bindings} asked for
 * target-workspace membership only. The same UI page therefore saw one face answer 200 and its
 * neighbour answer 403 for one and the same credential row.</p>
 *
 * <p>The ruling is: every credential face requires <b>both</b> gates, and the stricter one wins.
 * The ownership gate is the one implemented here and it is deliberately <b>not</b> bypassable by
 * {@code cap:instance:admin} — an instance administrator may read INSTANCE-owned rows (that is
 * what the INSTANCE branch is for), but no administrator may read another user's USER-owned row
 * or a workspace row it is not a member of. Retired bypasses are exactly how "one 200, one 403"
 * happens.</p>
 *
 * <p>The atom gate stays where it was (each caller keeps its own action class: {@code
 * credential_manage@credential:<id>} for references/events/bindings, {@code
 * credential_reveal@credential:<id>} for reveal). Callers apply atom-then-ownership or
 * ownership-then-atom as their failure contract requires, but both must pass.</p>
 */
@Service
public class CredentialOwnerGate {

    private final AuthzContext authzContext;
    private final WorkspaceService workspaceService;

    public CredentialOwnerGate(AuthzContext authzContext, WorkspaceService workspaceService) {
        this.authzContext = authzContext;
        this.workspaceService = workspaceService;
    }

    public void requireVisible(UUID actorId, Credential credential) {
        requireVisible(actorId, credential.getOwnerType(), credential.getOwnerId());
    }

    /**
     * Three branches, unchanged in substance from the historical USER/INSTANCE/WORKSPACE rule
     * (D-1009 kept INSTANCE on the capability atom so a custom role carrying the atom works and a
     * role <em>named</em> admin does not).
     */
    public void requireVisible(UUID actorId, String ownerType, String ownerId) {
        if ("USER".equals(ownerType)) {
            if (ownerId == null || !ownerId.equalsIgnoreCase(actorId.toString())) {
                throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                        "Only the caller's own USER credentials are visible here");
            }
            return;
        }
        if (Credential.OWNER_INSTANCE.equals(ownerType)) {
            if (!authzContext.capabilitiesFor(actorId)
                    .holdsCapability(PermissionAtomCatalog.CAP_INSTANCE_ADMIN, null)) {
                throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                        "Instance administration is required for INSTANCE-owned credentials");
            }
            return;
        }
        if (ownerId == null || !workspaceService.isWorkspaceMember(ownerId, actorId.toString())) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN", "Workspace membership is required");
        }
    }
}
