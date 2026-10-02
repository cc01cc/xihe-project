package com.cc01cc.p.xihe.cp.runtime;

import com.cc01cc.p.xihe.cp.runtime.RuntimeContextSourceClient.SourceRead;
import com.cc01cc.p.xihe.cp.runtime.RuntimeContextSourceClient.SourceReadKind;
import com.github.tomakehurst.wiremock.WireMockServer;
import com.github.tomakehurst.wiremock.core.WireMockConfiguration;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.web.client.RestTemplate;

import java.util.Map;
import java.util.Optional;

import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.exactly;
import static com.github.tomakehurst.wiremock.client.WireMock.post;
import static com.github.tomakehurst.wiremock.client.WireMock.get;
import static com.github.tomakehurst.wiremock.client.WireMock.postRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.getRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.urlEqualTo;
import static com.github.tomakehurst.wiremock.stubbing.Scenario.STARTED;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * PLAN-0382 T3.2: {@link RuntimeContextSourceClient} wire contract against a
 * real HTTP server (WireMock, no Spring context).
 *
 * <p>Freezes spec §3's wire→status mapping (found/not-found/error three-state,
 * 4xx→failed, transport/5xx→unavailable) and T1.4's bounded retry rule (ONE
 * immediate retry, transport + 5xx only, 4xx never retried).
 */
class RuntimeContextSourceContractTest {

    private static final WireMockServer wireMock =
            new WireMockServer(WireMockConfiguration.wireMockConfig().dynamicPort());

    private RuntimeContextSourceClient client;

    @BeforeAll
    static void startServer() {
        wireMock.start();
    }

    @AfterAll
    static void stopServer() {
        wireMock.stop();
    }

    @BeforeEach
    void setUp() {
        wireMock.resetAll();
        client = new RuntimeContextSourceClient(
                new RestTemplate(),
                "http://localhost:" + wireMock.port(),
                "test-token");
    }

    private String readPath() {
        return "/internal/v1/runtime/workspaces/ws-1/files/read";
    }

    @Test
    void foundTrueWithContentIsContent() {
        wireMock.stubFor(post(urlEqualTo(readPath())).willReturn(
                aResponse().withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withBody("{\"found\":true,\"content\":\"# rules\",\"truncated\":false}")));

        SourceRead read = client.readAgents("ws-1");

        assertThat(read.kind()).isEqualTo(SourceReadKind.CONTENT);
        assertThat(read.content()).isEqualTo("# rules");
    }

    @Test
    void foundFalseIsAbsent() {
        wireMock.stubFor(post(urlEqualTo(readPath())).willReturn(
                aResponse().withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withBody("{\"found\":false,\"content\":\"\",\"truncated\":false}")));

        SourceRead read = client.readAgents("ws-1");

        assertThat(read.kind()).isEqualTo(SourceReadKind.ABSENT);
    }

    @Test
    void mixedDeploymentWithoutFoundKeyWithContentIsContent() {
        // spec §5 mixed rule: old Runtime answers {content} only → ok.
        wireMock.stubFor(post(urlEqualTo(readPath())).willReturn(
                aResponse().withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withBody("{\"content\":\"# legacy rules\",\"truncated\":false}")));

        SourceRead read = client.readAgents("ws-1");

        assertThat(read.kind()).isEqualTo(SourceReadKind.CONTENT);
        assertThat(read.content()).isEqualTo("# legacy rules");
    }

    @Test
    void malformed200BodyIsFailed() {
        wireMock.stubFor(post(urlEqualTo(readPath())).willReturn(
                aResponse().withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withBody("{\"unexpected\":true}")));

        SourceRead read = client.readAgents("ws-1");

        assertThat(read.kind()).isEqualTo(SourceReadKind.ERROR);
        assertThat(read.failureStatus()).isEqualTo("failed");
    }

