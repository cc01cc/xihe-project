package com.cc01cc.p.xihe.cp.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.DefaultApplicationArguments;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * PLAN-0767 M1-3 (PG lane): the deployment identity singleton, its env three-state seeding, the
 * sentinel backfill and the read endpoint. Real PostgreSQL + Flyway + {@code ddl-auto=validate},
 * so this is the schema-gate lane; the H2 lane (flyway off, create-drop) is exercised separately.
 */
class InstanceIdentityIntegrationTest extends AbstractIntegrationTest {

    private static final String PASSWORD = "Identity-pass-1";
    private static final String SENTINEL = "instance";

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private com.cc01cc.p.xihe.cp.config.JwtTokenProvider jwtTokenProvider;

    @Autowired
    private com.cc01cc.p.xihe.cp.policy.AuthzContext authzContext;

    @Autowired
    private InstanceIdentityService identity;

    @Autowired
    private com.cc01cc.p.xihe.cp.policy.RoleGrantMaterializer roleGrantMaterializer;

    @Autowired
    private InstanceIdentityInitializer initializer;

    @BeforeEach
    void cleanInstanceConnections() {
        jdbc.update("DELETE FROM provider_connections WHERE owner_type = 'INSTANCE'");
    }

    // ── C8: the read endpoint (contract 182) ────────────────────────────────

    @Test
    void identityEndpointServesTheSeededViewToInstanceAdminsOnly() throws Exception {
        UUID stored = jdbc.queryForObject(
                "SELECT instance_id FROM instance_identity WHERE id = 1", UUID.class);
        assertNotNull(stored);
        assertEquals(stored, identity.instanceId());

        String adminToken = register("identity-admin@test.com");
        promote(userIdOf(adminToken), "ADMIN");
        adminToken = login("identity-admin@test.com");
        ResponseEntity<String> ok = get(adminToken, "/api/v1/instance/identity");
        assertEquals(HttpStatus.OK, ok.getStatusCode(), ok.getBody());
        JsonNode body = objectMapper.readTree(ok.getBody());
        assertEquals(stored.toString(), body.path("instanceId").asText());
        assertNotNull(body.path("createdAt").asText());
        assertTrue(body.has("schemaVersion"), "the contract carries schemaVersion explicitly");
        assertTrue(body.path("schemaVersion").isNull(), "M1 always reports schemaVersion null");

        String userToken = register("identity-user@test.com");
        ResponseEntity<String> denied = get(userToken, "/api/v1/instance/identity");
        assertEquals(HttpStatus.FORBIDDEN, denied.getStatusCode(), denied.getBody());

        ResponseEntity<String> anonymous = restTemplate.exchange(
                url("/api/v1/instance/identity"), HttpMethod.GET, HttpEntity.EMPTY, String.class);
        assertEquals(HttpStatus.UNAUTHORIZED, anonymous.getStatusCode());
    }

    // ── C4: env three-state seeding ────────────────────────────────────────

    @Test
    void envSeedsAnEmptyDatabaseAndARepeatedBootIsIdempotent() {
        UUID configured = UUID.randomUUID();
        jdbc.update("DELETE FROM instance_identity");
        int initBefore = auditCount("instance_identity_init");

        identity.ensureSeeded(configured.toString());
        assertEquals(configured, jdbc.queryForObject(
                "SELECT instance_id FROM instance_identity WHERE id = 1", UUID.class));
        assertEquals(initBefore + 1, auditCount("instance_identity_init"));
        assertEquals("source=env backfilled=0", latestInitDetail());

        // Same value in the 32-hex + uppercase form must be recognized as "consistent" and write
        // neither a row nor an audit.
        identity.ensureSeeded(configured.toString().replace("-", "").toUpperCase());
        assertEquals(initBefore + 1, auditCount("instance_identity_init"));
        assertEquals(configured, jdbc.queryForObject(
                "SELECT instance_id FROM instance_identity WHERE id = 1", UUID.class));
    }

    @Test
    void conflictingOrInvalidEnvFailsFastWithoutTouchingTheDatabase() {
        UUID stored = jdbc.queryForObject(
                "SELECT instance_id FROM instance_identity WHERE id = 1", UUID.class);
        int initBefore = auditCount("instance_identity_init");
        int backfillBefore = auditCount("instance_identity_backfill");

        IllegalStateException mismatch = assertThrows(IllegalStateException.class,
                () -> identity.ensureSeeded(UUID.randomUUID().toString()));
        assertTrue(mismatch.getMessage().contains("does not match"), mismatch.getMessage());
        assertEquals(stored, jdbc.queryForObject(
                "SELECT instance_id FROM instance_identity WHERE id = 1", UUID.class));
        assertEquals(initBefore, auditCount("instance_identity_init"));
        assertEquals(backfillBefore, auditCount("instance_identity_backfill"));

        IllegalStateException invalid = assertThrows(IllegalStateException.class,
                () -> identity.ensureSeeded("not-an-identity"));
        assertTrue(invalid.getMessage().contains("not a valid"), invalid.getMessage());
        assertEquals(stored, jdbc.queryForObject(
                "SELECT instance_id FROM instance_identity WHERE id = 1", UUID.class));
    }

