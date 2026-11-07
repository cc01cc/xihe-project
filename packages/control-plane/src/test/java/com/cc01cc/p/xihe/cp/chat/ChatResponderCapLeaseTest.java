package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.SessionParticipant;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.service.SessionParticipantService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0623 M1b-②: the lease cap must come from the ONE Responder resolved in the request
 * thread ({@code ChatController.leaseCapFor}). Four contract cases:
 * a) two participants with different caps each get their own;
 * b) an explicit HUMAN asParticipantId yields the HUMAN projection, not the PRIMARY's;
 * c) a non-PRIMARY AGENT participant yields that AGENT's cap;
 * d) the responder==null default path keeps the frozen 0622 C3 snapshot field-for-field.
 */
class ChatResponderCapLeaseTest extends AbstractIntegrationTest {

    @Autowired private ChatController controller;
    @Autowired private SessionParticipantService sessionParticipantService;
    @Autowired private WorkspaceFixture workspaceFixture;
    @Autowired private ObjectMapper json;
    @Autowired private com.cc01cc.p.xihe.cp.repository.SessionRepository sessions;
    @Autowired private com.cc01cc.p.xihe.cp.repository.SessionParticipantRepository participantRows;
    @Autowired private com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository principals;
    @Autowired private com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository bindingRepository;
    @Autowired private com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository grantRepository;

    private String workspaceId;
    private String ownerId;
    private UUID primaryAgentId;
    private UUID guardAgentId;
    private UUID sessionId;
    private Session sessionRow;

    @BeforeEach
    void fixture() {
        AuthResponse owner = register("p623-cap-owner");
        ownerId = owner.getUser().getId();
        workspaceId = workspaceFixture.createOwnedWorkspace("P623 cap ws", ownerId).getId().toString();

        AgentPrincipal primary = new AgentPrincipal();
        primary.setName("P623 primary");
        primary.setCreatedByUserId(ownerId);
        primary.setDefaultModelProvider("alpha");
        primary.setDefaultModelName("m1");
        primary.setAllowedModels(json.createArrayNode().add("alpha:m1"));
        primary = principals.saveAndFlush(primary);
        primaryAgentId = primary.getId();

        AgentPrincipal guard = new AgentPrincipal();
        guard.setName("P623 guard agent");
        guard.setCreatedByUserId(ownerId);
        guard.setDefaultModelProvider("beta");
        guard.setDefaultModelName("m2");
        guard.setAllowedModels(json.createArrayNode().add("beta:m2"));
        guard = principals.saveAndFlush(guard);
        guardAgentId = guard.getId();

        // resolveCapFor requires a workspace binding for the AGENT principals.
        bindingRepository.saveAndFlush(new com.cc01cc.p.xihe.cp.entity.WorkspaceAgent(
                primaryAgentId.toString(), workspaceId,
                json.createArrayNode().add(json.createObjectNode().put("actionClass", "read"))));
        bindingRepository.saveAndFlush(new com.cc01cc.p.xihe.cp.entity.WorkspaceAgent(
                guardAgentId.toString(), workspaceId,
                json.createArrayNode().add(json.createObjectNode().put("actionClass", "write"))));
        // The cap is binding∩principal-grants; without grants both caps would be [].
        grant(primaryAgentId, "read");
        grant(guardAgentId, "write");

        Session session = new Session();
        session.setId(UUID.randomUUID());
        session.setWorkspaceId(workspaceId);
        session.setUserId(ownerId);
        session.setTitle("P623 cap session");
        session.setAgentPermissionsSnapshot(json.createObjectNode().put("frozen", "c3"));
        sessionRow = sessions.saveAndFlush(session);
        sessionId = sessionRow.getId();

        participant(participantRow("PRIMARY", "AGENT", primaryAgentId, 10));
        participant(participantRow("MEMBER", "HUMAN", UUID.fromString(ownerId), 20));
        participant(participantRow("GUARD", "AGENT", guardAgentId, 30));
    }

