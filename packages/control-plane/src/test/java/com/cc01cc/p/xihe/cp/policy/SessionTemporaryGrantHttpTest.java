package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.mockito.Mockito;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * task-200 / DSD-1509 follow-up: the <b>wire face</b> of {@code POST
 * /api/v1/sessions/{sessionId}/temporary-grants}.
 *
 * <p><b>Why this test exists.</b> task-124 shipped the controller binding
 * {@code @RequestBody com.fasterxml.jackson.databind.JsonNode}. Boot 4 binds request bodies with
 * <b>Jackson 3</b>, so the Jackson-2 node could not be constructed and every request that carried a
 * body died <em>before the handler ran</em>. The service-level integration test
 * ({@link SessionTemporaryGrantIntegrationTest}) calls {@code service.issue(...)} directly and
 * therefore never crossed a mapper — that is how the defect shipped with a green suite. This class
 * crosses the real HTTP converter instead: standalone MockMvc in Boot 4 wires the same Jackson-3
 * converter production uses (measured for task-67, see {@code Jackson2NodeInboundScanTest}), so a
 * Jackson-2 binding face fails here exactly as it fails in production.</p>
 *
 * <p><b>What is asserted.</b> Not "the response is not a 500" — that would also pass if the body
 * were deserialised into an empty object. The readings below tie the <em>request</em> fields to the
 * <em>service call</em> (the Jackson-2 atom tree the store would persist, and the TTL) and the
 * <em>response</em> body to the created row: the two ends of the wire, not a status code.</p>
 */
class SessionTemporaryGrantHttpTest {

    private static final String SESSION_ID = "a1111111-1111-4111-8111-111111111111";
    private static final String USER_ID = "c1111111-1111-4111-8111-111111111111";
    private static final String WORKSPACE_ID = "b1111111-1111-4111-8111-111111111111";
    private static final String PRINCIPAL_ID = "d1111111-1111-4111-8111-111111111111";
    private static final String GRANT_ID = "e1111111-1111-4111-8111-111111111111";
    private static final String BASE = "/api/v1/sessions/" + SESSION_ID + "/temporary-grants";

    private SessionTemporaryGrantService service;
    private MockMvc mockMvc;

    @BeforeEach
    void setUp() {
        service = Mockito.mock(SessionTemporaryGrantService.class);
        mockMvc = MockMvcBuilders
                .standaloneSetup(new SessionTemporaryGrantController(service, new ObjectMapper()))
                .setControllerAdvice(new ProblemDetailsHandler(5000))
                .build();
        TenantContext.setUserId(USER_ID);
        TenantContext.setWorkspaceId(WORKSPACE_ID);
    }

    @AfterEach
    void tearDown() {
        TenantContext.clear();
    }

    /**
     * The defect's own reading: a body carrying {@code atoms} + {@code ttlSeconds} must reach the
     * handler, arrive at the service as a Jackson-2 array of {@code {actionClass, resource?}}, and
     * come back as the created row's contract fields.
     */
    @Test
    void aJsonBodyReachesTheServiceAsAGrantTreeAndTheResponseIsTheCreatedRow() throws Exception {
        when(service.issue(eq(USER_ID), eq(WORKSPACE_ID), eq(SESSION_ID), any(), any()))
                .thenReturn(row());
        String body = "{\"atoms\":[{\"actionClass\":\"read\",\"resource\":\"fs:ws-1/**\"},"
                + "{\"actionClass\":\"write\"}],\"ttlSeconds\":600}";

        mockMvc.perform(post(BASE).contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.id").value(GRANT_ID))
                .andExpect(jsonPath("$.sessionId").value(SESSION_ID))
                .andExpect(jsonPath("$.principalId").value(PRINCIPAL_ID))
                .andExpect(jsonPath("$.atoms[0].actionClass").value("read"))
                .andExpect(jsonPath("$.atoms[0].resource").value("fs:ws-1/**"))
                .andExpect(jsonPath("$.atoms[1].actionClass").value("write"))
                .andExpect(jsonPath("$.atoms[1].resource").value("*"))
                .andExpect(jsonPath("$.grantedBy").value(USER_ID))
                .andExpect(jsonPath("$.expiresAt").value("2026-11-21T10:15:00Z"));

        ArgumentCaptor<JsonNode> atoms = ArgumentCaptor.forClass(JsonNode.class);
        ArgumentCaptor<Integer> ttl = ArgumentCaptor.forClass(Integer.class);
        verify(service).issue(eq(USER_ID), eq(WORKSPACE_ID), eq(SESSION_ID), atoms.capture(), ttl.capture());

        JsonNode tree = atoms.getValue();
        assertNotNull(tree, "the atoms array must reach the service as a tree, not as null");
        assertTrue(tree.isArray(), "atoms must arrive as an array: " + tree);
        assertEquals(2, tree.size(), "both atoms must survive the wire: " + tree);
        assertEquals("read", tree.get(0).get("actionClass").asText());
        assertEquals("fs:ws-1/**", tree.get(0).get("resource").asText());
        assertEquals("write", tree.get(1).get("actionClass").asText());
        assertFalse(tree.get(1).has("resource"),
                "an omitted resource must stay omitted (the service reads absence as the wildcard): " + tree);
        assertEquals(600, ttl.getValue(), "ttlSeconds must reach the service as the integer it was");
    }

    /** The TTL guard still lives on the controller side of the wire, after the binding change. */
    @Test
    void aNonIntegralTtlIsRefusedWithTheSameInvalidRequestCode() throws Exception {
        mockMvc.perform(post(BASE).contentType(MediaType.APPLICATION_JSON)
                        .content("{\"atoms\":[{\"actionClass\":\"read\"}],\"ttlSeconds\":1.5}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("INVALID_REQUEST"))
                .andExpect(jsonPath("$.detail").value("ttlSeconds must be an integer number of seconds"));

        verify(service, Mockito.never()).issue(any(), any(), any(), any(), any());
    }

    /** {@code required = false} is part of the contract: an absent body must reach the service as nulls. */
    @Test
    void anAbsentBodyReachesTheServiceAsNullAtomsAndNullTtl() throws Exception {
        when(service.issue(eq(USER_ID), eq(WORKSPACE_ID), eq(SESSION_ID), any(), any()))
                .thenReturn(row());

        mockMvc.perform(post(BASE))
                .andExpect(status().isCreated());

        ArgumentCaptor<JsonNode> atoms = ArgumentCaptor.forClass(JsonNode.class);
        ArgumentCaptor<Integer> ttl = ArgumentCaptor.forClass(Integer.class);
        verify(service).issue(eq(USER_ID), eq(WORKSPACE_ID), eq(SESSION_ID), atoms.capture(), ttl.capture());
        assertNull(atoms.getValue(), "no body means no atoms tree");
        assertNull(ttl.getValue(), "no body means no TTL (the service applies its default)");
    }

    /** The row the mocked service returns; every field the response view renders is distinct on purpose. */
    private static SessionTemporaryGrant row() {
        Instant grantedAt = Instant.parse("2026-11-21T10:00:00Z");
        return new SessionTemporaryGrant(
                UUID.fromString(GRANT_ID),
                UUID.fromString(SESSION_ID),
                UUID.fromString(WORKSPACE_ID),
                UUID.fromString(PRINCIPAL_ID),
                List.of(new GrantIntersectionEvaluator.PermissionAtom("read", "fs:ws-1/**"),
                        new GrantIntersectionEvaluator.PermissionAtom("write", null)),
                UUID.fromString(USER_ID),
                grantedAt,
                Instant.parse("2026-11-21T10:15:00Z"),
                null,
                null);
    }
}