    @Test
    void http404IsFailedWithoutRetry() {
        wireMock.stubFor(post(urlEqualTo(readPath())).willReturn(
                aResponse().withStatus(404).withHeader("Content-Type", "application/json")
                        .withBody("{\"code\":\"WORKSPACE_NOT_FOUND\"}")));

        SourceRead read = client.readAgents("ws-1");

        assertThat(read.kind()).isEqualTo(SourceReadKind.ERROR);
        assertThat(read.httpStatus()).isEqualTo(404);
        assertThat(read.failureStatus()).isEqualTo("failed");
        wireMock.verify(exactly(1), postRequestedFor(urlEqualTo(readPath())));
    }

    @Test
    void http500RetriesOnceThenUnavailable() {
        wireMock.stubFor(post(urlEqualTo(readPath()))
                .inScenario("5xx")
                .whenScenarioStateIs(STARTED)
                .willReturn(aResponse().withStatus(500))
                .willSetStateTo("second"));
        wireMock.stubFor(post(urlEqualTo(readPath()))
                .inScenario("5xx")
                .whenScenarioStateIs("second")
                .willReturn(aResponse().withStatus(500)));

        SourceRead read = client.readAgents("ws-1");

        assertThat(read.kind()).isEqualTo(SourceReadKind.ERROR);
        assertThat(read.failureStatus()).isEqualTo("unavailable");
        wireMock.verify(exactly(2), postRequestedFor(urlEqualTo(readPath())));
    }

    @Test
    void transportFailureIsUnavailable() {
        RuntimeContextSourceClient dead = new RuntimeContextSourceClient(
                new RestTemplate(), "http://localhost:1", "test-token");

        SourceRead read = dead.readAgents("ws-1");

        assertThat(read.kind()).isEqualTo(SourceReadKind.ERROR);
        assertThat(read.httpStatus()).isNull();
        assertThat(read.failureStatus()).isEqualTo("unavailable");
    }

    @Test
    void gitFactsRetries5xxOnce() {
        wireMock.stubFor(get(urlEqualTo("/internal/v1/runtime/workspaces/ws-1/git-facts"))
                .inScenario("facts")
                .whenScenarioStateIs(STARTED)
                .willReturn(aResponse().withStatus(503))
                .willSetStateTo("second"));
        wireMock.stubFor(get(urlEqualTo("/internal/v1/runtime/workspaces/ws-1/git-facts"))
                .inScenario("facts")
                .whenScenarioStateIs("second")
                .willReturn(aResponse().withStatus(503)));

        Optional<Map<String, Object>> facts = client.readGitFacts("ws-1");

        assertThat(facts).isEmpty();
        wireMock.verify(exactly(2),
                getRequestedFor(urlEqualTo("/internal/v1/runtime/workspaces/ws-1/git-facts")));
    }

    @Test
    void gitFactsOldShapePassesThroughUntouched() {
        // Mixed deployment: no observedAt/cwd/platform/shell keys — the client
        // must not invent them (service maps absence → env_status=unknown).
        wireMock.stubFor(get(urlEqualTo("/internal/v1/runtime/workspaces/ws-1/git-facts"))
                .willReturn(aResponse().withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withBody("{\"isRepository\":false}")));

        Optional<Map<String, Object>> facts = client.readGitFacts("ws-1");

        assertThat(facts).isPresent();
        assertThat(facts.get()).containsOnlyKeys("isRepository");
    }

    @Test
    void http404OnGitFactsDoesNotRetry() {
        wireMock.stubFor(get(urlEqualTo("/internal/v1/runtime/workspaces/ws-1/git-facts"))
                .willReturn(aResponse().withStatus(404)));

        assertThat(client.readGitFacts("ws-1")).isEmpty();
        wireMock.verify(exactly(1),
                getRequestedFor(urlEqualTo("/internal/v1/runtime/workspaces/ws-1/git-facts")));
    }

    @Test
    void failureStatusMappingMatchesFrozenWireTable() {
        assertThat(SourceRead.error(null).failureStatus()).isEqualTo("unavailable");
        assertThat(SourceRead.error(503).failureStatus()).isEqualTo("unavailable");
        assertThat(SourceRead.error(404).failureStatus()).isEqualTo("failed");
        assertThat(SourceRead.error(200).failureStatus()).isEqualTo("failed");
    }
}
