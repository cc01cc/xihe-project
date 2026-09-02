package com.cc01cc.p.xihe.cp.controller;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.WorkspaceExecutionSpec;
import com.cc01cc.p.xihe.cp.service.WorkspaceExecutionSpecService;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@RestController
@RequestMapping("/internal/v1/runtime")
public class RuntimeExecutionSpecController {

    private static final Logger logger = LoggerFactory.getLogger(RuntimeExecutionSpecController.class);

    private final WorkspaceExecutionSpecService executionSpecService;
    private final ObjectMapper objectMapper;

    public RuntimeExecutionSpecController(WorkspaceExecutionSpecService executionSpecService,
                                          ObjectMapper objectMapper) {
        this.executionSpecService = executionSpecService;
        this.objectMapper = objectMapper;
    }

    @GetMapping("/workspaces/{workspaceId}/execution-spec")
    public WorkspaceExecutionSpecResponse getCurrentSpec(@PathVariable String workspaceId) {
        WorkspaceExecutionSpec spec = executionSpecService.findCurrentExecutionSpec(workspaceId);
        try {
            Map<String, Object> sandboxSpec = objectMapper.readValue(
                    spec.getSandboxSpec(), new TypeReference<>() { });
            return new WorkspaceExecutionSpecResponse(
                    spec.getWorkspaceId(),
                    spec.getGeneration(),
                    spec.getSandboxSpecHash(),
                    sandboxSpec,
                    spec.getStorageBackend(),
                    spec.getStorageRef());
        } catch (JsonProcessingException e) {
            logger.error("Invalid persisted sandbox spec workspaceId={} generation={}",
                    spec.getWorkspaceId(), spec.getGeneration(), e);
            throw new CpApiException(
                    org.springframework.http.HttpStatus.INTERNAL_SERVER_ERROR,
                    "INVALID_EXECUTION_SPEC",
                    "Persisted sandboxSpec is not valid JSON",
                    e);
        }
    }

    public record WorkspaceExecutionSpecResponse(
            String workspaceId,
            Integer generation,
            String sandboxSpecHash,
            Map<String, Object> sandboxSpec,
            String storageBackend,
            String storageRef) {
    }
}
