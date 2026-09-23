package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.event.WorkspaceEventManager;
import com.cc01cc.p.xihe.cp.operation.JobStateService;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.web.client.RestTemplate;

import java.time.Instant;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.Optional;

@Service
public class WorkspaceService {

    private static final Logger logger = LoggerFactory.getLogger(WorkspaceService.class);

    /** Allowed sandbox security profiles for initial ExecutionSpec (PLAN-262 decision 10/13). */
    private static final java.util.Set<String> ALLOWED_PROFILES =
            java.util.Set.of("strict", "coding", "isolated");

    /** Allowed sandbox images (PLAN-262 decision 13: allowlist only). */
    private static final java.util.Set<String> ALLOWED_IMAGES =
            java.util.Set.of("xihe/workspace:latest");

    private static final String DEFAULT_IMAGE = "xihe/workspace:latest";
    private static final String DEFAULT_STORAGE_MODE = "managed_import";
    private static final String DEFAULT_EXECUTION_MODE = "docker";

    private final WorkspaceRepository workspaceRepository;
    private final WorkspaceUserRepository workspaceUserRepository;
    private final UserRepository userRepository;
    private final WorkspaceExecutionSpecService executionSpecService;
    private final RestTemplate restTemplate;
    private final String runtimeUrl;
    private final String serviceToken;
    private final JobStateService jobStateService;
    private final com.fasterxml.jackson.databind.ObjectMapper objectMapper;
    private final WorkspaceEventManager workspaceEventManager;
    private final AuditLogger auditLogger;

    public WorkspaceService(WorkspaceRepository workspaceRepository,
                            WorkspaceUserRepository workspaceUserRepository,
                            UserRepository userRepository,
                            WorkspaceExecutionSpecService executionSpecService,
                            @Qualifier("runtimeCleanupRestTemplate") RestTemplate restTemplate,
                            @Value("${cp.mcp.runtime-url:http://localhost:12633}") String runtimeUrl,
                            @Value("${cp.agent-api-token:dev-token-not-secure}") String serviceToken,
                            JobStateService jobStateService,
                            com.fasterxml.jackson.databind.ObjectMapper objectMapper,
                            WorkspaceEventManager workspaceEventManager,
                            AuditLogger auditLogger) {
        this.workspaceRepository = workspaceRepository;
        this.workspaceUserRepository = workspaceUserRepository;
        this.userRepository = userRepository;
        this.executionSpecService = executionSpecService;
        this.restTemplate = restTemplate;
        this.runtimeUrl = runtimeUrl;
        this.serviceToken = serviceToken;
        this.jobStateService = jobStateService;
        this.objectMapper = objectMapper;
        this.workspaceEventManager = workspaceEventManager;
        this.auditLogger = auditLogger;
    }

    /**
     * Returns the user's first active membership, creating the default resource only when none exists.
     * The user row lock serializes concurrent login/register responses for the same account.
     */
    @Transactional
    public Workspace getOrCreateDefaultWorkspace(String userId) {
        User user = userRepository.findByIdForUpdate(UUID.fromString(userId))
                .orElseThrow(() -> new CpApiException(
                        org.springframework.http.HttpStatus.NOT_FOUND, "USER_NOT_FOUND", "User not found"));
        List<Workspace> existing = workspaceRepository.findActiveByMemberUserId(user.getId());
        if (!existing.isEmpty()) {
            return existing.get(0);
        }
        return createWorkspaceLocked("Default Workspace", null, user.getId().toString());
    }

    /** Creates an active workspace for a user; users may own multiple active workspaces. */
    @Transactional
    public Workspace createWorkspace(String name, String ownerId) {
        return createWorkspace(name, null, ownerId, "coding", null);
    }

    @Transactional
    public Workspace createWorkspace(String name, String description, String ownerId) {
        return createWorkspace(name, description, ownerId, "coding", null);
    }

    @Transactional
    public Workspace createWorkspace(String name, String description, String ownerId,
            String profile, String image) {
        requireNonBlank(ownerId, "ownerId");
        return createWorkspaceLocked(name, description, ownerId,
                normalizeProfile(profile), normalizeImage(image),
                DEFAULT_STORAGE_MODE, null, DEFAULT_EXECUTION_MODE, null, null);
    }