    private SessionParticipant participantRow(String role, String kind, UUID principalId, int order) {
        SessionParticipant row = new SessionParticipant();
        row.setSessionId(sessionId);
        row.setRole(role);
        row.setPrincipalKind(kind);
        row.setPrincipalId(principalId);
        row.setOrderIndex(order);
        row.setWakePolicy("MENTION");
        row.setRespondPolicy("WHEN_MENTIONED");
        return row;
    }

    private void participant(SessionParticipant row) {
        participantRows.saveAndFlush(row);
    }

    @Test
    void twoParticipantsWithDifferentCapsEachGetTheirOwn() {
        SessionParticipantService.Responder primaryResponder =
                sessionParticipantService.responderFor(sessionId, null);
        SessionParticipantService.Responder humanResponder =
                sessionParticipantService.responderFor(sessionId, humanParticipantId());

        JsonNode primaryCap = controller.leaseCapFor(primaryResponder, workspaceId);
        JsonNode humanCap = controller.leaseCapFor(humanResponder, workspaceId);

        assertNotNull(primaryCap);
        assertNotNull(humanCap);
        assertNotEquals(primaryCap, humanCap);
    }

    @Test
    void humanAsParticipantUsesTheHumanProjectionNotThePrimaryCap() {
        SessionParticipantService.Responder humanResponder =
                sessionParticipantService.responderFor(sessionId, humanParticipantId());

        JsonNode humanCap = controller.leaseCapFor(humanResponder, workspaceId);
        JsonNode primaryCap = controller.leaseCapFor(
                sessionParticipantService.responderFor(sessionId, null), workspaceId);

        assertNotNull(humanCap);
        assertTrue(humanCap.isArray(), "HUMAN projection is the workspace atom array");
        assertNotEquals(primaryCap, humanCap);
    }

    @Test
    void nonPrimaryAgentParticipantUsesItsOwnAgentCap() {
        String guardParticipantId = participantRows.findBySessionIdOrderByOrderIndexAsc(sessionId).stream()
                .filter(row -> "AGENT".equals(row.getPrincipalKind()))
                .filter(row -> guardAgentId.equals(row.getPrincipalId()))
                .findFirst().orElseThrow().getId().toString();

        SessionParticipantService.Responder guardResponder =
                sessionParticipantService.responderFor(sessionId, guardParticipantId);

        JsonNode guardCap = controller.leaseCapFor(guardResponder, workspaceId);
        JsonNode primaryCap = controller.leaseCapFor(
                sessionParticipantService.responderFor(sessionId, null), workspaceId);

        assertNotNull(guardCap);
        assertNotEquals(primaryCap, guardCap);
        assertFalse(guardResponder.participantId() == null);
    }

    @Test
    void nullResponderOrPrincipalRefusesTheLeaseInsteadOfFallingBackToTheSnapshot() {
        // PLAN-0689 A4/A7 (D-55): the D23-31 snapshot fallback is gone and the Session column is
        // dropped. A run with no resolved Responder — or a Responder with no principal — has no
        // identity to bound a lease against; refusing is the strict reading, because an uncapped
        // lease would be a permission regression.
        com.cc01cc.p.xihe.cp.config.CpApiException refused = assertThrows(
                com.cc01cc.p.xihe.cp.config.CpApiException.class,
                () -> controller.leaseCapFor(null, workspaceId));

        assertEquals("AGENT_PRINCIPAL_MISSING", refused.getCode());
        assertEquals(org.springframework.http.HttpStatus.FORBIDDEN, refused.getStatus());

        SessionParticipantService.Responder missingPrincipal =
                new SessionParticipantService.Responder(UUID.randomUUID(), "AGENT", null);
        assertThrows(com.cc01cc.p.xihe.cp.config.CpApiException.class,
                () -> controller.leaseCapFor(missingPrincipal, workspaceId));
    }

