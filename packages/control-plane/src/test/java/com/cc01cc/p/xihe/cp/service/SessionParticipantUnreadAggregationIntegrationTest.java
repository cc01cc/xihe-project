package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.context.service.EventStoreService;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.SessionParticipant;
import com.cc01cc.p.xihe.cp.entity.SessionParticipantCursor;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.SessionParticipantCursorRepository;
import com.cc01cc.p.xihe.cp.repository.SessionParticipantRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0670 M2b (T2b.2): the roster's derived unread-mention aggregate must be computed by
 * PostgreSQL, and it must agree with the semantics the Java fallback implements.
 *
 * <p>BL-273 forbids native JSONB SQL on the H2 legacy lane, so the production path is selected by
 * the {@code DataSource} product name and the H2 path keeps the Java scan. This test runs against the
 * PostgreSQL integration lane and therefore is the one that <b>really executes</b> the native query —
 * the rule BL-273 wrote down after a mocked-only test hid a broken SQL.</p>
 *
 * <p>Fixture semantics (mirrors the Java loop exactly):</p>
 * <ul>
 *   <li>only {@code payload.outcome == "notify"} rows count;</li>
 *   <li>only rows with {@code sequence > last_read_event_seq} count;</li>
 *   <li>a participant <b>without</b> a cursor row counts nothing (the Java loop skips {@code null}
 *       thresholds);</li>
 *   <li>a payload whose {@code participantId} is not a UUID is skipped, never guessed.</li>
 * </ul>
 */
class SessionParticipantUnreadAggregationIntegrationTest extends AbstractIntegrationTest {

    @Autowired private WorkspaceFixture workspaceFixture;
    @Autowired private SessionRepository sessions;
    @Autowired private SessionParticipantRepository participants;
    @Autowired private SessionParticipantCursorRepository cursors;
    @Autowired private AgentPrincipalRepository principals;
    @Autowired private EventStoreService events;
    @Autowired private SessionParticipantService service;
    @Autowired private ObjectMapper json;

    private String ownerId;
    private String workspaceId;
    private String sessionId;

    @BeforeEach
    void fixture() {
        AuthResponse owner = register("p670-unread");
        ownerId = owner.getUser().getId();
        workspaceId = workspaceFixture.createOwnedWorkspace("P670 unread ws", ownerId).getId().toString();

        AgentPrincipal principal = new AgentPrincipal();
        principal.setName("P670 agent");
        principal.setCreatedByUserId(ownerId);
        principal = principals.saveAndFlush(principal);

        Session session = new Session();
        session.setId(UUID.randomUUID());
        session.setWorkspaceId(workspaceId);
        session.setUserId(ownerId);
        session.setTitle("P670 unread session");
        session.setAgentPrincipalId(principal.getId().toString());
        sessionId = sessions.saveAndFlush(session).getId().toString();
    }

    @Test
    void unreadMentionsAreAggregatedInPostgres_withTheSameSemanticsAsTheJavaFallback() {
        assertTrue(service.usesSqlUnreadAggregation(),
                "the PostgreSQL integration lane must take the SQL aggregation path");

        SessionParticipant counted = participants.saveAndFlush(new SessionParticipant(
                UUID.fromString(sessionId), SessionParticipant.KIND_AGENT, UUID.randomUUID(),
                SessionParticipant.ROLE_MEMBER, 10, SessionParticipant.WAKE_MENTION,
                SessionParticipant.RESPOND_WHEN_MENTIONED));
        SessionParticipant withoutCursor = participants.saveAndFlush(new SessionParticipant(
                UUID.fromString(sessionId), SessionParticipant.KIND_AGENT, UUID.randomUUID(),
                SessionParticipant.ROLE_MEMBER, 20, SessionParticipant.WAKE_MENTION,
                SessionParticipant.RESPOND_WHEN_MENTIONED));

        // Pointer sits on the first notify row ⇒ only rows after it count.
        long firstNotify = appendNotify(counted.getId(), 1L);
        cursors.saveAndFlush(new SessionParticipantCursor(counted.getId(), firstNotify));
        appendNotify(counted.getId(), 2L);
        appendNotify(counted.getId(), 3L);
        // A participant without a cursor row never accrues unread (Java fallback skips null thresholds).
        appendNotify(withoutCursor.getId(), 4L);
        // Non-notify outcomes and non-UUID participants must be ignored on both paths.
        appendWake(counted.getId(), "deferred", 5L);
        appendRaw("not-a-uuid", "notify", 6L);

        SessionParticipantService.ListView view = service.list(ownerId, workspaceId, sessionId);

        Map<UUID, Integer> unread = new LinkedHashMap<>();
        view.participants().forEach(row -> unread.put(row.participantId(),
                row.readCursor() == null ? 0 : row.readCursor().mentionCount()));

        assertNotNull(unread.get(counted.getId()), "counted participant must be in the roster");
        assertEquals(2, unread.get(counted.getId()),
                "two notify rows sit past the pointer; deferred/non-uuid rows must not count");
        assertEquals(0, unread.get(withoutCursor.getId()),
                "a participant without a cursor row counts nothing (null threshold)");
    }

    private long appendNotify(UUID participantId, long sequenceHint) {
        return appendWake(participantId, "notify", sequenceHint);
    }

    private long appendWake(UUID participantId, String outcome, long sequenceHint) {
        return appendRaw(participantId.toString(), outcome, sequenceHint);
    }

    private long appendRaw(String participantId, String outcome, long sequenceHint) {
        ObjectNode payload = json.createObjectNode();
        payload.put("outcome", outcome);
        payload.put("participantId", participantId);
        payload.put("wakeRoundId", "wake:p670:" + sequenceHint);
        return events.append(sessionId, workspaceId, ownerId, "wake_dispatch", payload).getSequence();
    }

    private AuthResponse register(String label) {
        var response = restTemplate.postForEntity(url("/api/v1/auth/register"),
                new RegisterRequest(label.toLowerCase(java.util.Locale.ROOT).replaceAll("[^a-z0-9]", "")
                        + "-" + UUID.randomUUID() + "@test.com",
                        TestDataFactory.PASSWORD, label), AuthResponse.class);
        assertEquals(201, response.getStatusCode().value());
        assertNotNull(response.getBody());
        return response.getBody();
    }
}
