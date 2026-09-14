package com.cc01cc.p.xihe.cp.runtime;

import com.cc01cc.p.xihe.cp.AppConfig;
import org.junit.jupiter.api.Test;
import org.springframework.web.client.RestTemplate;

import java.net.ServerSocket;
import java.net.Socket;
import java.time.Duration;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertTimeoutPreemptively;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * CHN-5: CP → Runtime calls must fail fast when the Runtime accepts the TCP
 * connection but never responds. Without the bounded RestTemplate the request
 * thread would hang indefinitely; with the read timeout it surfaces through the
 * existing "unavailable" path.
 */
class RuntimeWorkspaceClientTimeoutTest {

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
