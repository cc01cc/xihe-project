package com.cc01cc.p.xihe.cp.config;

import jakarta.servlet.FilterChain;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0632 D32-06 / M2-3: the three behaviours the same-origin static serving must never lose.
 *
 * <ol>
 *   <li><b>Off means off.</b> With no {@code cp.ui.static-root} the filter is a pure pass-through —
 *       every request, including a traversal-looking one, reaches the original chain exactly as it
 *       did before this class existed. This is the one that protects the dev/host lanes and the
 *       whole existing suite.</li>
 *   <li><b>On means "shell now, API still yours".</b> {@code GET /} and deep SPA routes answer
 *       {@code index.html}, while every machine-facing prefix ({@code /api}, {@code /internal},
 *       {@code /actuator}, {@code /v3/api-docs}, {@code /swagger-ui}, {@code /error}) and every
 *       non-GET method keep the original chain — the SPA fallback must not rewrite a 404 or a 401
 *       into a 200 HTML page.</li>
 *   <li><b>Traversal is refused.</b> {@code ..}, encoded {@code %2e%2e}, backslashes and NUL never
 *       escape the root; the response is 400 and no file outside the root is ever read.</li>
 * </ol>
 *
 * <p>Deliberately a plain unit test: the filter's contract is "which chain gets the request", so it
 * is asserted without Spring, PostgreSQL or a servlet container. The end-to-end wiring (property →
 * bean → real HTTP) is covered by the installer smoke (M2-3 evidence) and by {@code ui-static}
 * launcher phase, which fails when the CP answers {@code /} with anything but 200.</p>
 */
class UiStaticServingFilterTest {

    private static final String SECRET = "TOP-SECRET-OUTSIDE-ROOT";
    private static final String INDEX_BODY = "<!doctype html><div id=\"app\">spa-shell</div>";
    private static final String ASSET_BODY = "console.log('asset');";

    private final AtomicInteger chained = new AtomicInteger();

    private Path base;
    private Path root;

    @BeforeEach
    void setUp() throws IOException {
        base = Files.createTempDirectory("ui-static-test");
        root = Files.createDirectories(base.resolve("ui"));
        Files.writeString(root.resolve("index.html"), INDEX_BODY, StandardCharsets.UTF_8);
        Path assets = Files.createDirectories(root.resolve("assets"));
        Files.writeString(assets.resolve("app.js"), ASSET_BODY, StandardCharsets.UTF_8);
        Files.writeString(base.resolve("secret.txt"), SECRET, StandardCharsets.UTF_8);
        chained.set(0);
    }

    @AfterEach
    void tearDown() throws IOException {
        if (base == null || !Files.exists(base)) {
            return;
        }
        try (Stream<Path> walk = Files.walk(base)) {
            for (Path path : walk.sorted(Comparator.reverseOrder()).toList()) {
                Files.deleteIfExists(path);
            }
        }
    }

    private FilterChain chain() {
        return (request, response) -> chained.incrementAndGet();
    }

    private MockHttpServletResponse get(UiStaticServingFilter filter, String uri) throws Exception {
        MockHttpServletRequest request = new MockHttpServletRequest("GET", uri);
        request.setRequestURI(uri);
        MockHttpServletResponse response = new MockHttpServletResponse();
        filter.doFilter(request, response, chain());
        return response;
    }

    private MockHttpServletResponse request(UiStaticServingFilter filter, String method, String uri)
            throws Exception {
        MockHttpServletRequest request = new MockHttpServletRequest(method, uri);
        request.setRequestURI(uri);
        MockHttpServletResponse response = new MockHttpServletResponse();
        filter.doFilter(request, response, chain());
        return response;
    }

    /* ------------------------------------------------ 1. off = unchanged */

    @Test
    void blankRootDisablesTheFilterAndKeepsTheOriginalChain() throws Exception {
        UiStaticServingFilter filter = new UiStaticServingFilter("");

        assertFalse(filter.isEnabled(), "an empty cp.ui.static-root must leave the filter inert");

        MockHttpServletResponse rootResponse = get(filter, "/");
        assertEquals(1, chained.get(), "GET / must reach the original chain when the filter is off");
        assertEquals(200, rootResponse.getStatus());
        assertEquals("", rootResponse.getContentAsString(), "the filter must not write a body when off");
        assertNull(rootResponse.getContentType());

        MockHttpServletResponse weirdResponse = get(filter, "/../../secret.txt");
        assertEquals(2, chained.get(), "even traversal-shaped paths keep the original chain when off");
        assertEquals(200, weirdResponse.getStatus());
    }

    @Test
    void whitespaceRootIsAlsoOff() {
        assertFalse(new UiStaticServingFilter("   ").isEnabled());
    }

    /* ------------------------------------------------- 2. on = shell + API */

    @Test
    void enabledServesIndexForTheRootPath() throws Exception {
        UiStaticServingFilter filter = new UiStaticServingFilter(root.toString());

        MockHttpServletResponse response = get(filter, "/");

        assertEquals(0, chained.get(), "a served file must not reach the original chain");
        assertEquals(200, response.getStatus());
        assertEquals(INDEX_BODY, response.getContentAsString());
        assertEquals("text/html; charset=utf-8", response.getContentType());
        assertEquals("no-store", response.getHeader("Cache-Control"));
    }

