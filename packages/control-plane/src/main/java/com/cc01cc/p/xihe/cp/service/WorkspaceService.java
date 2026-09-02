package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.client.RestTemplate;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

@Service
public class WorkspaceService {

    private static final Logger logger = LoggerFactory.getLogger(WorkspaceService.class);

    private final WorkspaceRepository workspaceRepository;
    private final WorkspaceUserRepository workspaceUserRepository;
    private final UserRepository userRepository;
    private final WorkspaceExecutionSpecService executionSpecService;
    private final RestTemplate restTemplate;
    private final String runtimeUrl;
    private final String workspaceImage;
    private final String serviceToken;

    public WorkspaceService(WorkspaceRepository workspaceRepository,
                            WorkspaceUserRepository workspaceUserRepository,
                            UserRepository userRepository,
                            WorkspaceExecutionSpecService executionSpecService,
                            RestTemplate restTemplate,
                            @Value("${cp.mcp.runtime-url:http://localhost:12633}") String runtimeUrl,
                            @Value("${cp.workspace-image:xihe/workspace:latest}") String workspaceImage,
                            @Value("${cp.agent-api-token:dev-token-not-secure}") String serviceToken) {
        this.workspaceRepository = workspaceRepository;
        this.workspaceUserRepository = workspaceUserRepository;
        this.userRepository = userRepository;
        this.executionSpecService = executionSpecService;
        this.restTemplate = restTemplate;
        this.runtimeUrl = runtimeUrl;
        this.workspaceImage = workspaceImage;
        this.serviceToken = serviceToken;
    }

    /**
     * Returns the user's first active membership, creating the default resource only when none exists.
     * The user row lock serializes concurrent login/register responses for the same account.
     */
    @Transactional
    public Workspace getOrCreateDefaultWorkspace(String userId) {
        User user = userRepository.findByIdForUpdate(userId)
                .orElseThrow(() -> new CpApiException(
                        org.springframework.http.HttpStatus.NOT_FOUND, "USER_NOT_FOUND", "User not found"));
        List<Workspace> existing = workspaceRepository.findActiveByMemberUserId(user.getId());
        if (!existing.isEmpty()) {
            return existing.get(0);
        }
        return createWorkspaceLocked("Default Workspace", null, user.getId());
    }

    /** Creates the one active workspace allowed for a user. */
    @Transactional
    public Workspace createWorkspace(String name, String ownerId) {
        return createWorkspace(name, null, ownerId);
    }

    @Transactional
    public Workspace createWorkspace(String name, String description, String ownerId) {
        requireNonBlank(ownerId, "ownerId");
        if (userRepository.findByIdForUpdate(ownerId).isPresent()
                && !workspaceRepository.findActiveByMemberUserId(ownerId).isEmpty()) {
            throw workspaceAlreadyExists();
        }
        if (!workspaceRepository.findActiveByMemberUserId(ownerId).isEmpty()) {
            throw workspaceAlreadyExists();
        }
        return createWorkspaceLocked(name, description, ownerId);
    }

    @Transactional(readOnly = true)
    public Optional<Workspace> findCurrentWorkspace(String userId) {
        if (userId == null || userId.isBlank()) {
            return Optional.empty();
        }
        return workspaceRepository.findActiveByMemberUserId(userId).stream().findFirst();
    }

    @Transactional(readOnly = true)
    public Workspace getWorkspace(String id) {
        return requireActiveWorkspace(id);
    }

    @Transactional(readOnly = true)
    public List<Workspace> getWorkspacesByUser(String userId) {
        return workspaceRepository.findActiveByMemberUserId(userId);
    }

    @Transactional(readOnly = true)
    public Workspace requireActiveWorkspace(String workspaceId) {
        return workspaceRepository.findByIdAndDeletedAtIsNull(workspaceId)
                .orElseThrow(() -> new CpApiException(
                        org.springframework.http.HttpStatus.NOT_FOUND,
                        "WORKSPACE_NOT_FOUND",
                        "Workspace not found"));
    }

    @Transactional(readOnly = true)
    public Workspace requireAccessibleWorkspace(String workspaceId, String userId) {
        Workspace workspace = requireActiveWorkspace(workspaceId);
        if (userId == null || workspaceUserRepository
                .findByIdWorkspaceIdAndIdUserId(workspaceId, userId).isEmpty()) {
            throw new CpApiException(
                    org.springframework.http.HttpStatus.NOT_FOUND,
                    "WORKSPACE_NOT_FOUND",
                    "Workspace not found");
        }
        return workspace;
    }

