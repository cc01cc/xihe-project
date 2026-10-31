package com.cc01cc.p.xihe.cp.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.policy.GrantDefaultService;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
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
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.client.RestTemplate;

/**
 * PLAN-0580 M1/M2 contract tests on <b>real PostgreSQL</b> (Testcontainers, Flyway
 * on, {@code ddl-auto=validate}).
 *
 * <p>Round-1 F6 is why these must not run on H2: the H2 profile disables Flyway,
 * so {@code instance_owner} is created by the entities with <b>zero rows</b> —
 * {@code FOR UPDATE} would lock nothing and every concurrency assertion would be
 * a false green.
 *
 * <p>Fixtures are built with SQL on purpose (role/owner/epoch are database facts,
 * not API-only state); the behaviour under test always goes through the public
 * HTTP surface.
 */
class InstanceOwnershipIntegrationTest extends AbstractIntegrationTest {

    private static final String PASSWORD = "Ownership-pass-1";

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private SessionRepository sessionRepository;

    @Autowired
    private GrantDefaultService grantDefaultService;

    @Autowired
    private com.cc01cc.p.xihe.cp.config.JwtTokenProvider jwtTokenProvider;

    /**
     * The shared test RestTemplate is backed by the JDK {@code HttpURLConnection},
     * which cannot emit PATCH and drops the 401 bodies this suite asserts on. The
     * JDK {@code HttpClient} factory can do both (same workaround as
     * {@code ExecutionModeAuthorityTest}).
     */
    private RestTemplate api;

    @BeforeEach
    void resetInstanceState() {
        api = new RestTemplate(new org.springframework.http.client.JdkClientHttpRequestFactory());
        api.setErrorHandler(new org.springframework.web.client.DefaultResponseErrorHandler() {
            @Override
            public boolean hasError(org.springframework.http.HttpStatusCode statusCode) {
                return statusCode.is5xxServerError();
            }
        });
        // Deterministic starting point: no ADMINs, no owner, epoch back to the
        // value V85 initializes. Each test promotes exactly the accounts it needs.
        jdbc.update("UPDATE users SET role = 'USER', token_version = 0");
        jdbc.update("UPDATE instance_owner SET owner_user_id = NULL, assigned_at = NULL, assigned_by = NULL");
    }

    // ── V8: migration + deterministic backfill ────────────────────────────────