    /**
     * Creates a workspace with an explicit storage/execution selection. The
     * Runtime probe is deliberately completed before the row is persisted for
     * direct-attach, so an unavailable backend cannot create a misleading
     * ready-looking workspace.
     */
    @Transactional
    public Workspace createWorkspace(String name, String description, String ownerId,
            String profile, String image, String storageMode, String hostPath,
            String executionMode, String idempotencyKey) {
        requireNonBlank(ownerId, "ownerId");
        String normalizedStorageMode = normalizeStorageMode(storageMode);
        String normalizedExecutionMode = normalizeExecutionMode(executionMode, normalizedStorageMode);
        String normalizedHostPath = normalizeHostPath(hostPath, normalizedStorageMode);
        String normalizedProfile = normalizeProfileForExecution(profile, normalizedExecutionMode);
        String normalizedImage = normalizeImageForExecution(image, normalizedExecutionMode);
        String normalizedIdempotencyKey = normalizeIdempotencyKey(idempotencyKey);
        String requestHash = requestHash(name, description, normalizedProfile, normalizedImage,
                normalizedStorageMode, normalizedHostPath, normalizedExecutionMode);

        if (normalizedIdempotencyKey != null) {
            Optional<Workspace> existing = workspaceRepository
                    .findByOwnerIdAndCreateIdempotencyKeyAndDeletedAtIsNull(ownerId, normalizedIdempotencyKey);
            if (existing.isPresent()) {
                if (!requestHash.equals(existing.get().getCreateRequestHash())) {
                    throw new CpApiException(
                            org.springframework.http.HttpStatus.CONFLICT,
                            "IDEMPOTENCY_KEY_REUSE",
                            "Idempotency-Key was already used with a different workspace request");
                }
                return existing.get();
            }
        }

        if ("direct_attach".equals(normalizedStorageMode)) {
            probeDirectAttach(normalizedStorageMode, normalizedHostPath, normalizedExecutionMode);
        }

        return createWorkspaceLocked(name, description, ownerId, normalizedProfile, normalizedImage,
                normalizedStorageMode, normalizedHostPath, normalizedExecutionMode,
                normalizedIdempotencyKey, requestHash);
    }

    @Transactional(readOnly = true)
    public Optional<Workspace> findCurrentWorkspace(String userId) {
        if (userId == null || userId.isBlank()) {
            return Optional.empty();
        }
        return workspaceRepository.findActiveByMemberUserId(UUID.fromString(userId)).stream().findFirst();
    }

    @Transactional(readOnly = true)
    public Workspace getWorkspace(String id) {
        return requireActiveWorkspace(id);
    }

    @Transactional(readOnly = true)
    public List<Workspace> getWorkspacesByUser(String userId) {
        return workspaceRepository.findActiveByMemberUserId(UUID.fromString(userId));
    }

    @Transactional(readOnly = true)
    public Workspace requireActiveWorkspace(String workspaceId) {
        return workspaceRepository.findByIdAndDeletedAtIsNull(UUID.fromString(workspaceId))
                .orElseThrow(() -> new CpApiException(
                        org.springframework.http.HttpStatus.NOT_FOUND,
                        "WORKSPACE_NOT_FOUND",
                        "Workspace not found"));
    }

    @Transactional(readOnly = true)
    public Workspace requireAccessibleWorkspace(String workspaceId, String userId) {
        Workspace workspace = requireActiveWorkspace(workspaceId);
        if (userId == null || workspaceUserRepository
                .findByIdWorkspaceIdAndIdUserId(UUID.fromString(workspaceId), UUID.fromString(userId)).isEmpty()) {
            throw new CpApiException(
                    org.springframework.http.HttpStatus.NOT_FOUND,
                    "WORKSPACE_NOT_FOUND",
                    "Workspace not found");
        }
        return workspace;
    }

    @Transactional(readOnly = true)
    public boolean isWorkspaceMember(String workspaceId, String userId) {
        return workspaceRepository.findByIdAndDeletedAtIsNull(UUID.fromString(workspaceId)).isPresent()
                && userId != null
                && workspaceUserRepository.findByIdWorkspaceIdAndIdUserId(UUID.fromString(workspaceId), UUID.fromString(userId)).isPresent();
    }

