package com.cc01cc.p.xihe.cp.config;

import com.cc01cc.p.xihe.cp.AbstractH2Test;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * D-928 / PLAN-0766 M2: the shared workspace-default layer over HTTP.
 *
 * <p>Covers the card's gates: 403 without the MANAGE_WORKSPACE_DEFAULT_CONFIG atom,
 * 200 with it (the seeded ADMIN fixed set carries the atom via Flyway V153),
 * 400 DOMAIN_NOT_WORKSPACE_WRITABLE on a non-writable domain, DELETE clearing one
 * row so the chain inherits again, and the raw layer read for non-admins.
 */
class ConfigWorkspaceDefaultLayerTest extends AbstractH2Test {

    @Autowired
    private com.cc01cc.p.xihe.cp.config.JwtTokenProvider jwtTokenProvider;

    @Autowired
    private com.cc01cc.p.xihe.cp.integration.WorkspaceFixture workspaceFixture;

    @Autowired
    private ConfigService configService;

    private HttpHeaders authHeaders(String token) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        return headers;
    }

    private String userToken() {
        ResponseEntity<Map> reg = restTemplate.postForEntity(
            url("/api/v1/auth/register"),
            Map.of("email", "wsdef-user-" + System.nanoTime() + "@test.com",
                "password", TestDataFactory.PASSWORD, "name", "WsDefUser"),
            Map.class);
        assertEquals(HttpStatus.CREATED, reg.getStatusCode());
        return (String) reg.getBody().get("accessToken");
    }

    private String adminToken() {
        ResponseEntity<Map> login = restTemplate.postForEntity(
            url("/api/v1/auth/login"),
            Map.of("identifier", "admin@xihe.local", "password", DataSeeder.seededAdminPassword()),
            Map.class);
        assertEquals(HttpStatus.OK, login.getStatusCode());
        String token = (String) login.getBody().get("accessToken");
        assertNotNull(token);
        return token;
    }

    @Test
    void put_rejectsCallerWithoutAtom() {
        ResponseEntity<Map> resp = restTemplate.exchange(
            url("/api/v1/config/workspace-default/rag"), HttpMethod.PUT,
            new HttpEntity<>(Map.of("topK", "7"), authHeaders(userToken())), Map.class);

        assertEquals(HttpStatus.FORBIDDEN, resp.getStatusCode());
    }

    @Test
    void put_adminWithAtom_succeedsAndLayerIsReadable() {
        // T2.4: rag left the workspace-default layer with the model 4 domains, so the
        // positive write runs on a behavior domain (job-policy).
        String admin = adminToken();
        ResponseEntity<Map> put = restTemplate.exchange(
            url("/api/v1/config/workspace-default/job-policy"), HttpMethod.PUT,
            new HttpEntity<>(Map.of("defaultTimeoutSecs", "70"), authHeaders(admin)), Map.class);
        assertEquals(HttpStatus.OK, put.getStatusCode());

        // The shared default layer is readable by any authenticated caller.
        ResponseEntity<Map> layerView = restTemplate.exchange(
            url("/api/v1/config/job-policy?layer=workspace-default"), HttpMethod.GET,
            new HttpEntity<>(authHeaders(userToken())), Map.class);
        assertEquals(HttpStatus.OK, layerView.getStatusCode());
        assertEquals("70", layerView.getBody().get("defaultTimeoutSecs"));

        // Effective view for a user/workspace without their own row picks it up.
        String user = userToken();
        ResponseEntity<Map> effective = restTemplate.exchange(
            url("/api/v1/config/job-policy"), HttpMethod.GET,
            new HttpEntity<>(authHeaders(user)), Map.class);
        assertEquals(HttpStatus.OK, effective.getStatusCode());
        assertEquals("70", effective.getBody().get("defaultTimeoutSecs"));
    }

    @Test
    void put_modelDomainsAnswer400DomainNotWorkspaceWritable_onThisLayer() {
        // T2.4 refusal pin (half of the 4-domains × 2-layers pair; the workspace-layer half
        // lives in ConfigControllerTest): each model domain that left the workspace layer
        // must answer the layer verdict — 400 + DOMAIN_NOT_WORKSPACE_WRITABLE — on this
        // layer, before any body validation could answer a different 400.
        String admin = adminToken();
        for (String domain : java.util.List.of("llm-provider", "context-policy", "embedding", "rag")) {
            ResponseEntity<Map> resp = restTemplate.exchange(
                url("/api/v1/config/workspace-default/" + domain), HttpMethod.PUT,
                new HttpEntity<>(Map.of("anything", "x"), authHeaders(admin)), Map.class);
            assertEquals(HttpStatus.BAD_REQUEST, resp.getStatusCode(), domain);
            assertEquals("DOMAIN_NOT_WORKSPACE_WRITABLE", resp.getBody().get("code"), domain);
        }
    }

    @Test
    void put_nonWritableDomain_answers400DomainNotWorkspaceWritable() {
        ResponseEntity<Map> resp = restTemplate.exchange(
            url("/api/v1/config/workspace-default/logging"), HttpMethod.PUT,
            new HttpEntity<>(Map.of("logLevel", "DEBUG"), authHeaders(adminToken())), Map.class);

        assertEquals(HttpStatus.BAD_REQUEST, resp.getStatusCode());
        assertEquals("DOMAIN_NOT_WORKSPACE_WRITABLE", resp.getBody().get("code"));
    }

    @Test
    void put_apiRequestTemplatesDomain_isRejectedEvenThoughExplicitOnly() {
        // api-request-templates is EXPLICIT_ONLY but NOT one of the four WORKSPACE_WRITABLE ∩
        // UI_DOMAINS behavior domains, so the workspace-default layer must refuse it
        // (instance-only stays instance-only).
        ResponseEntity<Map> resp = restTemplate.exchange(
            url("/api/v1/config/workspace-default/api-request-templates"), HttpMethod.PUT,
            new HttpEntity<>(Map.of("connectionDefaultTemplates", "{}"), authHeaders(adminToken())),
            Map.class);

        assertEquals(HttpStatus.BAD_REQUEST, resp.getStatusCode());
        assertEquals("DOMAIN_NOT_WORKSPACE_WRITABLE", resp.getBody().get("code"));
    }

    @Test
    void put_contextTemplatesDomain_answers400BecauseItHasNoGenericConfigReadFace() {
        // task-183: context-templates owns a dedicated template API but has NO generic config
        // read face (no meta view), so accepting a workspace-default write here would persist a
        // layer no generic read surface could serve. Same 400 shape as api-request-templates.
        ResponseEntity<Map> resp = restTemplate.exchange(
            url("/api/v1/config/workspace-default/context-templates"), HttpMethod.PUT,
            new HttpEntity<>(Map.of("templates", "[]"), authHeaders(adminToken())), Map.class);

        assertEquals(HttpStatus.BAD_REQUEST, resp.getStatusCode());
        assertEquals("DOMAIN_NOT_WORKSPACE_WRITABLE", resp.getBody().get("code"));
    }

    @Test
    void put_contextTemplatesDomain_answers400DomainNotWorkspaceWritableEvenWhenBodyFailsTemplateSchema() {
        // task-196 regression (real-stack F1): a body that the template schema would reject must
        // still answer the LAYER verdict, not the template validator's code. Before the guard moved
        // to writeLayer's entry, {"anything":"x"} answered 400 INVALID_CONTEXT_TEMPLATE while the
        // status matched and only the code was wrong.
        ResponseEntity<Map> resp = restTemplate.exchange(
            url("/api/v1/config/workspace-default/context-templates"), HttpMethod.PUT,
            new HttpEntity<>(Map.of("anything", "x"), authHeaders(adminToken())), Map.class);

        assertEquals(HttpStatus.BAD_REQUEST, resp.getStatusCode());
        assertEquals("DOMAIN_NOT_WORKSPACE_WRITABLE", resp.getBody().get("code"));
    }

    @Test
    void delete_contextTemplatesDomain_answers400Too() {
        // README-183 requirement 1 covers DELETE as well: the service guards the layer before the
        // template-specific checks, so a clear on this domain cannot slip past the narrowed set.
        ResponseEntity<Map> resp = restTemplate.exchange(
            url("/api/v1/config/workspace-default/context-templates/templates"), HttpMethod.DELETE,
            new HttpEntity<>(authHeaders(adminToken())), Map.class);

        assertEquals(HttpStatus.BAD_REQUEST, resp.getStatusCode());
        assertEquals("DOMAIN_NOT_WORKSPACE_WRITABLE", resp.getBody().get("code"));
    }

    @Test
    void delete_clearsRow_andChainInheritsAgain() {
        // T2.4: the clear-chain runs on a behavior domain (rag left the layer).
        String admin = adminToken();
        restTemplate.exchange(url("/api/v1/config/instance/job-policy"), HttpMethod.PUT,
            new HttpEntity<>(Map.of("defaultTimeoutSecs", "30"), authHeaders(admin)), Map.class);
        restTemplate.exchange(url("/api/v1/config/workspace-default/job-policy"), HttpMethod.PUT,
            new HttpEntity<>(Map.of("defaultTimeoutSecs", "70"), authHeaders(admin)), Map.class);

        ResponseEntity<Map> hit = restTemplate.exchange(
            url("/api/v1/config/job-policy"), HttpMethod.GET,
            new HttpEntity<>(authHeaders(userToken())), Map.class);
        assertEquals("70", hit.getBody().get("defaultTimeoutSecs"));

        ResponseEntity<Map> del = restTemplate.exchange(
            url("/api/v1/config/workspace-default/job-policy/defaultTimeoutSecs"), HttpMethod.DELETE,
            new HttpEntity<>(authHeaders(admin)), Map.class);
        assertEquals(HttpStatus.OK, del.getStatusCode());

        ResponseEntity<Map> after = restTemplate.exchange(
            url("/api/v1/config/job-policy"), HttpMethod.GET,
            new HttpEntity<>(authHeaders(userToken())), Map.class);
        assertEquals("30", after.getBody().get("defaultTimeoutSecs"));
    }

    @Test
    void delete_rejectsCallerWithoutAtom() {
        ResponseEntity<Map> resp = restTemplate.exchange(
            url("/api/v1/config/workspace-default/rag/topK"), HttpMethod.DELETE,
            new HttpEntity<>(authHeaders(userToken())), Map.class);

        assertEquals(HttpStatus.FORBIDDEN, resp.getStatusCode());
    }

    @Test
    void meta_layerViewsExposeWorkspaceDefaultProvenance() {
        // T2.4: rag left the layer, so the provenance assertions run on job-policy.
        String admin = adminToken();
        restTemplate.exchange(url("/api/v1/config/workspace-default/job-policy"), HttpMethod.PUT,
            new HttpEntity<>(Map.of("defaultTimeoutSecs", "70"), authHeaders(admin)), Map.class);

        ResponseEntity<Map> meta = restTemplate.exchange(
            url("/api/v1/config/job-policy/meta?layer=workspace-default"), HttpMethod.GET,
            new HttpEntity<>(authHeaders(admin)), Map.class);
        assertEquals(HttpStatus.OK, meta.getStatusCode());
        assertTrue(meta.getBody().get("keys") instanceof java.util.List);
        java.util.List<Map<String, Object>> keys = (java.util.List<Map<String, Object>>) meta.getBody().get("keys");
        Map<String, Object> jobRow = keys.stream()
            .filter(k -> "defaultTimeoutSecs".equals(k.get("key"))).findFirst().orElseThrow();
        assertEquals("workspace-default", jobRow.get("source"));

        // The workspace layer view sees the default row as workspace-default provenance.
        String token = userToken();
        String workspaceId = workspaceFixture.createOwnedWorkspace("wsdef meta ws",
            jwtTokenProvider.getUserIdFromToken(token)).getId().toString();
        HttpHeaders headers = authHeaders(token);
        headers.set("X-Workspace-Id", workspaceId);
        ResponseEntity<Map> wsMeta = restTemplate.exchange(
            url("/api/v1/config/job-policy/meta?layer=workspace"), HttpMethod.GET,
            new HttpEntity<>(headers), Map.class);
        assertEquals(HttpStatus.OK, wsMeta.getStatusCode());
        java.util.List<Map<String, Object>> wsKeys =
            (java.util.List<Map<String, Object>>) wsMeta.getBody().get("keys");
        Map<String, Object> wsTopK = wsKeys.stream()
            .filter(k -> "defaultTimeoutSecs".equals(k.get("key"))).findFirst().orElseThrow();
        assertEquals("workspace-default", wsTopK.get("source"));
    }
}
