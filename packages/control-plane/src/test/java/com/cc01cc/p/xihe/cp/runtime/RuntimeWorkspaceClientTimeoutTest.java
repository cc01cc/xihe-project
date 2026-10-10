package com.cc01cc.p.xihe.cp.runtime;

import com.cc01cc.p.xihe.cp.AppConfig;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.web.client.RestTemplate;
import org.springframework.test.web.client.MockRestServiceServer;

import java.net.ServerSocket;
import java.net.Socket;
import java.time.Duration;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertTimeoutPreemptively;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.method;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withStatus;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess;

/**
 * CHN-5: CP → Runtime calls must fail fast when the Runtime accepts the TCP
 * connection but never responds. Without the bounded RestTemplate the request
 * thread would hang indefinitely; with the read timeout it surfaces through the
 * existing "unavailable" path.
 */
class RuntimeWorkspaceClientTimeoutTest {

    @Test
    void detailedStatusDistinguishesUnboundFromUnreachable() {
        RestTemplate restTemplate = new RestTemplate();
        MockRestServiceServer server = MockRestServiceServer.bindTo(restTemplate).build();
        String url = "http://runtime.test/internal/v1/runtime/workspaces/ws-1/status";
        RuntimeWorkspaceClient client = new RuntimeWorkspaceClient(
                restTemplate, "http://runtime.test", "test-token");

        server.expect(requestTo(url)).andExpect(method(HttpMethod.GET))
                .andRespond(withStatus(HttpStatus.NOT_FOUND));
        server.expect(requestTo(url)).andExpect(method(HttpMethod.GET))
                .andRespond(withStatus(HttpStatus.INTERNAL_SERVER_ERROR));

        RuntimeWorkspaceClient.RuntimeStatusResult unbound = client.fetchStatusDetailed("ws-1");
        assertTrue(unbound.unbound());
        assertFalse(unbound.unreachable());
        RuntimeWorkspaceClient.RuntimeStatusResult unavailable = client.fetchStatusDetailed("ws-1");
        assertFalse(unavailable.unbound());
        assertTrue(unavailable.unreachable());
        server.verify();
    }

    @Test
    void detailedStatusCarriesRuntimeProjection() {
        RestTemplate restTemplate = new RestTemplate();
        MockRestServiceServer server = MockRestServiceServer.bindTo(restTemplate).build();
        server.expect(requestTo("http://runtime.test/internal/v1/runtime/workspaces/ws-1/status"))
                .andExpect(method(HttpMethod.GET))
                .andRespond(withSuccess("{\"state\":\"creating\"}", MediaType.APPLICATION_JSON));

        RuntimeWorkspaceClient.RuntimeStatusResult result = new RuntimeWorkspaceClient(
                restTemplate, "http://runtime.test", "test-token").fetchStatusDetailed("ws-1");

        assertFalse(result.unbound());
        assertFalse(result.unreachable());
        assertEquals("creating", result.body().get("state"));
        server.verify();
    }

    @Test
    void materializePreservesRuntimeProblemCodeAndStatus() {
        RestTemplate restTemplate = new RestTemplate();
        MockRestServiceServer server = MockRestServiceServer.bindTo(restTemplate).build();
        server.expect(requestTo("http://runtime.test/internal/v1/runtime/workspaces/ws-1/materialize"))
                .andExpect(method(HttpMethod.POST))
                .andRespond(withStatus(HttpStatus.CONFLICT)
                        .contentType(MediaType.APPLICATION_JSON)
                        .body("{\"code\":\"WORKSPACE_DESTROYING\",\"detail\":\"destroy in progress\"}"));

        RuntimeWorkspaceClient.MaterializeResult result = new RuntimeWorkspaceClient(
                restTemplate, "http://runtime.test", "test-token").materialize("ws-1");

        assertEquals(409, result.httpStatus());
        assertEquals("WORKSPACE_DESTROYING", result.problemCode());
        assertEquals("destroy in progress", result.problemDetail());
        assertFalse(result.unreachable());
        server.verify();
    }

    @Test
    void statusFetchIsBoundedWhenRuntimeAcceptsButNeverResponds() throws Exception {
        try (ServerSocket server = new ServerSocket(0)) {
            Thread silentServer = new Thread(() -> {
                try (Socket socket = server.accept()) {
                    Thread.sleep(30_000);
                } catch (Exception ignored) {
                    // test teardown closes the socket
                }
            });
            silentServer.setDaemon(true);
            silentServer.start();

            RestTemplate restTemplate = new AppConfig().restTemplate();
            RuntimeWorkspaceClient client = new RuntimeWorkspaceClient(
                    restTemplate, "http://127.0.0.1:" + server.getLocalPort(), "test-token");

            Optional<Map<String, Object>> result = assertTimeoutPreemptively(
                    Duration.ofSeconds(15),
                    () -> client.fetchStatus("ws-1"),
                    "CP → Runtime call must be bounded by the read timeout");

            assertTrue(result.isEmpty(), "half-dead Runtime must surface as unavailable");
        }
    }
}
