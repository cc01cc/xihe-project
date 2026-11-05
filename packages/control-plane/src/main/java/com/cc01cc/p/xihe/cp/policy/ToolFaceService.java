package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.ToolFaceEntity;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.repository.ToolFaceRepository;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * Tool face administration (PLAN-0328 M1, decision #38 / #56): tools stay
 * {@code unclassified ⇒ ask + no reuse} until an owner/admin classifies them.
 */
@Service
public class ToolFaceService {

    public static final String SCOPE_INSTANCE = "instance";
    public static final String SCOPE_WORKSPACE = "workspace";
    public static final String SCOPE_BUILTIN = "builtin";
    private static final Set<String> SCOPES = Set.of(SCOPE_INSTANCE, SCOPE_WORKSPACE);
    private static final Set<String> SHAPES = Set.of("structured", "interpreter", "opaque");
    private static final ToolFaceRegistry BUILTIN_REGISTRY = new ToolFaceRegistry();
    private static final int MAX_TOOL = 128;
    private static final int MAX_ACTION_CLASS = 64;

    private final ToolFaceRepository repository;
    private final PolicyRevision policyRevision;
    private final AuditLogger audit;
    private final RequesterAuthority requesterAuthority;

    public ToolFaceService(ToolFaceRepository repository, PolicyRevision policyRevision, AuditLogger audit,
                           RequesterAuthority requesterAuthority) {
        this.repository = repository;
        this.policyRevision = policyRevision;
        this.audit = audit;
        this.requesterAuthority = requesterAuthority;
    }

    public record FaceInput(String tool, String actionClass, String shape) {}

    public record FaceView(UUID id, String scope, String ownerId, String tool, String actionClass, String shape) {}

    @Transactional(readOnly = true)
    public List<FaceView> list(String scope, String userId, String workspaceId, boolean admin) {
        String owner = ownerFor(scope, workspaceId, admin, false);
        Map<String, FaceView> merged = new LinkedHashMap<>();

        BUILTIN_REGISTRY.knownTools().stream()
                .sorted()
                .forEach(tool -> {
                    ToolFaceRegistry.Face face = BUILTIN_REGISTRY.faceOf(tool);
                    merged.put(tool, new FaceView(null, SCOPE_BUILTIN, null, tool,
                            face.actionClass(), face.shape().name().toLowerCase(Locale.ROOT)));
                });

        if (SCOPE_INSTANCE.equals(scope)) {
            mergePersisted(merged, repository.findByScopeAndOwnerIdIsNullOrderByCreatedAtAscIdAsc(scope));
        } else {
            // Workspace views are effective views: built-ins < instance rows < workspace rows.
            mergePersisted(merged,
                    repository.findByScopeAndOwnerIdIsNullOrderByCreatedAtAscIdAsc(SCOPE_INSTANCE));
            List<ToolFaceEntity> workspaceRows = owner == null
                    ? repository.findByScopeAndOwnerIdIsNullOrderByCreatedAtAscIdAsc(scope)
                    : repository.findByScopeAndOwnerIdOrderByCreatedAtAscIdAsc(scope, owner);
            mergePersisted(merged, workspaceRows);
        }

        return merged.values().stream()
                .sorted(Comparator.comparing(FaceView::tool))
                .toList();
    }

    private static void mergePersisted(Map<String, FaceView> merged, List<ToolFaceEntity> rows) {
        for (ToolFaceEntity row : rows) {
            merged.put(row.getTool(), new FaceView(row.getId(), row.getScope(), row.getOwnerId(), row.getTool(),
                    row.getActionClass(), row.getShape()));
        }
    }

    @Transactional
    public FaceView upsert(String scope, String userId, String workspaceId, boolean admin, FaceInput input) {
        String owner = ownerFor(scope, workspaceId, admin, true);
        String tool = requireText(input.tool(), "tool", MAX_TOOL);
        String actionClass = requireText(input.actionClass(), "actionClass", MAX_ACTION_CLASS);
        String shape = input.shape() == null ? "" : input.shape().toLowerCase();
        if (!SHAPES.contains(shape)) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "shape must be one of structured/interpreter/opaque");
        }
        if (SCOPE_WORKSPACE.equals(scope) && BUILTIN_REGISTRY.configuredFace(tool).isPresent()) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                    "built-in tool classification cannot be overridden at workspace scope; "
                            + "instance ADMIN may override");
        }
        List<ToolFaceEntity> existing = owner == null
                ? repository.findByScopeAndOwnerIdIsNullOrderByCreatedAtAscIdAsc(scope)
                : repository.findByScopeAndOwnerIdOrderByCreatedAtAscIdAsc(scope, owner);
        ToolFaceEntity current = existing.stream()
                .filter(row -> row.getTool().equals(tool))
                .findFirst()
                .orElse(null);
        boolean created = current == null;
        String previousActionClass = created ? null : current.getActionClass();
        String previousShape = created ? null : current.getShape();
        ToolFaceEntity entity = created
                ? new ToolFaceEntity(UUID.randomUUID(), scope, owner, tool, actionClass, shape,
                        userId == null ? "system" : userId)
                : current;
        entity.setActionClass(actionClass);
        entity.setShape(shape);
        repository.save(entity);
        policyRevision.bump();
        audit.record(null, tool, "tool_face_classified",
                classifyDetail(created, scope, tool, actionClass, shape, previousActionClass, previousShape));
        return new FaceView(entity.getId(), scope, owner, tool, actionClass, shape);
    }

    private static String classifyDetail(boolean created, String scope, String tool, String actionClass,
                                         String shape, String previousActionClass, String previousShape) {
        return (created ? "create" : "update")
                + " scope=" + scope
                + " tool=" + tool
                + " actionClass=" + (created ? actionClass : previousActionClass + "->" + actionClass)
                + " shape=" + (created ? shape : previousShape + "->" + shape);
    }

    private static String requireText(String value, String field, int max) {
        if (value == null || value.isBlank()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", field + " is required");
        }
        if (value.length() > max) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    field + " exceeds " + max + " characters");
        }
        return value.trim();
    }

    private String ownerFor(String scope, String workspaceId, boolean admin, boolean requireOwner) {
        if (scope == null || !SCOPES.contains(scope)) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "scope must be one of instance/workspace");
        }
        if (SCOPE_INSTANCE.equals(scope)) {
            if (requireOwner && !admin) {
                throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                        "instance-scope faces require ADMIN");
            }
            return null;
        }
        if (requireOwner && workspaceId == null) {
            throw CpApiException.workspaceContextRequired();
        }
        if (requireOwner && !workspaceManager()) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                    "workspace-scope faces require workspace OWNER or ADMIN");
        }
        return workspaceId;
    }

    /**
     * PLAN-0651 M3 T3.3 (A14 → N9 {@code MANAGE_WORKSPACE_POLICY}).
     *
     * <p>D51-28: the {@code WorkspaceRole.canManage(role)} check is a <b>retained role judgement</b>
     * (today's A14 is OWNER-only; N9 defaults also include WS_EDITOR, so replacing the role check
     * with the atom would widen A14 — a B-class change pending a ruling). Only the old instance
     * bypass is migrated, and it is evaluated at <b>instance scope</b> so a workspace-scoped N9 row
     * (WS_OWNER/WS_EDITOR) cannot silently become the bypass. ADMIN/SUPER_ADMIN hold N9 at instance
     * scope, so matrix cell S1 is unchanged; the 403 message/shape stays the same.</p>
     */
    private boolean workspaceManager() {
        String role = TenantContext.getWorkspaceRole();
        if (WorkspaceRole.canManage(role)) {
            return true;
        }
        String actor = TenantContext.getUserId();
        if (actor == null || actor.isBlank()) {
            return false;
        }
        try {
            return requesterAuthority.holdsActionAtom(UUID.fromString(actor),
                    ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_POLICY, null);
        } catch (IllegalArgumentException invalidSubject) {
            return false;
        }
    }
}

