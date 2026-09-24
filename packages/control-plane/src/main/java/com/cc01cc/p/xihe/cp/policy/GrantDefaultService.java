package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.config.DbLockTimeout;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.UserRole;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.UUID;

/** Materializes the default permission set through the same grants row used by explicit grants. */
@Service
public class GrantDefaultService {

    private static final List<String> USER_ACTIONS = List.of("read", "write", "delete", "exec", "network");
    private static final List<String> ADMIN_ACTIONS = List.of(
            "read", "write", "delete", "exec", "network", "credential");

    private final AuthorizationGrantRepository grantRepository;
    private final SessionRepository sessionRepository;
    private final UserRepository userRepository;
    private final AuditLogger auditLogger;
    private final ObjectMapper objectMapper;
    private final DbLockTimeout dbLockTimeout;

    public GrantDefaultService(AuthorizationGrantRepository grantRepository,
                               SessionRepository sessionRepository,
                               UserRepository userRepository,
                               AuditLogger auditLogger,
                               ObjectMapper objectMapper,
                               DbLockTimeout dbLockTimeout) {
        this.grantRepository = grantRepository;
        this.sessionRepository = sessionRepository;
        this.userRepository = userRepository;
        this.auditLogger = auditLogger;
        this.objectMapper = objectMapper;
        this.dbLockTimeout = dbLockTimeout;
    }

    @Transactional
    public void ensureUserDefault(User user) {
        if (user == null || user.getId() == null || user.getRole() == null) {
            throw new IllegalArgumentException("A persisted user and role are required for default grants");
        }
        dbLockTimeout.apply();
        User lockedUser = userRepository.findByIdForUpdate(user.getId())
                .orElseThrow(() -> new IllegalArgumentException("User not found"));
        ensureDefault("user", lockedUser.getId(), lockedUser.getRole(), lockedUser.getId().toString(), null);
    }

    @Transactional
    public void ensureAgentSessionDefault(Session session) {
        if (session == null || session.getId() == null || session.getUserId() == null) {
            throw new IllegalArgumentException("A persisted root Session is required for default grants");
        }
        dbLockTimeout.apply();
        Session lockedSession = sessionRepository.findByIdForUpdate(session.getId())
                .orElseThrow(() -> new IllegalArgumentException("Session not found"));
        if (lockedSession.getKind() != null) {
            throw new IllegalArgumentException("Derived Sessions require an explicit narrowed grant snapshot");
        }
        User user = userRepository.findById(UUID.fromString(lockedSession.getUserId()))
                .orElseThrow(() -> new IllegalArgumentException("Session owner not found"));
        ensureDefault("agent", lockedSession.getId(), user.getRole(), user.getId().toString(),
                lockedSession.getWorkspaceId());
    }

    private void ensureDefault(String subjectType, UUID subjectId, UserRole role,
                               String actorUserId, String workspaceId) {
        if (grantRepository.existsBySubjectTypeAndSubjectIdAndSource(subjectType, subjectId, "default")) {
            return;
        }
        AuthorizationGrant grant = new AuthorizationGrant();
        grant.setId(UUID.randomUUID());
        grant.setSubjectType(subjectType);
        grant.setSubjectId(subjectId);
        grant.setPermissions(defaultPermissions(role));
        grant.setSource("default");
        grant.setReadState("read");
        AuthorizationGrant saved = grantRepository.save(grant);
        auditLogger.recordDurableChange(actorUserId, workspaceId,
                "authorization_default_grant_created", "grant", saved.getId().toString(),
                "source=default subjectType=" + subjectType + " userRole=" + role.name());
    }

    private ArrayNode defaultPermissions(UserRole role) {
        List<String> actions = switch (role) {
            case ADMIN -> ADMIN_ACTIONS;
            case USER -> USER_ACTIONS;
        };
        ArrayNode permissions = objectMapper.createArrayNode();
        for (String actionClass : actions) {
            ObjectNode atom = objectMapper.createObjectNode();
            atom.put("actionClass", actionClass);
            permissions.add(atom);
        }
        return permissions;
    }
}
