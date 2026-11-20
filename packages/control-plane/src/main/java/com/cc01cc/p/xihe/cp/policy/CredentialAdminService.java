package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.auth.AuthService;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.credentials.CredentialService;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.Credential;
import com.cc01cc.p.xihe.cp.entity.ProviderConnection;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.CredentialEventRepository;
import com.cc01cc.p.xihe.cp.repository.CredentialRepository;
import com.cc01cc.p.xihe.cp.repository.ProviderConnectionRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.fasterxml.jackson.databind.JsonNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.domain.PageRequest;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * PLAN-0496 M3 (T3.1; contract: 0496 §方案 6): the management-API orchestration layer —
 * list/replace/delete/references/precheck over the credential domain plus the
 * credential_manage authorization gates. Registering a new credential requires the
 * wide {@code credential_manage@credential:*} ceiling; replacing/deleting a concrete
 * credential requires {@code credential_manage@credential:<id>}. Reads are not uniform and
 * must not be made uniform by accident: the list face answers ownership visibility only, while
 * the two per-credential read faces (references, events) require the atom gate <b>and</b> the
 * ownership gate (DSD-1519 ①, task-142) — see {@link CredentialOwnerGate}.
 * Responses never carry ciphertext or suffixes.
 */
@Service
public class CredentialAdminService {

    private static final Logger log = LoggerFactory.getLogger(CredentialAdminService.class);

    /** PLAN-0497 T3.2 read face bound (wave review): newest-first, max 500 per request. */
    static final int MAX_EVENT_LIMIT = 500;

    private final CredentialService credentialService;
    private final GrantIntersectionEvaluator evaluator;
    private final AuthorizationGrantRepository grantRepository;
    private final WorkspaceAgentRepository workspaceAgentRepository;
    private final AuthService authService;
    private final CredentialRepository credentialRepository;
    private final CredentialEventRepository credentialEventRepository;
    private final ProviderConnectionRepository providerConnectionRepository;

    /** DSD-1519 ① (task-142): owner visibility shared by every credential read face. */
    private final CredentialOwnerGate ownerGate;

    public CredentialAdminService(CredentialService credentialService,
            GrantIntersectionEvaluator evaluator,
            AuthorizationGrantRepository grantRepository,
            WorkspaceAgentRepository workspaceAgentRepository,
            AuthService authService,
            CredentialRepository credentialRepository,
            CredentialEventRepository credentialEventRepository,
            ProviderConnectionRepository providerConnectionRepository,
            CredentialOwnerGate ownerGate) {
        this.credentialService = credentialService;
        this.evaluator = evaluator;
        this.grantRepository = grantRepository;
        this.workspaceAgentRepository = workspaceAgentRepository;
        this.authService = authService;
        this.credentialRepository = credentialRepository;
        this.credentialEventRepository = credentialEventRepository;
        this.providerConnectionRepository = providerConnectionRepository;
        this.ownerGate = ownerGate;
    }

    public record CredentialSummary(String id, String label, String kind, String deliveryTier,
            String ownerType, String ownerId, String status, String fingerprint, int revision,
            int referenceCount, String createdAt, String replacedAt) {}

    public record ReferenceEntry(String source, String subjectType, String subjectId, String actionClass,
            String resource) {}

    public record DeleteReport(String id, List<ReferenceEntry> references) {}

    public record CredentialEventView(String id, String eventType, String actor, String createdAt) {}

    @Transactional(readOnly = true)
    public List<CredentialSummary> list(String actorUserId, String ownerType, String ownerId) {
        UUID actorId = requireUser(actorUserId);
        String normalizedType = normalizeOwnerType(ownerType);
        String normalizedOwner = normalizeOwnerId(normalizedType, ownerId, actorId);
        requireOwnerVisible(actorId, normalizedType, normalizedOwner);
        Map<String, Integer> counts = referenceCounts();
        return credentialService.listForOwner(normalizedType, normalizedOwner).stream()
                .map(credential -> new CredentialSummary(credential.getId().toString(), credential.getLabel(),
                        credential.getKind(), credential.getDeliveryTier(), credential.getOwnerType(),
                        credential.getOwnerId(), credential.getStatus(), credential.getFingerprint(),
                        credential.getRevision(),
                        counts.getOrDefault("credential:" + credential.getId(), 0),
                        credential.getCreatedAt() == null ? null : credential.getCreatedAt().toString(),
                        credential.getReplacedAt() == null ? null : credential.getReplacedAt().toString()))
                .toList();
    }

