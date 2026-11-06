package com.cc01cc.p.xihe.cp.controller;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.WorkspaceExecutionSpec;
import com.cc01cc.p.xihe.cp.service.WorkspaceExecutionSpecService;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
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
    private final WorkspaceService workspaceService;
    private final ObjectMapper objectMapper;

    public RuntimeExecutionSpecController(WorkspaceExecutionSpecService executionSpecService,
                                          WorkspaceService workspaceService,
                                          ObjectMapper objectMapper) {
        this.executionSpecService = executionSpecService;
        this.workspaceService = workspaceService;
        this.objectMapper = objectMapper;
    }

    @GetMapping("/workspaces/{workspaceId}/execution-spec")
    public WorkspaceExecutionSpecResponse getCurrentSpec(@PathVariable String workspaceId) {
        WorkspaceExecutionSpec spec = executionSpecService.findCurrentExecutionSpec(workspaceId);
        try {
            Map<String, Object> sandboxSpec = objectMapper.readValue(
                    spec.getSandboxSpec(), new TypeReference<>() { });
            var workspace = workspaceService.requireActiveWorkspace(workspaceId);
            // PLAN-0641 T7.5：roots 是 Runtime declared-root 的唯一真相（绝对 hostPath）。
            // BL-415：V104 加列时未回填，legacy spec 的 roots 为 NULL（或空数组）——空根表不是
            // 合法声明，Runtime 会把它当有效列表索引 root[0] 而 panic。此时用工作区 hostPath
            // 合成主根（rootId=workspaceId，与 Runtime 的 legacy 合成约定一致），不下发 roots:[]。
            java.util.List<java.util.Map<String, Object>> roots = spec.getRoots() == null
                    ? java.util.List.of()
                    : objectMapper.readValue(spec.getRoots(), new TypeReference<>() { });
            if (roots.isEmpty() && workspace.getHostPath() != null && !workspace.getHostPath().isBlank()) {
                roots = java.util.List.of(java.util.Map.<String, Object>of(
                        "rootId", workspaceId,
                        "hostPath", workspace.getHostPath()));
            }
            return new WorkspaceExecutionSpecResponse(
                    spec.getWorkspaceId(),
                    spec.getGeneration(),
                    spec.getSandboxSpecHash(),
                    sandboxSpec,
                    spec.getStorageBackend(),
                    spec.getStorageRef(),
                    workspace.getStorageMode(),
                    workspace.getHostPath(),
                    workspace.getExecutionMode(),
                    roots);
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
            String storageRef,
            String storageMode,
            String hostPath,
            String executionMode,
            java.util.List<java.util.Map<String, Object>> roots) {
    }
}
