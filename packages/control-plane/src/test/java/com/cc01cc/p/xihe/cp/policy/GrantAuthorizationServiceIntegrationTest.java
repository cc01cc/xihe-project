package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.UserRole;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
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
    private AuthorizationGrantRepository grantRepository;

    @Autowired
    private ChatRunRepository chatRunRepository;

    @Autowired
    private SessionRepository sessionRepository;

    @Autowired
    private WorkspaceRepository workspaceRepository;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private ObjectMapper objectMapper;

    private String userId;
    private UUID workspaceId;
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
        if (workspaceId != null) {
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

        Session rootSession = saveSession(workspaceId, userId, "Root agent");
        parentRunId = UUID.randomUUID();
        ChatRun parentRun = chatRunRepository.saveAndFlush(new ChatRun(
                parentRunId.toString(), rootSession.getId().toString(), userId, workspaceId.toString(),
                "root-run", "root-hash", "provider", "model", "workspace", "running"));

        addGrant("user", UUID.fromString(userId), "default", null, null, atoms("read", "write"));
        addGrant("agent", rootSession.getId(), "default", null, null, atoms("read"));

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

    private void addGrant(String subjectType, UUID subjectId, String source,
                          String granterType, UUID granterId, ArrayNode permissions) {
        AuthorizationGrant grant = new AuthorizationGrant();
        grant.setId(UUID.randomUUID());
        grant.setSubjectType(subjectType);
        grant.setSubjectId(subjectId);
        grant.setGranterType(granterType);
        grant.setGranterId(granterId);
        grant.setSource(source);
        grant.setPermissions(permissions);
        grantIds.add(grantRepository.save(grant).getId());
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