    // ── C4/C7: sentinel backfill is idempotent ─────────────────────────────

    @Test
    void sentinelInstanceConnectionsAreBackfilledToTheIdentityOnce() {
        UUID stored = jdbc.queryForObject(
                "SELECT instance_id FROM instance_identity WHERE id = 1", UUID.class);
        jdbc.update("INSERT INTO provider_connections (id, owner_type, owner_id, provider_id,"
                        + " connection_key, api_type_id, api_type_version, label, enabled, status,"
                        + " model_discovery, revision, created_at, updated_at)"
                        + " VALUES (CAST(? AS UUID), 'INSTANCE', ?, 'deepseek', 'identity-default',"
                        + " 'openai-chat-completions', 1, 'identity seed', TRUE, 'READY',"
                        + " 'remote-models', 2, NOW(), NOW())",
                UUID.randomUUID().toString(), SENTINEL);
        int backfillBefore = auditCount("instance_identity_backfill");

        identity.ensureSeeded(null);
        assertEquals(stored.toString(), jdbc.queryForObject(
                "SELECT owner_id FROM provider_connections WHERE owner_type = 'INSTANCE'",
                String.class));
        assertEquals(0L, jdbc.queryForObject(
                "SELECT COUNT(*) FROM provider_connections WHERE owner_type = 'INSTANCE'"
                        + " AND owner_id = 'instance'", Long.class));
        assertEquals(backfillBefore + 1, auditCount("instance_identity_backfill"));

        // Second boot: nothing left to backfill, therefore no new audit row.
        identity.ensureSeeded(null);
        assertEquals(backfillBefore + 1, auditCount("instance_identity_backfill"));
    }

    // ── C7: concurrent first boots ─────────────────────────────────────────

    @Test
    void concurrentFirstBootsConvergeOnOneRowAndOneInitAudit() throws Exception {
        jdbc.update("DELETE FROM instance_identity");
        int initBefore = auditCount("instance_identity_init");
        CyclicBarrier barrier = new CyclicBarrier(2);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            Callable<Void> boot = () -> {
                barrier.await(10, TimeUnit.SECONDS);
                initializer.run(new DefaultApplicationArguments(new String[0]));
                return null;
            };
            List<Future<Void>> futures = List.of(pool.submit(boot), pool.submit(boot));
            for (Future<Void> future : futures) {
                future.get(30, TimeUnit.SECONDS);
            }
        } finally {
            pool.shutdownNow();
        }
        assertEquals(1, jdbc.queryForObject(
                "SELECT COUNT(*) FROM instance_identity", Integer.class));
        assertEquals(initBefore + 1, auditCount("instance_identity_init"),
                "exactly one boot created the row, the loser re-read it");
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    private String latestInitDetail() {
        return jdbc.queryForObject("SELECT details FROM audit_logs"
                + " WHERE action = 'instance_identity_init' ORDER BY created_at DESC LIMIT 1",
                String.class);
    }

    private int auditCount(String action) {
        return jdbc.queryForObject("SELECT COUNT(*) FROM audit_logs WHERE action = ?",
                Integer.class, action);
    }

    private String register(String email) throws Exception {
        ResponseEntity<String> response = restTemplate.postForEntity(url("/api/v1/auth/register"),
                Map.of("email", email, "password", PASSWORD, "name", "Identity"), String.class);
        assertEquals(HttpStatus.CREATED, response.getStatusCode(), response.getBody());
        return objectMapper.readTree(response.getBody()).path("accessToken").asText();
    }

    private String login(String email) throws Exception {
        ResponseEntity<String> response = restTemplate.postForEntity(url("/api/v1/auth/login"),
                Map.of("identifier", email, "password", PASSWORD), String.class);
        assertEquals(HttpStatus.OK, response.getStatusCode(), response.getBody());
        return objectMapper.readTree(response.getBody()).path("accessToken").asText();
    }

    private String userIdOf(String token) {
        return jwtTokenProvider.getUserIdFromToken(token);
    }

    private void promote(String userId, String roleName) {
        jdbc.update("DELETE FROM role_bindings WHERE subject_type = 'user'"
                + " AND subject_id = CAST(? AS UUID) AND scope_type = 'instance'", userId);
        jdbc.update("INSERT INTO role_bindings (id, role_id, subject_type, subject_id, scope_type,"
                        + " granted_at) SELECT CAST(? AS UUID), r.id, 'user', CAST(? AS UUID),"
                        + " 'instance', NOW() FROM roles r WHERE r.name = ?",
                UUID.randomUUID().toString(), userId, roleName);
        roleGrantMaterializer.materializeSubject(
                com.cc01cc.p.xihe.cp.policy.AuthzContext.SUBJECT_USER,
                UUID.fromString(userId), UUID.fromString(userId), null);
        authzContext.invalidate(UUID.fromString(userId));
    }

    private ResponseEntity<String> get(String token, String path) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        return restTemplate.exchange(url(path), HttpMethod.GET,
                new HttpEntity<>(headers), String.class);
    }
}