    @Transactional(readOnly = true)
    public String resolveWorkspaceRole(String workspaceId, String userId) {
        if (!isWorkspaceMember(workspaceId, userId)) {
            return null;
        }
        return workspaceUserRepository.findByIdWorkspaceIdAndIdUserId(UUID.fromString(workspaceId), UUID.fromString(userId))
                .map(WorkspaceUser::getRole)
                .map(Enum::name)
                .orElse(null);
    }

    @Transactional
    public Workspace updateWorkspace(String workspaceId, String ownerId, String name, String description) {
        Workspace workspace = workspaceRepository.findByIdForUpdate(UUID.fromString(workspaceId))
                .orElseThrow(() -> new CpApiException(
                        org.springframework.http.HttpStatus.NOT_FOUND,
                        "WORKSPACE_NOT_FOUND",
                        "Workspace not found"));
        ensureOwner(workspace, ownerId);
        if (name != null) {
            requireNonBlank(name, "name");
            workspace.setName(name.trim());
        }
        if (description != null) {
            workspace.setDescription(description);
        }
        return workspaceRepository.save(workspace);
    }

    @Transactional
    public Workspace changeExecutionMode(String workspaceId, String actorId, boolean admin,
            String executionMode) {
        Workspace workspace = workspaceRepository.findByIdForUpdate(UUID.fromString(workspaceId))
                .orElseThrow(() -> new CpApiException(
                        org.springframework.http.HttpStatus.NOT_FOUND,
                        "WORKSPACE_NOT_FOUND",
                        "Workspace not found"));
        if (!admin && (actorId == null || !actorId.equals(workspace.getOwnerId()))) {
            throw new CpApiException(
                    org.springframework.http.HttpStatus.NOT_FOUND,
                    "WORKSPACE_NOT_FOUND",
                    "Workspace not found");
        }
        String normalizedMode = normalizeExecutionMode(executionMode, workspace.getStorageMode());
        if (normalizedMode.equals(workspace.getExecutionMode())) {
            return workspace;
        }
        if (jobStateService.hasRunningForWorkspace(workspaceId)) {
            throw new CpApiException(
                    org.springframework.http.HttpStatus.CONFLICT,
                    "WORKSPACE_BUSY",
                    "Stop active jobs before changing execution mode");
        }
        if ("direct_attach".equals(workspace.getStorageMode())) {
            probeDirectAttach("direct_attach", workspace.getHostPath(), normalizedMode);
        }
        String previousMode = workspace.getExecutionMode();
        workspace.setExecutionMode(normalizedMode);
        String sandboxSpec = workspace.getSandboxSpec();
        if (sandboxSpec == null || sandboxSpec.isBlank()) {
            sandboxSpec = "{\"image\":\"" + DEFAULT_IMAGE + "\",\"profile\":\"coding\"}";
        }
        workspaceRepository.save(workspace);
        executionSpecService.createExecutionSpec(workspaceId, sandboxSpec,
                actorId == null ? "admin" : actorId, "execution-mode-change");
        auditLogger.recordDurableChange(actorId, workspaceId, "workspace_execution_mode_changed",
                "workspace", workspaceId,
                "actorType=" + (admin ? "admin" : "user") + " from=" + previousMode + " to=" + normalizedMode);
        return workspace;
    }