    @Test
    void enabledServesIndexForDeepSpaRoutes() throws Exception {
        UiStaticServingFilter filter = new UiStaticServingFilter(root.toString());

        MockHttpServletResponse response = get(filter, "/workspaces/abc/sessions/def");

        assertEquals(0, chained.get());
        assertEquals(200, response.getStatus());
        assertEquals(INDEX_BODY, response.getContentAsString());
    }

    @Test
    void enabledServesRealAssetsWithImmutableCaching() throws Exception {
        UiStaticServingFilter filter = new UiStaticServingFilter(root.toString());

        MockHttpServletResponse response = get(filter, "/assets/app.js");

        assertEquals(0, chained.get());
        assertEquals(200, response.getStatus());
        assertEquals(ASSET_BODY, response.getContentAsString());
        assertEquals("text/javascript; charset=utf-8", response.getContentType());
        assertEquals("public, max-age=31536000, immutable", response.getHeader("Cache-Control"));
    }

    @Test
    void missingAssetIs404AndNotTheSpaShell() throws Exception {
        UiStaticServingFilter filter = new UiStaticServingFilter(root.toString());

        MockHttpServletResponse response = get(filter, "/assets/missing.js");

        assertEquals(404, response.getStatus());
        assertEquals("", response.getContentAsString());
        assertEquals(0, chained.get(), "a missing asset is still our answer, not the API's");
    }

    @ParameterizedTest
    @ValueSource(strings = {
            "/api",
            "/api/v1/health",
            "/api/v1/workspaces/abc/sessions",
            "/internal",
            "/internal/v1/agent/health",
            "/actuator/health",
            "/v3/api-docs",
            "/v3/api-docs/swagger-config",
            "/swagger-ui.html",
            "/swagger-ui/index.html",
            "/error"})
    void apiSurfacesKeepTheOriginalChain(String uri) throws Exception {
        UiStaticServingFilter filter = new UiStaticServingFilter(root.toString());

        MockHttpServletResponse response = get(filter, uri);

        assertEquals(1, chained.get(), uri + " must not be answered by the SPA fallback");
        assertEquals(200, response.getStatus());
        assertEquals("", response.getContentAsString());
    }

    @Test
    void nonReadMethodsKeepTheOriginalChain() throws Exception {
        UiStaticServingFilter filter = new UiStaticServingFilter(root.toString());

        MockHttpServletResponse response = request(filter, "POST", "/workspaces");

        assertEquals(1, chained.get());
        assertEquals(200, response.getStatus());
    }

    @Test
    void headRequestsAnswerHeadersWithoutABody() throws Exception {
        UiStaticServingFilter filter = new UiStaticServingFilter(root.toString());

        MockHttpServletResponse response = request(filter, "HEAD", "/");

        assertEquals(0, chained.get());
        assertEquals(200, response.getStatus());
        assertEquals(INDEX_BODY.getBytes(StandardCharsets.UTF_8).length, response.getContentLength());
        assertEquals("", response.getContentAsString());
    }

    /* ------------------------------------------------------ 3. traversal */

    @ParameterizedTest
    @ValueSource(strings = {
            "/../secret.txt",
            "/assets/../../secret.txt",
            "/%2e%2e/secret.txt",
            "/assets/%2E%2E/%2E%2E/secret.txt",
            "/..%5csecret.txt"})
    void traversalIsRefusedWithoutReadingOutsideTheRoot(String uri) throws Exception {
        UiStaticServingFilter filter = new UiStaticServingFilter(root.toString());

        MockHttpServletResponse response = get(filter, uri);

        assertEquals(400, response.getStatus(), uri + " must be rejected");
        assertFalse(response.getContentAsString().contains(SECRET), "the response must not leak the file");
        assertEquals(0, chained.get(), "a refused path must not fall through to the API either");
    }

    @Test
    void missingStaticRootDegradesToTheOriginalChain() throws Exception {
        UiStaticServingFilter filter = new UiStaticServingFilter(base.resolve("does-not-exist").toString());

        assertFalse(filter.isEnabled(), "a configured but absent root must not half-enable the filter");
        get(filter, "/");

        assertEquals(1, chained.get());
    }

    @Test
    void rootWithoutIndexStillServesAssetsAnd404sDeepRoutes() throws Exception {
        Path bare = Files.createDirectories(base.resolve("bare"));
        Files.writeString(bare.resolve("app.css"), "body{}", StandardCharsets.UTF_8);
        UiStaticServingFilter filter = new UiStaticServingFilter(bare.toString());

        MockHttpServletResponse asset = get(filter, "/app.css");
        assertEquals(200, asset.getStatus());
        assertEquals("text/css; charset=utf-8", asset.getContentType());

        MockHttpServletResponse deep = get(filter, "/workspaces/abc");
        assertEquals(404, deep.getStatus(), "no index.html ⇒ an honest 404, never an empty 200");
    }

    @Test
    void htmlIsServedAsUtf8NotAsThePlatformCharset() throws Exception {
        UiStaticServingFilter filter = new UiStaticServingFilter(root.toString());
        Files.writeString(root.resolve("note.txt"), "中文", StandardCharsets.UTF_8);

        MockHttpServletResponse response = get(filter, "/note.txt");

        assertEquals("中文", response.getContentAsString(), "charset must be pinned, not platform dependent");
        assertTrue(response.getContentType().startsWith("text/plain"));
    }
}