    /**
     * V8: the shipped V85 backfill must pick the earliest ADMIN with an id
     * tie-break. Two ADMINs share {@code created_at} on purpose (the column is
     * {@code DEFAULT NOW()} = transaction time, so equal values are the normal
     * case), which is exactly the situation where ordering by time alone is not
     * deterministic (round-1 F3).
     */
    @Test
    void migrationBackfillPicksEarliestAdminWithTieBreak() throws Exception {
        String first = register("tie-a@test.com");
        String second = register("tie-b@test.com");
        String firstId = userIdOf(first);
        String secondId = userIdOf(second);
        // Equal created_at + both ADMIN + no owner yet: the frozen ORDER BY must
        // resolve to the smaller id.
        jdbc.update("UPDATE users SET role = 'ADMIN', created_at = TIMESTAMPTZ '2026-01-01 00:00:00+00'"
                + " WHERE id IN (CAST(? AS UUID), CAST(? AS UUID))", firstId, secondId);
        String expected = firstId.compareTo(secondId) < 0 ? firstId : secondId;

        assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM instance_owner", Integer.class),
                "V85 inserts exactly one singleton row");
        assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM flyway_schema_history"
                + " WHERE version = '85' AND success = true", Integer.class),
                "V85 must be recorded once as successful");
        // V85 adds token_version with DEFAULT 0: a freshly registered account starts at 0.
        assertEquals(0, jdbc.queryForObject("SELECT token_version FROM users WHERE id = CAST(? AS UUID)",
                Integer.class, firstId), "V85 initializes the epoch of new rows to 0");

        runShippedBackfill();

        assertEquals(UUID.fromString(expected), jdbc.queryForObject(
                        "SELECT owner_user_id FROM instance_owner WHERE id = 1", UUID.class),
                "backfill must be deterministic: ORDER BY created_at, id LIMIT 1");

        // Idempotent: a second run must not overwrite an existing pointer.
        jdbc.update("UPDATE instance_owner SET owner_user_id = CAST(? AS UUID) WHERE id = 1", secondId);
        runShippedBackfill();
        assertEquals(UUID.fromString(secondId), jdbc.queryForObject(
                "SELECT owner_user_id FROM instance_owner WHERE id = 1", UUID.class),
                "o.owner_user_id IS NULL guard keeps a transferred pointer intact");
    }

    /** Runs the exact UPDATE shipped in V85 (extracted from the migration file). */
    private void runShippedBackfill() throws Exception {
        String sql = Files.readString(Path.of("src/main/resources/db/migration/V85__instance_ownership.sql"),
                StandardCharsets.UTF_8);
        int start = sql.indexOf("UPDATE instance_owner o");
        int end = sql.indexOf(';', start);
        assertTrue(start > 0 && end > start, "V85 must contain the frozen backfill UPDATE");
        jdbc.update(sql.substring(start, end));
    }

    // ── V2/V4: read surface, privacy and epoch ───────────────────────────────

    /** V2: GET reports the pointer and "am I it", and never leaks account identifiers. */
    @Test
    void ownerReadHidesAccountIdentifiers() throws Exception {
        String ownerToken = register("owner-read@test.com");
        String ownerId = userIdOf(ownerToken);
        promote(ownerId);
        assignOwner(ownerId);
        ownerToken = login("owner-read@test.com");

        ResponseEntity<String> response = get(ownerToken, "/api/v1/instance/owner");
        assertEquals(HttpStatus.OK, response.getStatusCode());
        JsonNode body = objectMapper.readTree(response.getBody());
        assertEquals(ownerId, body.path("ownerUserId").asText());
        assertTrue(body.path("isCurrentUser").asBoolean());
        assertFalse(body.has("username") || body.has("email") || body.has("name"),
                "owner read must not be an account-enumeration side channel: " + response.getBody());

        String otherToken = register("other-read@test.com");
        JsonNode otherView = objectMapper.readTree(get(otherToken, "/api/v1/instance/owner").getBody());
        assertFalse(otherView.path("isCurrentUser").asBoolean());
    }

    /** V4: a role change bumps the epoch, so the previously issued access token is rejected. */
    @Test
    void roleChangeInvalidatesPreviouslyIssuedAccessToken() throws Exception {
        String ownerToken = register("epoch-owner@test.com");
        String ownerId = userIdOf(ownerToken);
        promote(ownerId);
        assignOwner(ownerId);
        ownerToken = login("epoch-owner@test.com");

        String targetToken = register("epoch-target@test.com");
        String targetId = userIdOf(targetToken);
        // The target's refresh token, so the recovery path under test is
        // POST /auth/refresh (V4 wording), not a fresh login.
        String targetRefresh = tokens("epoch-target@test.com").get("refreshToken").asText();

        assertEquals(HttpStatus.OK, patchRole(ownerToken, targetId, "ADMIN").getStatusCode());
        assertEquals(1, jdbc.queryForObject("SELECT token_version FROM users WHERE id = CAST(? AS UUID)",
                Integer.class, targetId), "I4: epoch bumped in the same transaction");

        ResponseEntity<String> stale = get(targetToken, "/api/v1/auth/me");
        assertEquals(HttpStatus.UNAUTHORIZED, stale.getStatusCode(),
                "a token carrying the old epoch must be rejected: " + stale.getBody());
        assertTrue(stale.getBody().contains("AUTHORIZATION_REQUIRED"));

        // V4: refresh re-reads the user row, so the new token carries both the new
        // role and the new epoch; the pre-change access token stays dead.
        ResponseEntity<String> refreshed = api.postForEntity(url("/api/v1/auth/refresh"),
                Map.of("refreshToken", targetRefresh), String.class);
        assertEquals(HttpStatus.OK, refreshed.getStatusCode(), refreshed.getBody());
        String newToken = objectMapper.readTree(refreshed.getBody()).path("accessToken").asText();
        assertEquals("ADMIN", jwtTokenProvider.getRoleFromToken(newToken),
                "the refreshed token must carry the new role claim");
        assertEquals(HttpStatus.OK, get(newToken, "/api/v1/auth/me").getStatusCode());
        assertEquals(HttpStatus.OK, get(newToken, "/api/v1/instance/owner").getStatusCode());
        assertEquals(HttpStatus.UNAUTHORIZED, get(targetToken, "/api/v1/auth/me").getStatusCode(),
                "the pre-change access token must stay dead after refresh");
    }

    /** V4.1 / decision #14: all three fail-closed states answer 401, never 500. */
    @Test
    void threeEpochStatesAre401AndNever500() throws Exception {
        String ownerToken = register("epoch-states@test.com");
        String ownerId = userIdOf(ownerToken);
        promote(ownerId);
        assignOwner(ownerId);
        ownerToken = login("epoch-states@test.com");

        // T1: sub is not a UUID (the filter used to let UUID.fromString throw a 500).
        String t1 = jwtTokenProvider.createAccessToken("internal-service", "x@test.com", "ADMIN", 0);
        assertEquals(HttpStatus.UNAUTHORIZED, get(t1, "/api/v1/instance/owner").getStatusCode());

        // T2: valid UUID, no such row.
        String t2 = jwtTokenProvider.createAccessToken(
                UUID.randomUUID().toString(), "ghost@test.com", "ADMIN", 0);
        assertEquals(HttpStatus.UNAUTHORIZED, get(t2, "/api/v1/instance/owner").getStatusCode());

        // T3: stale epoch (claim 99 vs row 0).
        String t3 = jwtTokenProvider.createAccessToken(ownerId, "epoch-states@test.com", "ADMIN", 99);
        ResponseEntity<String> t3Response = get(t3, "/api/v1/instance/owner");
        assertEquals(HttpStatus.UNAUTHORIZED, t3Response.getStatusCode());
        assertFalse(t3Response.getBody().contains("\"status\":500"));

        // A control: the live token still works, so the 401s above are the epoch rule.
        assertEquals(HttpStatus.OK, get(ownerToken, "/api/v1/instance/owner").getStatusCode());
    }

    // ── V2/V3: transfer ──────────────────────────────────────────────────────

    /** V3: transfer requires the current owner's password and writes a durable audit row. */
    @Test
    void transferRequiresOwnerPasswordAndAuditsThePointerMove() throws Exception {
        String ownerToken = register("transfer-owner@test.com");
        String ownerId = userIdOf(ownerToken);
        promote(ownerId);
        assignOwner(ownerId);
        ownerToken = login("transfer-owner@test.com");

        String targetToken = register("transfer-target@test.com");
        String targetId = userIdOf(targetToken);
        promote(targetId);

        int auditsBefore = auditCount("instance_owner_transferred");
        ResponseEntity<String> wrongPassword = putOwner(ownerToken, targetId, "definitely-wrong");
        assertEquals(HttpStatus.UNAUTHORIZED, wrongPassword.getStatusCode());
        assertTrue(wrongPassword.getBody().contains("INVALID_CREDENTIALS"));
        assertEquals(ownerId, currentOwnerId(), "a failed re-authentication must not move the pointer");
        assertEquals(auditsBefore, auditCount("instance_owner_transferred"));

        ResponseEntity<String> ok = putOwner(ownerToken, targetId, PASSWORD);
        assertEquals(HttpStatus.OK, ok.getStatusCode(), ok.getBody());
        assertEquals(targetId, currentOwnerId());
        assertEquals(auditsBefore + 1, auditCount("instance_owner_transferred"));
        Map<String, Object> audit = jdbc.queryForMap(
                "SELECT user_id, resource_id, details FROM audit_logs WHERE action = 'instance_owner_transferred'"
                        + " ORDER BY created_at DESC LIMIT 1");
        assertEquals(UUID.fromString(ownerId), audit.get("user_id"), "actor is the previous owner");
        assertEquals(targetId, audit.get("resource_id"));
        assertFalse(String.valueOf(audit.get("details")).contains(PASSWORD),
                "audit must never contain the password");

        // The previous owner stays ADMIN: only the pointer moves.
        assertEquals("ADMIN", roleOf(ownerId));
        assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM instance_owner", Integer.class));
        // And GET now reports the new owner as "me" for the new owner's token.
        String newOwnerToken = login("transfer-target@test.com");
        assertTrue(objectMapper.readTree(get(newOwnerToken, "/api/v1/instance/owner").getBody())
                .path("isCurrentUser").asBoolean());
    }

    /** V3: non-owner callers and non-ADMIN targets are rejected with the frozen codes. */
    @Test
    void transferRejectsNonOwnerCallerAndNonAdminTarget() throws Exception {
        String ownerToken = register("guard-owner@test.com");
        String ownerId = userIdOf(ownerToken);
        promote(ownerId);
        assignOwner(ownerId);
        ownerToken = login("guard-owner@test.com");

        String adminToken = register("guard-admin@test.com");
        String plainUserToken = register("guard-user@test.com");
        String plainUserId = userIdOf(plainUserToken);

        ResponseEntity<String> notOwner = putOwner(adminToken, plainUserId, PASSWORD);
        assertEquals(HttpStatus.FORBIDDEN, notOwner.getStatusCode());
        assertTrue(notOwner.getBody().contains("NOT_INSTANCE_OWNER"));

        promote(userIdOf(adminToken));
        ResponseEntity<String> notAdmin = putOwner(ownerToken, plainUserId, PASSWORD);
        assertEquals(HttpStatus.CONFLICT, notAdmin.getStatusCode());
        assertTrue(notAdmin.getBody().contains("OWNER_TARGET_NOT_ADMIN"));

        ResponseEntity<String> missing = putOwner(ownerToken, UUID.randomUUID().toString(), PASSWORD);
        assertEquals(HttpStatus.NOT_FOUND, missing.getStatusCode());
        assertTrue(missing.getBody().contains("USER_NOT_FOUND"));
    }

    // ── V1/V2: guards + concurrency ─────────────────────────────────────────

    /** V2: the owner can never be demoted, and that denial is audited. */
    @Test
    void ownerCannotBeDemoted() throws Exception {
        String ownerToken = register("protect-owner@test.com");
        String ownerId = userIdOf(ownerToken);
        promote(ownerId);
        assignOwner(ownerId);
        String secondAdminToken = register("protect-admin@test.com");
        String secondAdminId = userIdOf(secondAdminToken);
        promote(secondAdminId);
        ownerToken = login("protect-owner@test.com");
        secondAdminToken = login("protect-admin@test.com");

        int denialsBefore = auditCount("user_role_change_denied");
        ResponseEntity<String> denied = patchRole(secondAdminToken, ownerId, "USER");
        assertEquals(HttpStatus.CONFLICT, denied.getStatusCode());
        assertTrue(denied.getBody().contains("INSTANCE_OWNER_PROTECTED"));
        assertEquals("ADMIN", roleOf(ownerId));

        assertEquals(denialsBefore + 1, auditCount("user_role_change_denied"),
                "the denial must leave a durable audit row despite the rollback");
        Map<String, Object> audit = jdbc.queryForMap(
                "SELECT details FROM audit_logs WHERE action = 'user_role_change_denied'"
                        + " ORDER BY created_at DESC LIMIT 1");
        assertTrue(String.valueOf(audit.get("details")).contains("reason=INSTANCE_OWNER_PROTECTED"));
    }

    /**
     * V1: the last-admin guard. A consistent instance cannot reach it through the
     * API (the last ADMIN is always the owner, and the owner guard fires first),
     * so the state is built directly — this is defence in depth for the
     * disable/delete paths that PLAN-0581 will add.
     */
    @Test
    void lastAdminGuardRejectsTheOnlyRemainingAdmin() throws Exception {
        String actorToken = register("last-admin-actor@test.com");
        String actorId = userIdOf(actorToken);
        promote(actorId);
        String onlyAdminToken = register("last-admin-only@test.com");
        String onlyAdminId = userIdOf(onlyAdminToken);
        promote(onlyAdminId);
        // Owner points at a plain USER so the owner guard does not answer first.
        String plainUserToken = register("last-admin-plain@test.com");
        assignOwner(userIdOf(plainUserToken));
        actorToken = login("last-admin-actor@test.com");
        // Two ADMINs -> demoting the actor is allowed (one ADMIN remains).
        assertEquals(HttpStatus.OK, patchRole(actorToken, actorId, "USER").getStatusCode());
        onlyAdminToken = login("last-admin-only@test.com");

        ResponseEntity<String> denied = patchRole(onlyAdminToken, onlyAdminId, "USER");
        assertEquals(HttpStatus.CONFLICT, denied.getStatusCode());
        assertTrue(denied.getBody().contains("LAST_ADMIN"), denied.getBody());
        assertEquals("ADMIN", roleOf(onlyAdminId));
        assertEquals(1, adminCount());
    }

    /**
     * V1: two concurrent demotions of the only two ADMINs must yield exactly one
     * 200 and one 409 (the singleton row lock serializes them; the second sees
     * count = 1). A 503 here would mean the lock was held longer than
     * {@code cp.lock-timeout-ms} — a test-design problem, not a pass.
     */
    @Test
    void concurrentDemotionsKeepExactlyOneAdmin() throws Exception {
        String firstToken = register("race-a@test.com");
        String firstId = userIdOf(firstToken);
        String secondToken = register("race-b@test.com");
        String secondId = userIdOf(secondToken);
        promote(firstId);
        promote(secondId);
        assignOwner(firstId);
        firstToken = login("race-a@test.com");
        secondToken = login("race-b@test.com");
        assertEquals(2, adminCount());

        String firstCaller = firstToken;
        String secondCaller = secondToken;
        CyclicBarrier barrier = new CyclicBarrier(2);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            List<Callable<ResponseEntity<String>>> tasks = new ArrayList<>();
            tasks.add(() -> {
                barrier.await(10, TimeUnit.SECONDS);
                return patchRole(firstCaller, firstId, "USER");
            });
            tasks.add(() -> {
                barrier.await(10, TimeUnit.SECONDS);
                return patchRole(secondCaller, secondId, "USER");
            });
            List<Future<ResponseEntity<String>>> futures = pool.invokeAll(tasks, 30, TimeUnit.SECONDS);
            List<Integer> statuses = new ArrayList<>();
            for (Future<ResponseEntity<String>> future : futures) {
                statuses.add(future.get(30, TimeUnit.SECONDS).getStatusCode().value());
            }
            assertEquals(1, statuses.stream().filter(status -> status == 200).count(),
                    "exactly one demotion may succeed, got " + statuses);
            assertEquals(1, statuses.stream().filter(status -> status == 409).count(),
                    "the loser must be a 409 state conflict (never 503), got " + statuses);
            assertFalse(statuses.contains(503), "lock wait exceeded cp.lock-timeout-ms: " + statuses);
        } finally {
            pool.shutdownNow();
        }
        assertEquals(1, adminCount(), "the instance must still have exactly one ADMIN");
    }

    // ── V5/V5.1: default grants ─────────────────────────────────────────────

    /**
     * V5 + V5.1: promoting a user rewrites only the {@code subject_type=user}
     * default grant; the {@code subject_type=agent} snapshot of an already
     * created Session keeps the old set (decision #13, explicit acceptance).
     */
    @Test
    void roleChangeResyncsUserDefaultButKeepsAgentSnapshot() throws Exception {
        String ownerToken = register("grant-owner@test.com");
        String ownerId = userIdOf(ownerToken);
        promote(ownerId);
        assignOwner(ownerId);
        ownerToken = login("grant-owner@test.com");

        String memberToken = register("grant-member@test.com");
        String memberId = userIdOf(memberToken);
        String memberWorkspace = workspaceOfMember(memberId);

        Session session = new Session(memberWorkspace, memberId, "PLAN-0580 snapshot probe");
        session.setId(UUID.randomUUID());
        sessionRepository.saveAndFlush(session);
        grantDefaultService.ensureAgentSessionDefault(session);

        String agentBefore = permissionsOf("agent", session.getId());
        String userBefore = permissionsOf("user", UUID.fromString(memberId));
        assertFalse(userBefore.contains("credential_use"), "USER default has no credential atoms");
        assertFalse(agentBefore.contains("credential_use"));

        assertEquals(HttpStatus.OK, patchRole(ownerToken, memberId, "ADMIN").getStatusCode());

        String userAfter = permissionsOf("user", UUID.fromString(memberId));
        String agentAfter = permissionsOf("agent", session.getId());
        assertTrue(userAfter.contains("credential_use"), "V5: USER->ADMIN adds the credential atoms");
        assertTrue(userAfter.contains("credential_manage"));
        assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM grants WHERE subject_type = 'user'"
                        + " AND subject_id = CAST(? AS UUID) AND source = 'default'", Integer.class, memberId),
                "V5: still exactly one default row for the subject");
        assertEquals(agentBefore, agentAfter,
                "V5.1: an existing Session's agent default snapshot must stay frozen");
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    /** Registers a fresh USER account and returns its access token. */
    private String register(String email) throws Exception {
        ResponseEntity<String> response = api.postForEntity(url("/api/v1/auth/register"),
                Map.of("email", email, "password", PASSWORD, "name", "Ownership"), String.class);
        assertEquals(HttpStatus.CREATED, response.getStatusCode(), response.getBody());
        return objectMapper.readTree(response.getBody()).path("accessToken").asText();
    }

    /** Re-issues a token after a direct role/epoch change (login reads the role from the row). */
    private String login(String email) throws Exception {
        ResponseEntity<String> response = api.postForEntity(url("/api/v1/auth/login"),
                Map.of("identifier", email, "password", PASSWORD), String.class);
        assertEquals(HttpStatus.OK, response.getStatusCode(), response.getBody());
        return objectMapper.readTree(response.getBody()).path("accessToken").asText();
    }

    private String userIdOf(String token) {
        return jwtTokenProvider.getUserIdFromToken(token);
    }

    /** Fresh login response as JSON (access token, refresh token, workspaceId). */
    private JsonNode tokens(String email) throws Exception {
        ResponseEntity<String> response = api.postForEntity(url("/api/v1/auth/login"),
                Map.of("identifier", email, "password", PASSWORD), String.class);
        assertEquals(HttpStatus.OK, response.getStatusCode(), response.getBody());
        return objectMapper.readTree(response.getBody());
    }

    private String workspaceOfMember(String userId) {
        return jdbc.queryForObject("SELECT workspace_id FROM workspace_users WHERE user_id = ? LIMIT 1",
                String.class, UUID.fromString(userId));
    }

    private void promote(String userId) {
        jdbc.update("UPDATE users SET role = 'ADMIN' WHERE id = CAST(? AS UUID)", userId);
    }

    private void assignOwner(String userId) {
        jdbc.update("UPDATE instance_owner SET owner_user_id = CAST(? AS UUID), assigned_at = NOW()"
                + " WHERE id = 1", userId);
    }

    private String currentOwnerId() {
        UUID owner = jdbc.queryForObject("SELECT owner_user_id FROM instance_owner WHERE id = 1", UUID.class);
        return owner == null ? null : owner.toString();
    }

    private String roleOf(String userId) {
        return jdbc.queryForObject("SELECT role FROM users WHERE id = CAST(? AS UUID)", String.class, userId);
    }

    private int adminCount() {
        return jdbc.queryForObject("SELECT COUNT(*) FROM users WHERE role = 'ADMIN'", Integer.class);
    }

    private int auditCount(String action) {
        return jdbc.queryForObject("SELECT COUNT(*) FROM audit_logs WHERE action = ?", Integer.class, action);
    }

    private String permissionsOf(String subjectType, UUID subjectId) {
        return jdbc.queryForObject("SELECT permissions::text FROM grants WHERE subject_type = ?"
                + " AND subject_id = ? AND source = 'default' ORDER BY created_at DESC LIMIT 1",
                String.class, subjectType, subjectId);
    }

    private HttpHeaders authHeaders(String token) {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.setBearerAuth(token);
        return headers;
    }

    private ResponseEntity<String> get(String token, String path) {
        return api.exchange(url(path), HttpMethod.GET,
                new HttpEntity<>(authHeaders(token)), String.class);
    }

    private ResponseEntity<String> patchRole(String token, String targetUserId, String role) {
        return api.exchange(url("/api/v1/users/" + targetUserId + "/role"), HttpMethod.PATCH,
                new HttpEntity<>(Map.of("role", role), authHeaders(token)), String.class);
    }

    private ResponseEntity<String> putOwner(String token, String targetUserId, String password) {
        return api.exchange(url("/api/v1/instance/owner"), HttpMethod.PUT,
                new HttpEntity<>(Map.of("targetUserId", targetUserId, "password", password),
                        authHeaders(token)), String.class);
    }
}
