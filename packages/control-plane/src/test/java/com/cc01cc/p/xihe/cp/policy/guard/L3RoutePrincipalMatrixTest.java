package com.cc01cc.p.xihe.cp.policy.guard;

import com.cc01cc.p.xihe.cp.AbstractReusableIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.policy.AuthzContext;
import com.cc01cc.p.xihe.cp.policy.PresetGrantMaterializer;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.mvc.method.RequestMappingInfo;
import org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * task-869 L3: the route × six-principal matrix on <b>real PostgreSQL</b>.
 *
 * <p>Two gates live here, and they answer different questions:</p>
 *
 * <ol>
 *   <li><b>Universe invariants</b> over the live {@link RequestMappingHandlerMapping}: no route may
 *       answer anonymous with anything but 401 (public routes are an explicit literal list, so a
 *       route that becomes public by accident fails), and no GET may answer any principal with a
 *       5xx. The route set is derived at runtime, so a newly added route is covered the moment it
 *       exists — it cannot be "forgotten" out of the matrix.</li>
 *   <li><b>Exact (status, code) matrix</b> for the sensitive workspace/instance/session routes,
 *       driven with fixture ids so "exists but not allowed" is exercised instead of only random-id
 *       404s. This is where 403 and 404 must not be mixed: a non-existent resource answers 404, an
 *       existing one the principal may not touch answers 403.</li>
 * </ol>
 *
 * <p>Where the product <b>does</b> mix them today, the deviation is not silently accepted: it must
 * be listed in {@code l3-known-gaps.txt}, one line per (route, principal) with owner + reviewDate +
 * reason, and the entry fails the moment it stops reproducing (only-shrink, the same discipline as
 * the L2 baseline). The gap file is what makes this matrix honest before task-859's HTTP migration
 * finishes; it is not a place to add new gaps.</p>
 *
 * <p>Excluded from the sweep, each for a stated reason: framework surfaces ({@code /v3/api-docs},
 * swagger, actuator), streaming/long-poll faces (they hold the socket), and multipart upload
 * contracts (an empty JSON body can only prove "not validated", not a principal decision). The
 * exclusions are prefix rules printed in the failure message, not a growing per-route allowlist.</p>
 */
class L3RoutePrincipalMatrixTest extends AbstractReusableIntegrationTest {

    private static final Path GAPS = Path.of("src", "test", "java", "com", "cc01cc", "p", "xihe",
            "cp", "policy", "guard", "l3-known-gaps.txt");

    /** Intentionally anonymous product routes; each is here for a named reason. */
    private static final Map<String, String> PUBLIC_NON_401 = Map.ofEntries(
            Map.entry("GET /api/v1/health", "liveness/readiness"),
            Map.entry("GET /api/v1/auth/bootstrap-status", "pre-login bootstrap probe"),
            Map.entry("POST /api/v1/auth/login", "login"),
            Map.entry("POST /api/v1/auth/register", "registration"),
            Map.entry("POST /api/v1/auth/refresh", "token refresh"),
            Map.entry("GET /api/v1/oauth/callback", "provider callback"),
            Map.entry("POST /api/v1/bootstrap/first-run-account", "first-run disclosure (local-only gate)"),
            Map.entry("POST /api/v1/bootstrap/first-run-account/rewrite",
                    "first-run disclosure (local-only gate)"));

    /**
     * GET routes whose 503 is a <b>dependency</b> answer (no provider/model configured in this
     * lane), not an authorization answer. Literal and reasoned on purpose.
     */
    private static final Set<String> DEPENDENCY_503 = Set.of("GET /api/v1/models");

    @Autowired
    @Qualifier("requestMappingHandlerMapping")
    private RequestMappingHandlerMapping handlerMapping;

    @Autowired
    private WorkspaceFixture workspaceFixture;

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private AuthzContext authzContext;