    @Transactional
    public Credential create(String actorUserId, String ownerType, String ownerId, String label,
            String kind, String deliveryTier, CredentialService.SecretPayload secret) {
        UUID actorId = requireUser(actorUserId);
        requireManageWildcard(actorId);
        String normalizedType = normalizeOwnerType(ownerType);
        String normalizedOwner = normalizeOwnerId(normalizedType, ownerId, actorId);
        if ("USER".equals(normalizedType) && !normalizedOwner.equalsIgnoreCase(actorId.toString())) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                    "Credentials may only be created for the caller's own USER owner");
        }
        requireOwnerVisible(actorId, normalizedType, normalizedOwner);
        return credentialService.create(new CredentialService.CreateRequest(
                normalizedType, normalizedOwner, label, kind, deliveryTier, secret), actorId.toString());
    }

    @Transactional
    public Credential replace(String actorUserId, UUID credentialId, CredentialService.SecretPayload secret) {
        UUID actorId = requireUser(actorUserId);
        requireManageConcrete(actorId, credentialId);
        ownerGate.requireVisible(actorId, requireCredentialRow(credentialId));
        return credentialService.replaceSecret(credentialId, secret, actorId.toString());
    }

    @Transactional
    public DeleteReport delete(String actorUserId, UUID credentialId) {
        UUID actorId = requireUser(actorUserId);
        requireManageConcrete(actorId, credentialId);
        ownerGate.requireVisible(actorId, requireCredentialRow(credentialId));
        List<ReferenceEntry> references = references(credentialId);
        if (references.stream().anyMatch(reference ->
                "provider_connection".equals(reference.source()))) {
            throw new CpApiException(HttpStatus.CONFLICT, "CREDENTIAL_IN_USE",
                    "Credential is referenced by a provider connection and cannot be deleted");
        }
        Credential deleted = credentialService.delete(credentialId, actorId.toString());
        return new DeleteReport(deleted.getId().toString(), references);
    }

    /**
     * Management-API references view (DSD-1519 ①, task-142): both gates. The ownership gate answers
     * first, so a caller that may not even see the row learns nothing about who holds atoms on it;
     * the management atom is then required on top.
     */
    @Transactional(readOnly = true)
    public List<ReferenceEntry> referencesForActor(String actorUserId, UUID credentialId) {
        UUID actorId = requireUser(actorUserId);
        requireManageAndOwnerVisible(actorId, requireCredentialRow(credentialId));
        return references(credentialId);
    }

    /**
     * PLAN-0497 T3.2 (0497 design §方案 6, decision #9): the credentials audit
     * trail read surface consumed by 0498 — owner-visible events, newest first,
     * never a value or suffix.
     */
    @Transactional(readOnly = true)
    public List<CredentialEventView> eventsForActor(String actorUserId, UUID credentialId, int limit) {
        UUID actorId = requireUser(actorUserId);
        Credential credential = requireCredentialRow(credentialId);
        requireManageAndOwnerVisible(actorId, credential);
        // Wave review: bound the read face 0498 consumes — newest events, 1..MAX_EVENT_LIMIT.
        int bounded = Math.max(1, Math.min(limit, MAX_EVENT_LIMIT));
        return credentialEventRepository
                .findByCredentialIdOrderByCreatedAtDesc(credentialId.toString(),
                        PageRequest.of(0, bounded)).stream()
                .map(event -> new CredentialEventView(event.getId().toString(), event.getEventType(),
                        event.getActor(),
                        event.getCreatedAt() == null ? null : event.getCreatedAt().toString()))
                .toList();
    }

    @Transactional(readOnly = true)
    public List<ReferenceEntry> references(UUID credentialId) {
        String target = "credential:" + credentialId;
        List<ReferenceEntry> entries = new ArrayList<>();
        for (AuthorizationGrant grant : grantRepository.findAll()) {
            for (GrantIntersectionEvaluator.PermissionAtom atom : parseOrSkip(grant.getPermissions())) {
                if (ToolFaceRegistry.isCredentialActionClass(atom.actionClass())
                        && target.equals(atom.resource())) {
                    entries.add(new ReferenceEntry("grant", grant.getSubjectType(),
                            grant.getSubjectId().toString(), atom.actionClass(), atom.resource()));
                }
            }
        }
        for (WorkspaceAgent binding : workspaceAgentRepository.findAll()) {
            for (GrantIntersectionEvaluator.PermissionAtom atom
                    : parseOrSkip(binding.getPermissionsSnapshot())) {
                if (ToolFaceRegistry.isCredentialActionClass(atom.actionClass())
                        && target.equals(atom.resource())) {
                    entries.add(new ReferenceEntry("workspace_cap", "workspace_agent",
                            binding.getId().getPrincipalId() + "@" + binding.getId().getWorkspaceId(),
                            atom.actionClass(), atom.resource()));
                }
            }
        }
        for (ProviderConnection connection : providerConnectionRepository.findByCredentialId(credentialId)) {
            entries.add(new ReferenceEntry("provider_connection", "provider_connection",
                    connection.getId().toString(), ToolFaceRegistry.ACTION_CREDENTIAL_USE, target));
        }
        return entries;
    }

    /** Read-only pre-check for the role editor (0498): candidate atoms not covered by the caller. */
    @Transactional(readOnly = true)
    public List<String> precheck(String actorUserId, JsonNode permissions) {
        UUID actorId = requireUser(actorUserId);
        Set<GrantIntersectionEvaluator.PermissionAtom> requested = evaluator.parse(permissions);
        Set<GrantIntersectionEvaluator.PermissionAtom> actorPermissions = evaluator.union(
                grantRepository.findBySubjectTypeAndSubjectId(GrantPrincipalPathResolver.USER, actorId));
        List<String> uncovered = new ArrayList<>();
        for (GrantIntersectionEvaluator.PermissionAtom permission : requested) {
            boolean covered;
            if (ToolFaceRegistry.isCredentialActionClass(permission.actionClass())) {
                covered = coveredBy(permission, actorPermissions);
            } else {
                covered = evaluator.allows(new PolicyRequest("credential_precheck",
                        List.of(permission.actionClass()), List.of(permission.resource()),
                        ToolShape.STRUCTURED, actorId.toString(), null, null),
                        List.of(actorPermissions));
            }
            if (!covered) {
                uncovered.add(permission.actionClass() + "@" + permission.resource());
            }
        }
        return uncovered;
    }

    private Map<String, Integer> referenceCounts() {
        Map<String, Integer> counts = new HashMap<>();
        for (AuthorizationGrant grant : grantRepository.findAll()) {
            for (GrantIntersectionEvaluator.PermissionAtom atom : parseOrSkip(grant.getPermissions())) {
                if (ToolFaceRegistry.isCredentialActionClass(atom.actionClass())
                        && ToolFaceRegistry.isConcreteCredentialResource(atom.resource())) {
                    counts.merge(atom.resource(), 1, Integer::sum);
                }
            }
        }
        for (WorkspaceAgent binding : workspaceAgentRepository.findAll()) {
            for (GrantIntersectionEvaluator.PermissionAtom atom
                    : parseOrSkip(binding.getPermissionsSnapshot())) {
                if (ToolFaceRegistry.isCredentialActionClass(atom.actionClass())
                        && ToolFaceRegistry.isConcreteCredentialResource(atom.resource())) {
                    counts.merge(atom.resource(), 1, Integer::sum);
                }
            }
        }
        return counts;
    }

    /** Defensive parse: a malformed historical row must not break the reference report. */
    private Set<GrantIntersectionEvaluator.PermissionAtom> parseOrSkip(JsonNode permissions) {
        try {
            return evaluator.parse(permissions);
        } catch (IllegalArgumentException e) {
            log.warn("Skipping unparsable permission row in credential reference scan: errorType={}",
                    e.getClass().getSimpleName());
            return Set.of();
        }
    }

    private void requireManageWildcard(UUID actorId) {
        Set<GrantIntersectionEvaluator.PermissionAtom> actorPermissions = evaluator.union(
                grantRepository.findBySubjectTypeAndSubjectId(GrantPrincipalPathResolver.USER, actorId));
        GrantIntersectionEvaluator.PermissionAtom required = new GrantIntersectionEvaluator.PermissionAtom(
                ToolFaceRegistry.ACTION_CREDENTIAL_MANAGE, ToolFaceRegistry.CREDENTIAL_RESOURCE_WILDCARD);
        if (!coveredBy(required, actorPermissions)) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                    "credential_manage@credential:* is required to register credentials");
        }
    }

    private void requireManageConcrete(UUID actorId, UUID credentialId) {
        String resource = "credential:" + credentialId;
        PolicyRequest request = new PolicyRequest("credential_admin",
                List.of(ToolFaceRegistry.ACTION_CREDENTIAL_MANAGE), List.of(resource),
                ToolShape.OPAQUE, actorId.toString(), null, null);
        if (!evaluator.allows(request, List.of(evaluator.union(
                grantRepository.findBySubjectTypeAndSubjectId(GrantPrincipalPathResolver.USER, actorId))))) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                    "credential_manage@" + resource + " is required");
        }
    }

    /** DSD-1519 ①: the ownership gate lives in one place, {@link CredentialOwnerGate}. */
    private void requireOwnerVisible(UUID actorId, String ownerType, String ownerId) {
        ownerGate.requireVisible(actorId, ownerType, ownerId);
    }

    /** DSD-1519 ①: both gates, ownership first — shared by the two per-credential read faces. */
    private void requireManageAndOwnerVisible(UUID actorId, Credential credential) {
        ownerGate.requireVisible(actorId, credential);
        requireManageConcrete(actorId, credential.getId());
    }

    private Credential requireCredentialRow(UUID credentialId) {
        return credentialRepository.findByIdAndDeletedAtIsNull(credentialId)
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "CREDENTIAL_NOT_FOUND",
                        "Credential not found"));
    }

    private static boolean coveredBy(GrantIntersectionEvaluator.PermissionAtom candidate,
            Set<GrantIntersectionEvaluator.PermissionAtom> ceiling) {
        return ceiling.stream().anyMatch(atom -> atom.actionClass().equals(candidate.actionClass())
                && ToolFaceRegistry.resourceCovers(candidate.actionClass(), atom.resource(),
                        candidate.resource()));
    }

    private UUID requireUser(String actorUserId) {
        if (actorUserId == null || actorUserId.isBlank()) {
            throw new CpApiException(HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED", "Authentication required");
        }
        UUID actorId;
        try {
            actorId = UUID.fromString(actorUserId);
        } catch (IllegalArgumentException e) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_ACTOR", "A valid UUID is required", e);
        }
        if (!authService.userExists(actorId)) {
            throw new CpApiException(HttpStatus.NOT_FOUND, "USER_NOT_FOUND", "User not found");
        }
        return actorId;
    }

    private static String normalizeOwnerType(String ownerType) {
        String normalized = ownerType == null || ownerType.isBlank()
                ? "USER"
                : ownerType.trim().toUpperCase(Locale.ROOT);
        if (!"USER".equals(normalized) && !"WORKSPACE".equals(normalized)
                && !Credential.OWNER_INSTANCE.equals(normalized)) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_OWNER_TYPE",
                    "ownerType must be USER, WORKSPACE or INSTANCE");
        }
        return normalized;
    }

    /**
     * D-1009 (task-166): INSTANCE has no owner id — the stored row carries NULL. A supplied id is
     * rejected rather than ignored: silently dropping it would let a caller believe the row is
     * scoped to a subject it does not have.
     */
    private static String normalizeOwnerId(String ownerType, String ownerId, UUID actorId) {
        if (Credential.OWNER_INSTANCE.equals(ownerType)) {
            if (ownerId != null && !ownerId.isBlank()) {
                throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_OWNER_ID",
                        "INSTANCE-owned credentials have no ownerId");
            }
            return null;
        }
        if (ownerId == null || ownerId.isBlank()) {
            return actorId.toString();
        }
        try {
            return UUID.fromString(ownerId.trim()).toString();
        } catch (IllegalArgumentException e) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_OWNER_ID",
                    "ownerId must be a valid UUID", e);
        }
    }
}
