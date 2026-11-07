package com.cc01cc.p.xihe.cp.plugin;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * PLAN-0691 T1.1: catalog/lifecycle routes 1–7 of spec/openapi-delta.md.
 *
 * <p>D-66: the whole surface is behind {@code cp.plugin.enabled}; while the flag is off the
 * controller bean does not exist and these paths answer <b>404</b> (never 400), so an M1 deployment
 * with plugins off looks exactly like a build without the feature.</p>
 *
 * <p>Thin by design (CP architecture gate): no repository access, every decision in
 * {@link PluginCatalogService}; errors travel as one RFC 9457 problem+json body. Authorization in
 * T1.1 is authentication-only — the {@code plugin:manage} atom lands with T1.3.</p>
 */
@RestController
@RequestMapping("/api/v1/plugins")
@ConditionalOnProperty(name = "cp.plugin.enabled", havingValue = "true")
public class PluginController {

    private final PluginCatalogService service;

    public PluginController(PluginCatalogService service) {
        this.service = service;
    }

    @GetMapping
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<?> list(@RequestParam(required = false) String source,
            @RequestParam(required = false) String state) {
        try {
            List<PluginView> views = service.list(source, state).stream()
                    .map(PluginController::view)
                    .toList();
            return ResponseEntity.ok(Map.of("items", views));
        } catch (CpApiException e) {
            return problem(e);
        }
    }

    @GetMapping("/{pluginId}")
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<?> get(@PathVariable String pluginId) {
        try {
            return ResponseEntity.ok(view(service.getCurrent(pluginId)));
        } catch (CpApiException e) {
            return problem(e);
        }
    }

    @PostMapping("/install")
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<?> install(@RequestBody PackageRequest request) {
        try {
            Plugin installed = service.install(request.packagePath(), requireActor(),
                    TenantContext.getWorkspaceId());
            return ResponseEntity.status(HttpStatus.CREATED).body(view(installed));
        } catch (CpApiException e) {
            return problem(e);
        }
    }

    @PostMapping("/{pluginId}/upgrade")
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<?> upgrade(@PathVariable String pluginId,
            @RequestBody PackageRequest request) {
        try {
            Plugin upgraded = service.upgrade(pluginId, request.packagePath(), requireActor(),
                    TenantContext.getWorkspaceId());
            return ResponseEntity.ok(view(upgraded));
        } catch (CpApiException e) {
            return problem(e);
        }
    }

    @PostMapping("/{pluginId}/enable")
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<?> enable(@PathVariable String pluginId) {
        try {
            return ResponseEntity.ok(view(service.setEnabled(pluginId, true, requireActor(),
                    TenantContext.getWorkspaceId())));
        } catch (CpApiException e) {
            return problem(e);
        }
    }

    @PostMapping("/{pluginId}/disable")
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<?> disable(@PathVariable String pluginId) {
        try {
            return ResponseEntity.ok(view(service.setEnabled(pluginId, false, requireActor(),
                    TenantContext.getWorkspaceId())));
        } catch (CpApiException e) {
            return problem(e);
        }
    }

    @DeleteMapping("/{pluginId}")
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<?> uninstall(@PathVariable String pluginId) {
        try {
            service.uninstall(pluginId, requireActor(), TenantContext.getWorkspaceId());
            return ResponseEntity.noContent().build();
        } catch (CpApiException e) {
            return problem(e);
        }
    }

    private static String requireActor() {
        String actor = TenantContext.getUserId();
        if (actor == null || actor.isBlank()) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                    "no authenticated principal in the request context");
        }
        return actor;
    }

    private static ResponseEntity<?> problem(CpApiException e) {
        return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
    }

    private static PluginView view(Plugin plugin) {
        JsonNode manifest = plugin.getManifest();
        List<ActionView> actions = new ArrayList<>();
        JsonNode declared = manifest.path("actions");
        for (JsonNode action : declared) {
            actions.add(new ActionView(action.path("name").asText(),
                    action.path("title").isMissingNode() ? null : action.path("title").asText(),
                    action.path("actionClass").asText(),
                    action.path("resourceType").isMissingNode() ? null
                            : action.path("resourceType").asText()));
        }
        List<String> atoms = new ArrayList<>();
        manifest.path("requestedAtoms").forEach(atom -> atoms.add(atom.asText()));
        JsonNode limits = manifest.path("limits");
        LimitsView limitView = new LimitsView(limits.path("timeoutMs").asInt(5000),
                limits.path("maxConcurrency").asInt(4));
        return new PluginView(plugin.getId(), plugin.getVersion(), plugin.getDigest(),
                plugin.getSource(), plugin.getState(), manifest.path("manifestVersion").asText(),
                actions, atoms, limitView, plugin.getCreatedAt(), plugin.getUpdatedAt());
    }

    /** Wire view of spec/openapi-delta.md {@code PluginView}; the jsonb manifest never surfaces. */
    public record PluginView(String pluginId, String version, String digest, String source,
            String state, String manifestVersion, List<ActionView> actions,
            List<String> requestedAtoms, LimitsView limits, Instant createdAt,
            Instant updatedAt) {}

    public record ActionView(String name, String title, String actionClass,
            String resourceType) {}

    public record LimitsView(int timeoutMs, int maxConcurrency) {}

    /** {@code PluginInstallRequest}/{@code PluginUpgradeRequest}: packagePath only (B-3). */
    public record PackageRequest(String packagePath) {}
}