    @Test
    void derivedDispatchWithoutPrimaryFailsClosed() {
        // PLAN-0689 A7/D-55: this is exactly the derived execAsync branch — responder == null,
        // responderFor(sessionId, null) is the only identity lookup, and the resulting null Responder
        // must be refused with 403 AGENT_PRINCIPAL_MISSING (never a Session-column fallback).
        Session unbound = new Session();
        unbound.setId(UUID.randomUUID());
        unbound.setWorkspaceId(workspaceId);
        unbound.setUserId(ownerId);
        unbound.setTitle("P623 derived dispatch without PRIMARY");
        Session saved = sessions.saveAndFlush(unbound);

        SessionParticipantService.Responder derivedPath =
                sessionParticipantService.responderFor(saved.getId(), null);

        assertNull(derivedPath, "a Session without a PRIMARY participant has no derived Responder");
        com.cc01cc.p.xihe.cp.config.CpApiException refused = assertThrows(
                com.cc01cc.p.xihe.cp.config.CpApiException.class,
                () -> controller.leaseCapFor(derivedPath, workspaceId));
        assertEquals("AGENT_PRINCIPAL_MISSING", refused.getCode());
        assertEquals(org.springframework.http.HttpStatus.FORBIDDEN, refused.getStatus());
    }

    @Test
    void derivedPathPrimaryCapEqualsExplicitPrimaryCap() {
        // PLAN-0689 A7/D-55 + Lead 2026-11-07 ruling (option A): a derived dispatch resolves the
        // PRIMARY once, then calls the SAME leaseCapFor/resolveParticipantCap as an explicit
        // responder. The cap is live (design.md:118 / 2026-11-02 ruling); D-54's Session snapshot
        // is an authorization-intersection input only and must not leak into the lease cap.
        String primaryParticipantId = participantRows.findBySessionIdOrderByOrderIndexAsc(sessionId)
                .stream()
                .filter(row -> "PRIMARY".equals(row.getRole()))
                .findFirst().orElseThrow().getId().toString();

        SessionParticipantService.Responder explicitPrimary =
                sessionParticipantService.responderFor(sessionId, primaryParticipantId);
        SessionParticipantService.Responder derivedPath =
                sessionParticipantService.responderFor(sessionId, null);

        assertEquals(controller.leaseCapFor(explicitPrimary, workspaceId),
                controller.leaseCapFor(derivedPath, workspaceId),
                "derived dispatch must use the same resolveParticipantCap call as an explicit PRIMARY");
    }

    private String humanParticipantId() {
        return participantRows.findBySessionIdOrderByOrderIndexAsc(sessionId).stream()
                .filter(row -> "HUMAN".equals(row.getPrincipalKind()))
                .findFirst().orElseThrow().getId().toString();
    }

    private void grant(UUID agentPrincipalId, String actionClass) {
        com.cc01cc.p.xihe.cp.entity.AuthorizationGrant grant = new com.cc01cc.p.xihe.cp.entity.AuthorizationGrant();
        grant.setGranterType("user");
        grant.setGranterId(UUID.fromString(ownerId));
        grant.setSubjectType("agent_principal");
        grant.setSubjectId(agentPrincipalId);
        grant.setSource("role");
        grant.setReadState("read");
        grant.setPermissions(json.createArrayNode()
                .add(json.createObjectNode().put("actionClass", actionClass).put("resource", "*")));
        grantRepository.saveAndFlush(grant);
    }

    private AuthResponse register(String label) {
        var response = restTemplate.postForEntity(baseUrl + "/api/v1/auth/register",
                new com.cc01cc.p.xihe.cp.auth.RegisterRequest(label.toLowerCase(java.util.Locale.ROOT)
                        .replaceAll("[^a-z0-9]", "") + "-" + UUID.randomUUID() + "@test.com",
                        com.cc01cc.p.xihe.cp.integration.TestDataFactory.PASSWORD, label),
                AuthResponse.class);
        assertEquals(201, response.getStatusCode().value());
        assertNotNull(response.getBody());
        return response.getBody();
    }
}
