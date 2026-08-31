package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAssignment;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAssignmentRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.util.SandboxSpecHashUtil;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class WorkspaceAssignmentService {

    private final WorkspaceRepository workspaceRepository;
    private final WorkspaceAssignmentRepository assignmentRepository;

    public WorkspaceAssignmentService(WorkspaceRepository workspaceRepository,
                                      WorkspaceAssignmentRepository assignmentRepository) {
        this.workspaceRepository = workspaceRepository;
        this.assignmentRepository = assignmentRepository;
    }

    /**
     * Q17 A: DB 自增 generation per grill.
     * Increments workspace.generation, calculates hash, creates assignment row.
     */
    @Transactional
    public WorkspaceAssignment createAssignment(String workspaceId, String sandboxSpecJson, String actor, String reason) {
        if (actor == null || actor.trim().isEmpty()) {
            throw new IllegalArgumentException("actor is required per Q26 B");
        }
        if (reason == null || reason.trim().isEmpty()) {
            throw new IllegalArgumentException("reason is required per Q26 B");
        }
        Workspace ws = workspaceRepository.findById(workspaceId)
                .orElseThrow(() -> new IllegalArgumentException("Workspace not found: " + workspaceId));

        int nextGen = (ws.getGeneration() == null ? 0 : ws.getGeneration()) + 1;
        String hash = SandboxSpecHashUtil.hash(sandboxSpecJson);

        WorkspaceAssignment assignment = new WorkspaceAssignment();
        assignment.setWorkspaceId(workspaceId);
        assignment.setGeneration(nextGen);
        assignment.setSandboxSpecHash(hash);
        assignment.setSandboxSpec(sandboxSpecJson);
        assignment.setStorageBackend(ws.getStorageBackend() != null ? ws.getStorageBackend() : "host_directory");
        assignment.setStorageRef(ws.getStorageRef());
        assignment.setActor(actor);
        assignment.setReason(reason);
        assignmentRepository.save(assignment);

        ws.setGeneration(nextGen);
        ws.setSandboxSpecHash(hash);
        ws.setSandboxSpec(sandboxSpecJson);
        workspaceRepository.save(ws);

        return assignment;
    }
}
