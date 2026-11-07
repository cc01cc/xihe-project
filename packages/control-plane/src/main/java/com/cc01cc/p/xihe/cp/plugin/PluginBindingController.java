package com.cc01cc.p.xihe.cp.plugin;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * PLAN-0691 T1.2: binding routes 8–13 of {@code spec/openapi-delta.md} §1.
 *
 * <p>D-66: like the catalog surface, the whole controller is behind {@code cp.plugin.enabled} — with
 * the flag off these paths answer <b>404</b>, exactly as if the build had no plugin feature.</p>
 *
 * <p>Thin by design (CP architecture gate): no repository, no rules; the workspace comes from
 * {@code X-Workspace-Id} via {@link TenantContext} and every decision (existence → 403 before
 * disclosure → atom shape → state coupling) lives in {@link PluginBindingService}.</p>
 *
 * <p>Authorization: the annotation stays {@code isAuthenticated()} on purpose. The atom check is
 * <b>not</b> a SpEL precondition here — {@code PLUGIN_BIND} is evaluated inside
 * {@link PluginBindingService} as the first statement of each write path, so a denial is produced
 * before the transaction has written anything (spec/authz-plugin-atoms.md line 10 assigns binding
 * CRUD and session attach/detach to {@code plugin:bind}). Adding a second evaluation point here
 * would put the authoritative decision outside the scope that owns the rows.</p>
 */
@RestController
@RequestMapping("/api/v1/plugin-bindings")
@ConditionalOnProperty(name = "cp.plugin.enabled", havingValue = "true")
public class PluginBindingController {

    private final PluginBindingService service;

    public PluginBindingController(PluginBindingService service) {
        this.service = service;
    }

    @GetMapping
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<?> list(@RequestParam(required = false) String state) {
        try {
            List<PluginBindingView> views = service.list(TenantContext.getWorkspaceId(), state)
                    .stream().map(this::view).toList();
            return ResponseEntity.ok(Map.of("items", views));
        } catch (CpApiException e) {
            return problem(e);
        }
    }

    @PostMapping
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<?> create(@RequestBody CreateRequest request) {
        try {
            PluginBinding binding = service.create(TenantContext.getWorkspaceId(),
                    request.pluginId(), request.grantedAtoms(), requireActor());
            return ResponseEntity.status(HttpStatus.CREATED).body(view(binding));
        } catch (CpApiException e) {
            return problem(e);
        }
    }

    @GetMapping("/{bindingId}")
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<?> get(@PathVariable String bindingId) {
        try {
            return ResponseEntity.ok(view(service.get(TenantContext.getWorkspaceId(), bindingId)));
        } catch (CpApiException e) {
            return problem(e);
        }
    }

    @PatchMapping("/{bindingId}")
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<?> update(@PathVariable String bindingId,
            @RequestBody UpdateRequest request) {
        try {
            PluginBinding binding = service.update(TenantContext.getWorkspaceId(), bindingId,
                    request.state(), request.grantedAtoms(), requireActor());
            return ResponseEntity.ok(view(binding));
        } catch (CpApiException e) {
            return problem(e);
        }
    }

    @DeleteMapping("/{bindingId}")
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<?> delete(@PathVariable String bindingId) {
        try {
            service.delete(TenantContext.getWorkspaceId(), bindingId, requireActor());
            return ResponseEntity.noContent().build();
        } catch (CpApiException e) {
            return problem(e);
        }
    }

    @GetMapping("/{bindingId}/authorization")
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<?> authorization(@PathVariable String bindingId) {
        try {
            return ResponseEntity.ok(service.authorization(TenantContext.getWorkspaceId(),
                    bindingId));
        } catch (CpApiException e) {
            return problem(e);
        }
    }

    private PluginBindingView view(PluginBinding binding) {
        PluginBindingService.Detail detail = service.detail(binding);
        return new PluginBindingView(binding.getId(), binding.getPluginId(),
                binding.getWorkspaceId(), detail.source(), binding.state().wire(),
                binding.getVersion(), binding.getDigest(), binding.grantedAtomList(),
                detail.effectiveAtoms(), binding.getCreatedAt(), binding.getUpdatedAt());
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

    /** spec/openapi-delta.md §2 {@code PluginBindingCreateRequest}: pluginId + optional atoms. */
    public record CreateRequest(String pluginId, List<String> grantedAtoms) {}

    /** {@code PluginBindingUpdateRequest}: optional {@code state} and/or {@code grantedAtoms}. */
    public record UpdateRequest(String state, List<String> grantedAtoms) {}

    /**
     * spec/openapi-delta.md §2 {@code PluginBindingView}. {@code state} is the lowercase five-state
     * wire value; {@code source} is the plugin's {@code builtin|third-party} label (no secret, no
     * manifest node — PLAN-0633 C1).
     */
    public record PluginBindingView(UUID bindingId, String pluginId, UUID workspaceId,
            String source, String state, String version, String digest,
            List<String> grantedAtoms, List<String> effectiveAtoms, Instant createdAt,
            Instant updatedAt) {}
}
