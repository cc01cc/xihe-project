package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.ToolFaceEntity;
import com.cc01cc.p.xihe.cp.repository.ToolFaceRepository;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
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
    private static final Set<String> SCOPES = Set.of(SCOPE_INSTANCE, SCOPE_WORKSPACE);
    private static final Set<String> SHAPES = Set.of("structured", "interpreter", "opaque");
    private static final int MAX_TOOL = 128;
    private static final int MAX_ACTION_CLASS = 64;

    private final ToolFaceRepository repository;

    public ToolFaceService(ToolFaceRepository repository) {
        this.repository = repository;
    }

    public record FaceInput(String tool, String actionClass, String shape) {}

    public record FaceView(UUID id, String scope, String ownerId, String tool, String actionClass, String shape) {}

    @Transactional(readOnly = true)
    public List<FaceView> list(String scope, String userId, String workspaceId, boolean admin) {
        String owner = ownerFor(scope, workspaceId, admin, false);
        List<ToolFaceEntity> rows = owner == null
                ? repository.findByScopeAndOwnerIdIsNullOrderByCreatedAtAscIdAsc(scope)
                : repository.findByScopeAndOwnerIdOrderByCreatedAtAscIdAsc(scope, owner);
        return rows.stream()
                .map(row -> new FaceView(row.getId(), row.getScope(), row.getOwnerId(), row.getTool(),
                        row.getActionClass(), row.getShape()))
                .toList();
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
        List<ToolFaceEntity> existing = owner == null
                ? repository.findByScopeAndOwnerIdIsNullOrderByCreatedAtAscIdAsc(scope)
                : repository.findByScopeAndOwnerIdOrderByCreatedAtAscIdAsc(scope, owner);
        ToolFaceEntity entity = existing.stream()
                .filter(row -> row.getTool().equals(tool))
                .findFirst()
                .orElseGet(() -> new ToolFaceEntity(UUID.randomUUID(), scope, owner, tool, actionClass,
                        shape, userId == null ? "system" : userId));
        entity.setActionClass(actionClass);
        entity.setShape(shape);
        repository.save(entity);
        return new FaceView(entity.getId(), scope, owner, tool, actionClass, shape);
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

    private static String ownerFor(String scope, String workspaceId, boolean admin, boolean requireOwner) {
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
            throw new CpApiException(HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED",
                    "Workspace context is required");
        }
        return workspaceId;
    }
}