    @Transactional
    public Workspace deleteWorkspace(String workspaceId, String ownerId) {
        Workspace workspace = workspaceRepository.findByIdForUpdate(UUID.fromString(workspaceId))
                .orElseThrow(() -> new CpApiException(
                        org.springframework.http.HttpStatus.NOT_FOUND,
                        "WORKSPACE_NOT_FOUND",
                        "Workspace not found"));
        ensureOwner(workspace, ownerId);
        workspace.setDeletedAt(Instant.now());
        workspaceRepository.save(workspace);

        // Runtime owns the ephemeral Sandbox. WorkspaceStorage remains untouched.
        // STO-1: the Runtime notification must not run inside the delete
        // transaction (it would hold the workspace row lock across a remote call),
        // and a Runtime outage must not roll back an already-written logical
        // delete. Register it for after-commit and treat it as best-effort: the DB
        // delete is authoritative, and the Runtime reconciles orphan containers at
        // startup (cleanup_orphans).
        String storageRef = workspace.getStorageRef();
        Runnable cleanup = () -> {
            // PLAN-0344 T1.3：Runtime 在 destroying 窗口内枚举存活 job；
            // 枚举失败（null）→ CP 把该 workspace 全部 running 档案落 orphaned
            // （fail-closed），不留悬空 running。
            Set<String> aliveJobIds = notifyRuntimeDeleteBestEffort(workspaceId, storageRef);
            try {
                jobStateService.markOrphanedForWorkspace(workspaceId, aliveJobIds);
            } catch (RuntimeException e) {
                logger.error(
                        "JOB_ORPHAN_MARK_FAILED workspaceId={} reason={} (running archives stay for reconciliation)",
                        workspaceId, e.getMessage(), e);
            }
        };
        if (TransactionSynchronizationManager.isSynchronizationActive()) {
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override
                public void afterCommit() {
                    try {
                        cleanup.run();
                    } finally {
                        workspaceEventManager.completeWorkspace(workspaceId, "workspace_deleted");
                    }
                }
            });
        } else {
            try {
                cleanup.run();
            } finally {
                workspaceEventManager.completeWorkspace(workspaceId, "workspace_deleted");
            }
        }

        logger.info("Workspace logically deleted: id={} name={}", workspaceId, workspace.getName());
        return workspace;
    }

    private Workspace createWorkspaceLocked(String name, String description, String ownerId) {
        return createWorkspaceLocked(name, description, ownerId, "coding", DEFAULT_IMAGE,
                DEFAULT_STORAGE_MODE, null, DEFAULT_EXECUTION_MODE, null, null);
    }

    private Workspace createWorkspaceLocked(String name, String description, String ownerId,
            String profile, String image) {
        return createWorkspaceLocked(name, description, ownerId, profile, image,
                DEFAULT_STORAGE_MODE, null, DEFAULT_EXECUTION_MODE, null, null);
    }

    private Workspace createWorkspaceLocked(String name, String description, String ownerId,
            String profile, String image, String storageMode, String hostPath,
            String executionMode, String idempotencyKey, String requestHash) {
        requireNonBlank(name, "name");
        Workspace workspace = new Workspace(name.trim(), ownerId);
        workspace.setDescription(description);
        workspace.setStorageBackend("host_directory");
        workspace.setStorageMode(storageMode);
        workspace.setHostPath(hostPath);
        workspace.setExecutionMode(executionMode);
        workspace.setCreateIdempotencyKey(idempotencyKey);
        workspace.setCreateRequestHash(requestHash);
        workspace = workspaceRepository.save(workspace);
        workspace.setStorageRef(workspace.getId().toString());
        workspace = workspaceRepository.save(workspace);
        workspaceUserRepository.save(new WorkspaceUser(workspace.getId().toString(), ownerId, WorkspaceRole.OWNER));

        String initialSpec = "docker".equals(executionMode)
                ? "{\"image\":\"" + image + "\",\"profile\":\"" + profile + "\"}"
                : "{}";
        executionSpecService.createExecutionSpec(workspace.getId().toString(), initialSpec, ownerId, "create");
        logger.info("Workspace created: id={} name={} storageRef={} storageMode={} executionMode={} profile={} image={}",
                workspace.getId(), workspace.getName(), workspace.getStorageRef(),
                storageMode, executionMode, profile, image);
        return workspace;
    }

    private String normalizeStorageMode(String storageMode) {
        String normalized = storageMode == null || storageMode.isBlank()
                ? DEFAULT_STORAGE_MODE : storageMode.trim().toLowerCase(java.util.Locale.ROOT);
        if (!Set.of("managed_import", "direct_attach").contains(normalized)) {
            throw new CpApiException(
                    org.springframework.http.HttpStatus.BAD_REQUEST,
                    "INVALID_STORAGE_MODE",
                    "storageMode must be managed_import or direct_attach");
        }
        return normalized;
    }

    private String normalizeExecutionMode(String executionMode, String storageMode) {
        String normalized = executionMode == null || executionMode.isBlank()
                ? ("direct_attach".equals(storageMode) ? "windows-mxc" : DEFAULT_EXECUTION_MODE)
                : executionMode.trim().toLowerCase(java.util.Locale.ROOT);
        boolean valid = Set.of("docker", "windows-mxc", "windows-host").contains(normalized);
        if (!valid || ("managed_import".equals(storageMode) && !"docker".equals(normalized))
                || ("direct_attach".equals(storageMode) && "docker".equals(normalized))) {
            throw new CpApiException(
                    org.springframework.http.HttpStatus.BAD_REQUEST,
                    "INVALID_EXECUTION_MODE",
                    "executionMode is incompatible with storageMode");
        }
        return normalized;
    }

    private String normalizeHostPath(String hostPath, String storageMode) {
        if ("direct_attach".equals(storageMode)) {
            requireNonBlank(hostPath, "hostPath");
            return hostPath.trim();
        }
        if (hostPath != null && !hostPath.isBlank()) {
            throw new CpApiException(
                    org.springframework.http.HttpStatus.BAD_REQUEST,
                    "INVALID_HOST_PATH",
                    "hostPath is only allowed for direct_attach");
        }
        return null;
    }

    private String normalizeProfileForExecution(String profile, String executionMode) {
        if (!"docker".equals(executionMode) && profile != null && !profile.isBlank()) {
            throw new CpApiException(
                    org.springframework.http.HttpStatus.BAD_REQUEST,
                    "INVALID_PROFILE",
                    "profile is only allowed for docker execution");
        }
        return normalizeProfile(profile);
    }

    private String normalizeImageForExecution(String image, String executionMode) {
        if (!"docker".equals(executionMode) && image != null && !image.isBlank()) {
            throw new CpApiException(
                    org.springframework.http.HttpStatus.BAD_REQUEST,
                    "INVALID_IMAGE",
                    "image is only allowed for docker execution");
        }
        return normalizeImage(image);
    }

    private String normalizeIdempotencyKey(String idempotencyKey) {
        if (idempotencyKey == null || idempotencyKey.isBlank()) {
            return null;
        }
        String normalized = idempotencyKey.trim();
        if (normalized.length() > 128) {
            throw new CpApiException(
                    org.springframework.http.HttpStatus.BAD_REQUEST,
                    "INVALID_IDEMPOTENCY_KEY",
                    "Idempotency-Key must be at most 128 characters");
        }
        return normalized;
    }

    private String requestHash(String name, String description, String profile, String image,
            String storageMode, String hostPath, String executionMode) {
        String canonical = String.join("\u0000", List.of(
                name == null ? "" : name.trim(), description == null ? "" : description,
                profile == null ? "" : profile, image == null ? "" : image,
                storageMode, hostPath == null ? "" : hostPath, executionMode));
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(canonical.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder(digest.length * 2);
            for (byte value : digest) {
                hex.append(String.format("%02x", value));
            }
            return hex.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is unavailable", e);
        }
    }

    public Map<String, Object> capabilitySnapshot(Workspace workspace) {
        if (!"direct_attach".equals(workspace.getStorageMode())) {
            return Map.of(
                    "contractVersion", "v1",
                    "backendKind", "docker",
                    "backendRevision", "builtin",
                    "maturity", "stable",
                    "executionMode", "docker",
                    "available", true);
        }
        try {
            return probeDirectAttachSnapshot("direct_attach", workspace.getHostPath(),
                    workspace.getExecutionMode());
        } catch (CpApiException e) {
            logger.warn("DIRECT_ATTACH_CAPABILITY_UNAVAILABLE workspaceId={} executionMode={} code={}",
                    workspace.getId(), workspace.getExecutionMode(), e.getCode());
            return Map.of(
                    "contractVersion", "v1",
                    "backendKind", workspace.getExecutionMode(),
                    "backendRevision", "builtin",
                    "maturity", "experimental",
                    "executionMode", workspace.getExecutionMode(),
                    "available", false,
                    "reason", e.getCode());
        }
    }

    /**
     * Public capability preflight (PLAN-0384 T1.3/V2). Reuses the Workspace
     * storage/execution/host-path normalization, but a reachable Runtime that
     * reports {@code available:false} is a valid result returned with its
     * {@code reason} rather than a 503. Only an unreachable Runtime or invalid
     * JSON maps to {@code 502 RUNTIME_UNAVAILABLE}.
     */
    public Map<String, Object> preflightDirectAttach(String storageMode, String hostPath,
            String executionMode) {
        String requested = storageMode == null || storageMode.isBlank() ? "direct_attach" : storageMode;
        String normalizedStorageMode = normalizeStorageMode(requested);
        if (!"direct_attach".equals(normalizedStorageMode)) {
            throw new CpApiException(
                    org.springframework.http.HttpStatus.BAD_REQUEST,
                    "INVALID_STORAGE_MODE",
                    "capability preflight only supports storageMode=direct_attach");
        }
        String normalizedExecutionMode = normalizeExecutionMode(executionMode, normalizedStorageMode);
        String normalizedHostPath = normalizeHostPath(hostPath, normalizedStorageMode);
        final Map<String, Object> snapshot;
        try {
            snapshot = probeDirectAttachSnapshot(normalizedStorageMode, normalizedHostPath,
                    normalizedExecutionMode);
        } catch (CpApiException e) {
            // probeDirectAttachSnapshot only throws for transport/parse failures;
            // a reachable Runtime reporting unavailable is returned normally.
            throw new CpApiException(
                    org.springframework.http.HttpStatus.BAD_GATEWAY,
                    "RUNTIME_UNAVAILABLE",
                    "Runtime capability probe is unavailable",
                    e);
        }
        Map<String, Object> body = new LinkedHashMap<>(snapshot);
        body.put("checkedAt", Instant.now().toString());
        return body;
    }

    private Map<String, Object> probeDirectAttach(String storageMode, String hostPath, String executionMode) {
        Map<String, Object> snapshot = probeDirectAttachSnapshot(storageMode, hostPath, executionMode);
        if (!Boolean.TRUE.equals(snapshot.get("available"))) {
            String reason = snapshot.get("reason") instanceof String value ? value : "CAPABILITY_UNAVAILABLE";
            throw new CpApiException(
                    org.springframework.http.HttpStatus.SERVICE_UNAVAILABLE,
                    "DIRECT_ATTACH_UNAVAILABLE",
                    "direct attach backend is unavailable: " + reason);
        }
        return snapshot;
    }

    /**
     * Raw Runtime direct-attach capability projection. A reachable Runtime that
     * reports {@code available:false} is returned as-is (its {@code reason} is
     * preserved); only an unreachable Runtime, a non-2xx response, or invalid
     * JSON throws {@code DIRECT_ATTACH_PROBE_FAILED}.
     */
    private Map<String, Object> probeDirectAttachSnapshot(String storageMode, String hostPath,
            String executionMode) {
        try {
            HttpHeaders headers = new HttpHeaders();
            headers.setContentType(MediaType.APPLICATION_JSON);
            headers.setBearerAuth(serviceToken);
            Map<String, String> body = Map.of(
                    "storageMode", storageMode,
                    "hostPath", hostPath,
                    "executionMode", executionMode);
            ResponseEntity<String> response = restTemplate.postForEntity(
                    runtimeUrl + "/internal/v1/runtime/capabilities/direct-attach/probe",
                    new HttpEntity<>(body, headers), String.class);
            if (!response.getStatusCode().is2xxSuccessful()) {
                logger.error("DIRECT_ATTACH_PROBE_REJECTED executionMode={} status={}",
                        executionMode, response.getStatusCode());
                throw new CpApiException(
                        org.springframework.http.HttpStatus.SERVICE_UNAVAILABLE,
                        "DIRECT_ATTACH_PROBE_FAILED",
                        "Runtime direct-attach probe was rejected");
            }
            final JsonNode root;
            try {
                root = objectMapper.readTree(response.getBody());
            } catch (JsonProcessingException e) {
                logger.error("DIRECT_ATTACH_PROBE_INVALID_RESPONSE executionMode={} reason={}",
                        executionMode, e.getMessage(), e);
                throw new CpApiException(
                        org.springframework.http.HttpStatus.SERVICE_UNAVAILABLE,
                        "DIRECT_ATTACH_PROBE_FAILED",
                        "Runtime direct-attach probe returned invalid JSON");
            }
            return objectMapper.convertValue(root, new TypeReference<Map<String, Object>>() {});
        } catch (CpApiException e) {
            throw e;
        } catch (RuntimeException e) {
            logger.error("DIRECT_ATTACH_PROBE_FAILED executionMode={} reason={}", executionMode, e.getMessage(), e);
            throw new CpApiException(
                    org.springframework.http.HttpStatus.SERVICE_UNAVAILABLE,
                    "DIRECT_ATTACH_PROBE_FAILED",
                    "Runtime direct-attach probe failed");
        }
    }

    private String normalizeProfile(String profile) {
        String normalized = profile == null || profile.isBlank()
                ? "coding" : profile.trim().toLowerCase(java.util.Locale.ROOT);
        if (!ALLOWED_PROFILES.contains(normalized)) {
            throw new CpApiException(
                    org.springframework.http.HttpStatus.BAD_REQUEST,
                    "INVALID_PROFILE",
                    "profile must be one of: strict, coding, isolated");
        }
        return normalized;
    }

    private String normalizeImage(String image) {
        String normalized = image == null || image.isBlank() ? DEFAULT_IMAGE : image.trim();
        if (!ALLOWED_IMAGES.contains(normalized)) {
            throw new CpApiException(
                    org.springframework.http.HttpStatus.BAD_REQUEST,
                    "INVALID_IMAGE",
                    "image must be one of the allowlisted images: xihe/workspace:latest");
        }
        return normalized;
    }

    private void ensureOwner(Workspace workspace, String ownerId) {
        if (ownerId == null || !ownerId.equals(workspace.getOwnerId())) {
            throw new CpApiException(
                    org.springframework.http.HttpStatus.NOT_FOUND,
                    "WORKSPACE_NOT_FOUND",
                    "Workspace not found");
        }
    }

    /**
     * Best-effort Runtime sandbox cleanup, invoked after the delete transaction
     * has committed. It never throws and never blocks rollback; failures are
     * recorded with an explicit code and reconciled later by the Runtime's
     * startup orphan cleanup.
     *
     * @return Runtime 枚举到的存活 jobId 集合；枚举失败/调用失败时为 {@code null}
     *         （调用方按 fail-closed 处理）
     */
    private Set<String> notifyRuntimeDeleteBestEffort(String workspaceId, String storageRef) {
        try {
            HttpHeaders headers = new HttpHeaders();
            headers.setContentType(MediaType.APPLICATION_JSON);
            headers.setBearerAuth(serviceToken);
            Map<String, String> body = new LinkedHashMap<>();
            body.put("workspaceId", workspaceId);
            if (storageRef != null && !storageRef.isBlank()) {
                body.put("storageRef", storageRef);
            }
            ResponseEntity<String> response = restTemplate.postForEntity(
                    runtimeUrl + "/internal/v1/runtime/workspaces/delete",
                    new HttpEntity<>(body, headers),
                    String.class);
            if (!response.getStatusCode().is2xxSuccessful()) {
                logger.error(
                        "RUNTIME_CLEANUP_FAILED workspaceId={} status={} (deferred to Runtime orphan reconciliation)",
                        workspaceId, response.getStatusCode());
                return null;
            }
            var root = objectMapper.readTree(response.getBody());
            if (root.path("jobsEnumerationFailed").asBoolean(false)) {
                return null;
            }
            Set<String> aliveJobIds = new LinkedHashSet<>();
            for (var node : root.path("jobIds")) {
                if (node.isTextual()) {
                    aliveJobIds.add(node.asText());
                }
            }
            return aliveJobIds;
        } catch (Exception e) {
            logger.error(
                    "RUNTIME_CLEANUP_FAILED workspaceId={} storageRef={} reason={} (deferred to Runtime orphan reconciliation)",
                    workspaceId, storageRef, e.getMessage(), e);
            return null;
        }
    }

    private void requireNonBlank(String value, String field) {
        if (value == null || value.isBlank()) {
            throw new CpApiException(
                    org.springframework.http.HttpStatus.BAD_REQUEST,
                    "INVALID_REQUEST",
                    field + " is required");
        }
    }
}
