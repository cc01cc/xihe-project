package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.github.tomakehurst.wiremock.WireMockServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;

import java.util.UUID;

import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.equalTo;
import static com.github.tomakehurst.wiremock.client.WireMock.equalToJson;
import static com.github.tomakehurst.wiremock.client.WireMock.post;
import static com.github.tomakehurst.wiremock.client.WireMock.postRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.urlEqualTo;
import static com.github.tomakehurst.wiremock.core.WireMockConfiguration.wireMockConfig;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0660 M5-B / T5.12: the CP→Agent delivery wire, on a real HTTP stub.
 *
 * <p>Freezes the contract the Agent side must implement (the question counterpart of
 * {@code api/approval.py:15-34}): {@code POST /internal/v1/agent/user-question/respond}, service
 * bearer, camelCase body, 2xx = delivered. Every other outcome is one fail-closed error, because the
 * service rolls the state advance back on it.</p>
 */
class UserQuestionAgentClientTest {

    private static final String TOKEN = "test-service-token";
    private static final String PATH = "/internal/v1/agent/user-question/respond";
    private static final String QUESTION_ID = "11111111-1111-1111-1111-111111111111";
    private static final String SESSION_ID = "22222222-2222-2222-2222-222222222222";
    private static final String RUN_ID = "33333333-3333-3333-3333-333333333333";
    private static final String ANSWER = "rebase onto develop";

    private final ObjectMapper json = new ObjectMapper();
    private WireMockServer wireMock;

    @BeforeEach
    void startStub() {
        wireMock = new WireMockServer(wireMockConfig().dynamicPort());
        wireMock.start();
    }

    @AfterEach
    void stopStub() {
        wireMock.stop();
    }

    @Test
    void respond_postsTheFrozenWireShapeWithServiceBearer() {
        String expectedBody = "{\"questionId\":\"" + QUESTION_ID + "\",\"sessionId\":\"" + SESSION_ID
                + "\",\"runId\":\"" + RUN_ID + "\",\"answer\":\"" + ANSWER + "\"}";
        wireMock.stubFor(post(urlEqualTo(PATH))
                .withHeader("Authorization", equalTo("Bearer " + TOKEN))
                .withHeader("Content-Type", equalTo("application/json"))
                .withRequestBody(equalToJson(expectedBody))
                .willReturn(aResponse().withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withBody("{\"status\":\"accepted\"}")));

        client().respond(QUESTION_ID, SESSION_ID, RUN_ID, ANSWER);

        // A stub only serves a request whose path, method, headers and body all match, so a served
        // event is the assertion that the frozen wire shape left the process.
        wireMock.verify(1, postRequestedFor(urlEqualTo(PATH))
                .withHeader("Authorization", equalTo("Bearer " + TOKEN)));
        assertEquals(1, wireMock.getAllServeEvents().size());
    }

    @Test
    void respond_acceptsAReplayedDelivery() {
        wireMock.stubFor(post(urlEqualTo(PATH)).willReturn(aResponse().withStatus(200)
                .withHeader("Content-Type", "application/json")
                .withBody("{\"status\":\"already_delivered\"}")));

        client().respond(QUESTION_ID, SESSION_ID, RUN_ID, ANSWER);

        assertEquals(1, wireMock.getAllServeEvents().size(),
                "a replay is a normal outcome, not an error — the Agent answers 200 again");
    }

    @Test
    void respond_mapsEveryNon2xxToTheSameFailClosedError() {
        for (int status : new int[] {400, 404, 409, 410, 500, 503}) {
            wireMock.resetAll();
            wireMock.stubFor(post(urlEqualTo(PATH)).willReturn(aResponse().withStatus(status)));

            CpApiException failure = assertThrows(CpApiException.class,
                    () -> client().respond(QUESTION_ID, SESSION_ID, RUN_ID, ANSWER));

            assertEquals(HttpStatus.BAD_GATEWAY, failure.getStatus(),
                    "status " + status + " must not be reinterpreted as a decided question");
            assertEquals("AGENT_QUESTION_DELIVERY_FAILED", failure.getCode());
            assertTrue(failure.getMessage().contains(String.valueOf(status)),
                    "the upstream status belongs in the diagnosis: " + failure.getMessage());
            assertFalse(failure.getMessage().contains(ANSWER),
                    "the answer body must never reach a problem detail");
        }
    }

    @Test
    void respond_reportsAnUnreachableAgentAsADeliveryFailure() {
        // Port 1 has no listener: connection refused, i.e. the Agent is down.
        UserQuestionAgentClient offline = new UserQuestionAgentClient(json, "http://127.0.0.1:1", TOKEN);

        CpApiException failure = assertThrows(CpApiException.class,
                () -> offline.respond(QUESTION_ID, SESSION_ID, RUN_ID, ANSWER));

        assertEquals(HttpStatus.BAD_GATEWAY, failure.getStatus());
        assertEquals("AGENT_QUESTION_DELIVERY_FAILED", failure.getCode());
    }

    @Test
    void respond_rejectsMalformedInputBeforeAnyCall() {
        UserQuestionAgentClient client = client();
        assertEquals("INVALID_REQUEST", assertThrows(CpApiException.class,
                () -> client.respond("not-a-uuid", SESSION_ID, RUN_ID, ANSWER)).getCode());
        assertEquals("INVALID_REQUEST", assertThrows(CpApiException.class,
                () -> client.respond(QUESTION_ID, UUID.randomUUID() + "-bad", RUN_ID, ANSWER)).getCode());
        assertEquals("INVALID_REQUEST", assertThrows(CpApiException.class,
                () -> client.respond(QUESTION_ID, SESSION_ID, RUN_ID, "   ")).getCode());
        assertEquals(0, wireMock.getAllServeEvents().size(),
                "nothing may leave the process for input that cannot be delivered");
    }

    private UserQuestionAgentClient client() {
        return new UserQuestionAgentClient(json, wireMock.baseUrl(), TOKEN);
    }
}
