package com.cc01cc.p.xihe.cp.controller;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.entity.AgentMemory;
import com.cc01cc.p.xihe.cp.service.AgentMemoryService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/**
 * The memory wire shapes and the {@code status} vocabulary, shared by the subject-level endpoints
 * ({@link AgentPrincipalMemoryController}) and the deprecated workspace-nested ones
 * ({@code WorkspaceAgentController}).
 *
 * <p>One definition on purpose: the two routes must never drift in what a memory row looks like, or
 * the UI would see two different {@code archived}/{@code origin} semantics depending on which path it
 * happens to call during the migration window.</p>
 *
 * <p>No workspace field (V107 / Lead ruling 2026-11-04): memory is subject-scoped, so a wire view that
 * carried {@code workspaceId} would claim a partition that no longer exists.</p>
 */
final class AgentMemoryWire {

    private AgentMemoryWire() {}

    static Map<String, Object> envelope(AgentMemory memory) {
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("memory", toView(memory));
        return response;
    }

    static Map<String, Object> toView(AgentMemory memory) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("id", memory.getId().toString());
        view.put("origin", originBucket(memory.getOrigin()));
        view.put("pinned", memory.isPinned());
        view.put("createdAt", memory.getCreatedAt() == null ? null : memory.getCreatedAt().toString());
        view.put("updatedAt", memory.getUpdatedAt() == null ? null : memory.getUpdatedAt().toString());
        // Lead ruling 2026-11-03: "deleted" is an archive. Both keys are always present so the UI does
        // not have to guess from absence; a live row reports archived=false / deletedAt=null.
        view.put("archived", memory.getDeletedAt() != null);
        view.put("deletedAt", memory.getDeletedAt() == null ? null : memory.getDeletedAt().toString());
        view.put("content", memory.getContent());
        return view;
    }

    /**
     * UI vocabulary for "where did this memory come from" (Lead ruling 2026-11-03): the stored
     * {@code origin} stays the durable channel list ({@code tool|ui|cli|passive.*}); the wire exposes
     * the two buckets the UI can explain — {@code manual} (a person wrote it: {@code ui}/{@code cli})
     * and {@code run} (an agent run produced it: {@code tool}/{@code passive.*}).
     */
    static String originBucket(String origin) {
        if (origin == null) {
            return "run";
        }
        return switch (origin) {
            case AgentMemory.ORIGIN_UI, AgentMemory.ORIGIN_CLI -> "manual";
            default -> "run";
        };
    }

    /** {@code status=active|retired|all} (default {@code active}); an unknown value is a 400, not a fallback. */
    static AgentMemoryService.MemoryStatus status(String raw) {
        if (raw == null || raw.isBlank()) {
            return AgentMemoryService.MemoryStatus.ACTIVE;
        }
        return switch (raw.trim().toLowerCase(Locale.ROOT)) {
            case "active" -> AgentMemoryService.MemoryStatus.ACTIVE;
            case "retired" -> AgentMemoryService.MemoryStatus.RETIRED;
            case "all" -> AgentMemoryService.MemoryStatus.ALL;
            default -> throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "status must be one of active|retired|all");
        };
    }

    static ResponseEntity<Map<String, Object>> invalidRequest(String detail) {
        return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", detail);
    }
}
