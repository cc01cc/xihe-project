package com.cc01cc.p.xihe.cp.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.client.RestTemplate;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

@Service
public class WorkspaceService {

    private static final Logger logger = LoggerFactory.getLogger(WorkspaceService.class);

    private final String workspaceBasePath;
    private final WorkspaceRepository workspaceRepository;
    private final WorkspaceUserRepository workspaceUserRepository;
    private final RestTemplate restTemplate;
    private final String runtimeUrl;
    private final String workspaceImage;
    private final String serviceToken;

    public WorkspaceService(WorkspaceRepository workspaceRepository,
                            WorkspaceUserRepository workspaceUserRepository,
                            RestTemplate restTemplate,
                            @Value("${cp.workspace-base-path:/data/xihe/workspaces}") String workspaceBasePath,
                            @Value("${cp.mcp.runtime-url:http://localhost:12633}") String runtimeUrl,
                            @Value("${cp.workspace-image:xihe/workspace:latest}") String workspaceImage,
                            @Value("${cp.agent-api-token:dev-token-not-secure}") String serviceToken) {
        this.workspaceRepository = workspaceRepository;
        this.workspaceUserRepository = workspaceUserRepository;
        this.restTemplate = restTemplate;
        this.workspaceBasePath = workspaceBasePath;
        this.runtimeUrl = runtimeUrl;
        this.workspaceImage = workspaceImage;
        this.serviceToken = serviceToken;
    }

    @Transactional
    public Workspace createWorkspace(String name, String ownerId) {
        Workspace ws = new Workspace(name, ownerId);
        ws.setStoragePath(workspaceBasePath + "/" + java.util.UUID.randomUUID().toString().substring(0, 8));
        ws = workspaceRepository.save(ws);

        workspaceUserRepository.save(new WorkspaceUser(ws.getId(), ownerId, WorkspaceRole.OWNER));

        try {
            Files.createDirectories(Path.of(ws.getStoragePath()));
        } catch (Exception e) {
            logger.error("Failed to create workspace directory: {}", ws.getStoragePath(), e);
        }

        notifyRuntimeCreate(ws.getId(), ws.getStoragePath());

        logger.info("Workspace created: id={} name={} path={}", ws.getId(), name, ws.getStoragePath());
        return ws;
    }

    @Transactional
    public void deleteWorkspace(String workspaceId) {
        Workspace ws = workspaceRepository.findById(workspaceId)
                .orElseThrow(() -> new IllegalArgumentException("Workspace not found: " + workspaceId));

        workspaceUserRepository.deleteAll(workspaceUserRepository.findByIdWorkspaceId(workspaceId));
        workspaceRepository.delete(ws);

        notifyRuntimeDelete(workspaceId, ws.getStoragePath());

        logger.info("Workspace deleted: id={} name={}", workspaceId, ws.getName());
    }

    public Workspace getWorkspace(String id) {
        return workspaceRepository.findById(id)
                .orElseThrow(() -> new IllegalArgumentException("Workspace not found: " + id));
    }

    public List<Workspace> getWorkspacesByUser(String userId) {
        return workspaceRepository.findByOwnerId(userId);
    }

    public String resolveStoragePath(String workspaceId) {
        if (workspaceId == null) return null;
        return workspaceRepository.findById(workspaceId)
                .map(Workspace::getStoragePath)
                .orElse(null);
    }

    public String resolveWorkspaceRole(String workspaceId, String userId) {
        if (workspaceId == null || userId == null) return null;
        return workspaceUserRepository.findByIdWorkspaceIdAndIdUserId(workspaceId, userId)
                .map(wu -> wu.getRole().name())
                .orElse(null);
    }

    private void notifyRuntimeCreate(String workspaceId, String workspacePath) {
        try {
            HttpHeaders headers = new HttpHeaders();
            headers.setContentType(MediaType.APPLICATION_JSON);
            headers.setBearerAuth(serviceToken);
            Map<String, String> body = new java.util.LinkedHashMap<>();
            body.put("ws_id", workspaceId);
            body.put("workspace_path", workspacePath);
            body.put("image", workspaceImage);
            HttpEntity<Map<String, String>> request = new HttpEntity<>(body, headers);
            restTemplate.postForEntity(runtimeUrl + "/workspace/create", request, String.class);
            logger.debug("Runtime notified of workspace creation: {}", workspaceId);
        } catch (Exception e) {
            logger.warn("Failed to notify Runtime for workspace create (workspaceId={}): {}", workspaceId, e.getMessage());
        }
    }

    private void notifyRuntimeDelete(String workspaceId, String workspacePath) {
        try {
            HttpHeaders headers = new HttpHeaders();
            headers.setContentType(MediaType.APPLICATION_JSON);
            headers.setBearerAuth(serviceToken);
            Map<String, String> body = Map.of(
                    "ws_id", workspaceId,
                    "workspace_path", workspacePath
            );
            HttpEntity<Map<String, String>> request = new HttpEntity<>(body, headers);
            restTemplate.postForEntity(runtimeUrl + "/workspace/delete", request, String.class);
            logger.debug("Runtime notified of workspace deletion: {}", workspaceId);
        } catch (Exception e) {
            logger.warn("Failed to notify Runtime for workspace delete (workspaceId={}): {}", workspaceId, e.getMessage());
        }
    }
}
