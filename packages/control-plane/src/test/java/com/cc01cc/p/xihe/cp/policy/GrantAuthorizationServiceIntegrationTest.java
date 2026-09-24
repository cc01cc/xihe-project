package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.UserRole;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class GrantAuthorizationServiceIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private GrantAuthorizationService grantAuthorizationService;

    @Autowired
    private PolicyEngine policyEngine;

    @Autowired
    private AuthorizationGrantRepository grantRepository;

    @Autowired
    private ChatRunRepository chatRunRepository;

    @Autowired
    private SessionRepository sessionRepository;

    @Autowired
    private WorkspaceRepository workspaceRepository;

    @Autowired
    private WorkspaceUserRepository workspaceUserRepository;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private ObjectMapper objectMapper;

    private String userId;
    private UUID workspaceId;
    private UUID unjoinedWorkspaceId;
    private UUID parentRunId;
    private final List<UUID> sessionIds = new ArrayList<>();
    private final List<UUID> grantIds = new ArrayList<>();

    @AfterEach
    void cleanFixtures() {
        grantRepository.deleteAllById(grantIds);
        if (parentRunId != null) {
            chatRunRepository.deleteById(parentRunId);
        }
        sessionIds.forEach(sessionRepository::deleteById);
        if (unjoinedWorkspaceId != null) {
            workspaceRepository.deleteById(unjoinedWorkspaceId);
        }
        if (workspaceId != null) {
            workspaceUserRepository.deleteAll(workspaceUserRepository.findByIdWorkspaceId(workspaceId));
            workspaceRepository.deleteById(workspaceId);
        }
        if (userId != null) {
            userRepository.deleteById(UUID.fromString(userId));
        }
    }

    @Test
    void eachBoundaryReadsCurrentGrantsAndForkDoesNotInheritParentAgentSet() throws Exception {
        User user = userRepository.save(new User("grant-path-" + UUID.randomUUID() + "@test.com",
                "hash", UserRole.USER, "Grant path test"));
        userId = user.getId().toString();
        Workspace workspace = workspaceRepository.save(new Workspace("Grant path test", userId));
        workspaceId = workspace.getId();
        workspaceUserRepository.save(new WorkspaceUser(workspaceId.toString(), userId, WorkspaceRole.OWNER));

        Session rootSession = saveSession(workspaceId, userId, "Root agent");
        String writeBody = "{\"params\":{\"arguments\":{\"path\":\"src/main.java\"}}}";
        assertFalse(policyEngine.allowsByGrant(PolicyContext.EMPTY, "write_file", writeBody,
                rootSession.getId().toString(), userId, workspaceId.toString(), true),
                "an empty grant set denies before any approval policy is considered");
        parentRunId = UUID.randomUUID();
        ChatRun parentRun = chatRunRepository.saveAndFlush(new ChatRun(
                parentRunId.toString(), rootSession.getId().toString(), userId, workspaceId.toString(),
                "root-run", "root-hash", "provider", "model", "workspace", "running"));

        addGrant("user", UUID.fromString(userId), "default", null, null, atoms("read", "write"));
        addGrant("agent", rootSession.getId(), "default", null, null, atoms("read"));
        assertTrue(policyEngine.allowsByGrant(PolicyContext.EMPTY, "write_file", writeBody,
                rootSession.getId().toString(), userId, workspaceId.toString(), true),
                "a member's own user grant permits a user-direct mutation");
        assertFalse(policyEngine.allowsByGrant(PolicyContext.EMPTY, "write_file",
                "{\"params\":{\"arguments\":{\"path\":\"C:\\\\outside\\\\secret\"}}}",
                rootSession.getId().toString(), userId, workspaceId.toString(), true),
                "a wildcard grant cannot authorize an absolute host path");
        assertTrue(policyEngine.allowsByGrant(PolicyContext.EMPTY, "apply_patch",
                "{\"params\":{\"arguments\":{\"patches\":[{\"path\":\"src/main.java\"}]}}}",
                rootSession.getId().toString(), userId, workspaceId.toString(), true),
                "structured patch paths are extracted and scoped to the workspace");
        assertFalse(policyEngine.allowsByGrant(PolicyContext.EMPTY, "apply_patch",
                "{\"params\":{\"arguments\":{\"patches\":[{\"path\":\"../outside.java\"}]}}}",
                rootSession.getId().toString(), userId, workspaceId.toString(), true),
                "structured patch paths cannot escape the workspace");
        assertFalse(policyEngine.allowsByGrant(PolicyContext.EMPTY, "write_file", writeBody,
                rootSession.getId().toString(), userId, workspaceId.toString(), false),
                "the Agent path is constrained by each Session principal's grants");
        Workspace unjoinedWorkspace = workspaceRepository.save(
                new Workspace("Unjoined grant path test", userId));
        unjoinedWorkspaceId = unjoinedWorkspace.getId();
        assertFalse(grantAuthorizationService.allowsUserOnly(new PolicyRequest(
                "write_file", List.of("write"), List.of("src/main.java"), ToolShape.STRUCTURED,
                userId, unjoinedWorkspaceId.toString(), null)),
                "wildcard grants cannot cross into a workspace where the user has no membership");
        UUID malformedGrantId = addGrant("user", UUID.fromString(userId), "direct",
                "admin", UUID.randomUUID(), atoms("unknown-action"));
        assertFalse(policyEngine.allowsByGrant(PolicyContext.EMPTY, "write_file", writeBody,
                rootSession.getId().toString(), userId, workspaceId.toString(), true),
                "a malformed or out-of-vocabulary grant fails closed");
        grantRepository.deleteById(malformedGrantId);

        Session spawnSession = saveDerivedSession(workspaceId, userId, rootSession, parentRun, Session.KIND_SPAWN);
        addGrant("agent", spawnSession.getId(), "spawn", "agent", rootSession.getId(), atoms("write"));
        PolicyRequest spawnWrite = request(workspaceId, userId, spawnSession, "write", "src/main.java");

        boolean inFlightDecision = grantAuthorizationService.allows(spawnWrite);
        assertFalse(inFlightDecision, "the parent agent's narrower set constrains its spawned child");

        Session forkSession = saveDerivedSession(workspaceId, userId, rootSession, parentRun, Session.KIND_FORK);
        addGrant("agent", forkSession.getId(), "direct", "user", UUID.fromString(userId), atoms("write"));
        assertTrue(grantAuthorizationService.allows(
                request(workspaceId, userId, forkSession, "write", "src/main.java")),
                "a fork points to its source but does not inherit the source agent grant path");

        addGrant("agent", rootSession.getId(), "direct", "user", UUID.fromString(userId), atoms("write"));
        assertFalse(inFlightDecision, "a committed grant does not revise an already returned decision");
        assertTrue(grantAuthorizationService.allows(spawnWrite),
                "the next tool-boundary evaluation must read the newly committed grant");

        rootSession.setKind(Session.KIND_SPAWN);
        rootSession.setSpawnedFromSessionId(rootSession.getId());
        rootSession.setSpawnedFromRunId(parentRun.getId());
        rootSession.setSpawnedAt(Instant.now());
        sessionRepository.saveAndFlush(rootSession);
        assertFalse(grantAuthorizationService.allows(
                request(workspaceId, userId, rootSession, "write", "src/main.java")),
                "cyclic or inconsistent principal paths fail closed");
    }

    private Session saveSession(UUID wsId, String ownerId, String title) {
        Session session = new Session(wsId.toString(), ownerId, title);
        session.setId(UUID.randomUUID());
        Session saved = sessionRepository.save(session);
        sessionIds.add(saved.getId());
        return saved;
    }

    private Session saveDerivedSession(UUID wsId, String ownerId, Session parent, ChatRun parentRun, String kind) {
        Session session = new Session(wsId.toString(), ownerId, kind + " agent");
        session.setId(UUID.randomUUID());
        session.setSpawnedFromSessionId(parent.getId());
        session.setSpawnedFromRunId(parentRun.getId());
        session.setSpawnedAt(Instant.now());
        session.setKind(kind);
        Session saved = sessionRepository.save(session);
        sessionIds.add(saved.getId());
        return saved;
    }

    private UUID addGrant(String subjectType, UUID subjectId, String source,
                          String granterType, UUID granterId, ArrayNode permissions) {
        AuthorizationGrant grant = new AuthorizationGrant();
        grant.setId(UUID.randomUUID());
        grant.setSubjectType(subjectType);
        grant.setSubjectId(subjectId);
        grant.setGranterType(granterType);
        grant.setGranterId(granterId);
        grant.setSource(source);
        grant.setPermissions(permissions);
        UUID savedId = grantRepository.save(grant).getId();
        grantIds.add(savedId);
        return savedId;
    }

    private ArrayNode atoms(String... actionClasses) {
        ArrayNode permissions = objectMapper.createArrayNode();
        for (String actionClass : actionClasses) {
            ObjectNode atom = objectMapper.createObjectNode();
            atom.put("actionClass", actionClass);
            permissions.add(atom);
        }
        return permissions;
    }

    private static PolicyRequest request(UUID wsId, String ownerId, Session session,
                                         String actionClass, String resource) {
        return new PolicyRequest("write_file", List.of(actionClass), List.of(resource), ToolShape.STRUCTURED,
                ownerId, wsId.toString(), session.getId().toString());
    }
}
