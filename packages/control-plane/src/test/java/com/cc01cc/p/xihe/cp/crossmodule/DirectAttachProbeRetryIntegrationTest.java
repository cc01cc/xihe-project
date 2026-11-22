package com.cc01cc.p.xihe.cp.crossmodule;

import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.post;
import static com.github.tomakehurst.wiremock.client.WireMock.postRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.urlEqualTo;
import static com.github.tomakehurst.wiremock.stubbing.Scenario.STARTED;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.fail;

import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.web.client.HttpServerErrorException;

import java.io.IOException;
import java.nio.file.Files;
import java.util.Map;
import java.util.UUID;

/**
 * task-818: permanent regression gate for the task-795 direct-attach probe retry.
 *
 * <p>The Runtime's MXC probe has a 3 s budget, so a cold {@code wxc-exec --probe} can answer
 * {@code SANDBOX_PROBE_FAILED: probe timed out} once under load. CP absorbs exactly that
 * transient timeout with one bounded retry; every other unavailable reason keeps its original
 * outcome. Both call sites — the public capability preflight and workspace creation — are
 * covered here, in both directions:
 * <ul>
 *   <li>first probe times out, second is available ⇒ the caller succeeds and the probe ran twice;</li>
 *   <li>a non-timeout reason ⇒ the caller keeps that failure and the probe ran only once.</li>
 * </ul>
 *
 * <p>This class runs on the PostgreSQL lane ({@link AbstractWireMockPgTest}); the H2 lane is not
 * evidence for this contract.
 */
class DirectAttachProbeRetryIntegrationTest extends AbstractWireMockPgTest {

    private static final String PROBE_PATH =
            "/internal/v1/runtime/capabilities/direct-attach/probe";
    private static final String TIMEOUT_SCENARIO = "transient-probe-timeout";
    private static final String SECOND_STATE = "SECOND";
    private static final String TIMEOUT_REASON = "SANDBOX_PROBE_FAILED: probe timed out";

    @DynamicPropertySource
    static void configureRuntimeUrl(DynamicPropertyRegistry registry) {
        registry.add("cp.mcp.runtime-url", () -> "http://localhost:" + wireMock.port());
    }

    @Autowired
    private WorkspaceService workspaceService;

    @BeforeEach
    void resetProbeStubs() {
        wireMock.resetAll();
    }

    @Test
    void preflightRetriesOnceAfterTransientProbeTimeout() {
        stubTimedOutThenAvailable();

        Map<String, Object> snapshot = workspaceService.preflightDirectAttach(
                "direct_attach", "C:/work/repo", "windows-mxc");

        assertEquals(true, snapshot.get("available"),
                "the second probe answered available, so preflight must report the healthy snapshot");
        assertNotNull(snapshot.get("checkedAt"));
        wireMock.verify(2, postRequestedFor(urlEqualTo(PROBE_PATH)));
    }

    @Test
    void preflightDoesNotRetryANonTimeoutUnavailableReason() {
        stubUnavailable("MXC_EXECUTABLE_MISSING");

        Map<String, Object> snapshot = workspaceService.preflightDirectAttach(
                "direct_attach", "C:/work/repo", "windows-mxc");

        assertEquals(false, snapshot.get("available"));
        assertEquals("MXC_EXECUTABLE_MISSING", snapshot.get("reason"),
                "a non-timeout reason must be returned unchanged");
        wireMock.verify(1, postRequestedFor(urlEqualTo(PROBE_PATH)));
    }

    @Test
    void workspaceCreationRetriesOnceAfterTransientProbeTimeout() {
        stubTimedOutThenAvailable();
        String token = registerAndLogin();

        ResponseEntity<String> created = createDirectAttachWorkspace(token);

        assertEquals(HttpStatus.CREATED.value(), created.getStatusCode().value(), created.getBody());
        wireMock.verify(2, postRequestedFor(urlEqualTo(PROBE_PATH)));
    }

    @Test
    void workspaceCreationDoesNotRetryANonTimeoutUnavailableReason() {
        stubUnavailable("MXC_EXECUTABLE_MISSING");
        String token = registerAndLogin();

        try {
            createDirectAttachWorkspace(token);
            fail("a non-timeout probe failure must still reject direct_attach creation");
        } catch (HttpServerErrorException e) {
            assertEquals(HttpStatus.SERVICE_UNAVAILABLE.value(), e.getStatusCode().value());
            assertEquals(true, e.getResponseBodyAsString().contains("DIRECT_ATTACH_UNAVAILABLE"),
                    "the creation gate must report the direct-attach failure: " + e.getResponseBodyAsString());
            assertEquals(true, e.getResponseBodyAsString().contains("MXC_EXECUTABLE_MISSING"),
                    "the Runtime reason must survive the creation gate: " + e.getResponseBodyAsString());
        }
        wireMock.verify(1, postRequestedFor(urlEqualTo(PROBE_PATH)));
    }

    private void stubTimedOutThenAvailable() {
        wireMock.stubFor(post(urlEqualTo(PROBE_PATH))
                .inScenario(TIMEOUT_SCENARIO)
                .whenScenarioStateIs(STARTED)
                .willReturn(aResponse()
                        .withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withBody(probeBody(false, TIMEOUT_REASON)))
                .willSetStateTo(SECOND_STATE));
        wireMock.stubFor(post(urlEqualTo(PROBE_PATH))
                .inScenario(TIMEOUT_SCENARIO)
                .whenScenarioStateIs(SECOND_STATE)
                .willReturn(aResponse()
                        .withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withBody(probeBody(true, null))));
    }

    private void stubUnavailable(String reason) {
        wireMock.stubFor(post(urlEqualTo(PROBE_PATH))
                .willReturn(aResponse()
                        .withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withBody(probeBody(false, reason))));
    }

    private static String probeBody(boolean available, String reason) {
        StringBuilder body = new StringBuilder()
                .append("{\"contractVersion\":\"v1\",\"backendKind\":\"windows-mxc\",")
                .append("\"backendRevision\":\"builtin\",\"maturity\":\"experimental\",")
                .append("\"executionMode\":\"windows-mxc\",\"available\":")
                .append(available);
        if (reason != null) {
            body.append(",\"reason\":\"").append(reason).append('"');
        }
        return body.append('}').toString();
    }

    private ResponseEntity<String> createDirectAttachWorkspace(String token) {
        String hostPath;
        try {
            hostPath = Files.createTempDirectory("probe-retry-ws").toAbsolutePath().toString();
        } catch (IOException cause) {
            throw new IllegalStateException("cannot create the fixture host directory", cause);
        }
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.setBearerAuth(token);
        return restTemplate.exchange(url("/api/v1/workspaces"), HttpMethod.POST,
                new HttpEntity<>(Map.of(
                        "name", "probe-retry-" + UUID.randomUUID(),
                        "storageMode", "direct_attach",
                        "hostPath", hostPath,
                        "executionMode", "windows-host"), headers),
                String.class);
    }
}
