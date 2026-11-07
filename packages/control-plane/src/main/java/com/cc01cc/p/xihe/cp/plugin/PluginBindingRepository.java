package com.cc01cc.p.xihe.cp.plugin;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * PLAN-0691 T1.2 (V136 / DP-6): workspace-scoped bindings.
 *
 * <p>Every finder takes the workspace on purpose — a binding is never looked up by id alone, so the
 * cross-workspace check cannot be forgotten at a call site (spec/openapi-delta.md §4: a foreign
 * binding answers 403 <em>before</em> existence is disclosed).</p>
 */
@Repository
public interface PluginBindingRepository extends JpaRepository<PluginBinding, UUID> {

    List<PluginBinding> findByWorkspaceIdOrderByCreatedAtAsc(UUID workspaceId);

    List<PluginBinding> findByWorkspaceIdAndStateOrderByCreatedAtAsc(UUID workspaceId, String state);

    Optional<PluginBinding> findByIdAndWorkspaceId(UUID id, UUID workspaceId);

    Optional<PluginBinding> findByWorkspaceIdAndPluginId(UUID workspaceId, String pluginId);

    /** D-65 ③ uninstall guard: a plugin with live bindings must not lose its version rows. */
    long countByPluginId(String pluginId);
}
