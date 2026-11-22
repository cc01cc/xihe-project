package com.cc01cc.p.xihe.cp.policy.guard;

import com.cc01cc.p.xihe.cp.AbstractReusableIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.policy.AuthzContext;
import com.cc01cc.p.xihe.cp.policy.PresetGrantMaterializer;
import com.cc01cc.p.xihe.cp.policy.RequesterAuthority;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletRequest;

import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * task-869 L4: every policy DENY must be explainable — {@code code + missingAtom + missingLevel} —
 * and {@code /explain} must reach the <b>same conclusion</b> as the denying path.
 *
 * <p>The decision kernel is {@link RequesterAuthority#requireActionAtom(String)}: it refuses with a
 * {@link CpApiException} whose {@code extra} carries the deepest miss taken from
 * {@link com.cc01cc.p.xihe.cp.policy.GrantIntersectionEvaluator.GrantExplanation} — the exact object
 * {@code /explain} renders. This test pins all three links of that chain:</p>
 *
 * <ol>
 *   <li>the refusal carries the fields (and a capability refusal names the capability atom);</li>
 *   <li>the {@link ProblemDetailsHandler} renderer puts them in the RFC 9457 body;</li>
 *   <li>{@code POST /api/v1/authorization/explain} answers the same atom/level for the same
 *       subject, so the two paths cannot silently diverge.</li>
 * </ol>
 *
 * <p><b>Known boundary (reported, not hidden):</b> only the {@code require*} entry points emit this
 * body today. The existing {@code @PreAuthorize("@requesterAuthority.holdsActionAtom(...)")} call
 * sites live in controllers owned by another lane (task-843); switching them to {@code require*}
 * is a one-token change per site but belongs to that lane's write scope. Until then those
 * refusals still answer the old {@code code=FORBIDDEN} body without the two fields.</p>
 */
class L4DenyExplainabilityGuardTest extends AbstractReusableIntegrationTest {

    @Autowired
    private RequesterAuthority requesterAuthority;

    @Autowired
    private ProblemDetailsHandler problemDetailsHandler;

    @Autowired
    private PresetGrantMaterializer presetGrantMaterializer;

    @Autowired
    private AuthzContext authzContext;

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private ObjectMapper objectMapper;

    @AfterEach
    void clearTenant() {
        TenantContext.clear();
    }

    @Test
    @DisplayName("action-atom refusal carries code + missingAtom + missingLevel")
    void actionAtomRefusalIsExplainable() throws Exception {
        AuthResponse user = register("l4-action");
        TenantContext.setUserId(user.getUser().getId());

        assertThatThrownBy(() -> requesterAuthority.requireActionAtom("READ_INSTANCE_CONTENT"))
                .isInstanceOfSatisfying(CpApiException.class, error -> {
                    assertThat(error.getStatus().value()).isEqualTo(403);
                    assertThat(error.getCode()).isEqualTo("FORBIDDEN");
                    Map<String, Object> missingAtom = missingAtomOf(error);
                    assertThat(missingAtom.get("actionClass")).isEqualTo("action:READ_INSTANCE_CONTENT");
                    assertThat(error.getExtra().get("missingLevel")).isInstanceOf(Integer.class);
                    assertThat(missingAtom.get("reason")).isNotNull();
                });
    }

    @Test
    @DisplayName("capability refusal names the capability atom")
    void capabilityRefusalIsExplainable() throws Exception {
        AuthResponse user = register("l4-capability");
        TenantContext.setUserId(user.getUser().getId());

        assertThatThrownBy(() -> requesterAuthority.requireCapabilityAtom("instance:admin"))
                .isInstanceOfSatisfying(CpApiException.class, error -> {
                    Map<String, Object> missingAtom = missingAtomOf(error);
                    assertThat(missingAtom.get("actionClass")).isEqualTo("cap:instance:admin");
                    assertThat(missingAtom.get("reason")).isEqualTo("capability_not_held");
                    assertThat(error.getExtra().get("missingLevel")).isEqualTo(-1);
                });
    }

    @Test
    @DisplayName("the problem renderer puts the explanation into the DENY body")
    void rendererCarriesTheExplanation() throws Exception {
        AuthResponse user = register("l4-render");
        TenantContext.setUserId(user.getUser().getId());

        CpApiException refusal = catchRefusal(() ->
                requesterAuthority.requireActionAtom("READ_INSTANCE_CONTENT"));
        ResponseEntity<Map<String, Object>> response = problemDetailsHandler.badRequest(
                refusal, new MockHttpServletRequest("GET", "/api/v1/instance/identity"));

        assertThat(response.getStatusCode().value()).isEqualTo(403);
        Map<String, Object> body = response.getBody();
        assertThat(body).isNotNull();
        assertThat(body.get("code")).isEqualTo("FORBIDDEN");
        assertThat(body.get("missingLevel")).isEqualTo(refusal.getExtra().get("missingLevel"));
        assertThat(body.get("missingAtom")).isEqualTo(refusal.getExtra().get("missingAtom"));
        System.out.println("[L4-DENY-BODY] " + objectMapper.writeValueAsString(body));
    }

    @Test
    @DisplayName("/explain and the refusing path agree on atom and level")
    void explainAgreesWithTheRefusal() throws Exception {
        AuthResponse user = register("l4-explain");
        TenantContext.setUserId(user.getUser().getId());

        CpApiException refusal = catchRefusal(() ->
                requesterAuthority.requireActionAtom("READ_INSTANCE_CONTENT"));
        Map<String, Object> refusalAtom = missingAtomOf(refusal);

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.setBearerAuth(user.getAccessToken());
        ResponseEntity<String> explained = restTemplate.exchange(
                baseUrl + "/api/v1/authorization/explain", HttpMethod.POST,
                new HttpEntity<>(Map.of("actionClass", "READ_INSTANCE_CONTENT"), headers),
                String.class);

        assertThat(explained.getStatusCode().value()).isEqualTo(200);
        JsonNode body = objectMapper.readTree(explained.getBody());
        assertThat(body.path("allowed").asBoolean()).isFalse();
        assertThat(body.path("deepestMissingLevel").asInt())
                .isEqualTo(refusal.getExtra().get("missingLevel"));
        assertThat(body.path("missingAtom").path("actionClass").asText())
                .isEqualTo(refusalAtom.get("actionClass"));
    }

    @Test
    @DisplayName("the instance admin passes the same gate (the refusal is about the atom, not the path)")
    void instanceAdminPasses() throws Exception {
        AuthResponse admin = register("l4-admin");
        UUID subjectId = UUID.fromString(admin.getUser().getId());
        jdbc.update("INSERT INTO grant_preset_bindings (id, role_id, subject_type, subject_id, scope_type)"
                + " SELECT gen_random_uuid(), id, 'user', CAST(? AS UUID), 'instance'"
                + " FROM grant_presets WHERE name = 'SUPER_ADMIN' ON CONFLICT DO NOTHING", subjectId);
        presetGrantMaterializer.materializeSubject("user", subjectId, null, null);
        authzContext.invalidateAll();
        TenantContext.setUserId(subjectId.toString());

        assertThat(requesterAuthority.requireActionAtom("READ_INSTANCE_CONTENT")).isTrue();
        assertThat(requesterAuthority.requireCapabilityAtom("instance:admin")).isTrue();
    }

    // ------------------------------------------------------------------ helpers

    @SuppressWarnings("unchecked")
    private static Map<String, Object> missingAtomOf(CpApiException error) {
        assertThat(error.getExtra().get("missingAtom")).isInstanceOf(Map.class);
        return (Map<String, Object>) error.getExtra().get("missingAtom");
    }

    private interface Refusing {
        void run();
    }

    private static CpApiException catchRefusal(Refusing refusing) {
        try {
            refusing.run();
        } catch (CpApiException error) {
            return error;
        }
        throw new AssertionError("expected a CpApiException refusal");
    }

    private AuthResponse register(String prefix) throws Exception {
        String body = objectMapper.writeValueAsString(Map.of(
                "email", prefix + "-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com",
                "password", "Passw0rd!matrix",
                "name", "L4"));
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        String response = restTemplate.postForObject(baseUrl + "/api/v1/auth/register",
                new HttpEntity<>(body, headers), String.class);
        return objectMapper.readValue(response, AuthResponse.class);
    }
}
