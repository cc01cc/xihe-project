package com.cc01cc.p.xihe.cp.checkpoint;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/** Internal service-Bearer API for CP-owned LangGraph checkpoint data. */
@RestController
@RequestMapping("/internal/v1/agent/checkpoints")
public class AgentGraphCheckpointController {

    private final AgentGraphCheckpointService service;

    public AgentGraphCheckpointController(AgentGraphCheckpointService service) {
        this.service = service;
    }

    @PostMapping("/lineages")
    public ResponseEntity<?> createLineage(@RequestBody AgentGraphCheckpointService.LineageRequest request) {
        try {
            return ResponseEntity.status(HttpStatus.CREATED).body(service.createLineage(request));
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    @GetMapping("/lineages/{threadId}")
    public ResponseEntity<?> getLineage(
            @PathVariable String threadId,
            @RequestParam String sessionId,
            @RequestParam String userId,
            @RequestParam String workspaceId,
            @RequestParam(required = false) String sourceRunId,
            @RequestParam(required = false) String probeId) {
        try {
            return ResponseEntity.ok(service.getLineage(
                    threadId, new AgentGraphCheckpointService.LineageLookupRequest(
                            sessionId, userId, workspaceId, sourceRunId, probeId)));
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    @PutMapping("/{threadId}/checkpoints")
    public ResponseEntity<?> putCheckpoint(
            @PathVariable String threadId,
            @RequestBody AgentGraphCheckpointService.PutCheckpointRequest request) {
        try {
            service.putCheckpoint(threadId, request);
            return ResponseEntity.noContent().build();
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    @GetMapping("/{threadId}/checkpoints/{checkpointId}")
    public ResponseEntity<?> getCheckpoint(
            @PathVariable String threadId,
            @PathVariable String checkpointId,
            @RequestParam String sessionId,
            @RequestParam String userId,
            @RequestParam String workspaceId,
            @RequestParam(defaultValue = "") String checkpointNs) {
        try {
            AgentGraphCheckpointService.CheckpointView checkpoint = service.getCheckpoint(
                    threadId, new AgentGraphCheckpointService.OwnerRequest(sessionId, userId, workspaceId),
                    checkpointNs, checkpointId);
            if (checkpoint == null) {
                return ProblemDetailsHandler.problemResponse(
                        HttpStatus.NOT_FOUND, "CHECKPOINT_NOT_FOUND", "Checkpoint is unavailable");
            }
            return ResponseEntity.ok(checkpoint);
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    @GetMapping("/{threadId}/checkpoints")
    public ResponseEntity<?> listCheckpoints(
            @PathVariable String threadId,
            @RequestParam String sessionId,
            @RequestParam String userId,
            @RequestParam String workspaceId,
            @RequestParam(defaultValue = "") String checkpointNs,
            @RequestParam(required = false) String beforeCheckpointId,
            @RequestParam(required = false) Integer limit,
            @RequestParam(required = false) String filterSource,
            @RequestParam(required = false) Integer filterStep) {
        try {
            List<AgentGraphCheckpointService.CheckpointView> checkpoints = service.listCheckpoints(
                    threadId, new AgentGraphCheckpointService.OwnerRequest(sessionId, userId, workspaceId),
                    checkpointNs, beforeCheckpointId, limit, filterSource, filterStep);
            return ResponseEntity.ok(checkpoints);
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    @PostMapping("/{threadId}/writes")
    public ResponseEntity<?> putWrites(
            @PathVariable String threadId,
            @RequestBody AgentGraphCheckpointService.PutWritesRequest request) {
        try {
            service.putWrites(threadId, request);
            return ResponseEntity.noContent().build();
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    @DeleteMapping("/{threadId}")
    public ResponseEntity<?> deleteThread(
            @PathVariable String threadId,
            @RequestBody AgentGraphCheckpointService.OwnerRequest request) {
        try {
            service.deleteThread(threadId, request);
            return ResponseEntity.noContent().build();
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }
}
