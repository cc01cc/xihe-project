package com.cc01cc.p.xihe.cp.support;

import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpRequest;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.client.ClientHttpRequestExecution;
import org.springframework.http.client.ClientHttpRequestInterceptor;
import org.springframework.http.client.ClientHttpResponse;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/**
 * PLAN-0633 C1-4 (D33-11): the runtime net for "a Jackson-2 {@code JsonNode} must never reach the
 * wire".
 *
 * <p>Attached once to the {@code RestTemplate} of each real-HTTP test base class
 * ({@code AbstractIntegrationTest}, {@code AbstractH2Test}, {@code AbstractWireMockTest}), it asserts
 * {@link Jackson2NodeWire#assertClean} on <em>every</em> response those suites receive — the dominant
 * test lane in this module is {@code @SpringBootTest(RANDOM_PORT)} (real Tomcat, real Jackson 3
 * serialisation), which is exactly where the fingerprint appears.
 *
 * <p>Limits (documented, not hidden): streaming responses (SSE) are not read as a body by
 * {@code RestTemplate}, and endpoints no test calls stay uncovered — the static gate and the explicit
 * gold-path assertions cover those.
 */
public final class Jackson2NodeWireInterceptor implements ClientHttpRequestInterceptor {

    public static final Jackson2NodeWireInterceptor INSTANCE = new Jackson2NodeWireInterceptor();

    private Jackson2NodeWireInterceptor() {}

    @Override
    public ClientHttpResponse intercept(HttpRequest request, byte[] body, ClientHttpRequestExecution execution)
            throws IOException {
        ClientHttpResponse response = execution.execute(request, body);
        byte[] payload;
        try (InputStream stream = response.getBody()) {
            payload = stream.readAllBytes();
        }
        // fail() throws AssertionFailedError here, which surfaces at the caller's assertion site.
        Jackson2NodeWire.assertClean(new String(payload, StandardCharsets.UTF_8),
                request.getMethod() + " " + request.getURI().getPath());
        return new BufferedResponse(response, payload);
    }

    /** Replays the already-read body so the caller sees an unchanged response. */
    private static final class BufferedResponse implements ClientHttpResponse {

        private final ClientHttpResponse delegate;
        private final byte[] payload;

        private BufferedResponse(ClientHttpResponse delegate, byte[] payload) {
            this.delegate = delegate;
            this.payload = payload;
        }

        @Override
        public HttpStatusCode getStatusCode() throws IOException {
            return delegate.getStatusCode();
        }

        @Override
        public String getStatusText() throws IOException {
            return delegate.getStatusText();
        }

        @Override
        public HttpHeaders getHeaders() {
            return delegate.getHeaders();
        }

        @Override
        public InputStream getBody() {
            return new ByteArrayInputStream(payload);
        }

        @Override
        public void close() {
            delegate.close();
        }
    }
}
