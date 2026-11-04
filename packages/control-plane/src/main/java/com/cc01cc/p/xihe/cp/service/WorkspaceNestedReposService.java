package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.runtime.RuntimeCheckpointClient;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.List;

/**
 * PLAN-0641 T2.3/T2.4: nested-repos read face. Unknown or inaccessible
 * workspace → 404/403 from {@link WorkspaceService#requireAccessibleWorkspace}
 * before the Runtime is touched; probe answers are TTL-cached CP-side; the
 * capture warm and declare evict keep the cache honest.
 */
@Service
public class WorkspaceNestedReposService {

    private static final Logger logger = LoggerFactory.getLogger(WorkspaceNestedReposService.class);

    /** 503 problem code when the Runtime is unreachable for the read-only probe. */
    private static final String CODE_RUNTIME_UNAVAILABLE = "RUNTIME_UNAVAILABLE";

    private final WorkspaceService workspaces;
    private final RuntimeCheckpointClient runtime;
    private final WorkspaceNestedReposCache cache;

    public WorkspaceNestedReposService(WorkspaceService workspaces,
                                       RuntimeCheckpointClient runtime,
                                       WorkspaceNestedReposCache cache) {
        this.workspaces = workspaces;
        this.runtime = runtime;
        this.cache = cache;
    }

    /** Public read face (contract F2): items plus when this answer was produced. */
    public WorkspaceNestedReposView listNestedRepos(String workspaceId, String userId) {
        workspaces.requireAccessibleWorkspace(workspaceId, userId);
        return cache.getFresh(workspaceId)
                .map(entry -> new WorkspaceNestedReposView(workspaceId, entry.cachedAt(), entry.items()))
                .orElseGet(() -> {
                    List<RuntimeCheckpointClient.NestedRepoItem> items = runtime.nestedReposProbe(workspaceId)
                            .orElseThrow(() -> new CpApiException(HttpStatus.SERVICE_UNAVAILABLE,
                                    CODE_RUNTIME_UNAVAILABLE,
                                    "nested-repos probe is unavailable (Runtime unreachable)"));
                    cache.put(workspaceId, items);
                    return new WorkspaceNestedReposView(workspaceId, Instant.now(), items);
                });
    }

    /** F1 warm path (contract §3): classify-only after a primary-root capture. */
    public void warmFromCapture(String workspaceId, String rootId, List<String> paths) {
        try {
            if (rootId == null || !rootId.equals(workspaceId) || paths == null || paths.isEmpty()) {
                return; // only primary-root captures carry workspace-relative paths
            }
            runtime.classifyNestedRepos(workspaceId, paths)
                    .ifPresent(items -> cache.put(workspaceId, items));
        } catch (Exception e) {
            // Best-effort by contract: a failed warm never fails the capture.
            logger.warn("[LIFECYCLE] service=cp event=nested_repos_warm_failed workspaceId={} error={}",
                    workspaceId, e.getMessage());
        }
    }

    /** Root CRUD (add/patch/delete) evicts so {@code declared} labels re-project. */
    public void evict(String workspaceId) {
        cache.evict(workspaceId);
    }

    /** Wire view (contract F2): workspaceId + cachedAt + items. */
    public record WorkspaceNestedReposView(String workspaceId,
                                           Instant cachedAt,
                                           List<RuntimeCheckpointClient.NestedRepoItem> items) {}
}
