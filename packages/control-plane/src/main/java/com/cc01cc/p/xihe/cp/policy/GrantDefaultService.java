package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.auth.AuthUserLockService;
import com.cc01cc.p.xihe.cp.config.DbLockTimeout;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.UserRole;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.service.SessionLockService;
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
    private final AuthUserLockService userLock;
    private final SessionLockService sessionLock;
    private final AuditLogger auditLogger;
    private final ObjectMapper objectMapper;
    private final DbLockTimeout dbLockTimeout;

    public GrantDefaultService(AuthorizationGrantRepository grantRepository,
                               AuthUserLockService userLock,
                               SessionLockService sessionLock,
                               AuditLogger auditLogger,
                               ObjectMapper objectMapper,
                               DbLockTimeout dbLockTimeout) {
        this.grantRepository = grantRepository;
        this.userLock = userLock;
        this.sessionLock = sessionLock;
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
        User lockedUser = userLock.lockAndFind(user.getId())
                .orElseThrow(() -> new IllegalArgumentException("User not found"));
        ensureDefault("user", lockedUser.getId(), lockedUser.getRole(), lockedUser.getId().toString(), null);
    }

    @Transactional
    public void ensureAgentSessionDefault(Session session) {
        if (session == null || session.getId() == null || session.getUserId() == null) {
            throw new IllegalArgumentException("A persisted root Session is required for default grants");
        }
        dbLockTimeout.apply();
        Session lockedSession = sessionLock.lockAndFind(session.getId())
                .orElseThrow(() -> new IllegalArgumentException("Session not found"));
        if (lockedSession.getKind() != null) {
            throw new IllegalArgumentException("Derived Sessions require an explicit narrowed grant snapshot");
        }
        User user = userLock.lockAndFind(UUID.fromString(lockedSession.getUserId()))
                .orElseThrow(() -> new IllegalArgumentException("Session owner not found"));
        ensureDefault("agent", lockedSession.getId(), user.getRole(), user.getId().toString(),
                lockedSession.getWorkspaceId());
    }

    /**
     * PLAN-0470 (decision #15): session-scoped agent grants cleanup owned by
     * Policy; participates in the caller's Session deletion transaction.
     */
    @Transactional
    public void deleteSessionAgentGrants(UUID sessionId) {
        grantRepository.deleteBySubjectTypeAndSubjectId("agent", sessionId);
    }

    /**
     * PLAN-0470 (decision #22): the agent-principal default/template grant
     * write is owned by Policy; the Principal service computes the covered
     * permission set and hands it over. Joins the caller's transaction.
     */
    @Transactional
    public void createAgentPrincipalGrant(UUID principalId, UUID granterId, String source,
                                          String roleName, String templateName,
                                          com.fasterxml.jackson.databind.JsonNode permissions) {
        AuthorizationGrant grant = new AuthorizationGrant();
        grant.setId(UUID.randomUUID());
        grant.setSubjectType(GrantPrincipalPathResolver.AGENT_PRINCIPAL);
        grant.setSubjectId(principalId);
        grant.setGranterType(GrantPrincipalPathResolver.USER);
        grant.setGranterId(granterId);
        grant.setSource(source);
        grant.setRoleName(roleName);
        grant.setTemplateName(templateName);
        grant.setReadState("read");
        grant.setPermissions(permissions);
        grantRepository.saveAndFlush(grant);
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