    @Transactional(readOnly = true)
    public boolean isWorkspaceMember(String workspaceId, String userId) {
        return workspaceRepository.findByIdAndDeletedAtIsNull(workspaceId).isPresent()
                && userId != null
                && workspaceUserRepository.findByIdWorkspaceIdAndIdUserId(workspaceId, userId).isPresent();
    }

    @Transactional(readOnly = true)
    public String resolveWorkspaceRole(String workspaceId, String userId) {
        if (!isWorkspaceMember(workspaceId, userId)) {
            return null;
        }
        return workspaceUserRepository.findByIdWorkspaceIdAndIdUserId(workspaceId, userId)
                .map(WorkspaceUser::getRole)
                .map(Enum::name)
                .orElse(null);
    }

    @Transactional
    public Workspace updateWorkspace(String workspaceId, String ownerId, String name, String description) {
        Workspace workspace = workspaceRepository.findByIdForUpdate(workspaceId)
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
    public Workspace deleteWorkspace(String workspaceId, String ownerId) {
        Workspace workspace = workspaceRepository.findByIdForUpdate(workspaceId)
                .orElseThrow(() -> new CpApiException(
                        org.springframework.http.HttpStatus.NOT_FOUND,
                        "WORKSPACE_NOT_FOUND",
                        "Workspace not found"));
        ensureOwner(workspace, ownerId);
        workspace.setDeletedAt(Instant.now());
        workspaceRepository.save(workspace);

        // Runtime owns the ephemeral Sandbox. WorkspaceStorage remains untouched.
        notifyRuntimeDelete(workspaceId, workspace.getStorageRef());
        logger.info("Workspace logically deleted: id={} name={}", workspaceId, workspace.getName());
        return workspace;
    }

    private Workspace createWorkspaceLocked(String name, String description, String ownerId) {
        requireNonBlank(name, "name");
        Workspace workspace = new Workspace(name.trim(), ownerId);
        workspace.setDescription(description);
        workspace.setStorageBackend("host_directory");
        workspace = workspaceRepository.save(workspace);
        workspace.setStorageRef(workspace.getId());
        workspace = workspaceRepository.save(workspace);
        workspaceUserRepository.save(new WorkspaceUser(workspace.getId(), ownerId, WorkspaceRole.OWNER));

        String initialSpec = "{\"image\":\"" + workspaceImage + "\",\"profile\":\"coding\"}";
        executionSpecService.createExecutionSpec(workspace.getId(), initialSpec, ownerId, "create");
        logger.info("Workspace created: id={} name={} storageRef={}",
                workspace.getId(), workspace.getName(), workspace.getStorageRef());
        return workspace;
    }

    private void ensureOwner(Workspace workspace, String ownerId) {
        if (ownerId == null || !ownerId.equals(workspace.getOwnerId())) {
            throw new CpApiException(
                    org.springframework.http.HttpStatus.NOT_FOUND,
                    "WORKSPACE_NOT_FOUND",
                    "Workspace not found");
        }
    }

    private CpApiException workspaceAlreadyExists() {
        return new CpApiException(
                org.springframework.http.HttpStatus.CONFLICT,
                "WORKSPACE_ALREADY_EXISTS",
                "An active workspace already exists for this user");
    }

    private void notifyRuntimeDelete(String workspaceId, String storageRef) {
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
                logger.error("Runtime workspace cleanup rejected workspaceId={} status={}",
                        workspaceId, response.getStatusCode());
                throw runtimeCleanupFailure(workspaceId, response.getStatusCode().toString(), null);
            }
        } catch (Exception e) {
            if (e instanceof CpApiException apiException) {
                throw apiException;
            }
            logger.error("Runtime workspace cleanup failed workspaceId={} storageRef={}: {}",
                    workspaceId, storageRef, e.getMessage(), e);
            throw runtimeCleanupFailure(workspaceId, "request failed", e);
        }
    }

    private CpApiException runtimeCleanupFailure(String workspaceId, String reason, Throwable cause) {
        String detail = "Runtime workspace cleanup failed for " + workspaceId + " (" + reason + ")";
        return cause == null
                ? new CpApiException(org.springframework.http.HttpStatus.BAD_GATEWAY,
                        "RUNTIME_CLEANUP_FAILED", detail)
                : new CpApiException(org.springframework.http.HttpStatus.BAD_GATEWAY,
                        "RUNTIME_CLEANUP_FAILED", "Runtime workspace cleanup failed", cause);
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
