package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.credentials.CredentialService;
import com.cc01cc.p.xihe.cp.entity.Credential;
import com.cc01cc.p.xihe.cp.repository.CredentialRepository;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.UUID;

/**
 * PLAN-0771 M3 (contract {@code 37e7ddd8}, D-932 contract-first): the thin orchestration behind
 * {@code /api/v1/instance/credentials}.
 *
 * <p>The owner model was already settled by task-166: an instance credential is
 * {@code owner_type=INSTANCE} with an empty {@code owner_id} (D-1009), stored under a database
 * pairing constraint (V155). This service therefore adds no owner logic of its own; it only:
 * </p>
 * <ol>
 *   <li>pins the owner to INSTANCE (the HTTP body may not name an owner at all — an instance row has
 *       no owner id to address, so a supplied {@code ownerType}/{@code ownerId} is a 400
 *       {@code INVALID_REQUEST} rather than a silently dropped field);</li>
 *   <li>answers <b>404 {@code CREDENTIAL_NOT_FOUND}</b> for any row that is not INSTANCE-owned,
 *       exactly like a missing row: the instance surface must not become a cross-owner existence
 *       oracle (contract constraint 2, a security rule, not a style choice);</li>
 *   <li>delegates the rest to the existing atom-gated services
 *       ({@link CredentialAdminService} / {@link CredentialRevealService}) so the atom layer stays
 *       the single authority and nothing is re-implemented here.</li>
 * </ol>
 *
 * <p>{@code cap:instance:admin} is enforced on the URL layer
 * ({@code @PreAuthorize("@requesterAuthority.holdsCapabilityAtom('instance:admin')")}); this layer
 * deliberately re-reads nothing about the caller's roles.</p>
 */
@Service
public class InstanceCredentialService {

    private final CredentialAdminService adminService;
    private final CredentialRevealService revealService;
    private final CredentialRepository credentialRepository;

    public InstanceCredentialService(CredentialAdminService adminService,
            CredentialRevealService revealService,
            CredentialRepository credentialRepository) {
        this.adminService = adminService;
        this.revealService = revealService;
        this.credentialRepository = credentialRepository;
    }

    @Transactional(readOnly = true)
    public List<CredentialAdminService.CredentialSummary> list(String actorUserId) {
        // "INSTANCE" + null owner id: the row set the owner model defines (D-1009). Passing a null
        // owner id into the ordinary two-argument lookup would compile to "owner_id = null" and
        // silently return nothing (task-166), which is why CredentialAdminService normalizes first.
        return adminService.list(actorUserId, Credential.OWNER_INSTANCE, null);
    }

    @Transactional
    public Credential create(String actorUserId, CreateInstanceCredentialRequest request) {
        if (present(request.ownerType()) || present(request.ownerId())) {
            // Constraint 3: the instance side takes no owner coordinates at all.
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "an instance credential has no ownerType/ownerId; omit both fields");
        }
        return adminService.create(actorUserId, Credential.OWNER_INSTANCE, null, request.label(),
                request.kind(), request.deliveryTier(), request.toSecret());
    }

    @Transactional(readOnly = true)
    public Credential requireInstanceRow(UUID credentialId) {
        Credential credential = credentialRepository.findByIdAndDeletedAtIsNull(credentialId)
                .orElseThrow(InstanceCredentialService::notFound);
        if (!Credential.OWNER_INSTANCE.equals(credential.getOwnerType())) {
            // Constraint 2: identical answer for "not instance-owned" and "does not exist".
            throw notFound();
        }
        return credential;
    }

    @Transactional
    public CredentialAdminService.DeleteReport delete(String actorUserId, UUID credentialId) {
        // 404 before any atom work: a non-instance row must not reveal whether the atom would have
        // been sufficient (otherwise the 403/404 split becomes the oracle).
        requireInstanceRow(credentialId);
        return adminService.delete(actorUserId, credentialId);
    }

    /**
     * Not transactional on purpose (same reason as the user path): a failed step-up keeps its audit
     * record after the exception. {@link CredentialRevealService#revealInstance} already re-checks
     * the INSTANCE ownership and answers 404 for anything else.
     */
    public CredentialRevealService.RevealedCredential reveal(String actorUserId, UUID credentialId,
            String password) {
        return revealService.revealInstance(actorUserId, credentialId, password);
    }

    private static boolean present(String value) {
        return value != null && !value.isBlank();
    }

    private static CpApiException notFound() {
        return new CpApiException(HttpStatus.NOT_FOUND, "CREDENTIAL_NOT_FOUND", "Credential not found");
    }

    public record CreateInstanceCredentialRequest(String ownerType, String ownerId, String label,
            String kind, String deliveryTier, String token, String accessKey, String secretKey) {

        CredentialService.SecretPayload toSecret() {
            if (token != null && !token.isBlank()) {
                return CredentialService.SecretPayload.ofToken(token);
            }
            return CredentialService.SecretPayload.ofKeyPair(accessKey, secretKey);
        }
    }
}