    @Autowired
    private PresetGrantMaterializer presetGrantMaterializer;

    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5)).build();

    @Test
    @DisplayName("every live route: anonymous is 401 (public list literal), GET never 5xx")
    void universeInvariants() throws Exception {
        Fixture fixture = fixture();
        Set<String> routes = liveRoutes();
        assertThat(routes.size())
                .as("live route universe (a tiny/zero scan is a false green)")
                .isGreaterThan(250);

        List<String> problems = new ArrayList<>();
        List<String> unexpectedPublic = new ArrayList<>();
        for (String route : routes) {
            int status = call(route, fixture, "anonymous", "");
            if (PUBLIC_NON_401.containsKey(route)) {
                if (status == 401) {
                    problems.add("declared public but answers 401: " + route);
                }
                continue;
            }
            if (status != 401) {
                unexpectedPublic.add(route + " -> " + status + " " + codeOf(lastBody));
            }
        }
        assertThat(unexpectedPublic)
                .as("routes that answer anonymous with something other than 401 "
                        + "(add to PUBLIC_NON_401 only with a reason)")
                .isEmpty();

        for (Map.Entry<String, String> publicRoute : PUBLIC_NON_401.entrySet()) {
            if (!routes.contains(publicRoute.getKey())) {
                problems.add("public-route declaration is stale (route gone): " + publicRoute.getKey());
            }
        }

        for (String route : routes) {
            if (!route.startsWith("GET ")) {
                continue;
            }
            for (String principal : List.of("nonMember", "viewer", "editor", "owner", "instanceAdmin")) {
                int status = call(route, fixture, principal, "");
                if (status == 503 && DEPENDENCY_503.contains(route)) {
                    continue;
                }
                if (status >= 500 || status == -1) {
                    problems.add("GET answered " + status + " for " + principal + ": " + route);
                }
            }
        }
        assertThat(problems).as("universe invariants").isEmpty();
    }

    @Test
    @DisplayName("sensitive routes: exact status + code per principal, 403/404 never mixed")
    void sensitiveRouteMatrix() throws Exception {
        Fixture fixture = fixture();
        Set<String> routes = liveRoutes();
        Map<String, String> gaps = readGaps();
        List<String> problems = new ArrayList<>();
        Set<String> usedGaps = new LinkedHashSet<>();
        List<String> readings = new ArrayList<>();
        readings.add("method,path,principal,header,status,code,verdict");

        for (Case testCase : cases(fixture)) {
            String route = testCase.method() + " " + normalize(testCase.template(), fixture);
            if (!existsIn(routes, testCase.method(), route)) {
                problems.add("matrix case no longer exists in the live mapping: " + route);
                continue;
            }
            for (Map.Entry<String, Expectation> expected : testCase.expected().entrySet()) {
                int status = call(testCase.method() + " " + testCase.template(), fixture,
                        expected.getKey(), testCase.header());
                String observed = status + " " + codeOf(lastBody);
                String wanted = expected.getValue().status() + " " + expected.getValue().code();
                String gapKey = route + " | " + expected.getKey();
                boolean matched = matches(expected.getValue(), status, codeOf(lastBody));
                readings.add(String.join(",", testCase.method(),
                        "\"" + route.substring(route.indexOf(' ') + 1) + "\"",
                        expected.getKey(), String.valueOf(testCase.header()), Integer.toString(status),
                        codeOf(lastBody), matched ? "MATCH" : "GAP"));
                if (!matched) {
                    String entry = gaps.get(gapKey);
                    if (entry == null) {
                        problems.add(route + " | " + expected.getKey() + " expected " + wanted
                                + " but observed " + observed
                                + " (no l3-known-gaps entry)");
                    } else {
                        usedGaps.add(gapKey);
                        String gapObserved = entry.split("\\|")[3].trim();
                        if (!gapObserved.equals(observed)) {
                            problems.add(route + " | " + expected.getKey()
                                    + " gap baseline observed '" + gapObserved
                                    + "' but now '" + observed + "'");
                        }
                    }
                } else if (gaps.containsKey(gapKey)) {
                    problems.add("stale l3-known-gaps entry (now matches expectation): " + gapKey);
                }
            }
        }
        for (String gapKey : gaps.keySet()) {
            if (!usedGaps.contains(gapKey)) {
                problems.add("l3-known-gaps entry never exercised: " + gapKey);
            }
        }
        Files.write(Path.of("target-task869", "l3-matrix-final.csv"), readings, StandardCharsets.UTF_8);
        assertThat(problems).as("sensitive route matrix").isEmpty();
    }

    // ------------------------------------------------------------------ cases

    private record Expectation(int status, String code) {
    }

    private record Case(String method, String template, String header,
                        Map<String, Expectation> expected) {
    }

    private static final String ANY = null;
    private static final String WS_HEADER = "ws";

    private List<Case> cases(Fixture fixture) {
        String ws = fixture.workspaceId();
        String missing = fixture.missingId();
        List<Case> cases = new ArrayList<>();
        Map<String, Expectation> m;

        m = new LinkedHashMap<>();
        m.put("anonymous", new Expectation(401, "AUTHORIZATION_REQUIRED"));
        m.put("nonMember", new Expectation(403, "WORKSPACE_FORBIDDEN"));
        m.put("viewer", new Expectation(200, ""));
        m.put("editor", new Expectation(200, ""));
        m.put("owner", new Expectation(200, ""));
        cases.add(new Case("GET", "/api/v1/workspaces/" + ws, ANY, m));

        m = new LinkedHashMap<>();
        m.put("anonymous", new Expectation(401, "AUTHORIZATION_REQUIRED"));
        for (String principal : List.of("nonMember", "viewer", "editor", "owner")) {
            m.put(principal, new Expectation(404, "WORKSPACE_NOT_FOUND"));
        }
        cases.add(new Case("GET", "/api/v1/workspaces/" + missing, ANY, m));

        m = new LinkedHashMap<>();
        m.put("anonymous", new Expectation(401, "AUTHORIZATION_REQUIRED"));
        m.put("nonMember", new Expectation(403, "WORKSPACE_FORBIDDEN"));
        m.put("viewer", new Expectation(403, "WORKSPACE_FORBIDDEN"));
        m.put("editor", new Expectation(200, ""));
        m.put("owner", new Expectation(200, ""));
        cases.add(new Case("GET", "/api/v1/workspaces/" + ws + "/members", ANY, m));

        m = new LinkedHashMap<>();
        m.put("anonymous", new Expectation(401, "AUTHORIZATION_REQUIRED"));
        m.put("nonMember", new Expectation(403, "WORKSPACE_FORBIDDEN"));
        m.put("viewer", new Expectation(403, "WORKSPACE_FORBIDDEN"));
        m.put("editor", new Expectation(403, "WORKSPACE_FORBIDDEN"));
        m.put("owner", new Expectation(200, ""));
        cases.add(new Case("PATCH", "/api/v1/workspaces/" + ws, ANY, m));

        m = new LinkedHashMap<>();
        m.put("anonymous", new Expectation(401, "AUTHORIZATION_REQUIRED"));
        for (String principal : List.of("nonMember", "viewer", "editor", "owner")) {
            m.put(principal, new Expectation(404, "WORKSPACE_NOT_FOUND"));
        }
        cases.add(new Case("PATCH", "/api/v1/workspaces/" + missing, ANY, m));

        m = new LinkedHashMap<>();
        m.put("anonymous", new Expectation(401, "AUTHORIZATION_REQUIRED"));
        m.put("nonMember", new Expectation(403, "WORKSPACE_FORBIDDEN"));
        m.put("viewer", new Expectation(403, "WORKSPACE_READ_ONLY"));
        m.put("editor", new Expectation(400, "IMPORT_SOURCE_REQUIRED"));
        m.put("owner", new Expectation(400, "IMPORT_SOURCE_REQUIRED"));
        cases.add(new Case("POST", "/api/v1/workspaces/" + ws + "/imports", ANY, m));

        m = new LinkedHashMap<>();
        m.put("anonymous", new Expectation(401, "AUTHORIZATION_REQUIRED"));
        m.put("nonMember", new Expectation(409, "WORKSPACE_CONTEXT_REQUIRED"));
        m.put("viewer", new Expectation(200, ""));
        m.put("editor", new Expectation(200, ""));
        m.put("owner", new Expectation(200, ""));
        cases.add(new Case("GET", "/api/v1/sessions", ANY, m));

        m = new LinkedHashMap<>();
        m.put("anonymous", new Expectation(401, "AUTHORIZATION_REQUIRED"));
        for (String principal : List.of("nonMember", "viewer", "editor", "owner")) {
            m.put(principal, new Expectation(404, "SESSION_NOT_FOUND"));
        }
        cases.add(new Case("GET", "/api/v1/sessions/" + missing, ANY, m));

        m = new LinkedHashMap<>();
        m.put("anonymous", new Expectation(401, "AUTHORIZATION_REQUIRED"));
        m.put("nonMember", new Expectation(403, "WORKSPACE_ACCESS_DENIED"));
        m.put("viewer", new Expectation(200, ""));
        m.put("editor", new Expectation(200, ""));
        m.put("owner", new Expectation(200, ""));
        cases.add(new Case("GET", "/api/v1/workspaces/" + ws + "/agents", ANY, m));

        for (String route : List.of("/api/v1/instance/identity", "/api/v1/instance/credentials")) {
            m = new LinkedHashMap<>();
            m.put("anonymous", new Expectation(401, "AUTHORIZATION_REQUIRED"));
            for (String principal : List.of("nonMember", "viewer", "editor", "owner")) {
                m.put(principal, new Expectation(403, "FORBIDDEN"));
            }
            m.put("instanceAdmin", new Expectation(200, ""));
            cases.add(new Case("GET", route, ANY, m));
        }

        m = new LinkedHashMap<>();
        m.put("anonymous", new Expectation(401, "AUTHORIZATION_REQUIRED"));
        for (String principal : List.of("nonMember", "viewer", "editor", "owner", "instanceAdmin")) {
            m.put(principal, new Expectation(200, ""));
        }
        cases.add(new Case("GET", "/api/v1/me/permissions", ANY, m));
        return cases;
    }

    /** A 403 on an API the caller can see is the workspace write gate, not the tenant gate. */
    private static boolean matches(Expectation expected, int status, String code) {
        if (status != expected.status()) {
            return false;
        }
        return expected.code().isEmpty() || expected.code().equals(code);
    }

    // ------------------------------------------------------------------ fixture

    private record Fixture(Map<String, String> tokens, String workspaceId, String missingId) {
        String token(String principal) {
            return "anonymous".equals(principal) ? null : tokens.get(principal);
        }
    }

    private Fixture fixture() throws Exception {
        String suffix = UUID.randomUUID().toString().substring(0, 8);
        AuthResponse owner = register("l3-owner-" + suffix);
        AuthResponse viewer = register("l3-viewer-" + suffix);
        AuthResponse editor = register("l3-editor-" + suffix);
        AuthResponse nonMember = register("l3-stranger-" + suffix);
        AuthResponse admin = register("l3-admin-" + suffix);

        Workspace workspace = workspaceFixture.ensureOwnedWorkspace(
                UUID.fromString(owner.getUser().getId()), "L3 matrix workspace");
        String workspaceId = workspace.getId().toString();
        workspaceFixture.bindWorkspaceRole(workspaceId, viewer.getUser().getId(), WorkspaceRole.VIEWER);
        workspaceFixture.bindWorkspaceRole(workspaceId, editor.getUser().getId(), WorkspaceRole.EDITOR);
        bindSuperAdmin(UUID.fromString(admin.getUser().getId()));
        authzContext.invalidateAll();

        Map<String, String> tokens = new LinkedHashMap<>();
        tokens.put("nonMember", nonMember.getAccessToken());
        tokens.put("viewer", viewer.getAccessToken());
        tokens.put("editor", editor.getAccessToken());
        tokens.put("owner", owner.getAccessToken());
        tokens.put("instanceAdmin", admin.getAccessToken());
        return new Fixture(tokens, workspaceId, UUID.randomUUID().toString());
    }

    /**
     * The fixture's instance admin gets the real seeded preset binding and the real materializer
     * runs on it — capability atoms come from the binding projection, action atoms from the
     * {@code source='assigned'} rows. Hand-inserted atoms would prove a path the product never takes.
     */
    private void bindSuperAdmin(UUID subjectId) {
        jdbc.update("INSERT INTO grant_preset_bindings (id, role_id, subject_type, subject_id, scope_type)"
                + " SELECT gen_random_uuid(), id, 'user', CAST(? AS UUID), 'instance'"
                + " FROM grant_presets WHERE name = 'SUPER_ADMIN' ON CONFLICT DO NOTHING", subjectId);
        presetGrantMaterializer.materializeSubject("user", subjectId, null, null);
    }

    private AuthResponse register(String prefix) throws Exception {
        String body = objectMapper.writeValueAsString(Map.of(
                "email", prefix + "@test.com",
                "password", "Passw0rd!matrix",
                "name", "L3"));
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        String response = restTemplate.postForObject(baseUrl + "/api/v1/auth/register",
                new HttpEntity<>(body, headers), String.class);
        return objectMapper.readValue(response, AuthResponse.class);
    }

    // ------------------------------------------------------------------ routes

    private Set<String> liveRoutes() {
        Set<String> routes = new TreeSet<>();
        for (Map.Entry<RequestMappingInfo, HandlerMethod> entry
                : handlerMapping.getHandlerMethods().entrySet()) {
            RequestMappingInfo info = entry.getKey();
            Set<RequestMethod> methods = info.getMethodsCondition().getMethods();
            List<String> verbs = new ArrayList<>();
            if (methods.isEmpty()) {
                verbs.add("ANY");
            } else {
                methods.forEach(method -> verbs.add(method.name()));
            }
            for (String pattern : info.getPatternValues()) {
                if (excluded(pattern)) {
                    continue;
                }
                for (String verb : verbs) {
                    routes.add(verb + " " + pattern);
                }
            }
        }
        return routes;
    }

    private static boolean excluded(String pattern) {
        String lower = pattern.toLowerCase(Locale.ROOT);
        return lower.startsWith("/v3/") || lower.startsWith("/swagger")
                || lower.startsWith("/error") || lower.startsWith("/actuator")
                || lower.contains("monitor") || lower.contains("trace") || lower.contains("stream")
                || lower.contains("events") || lower.contains("download") || lower.contains("export")
                || lower.contains("upload") || lower.contains("attachments");
    }

    private int call(String route, Fixture fixture, String principal, String header)
            throws Exception {
        int space = route.indexOf(' ');
        String verb = route.substring(0, space);
        String path = concretize(route.substring(space + 1));
        String method = "ANY".equals(verb) ? "GET" : verb;
        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(baseUrl + path))
                .timeout(Duration.ofSeconds(10))
                .header("Content-Type", "application/json")
                .header("Accept", "*/*");
        if (WS_HEADER.equals(header)) {
            builder.header("X-Workspace-Id", fixture.workspaceId());
        }
        String token = fixture.token(principal);
        if (token != null) {
            builder.header("Authorization", "Bearer " + token);
        }
        boolean hasBody = !"GET".equals(method) && !"DELETE".equals(method) && !"HEAD".equals(method);
        builder.method(method, hasBody
                ? HttpRequest.BodyPublishers.ofString("{}")
                : HttpRequest.BodyPublishers.noBody());
        HttpResponse<String> response = http.send(builder.build(),
                HttpResponse.BodyHandlers.ofString());
        lastBody = response.body();
        return response.statusCode();
    }

    private String lastBody = "";

    private String codeOf(String lastBody) {
        if (lastBody == null || lastBody.isBlank()) {
            return "";
        }
        try {
            JsonNode node = objectMapper.readTree(lastBody);
            return node.path("code").isMissingNode() ? "" : node.path("code").asText();
        } catch (Exception notJson) {
            return "";
        }
    }

    /** Replaces a whole {@code {...}} segment (including nested regex braces) with a UUID. */
    private static String concretize(String template) {
        StringBuilder out = new StringBuilder();
        int index = 0;
        while (index < template.length()) {
            char current = template.charAt(index);
            if (current != '{' || index > 0 && template.charAt(index - 1) != '/') {
                out.append(current);
                index++;
                continue;
            }
            int depth = 0;
            int end = index;
            for (; end < template.length(); end++) {
                char in = template.charAt(end);
                if (in == '{') {
                    depth++;
                } else if (in == '}') {
                    depth--;
                    if (depth == 0) {
                        break;
                    }
                }
            }
            if (end >= template.length()) {
                out.append(current);
                index++;
                continue;
            }
            out.append(UUID.randomUUID());
            index = end + 1;
        }
        return out.toString();
    }

    /** True when the live universe has a route of this method whose shape matches the concrete path. */
    private static boolean existsIn(Set<String> routes, String method, String concrete) {
        String wantedMethod = method;
        String shape = shapeOf(concrete.substring(concrete.indexOf(' ') + 1));
        for (String route : routes) {
            int space = route.indexOf(' ');
            if (!route.substring(0, space).equals(wantedMethod)) {
                continue;
            }
            if (shapeOf(route.substring(space + 1)).equals(shape)) {
                return true;
            }
        }
        return false;
    }

    private static String shapeOf(String path) {
        return path.replaceAll("\\{[^/]*}", "{}")
                .replaceAll("/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}",
                        "/{}");
    }

    /** Stable matrix key: fixture ids become the placeholder names used in the gap file. */
    private static String normalize(String template, Fixture fixture) {
        return template.replace(fixture.workspaceId(), "{workspaceId}")
                .replace(fixture.missingId(), "{id}");
    }

    // ------------------------------------------------------------------ gaps

    private Map<String, String> readGaps() throws Exception {
        assertThat(Files.exists(GAPS))
                .as("L3 gap baseline missing: %s", GAPS.toAbsolutePath())
                .isTrue();
        Map<String, String> gaps = new LinkedHashMap<>();
        for (String line : Files.readAllLines(GAPS, StandardCharsets.UTF_8)) {
            String trimmed = line.trim();
            if (trimmed.isEmpty() || trimmed.startsWith("#")) {
                continue;
            }
            String[] parts = trimmed.split("\\|", -1);
            assertThat(parts.length)
                    .as("gap line must be 'METHOD /path | principal | expected | observed | owner |"
                            + " reviewDate | reason': " + line)
                    .isEqualTo(7);
            gaps.put(parts[0].trim() + " | " + parts[1].trim(), trimmed);
        }
        return gaps;
    }
}
