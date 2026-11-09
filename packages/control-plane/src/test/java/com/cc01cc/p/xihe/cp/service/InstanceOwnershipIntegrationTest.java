package com.cc01cc.p.xihe.cp.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.assertFalse;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.policy.GrantDefaultService;
import com.cc01cc.p.xihe.cp.policy.PermissionAtomCatalog;
import com.cc01cc.p.xihe.cp.policy.SystemAccessRoleCatalog;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
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
import org.springframework.web.client.RestTemplate;
import org.springframework.jdbc.core.JdbcTemplate;

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

    @Autowired
    private com.cc01cc.p.xihe.cp.policy.AuthzContext authzContext;

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
        // PLAN-0610 W4b: users.role is gone; each test grants the instance tier binding it needs.
        jdbc.update("DELETE FROM role_bindings WHERE scope_type = 'instance'");
        jdbc.update("UPDATE users SET token_version = 0");
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
        promote(firstId);
        promote(secondId);
        // Equal created_at + both ADMIN + no owner yet: the frozen ORDER BY must
        // resolve to the smaller id.
        jdbc.update("UPDATE users SET created_at = TIMESTAMPTZ '2026-01-01 00:00:00+00'"
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

/**
     * Replays the V85 pointer-claim contract against the access-role model.
     *
     * <p>The shipped V85 SQL reads {@code users.role}, which V89 dropped, so the statement cannot be
     * re-executed verbatim. The contract it froze — "claim the earliest ADMIN, ties broken by id,
     * never overwrite an existing pointer" — is replayed here over {@code role_bindings}, which is
     * the only place an instance tier lives since V88.</p>
     */
    private void runShippedBackfill() {
        jdbc.update("UPDATE instance_owner o SET owner_user_id = ("
                + " SELECT b.subject_id FROM role_bindings b"
                + " JOIN roles r ON r.id = b.role_id"
                + " JOIN users u ON u.id = b.subject_id"
                + " WHERE b.scope_type = 'instance' AND b.subject_type = 'user'"
                + "   AND r.name = 'ADMIN' AND u.deleted_at IS NULL"
                + " ORDER BY u.created_at, u.id LIMIT 1),"
                + " assigned_at = NOW(), assigned_by = NULL, updated_at = NOW()"
                + " WHERE o.id = 1 AND o.owner_user_id IS NULL");
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
        // PLAN-0610 W1b (R2-9): PUT /api/v1/instance/owner requires cap:instance:admin at the URL
        // layer, so the caller must be an administrator before the controller answers
        // NOT_INSTANCE_OWNER (a plain USER is refused earlier with 403 FORBIDDEN).
        promote(userIdOf(adminToken));

        ResponseEntity<String> notOwner = putOwner(adminToken, plainUserId, PASSWORD);
        assertEquals(HttpStatus.FORBIDDEN, notOwner.getStatusCode());
        assertTrue(notOwner.getBody().contains("NOT_INSTANCE_OWNER"), notOwner.getBody());

        promote(userIdOf(adminToken));
        ResponseEntity<String> notAdmin = putOwner(ownerToken, plainUserId, PASSWORD);
        assertEquals(HttpStatus.CONFLICT, notAdmin.getStatusCode());
        assertTrue(notAdmin.getBody().contains("OWNER_TARGET_NOT_ADMIN"));

        ResponseEntity<String> missing = putOwner(ownerToken, UUID.randomUUID().toString(), PASSWORD);
        assertEquals(HttpStatus.NOT_FOUND, missing.getStatusCode());
        assertTrue(missing.getBody().contains("USER_NOT_FOUND"));
    }

    // ── T4.3 (I5): the binding handover is part of the same transaction ─────

    /**
     * PLAN-0610 T4.3: one transfer writes <b>both</b> bindings, reconciles both atom sets, bumps
     * both epochs and moves the pointer. The previous owner keeps the ADMIN tier (contract §4
     * 「the previous owner stays ADMIN」) instead of holding a stale SUPER_ADMIN.
     */
    @Test
    void transferRewritesSuperAdminBindingsAtomically() throws Exception {
        String ownerToken = register("t43-owner@test.com");
        String ownerId = userIdOf(ownerToken);
        promote(ownerId);
        grantInstanceRole(ownerId, "SUPER_ADMIN");
        assignOwner(ownerId);
        ownerToken = login("t43-owner@test.com");

        String targetToken = register("t43-target@test.com");
        String targetId = userIdOf(targetToken);
        promote(targetId);

        authzContext.invalidateAll();
        assertEquals(List.of("SUPER_ADMIN"), instanceTierRoles(ownerId));
        assertEquals(List.of("ADMIN"), instanceTierRoles(targetId));
        assertTrue(authzContext.isInstanceSuper(UUID.fromString(ownerId)));
        int ownerEpochBefore = tokenVersion(ownerId);
        int targetEpochBefore = tokenVersion(targetId);
        int ownerAuditsBefore = auditCount("authorization_instance_super_admin_transferred");

        ResponseEntity<String> ok = putOwner(ownerToken, targetId, PASSWORD);
        assertEquals(HttpStatus.OK, ok.getStatusCode(), ok.getBody());

        assertEquals(targetId, currentOwnerId());
        assertEquals(List.of("SUPER_ADMIN"), instanceTierRoles(targetId),
                "the incoming owner holds exactly one instance tier binding (SUPER_ADMIN)");
        assertEquals(List.of("ADMIN"), instanceTierRoles(ownerId),
                "the outgoing owner is downgraded to ADMIN, not left without a tier");
        // Derived from the code-side role seeds (BL-312 removed CREATE_OWN_AGENT; the counts follow
        // the catalog): a hard-coded 15/8 would rot on the next atom change, and the claim here is
        // about *which* role materialized what, not about a magic number.
        assertEquals(materializableSeedAtoms(SystemAccessRoleCatalog.SUPER_ADMIN),
                atomRowCount("user", UUID.fromString(targetId)),
                "SUPER_ADMIN materializes every action atom (capability atoms stay out of grants)");
        assertEquals(materializableSeedAtoms(SystemAccessRoleCatalog.ADMIN),
                atomRowCount("user", UUID.fromString(ownerId)),
                "ADMIN materializes the user default set plus the three credential atoms");
        authzContext.invalidateAll();
        assertTrue(authzContext.isInstanceSuper(UUID.fromString(targetId)),
                "the new owner resolves cap:instance:super");
        assertFalse(authzContext.isInstanceSuper(UUID.fromString(ownerId)),
                "the previous owner no longer resolves cap:instance:super");
        assertTrue(authzContext.isInstanceAdmin(UUID.fromString(ownerId)));
        assertEquals(ownerEpochBefore + 1, tokenVersion(ownerId),
                "I4: the outgoing owner's epoch moves in the same transaction");
        assertEquals(targetEpochBefore + 1, tokenVersion(targetId),
                "I4: the incoming owner's epoch moves in the same transaction");
        assertEquals(ownerAuditsBefore + 1,
                auditCount("authorization_instance_super_admin_transferred"));
        assertEquals(1, jdbc.queryForObject(
                "SELECT COUNT(*) FROM role_bindings b JOIN roles r ON r.id = b.role_id"
                        + " WHERE r.name = 'SUPER_ADMIN' AND b.scope_type = 'instance'"
                        + " AND b.subject_id = CAST(? AS UUID)", Integer.class, targetId));
        assertTrue(activeSuperAdminBindings() >= 1,
                "I5: the instance still has at least one ACTIVE super administrator");
        assertEquals(0, jdbc.queryForObject(
                "SELECT COUNT(*) FROM role_bindings b JOIN roles r ON r.id = b.role_id"
                        + " WHERE r.name = 'SUPER_ADMIN' AND b.scope_type = 'instance'"
                        + " AND b.subject_id = CAST(? AS UUID)", Integer.class, ownerId),
                "the outgoing owner must not keep a second SUPER_ADMIN binding");
    }

    /**
     * T4.3: a DISABLED target cannot become the owner (it could never log in, so the instance would
     * be left without a usable SUPER_ADMIN). The refusal changes nothing.
     */
    @Test
    void transferRejectsDisabledTargetWithoutChangingAnything() throws Exception {
        String ownerToken = register("t43-disabled-owner@test.com");
        String ownerId = userIdOf(ownerToken);
        promote(ownerId);
        grantInstanceRole(ownerId, "SUPER_ADMIN");
        assignOwner(ownerId);
        ownerToken = login("t43-disabled-owner@test.com");

        String targetId = userIdOf(register("t43-disabled-target@test.com"));
        promote(targetId);
        jdbc.update("UPDATE users SET status = 'DISABLED' WHERE id = CAST(? AS UUID)", targetId);

        String before = transferState();
        int auditsBefore = auditCount("instance_owner_transferred");
        ResponseEntity<String> denied = putOwner(ownerToken, targetId, PASSWORD);
        assertEquals(HttpStatus.CONFLICT, denied.getStatusCode(), denied.getBody());
        assertTrue(denied.getBody().contains("OWNER_TARGET_UNAVAILABLE"), denied.getBody());
        assertEquals(ownerId, currentOwnerId());
        assertEquals(before, transferState(), "pointer/bindings/atoms/epochs must not change");
        assertEquals(auditsBefore, auditCount("instance_owner_transferred"));
    }

    /** T4.3: a soft-deleted target is refused with the shared 409 USER_DELETED code. */
    @Test
    void transferRejectsSoftDeletedTargetWithoutChangingAnything() throws Exception {
        String ownerToken = register("t43-deleted-owner@test.com");
        String ownerId = userIdOf(ownerToken);
        promote(ownerId);
        grantInstanceRole(ownerId, "SUPER_ADMIN");
        assignOwner(ownerId);
        ownerToken = login("t43-deleted-owner@test.com");

        String targetId = userIdOf(register("t43-deleted-target@test.com"));
        promote(targetId);
        jdbc.update("UPDATE users SET deleted_at = NOW(), status = 'DISABLED'"
                + " WHERE id = CAST(? AS UUID)", targetId);

        String before = transferState();
        ResponseEntity<String> denied = putOwner(ownerToken, targetId, PASSWORD);
        assertEquals(HttpStatus.CONFLICT, denied.getStatusCode(), denied.getBody());
        assertTrue(denied.getBody().contains("USER_DELETED"), denied.getBody());
        assertEquals(ownerId, currentOwnerId());
        assertEquals(before, transferState());
    }

    /** T4.3: a target without an instance ADMIN tier binding is still 409 (capability judgement). */
    @Test
    void transferRequiresTheTargetToHoldTheInstanceAdminCapability() throws Exception {
        String ownerToken = register("t43-cap-owner@test.com");
        String ownerId = userIdOf(ownerToken);
        promote(ownerId);
        grantInstanceRole(ownerId, "SUPER_ADMIN");
        assignOwner(ownerId);
        ownerToken = login("t43-cap-owner@test.com");

        // No instance ADMIN binding is granted to the target: the capability judgement (design §3.6)
        // refuses instead of trusting a legacy row.
        String targetId = userIdOf(register("t43-cap-target@test.com"));

        String before = transferState();
        ResponseEntity<String> denied = putOwner(ownerToken, targetId, PASSWORD);
        assertEquals(HttpStatus.CONFLICT, denied.getStatusCode(), denied.getBody());
        assertTrue(denied.getBody().contains("OWNER_TARGET_NOT_ADMIN"), denied.getBody());
        assertEquals(ownerId, currentOwnerId());
        assertEquals(before, transferState());
    }

    // ── V1/V2: guards + concurrency ─────────────────────────────────────────

    /** V2: the owner can never be demoted, and that denial is audited. */

    /**
     * V1: the last-admin guard. A consistent instance cannot reach it through the
     * API (the last ADMIN is always the owner, and the owner guard fires first),
     * so the state is built directly — this is defence in depth for the
     * disable/delete paths that PLAN-0581 will add.
     */

    /**
     * V1: two concurrent demotions of the only two ADMINs must yield exactly one
     * 200 and one 409 (the singleton row lock serializes them; the second sees
     * count = 1). A 503 here would mean the lock was held longer than
     * {@code cp.lock-timeout-ms} — a test-design problem, not a pass.
     */

    // ── V5/V5.1: default grants ─────────────────────────────────────────────

    /**
     * V5 + V5.1: promoting a user rewrites only the {@code subject_type=user}
     * default grant; the {@code subject_type=agent} snapshot of an already
     * created Session keeps the old set (decision #13, explicit acceptance).
     */

    /** T1.3(a): ADMIN -> USER drops the credential atoms from the user default set. */

    /** T1.3(b): a subject with no default row gets one created (create branch, not update). */

    /** T1.3(c): two concurrent promotions of the same subject stay idempotent (one default row). */

    /**
     * T3.2: two concurrent owner transfers must not both succeed — the singleton row
     * lock serializes them and the loser re-reads the pointer, finds it already
     * moved, and answers 403 NOT_INSTANCE_OWNER (never a second 200).
     */
    @Test
    void concurrentOwnerTransfersAllowExactlyOneWinner() throws Exception {
        String ownerToken = register("xfer-owner@test.com");
        String ownerId = userIdOf(ownerToken);
        promote(ownerId);
        assignOwner(ownerId);
        ownerToken = login("xfer-owner@test.com");

        String firstTargetId = userIdOf(register("xfer-target-a@test.com"));
        String secondTargetId = userIdOf(register("xfer-target-b@test.com"));
        promote(firstTargetId);
        promote(secondTargetId);
        int auditsBefore = auditCount("instance_owner_transferred");
        String caller = ownerToken;

        CyclicBarrier barrier = new CyclicBarrier(2);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        List<Integer> statuses = new ArrayList<>();
        try {
            List<Callable<ResponseEntity<String>>> tasks = new ArrayList<>();
            tasks.add(() -> {
                barrier.await(10, TimeUnit.SECONDS);
                return putOwner(caller, firstTargetId, PASSWORD);
            });
            tasks.add(() -> {
                barrier.await(10, TimeUnit.SECONDS);
                return putOwner(caller, secondTargetId, PASSWORD);
            });
            List<Future<ResponseEntity<String>>> futures = pool.invokeAll(tasks, 30, TimeUnit.SECONDS);
            for (Future<ResponseEntity<String>> future : futures) {
                statuses.add(future.get(30, TimeUnit.SECONDS).getStatusCode().value());
            }
        } finally {
            pool.shutdownNow();
        }

        assertEquals(1, statuses.stream().filter(status -> status == 200).count(),
                "exactly one transfer may succeed, got " + statuses);
        // T4.3: the winner bumps both epochs in the same transaction (I4), so the loser answers
        // either 403 NOT_INSTANCE_OWNER (it authenticated before the commit and then re-reads the
        // moved pointer) or 401 (its pre-transfer access token is already stale when the filter
        // runs). Both prove "exactly one winner"; any other status is a defect.
        assertEquals(1, statuses.stream().filter(status -> status == 403 || status == 401).count(),
                "the loser must be refused with 403 NOT_INSTANCE_OWNER or 401 (stale epoch), got "
                        + statuses);
        assertFalse(statuses.contains(503), "lock wait exceeded cp.lock-timeout-ms: " + statuses);
        assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM instance_owner", Integer.class));
        String owner = currentOwnerId();
        assertTrue(owner.equals(firstTargetId) || owner.equals(secondTargetId),
                "the owner must be exactly one of the two targets, got " + owner);
        assertEquals(auditsBefore + 1, auditCount("instance_owner_transferred"),
                "only the winning transfer is audited");
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
        return jdbc.queryForObject("SELECT scope_id FROM role_bindings WHERE subject_type = 'user'"
                + " AND subject_id = ? AND scope_type = 'workspace' LIMIT 1",
                String.class, UUID.fromString(userId));
    }

    /** PLAN-0610 W4a/W4b: the instance tier is the ADMIN role binding (users.role is gone). */
    private void promote(String userId) {
        grantInstanceRole(userId, "ADMIN");
    }

    private void grantInstanceRole(String userId, String roleName) {
        jdbc.update("DELETE FROM role_bindings WHERE subject_type = 'user'"
                + " AND subject_id = CAST(? AS UUID) AND scope_type = 'instance'", userId);
        jdbc.update("INSERT INTO role_bindings (id, role_id, subject_type, subject_id, scope_type,"
                + " granted_at) SELECT CAST(? AS UUID), r.id, 'user', CAST(? AS UUID), 'instance',"
                + " NOW() FROM roles r WHERE r.name = ?",
                UUID.randomUUID().toString(), userId, roleName);
        authzContext.invalidate(UUID.fromString(userId));
    }

    private void assignOwner(String userId) {
        jdbc.update("UPDATE instance_owner SET owner_user_id = CAST(? AS UUID), assigned_at = NOW()"
                + " WHERE id = 1", userId);
    }

    private String currentOwnerId() {
        UUID owner = jdbc.queryForObject("SELECT owner_user_id FROM instance_owner WHERE id = 1", UUID.class);
        return owner == null ? null : owner.toString();
    }

    /** PLAN-0610 W4b: the instance tier is a binding; users.role no longer exists. */
    private String roleOf(String userId) {
        return jdbc.queryForObject("SELECT r.name FROM role_bindings b JOIN roles r ON r.id = b.role_id"
                + " WHERE b.subject_type = 'user' AND b.subject_id = CAST(? AS UUID)"
                + " AND b.scope_type = 'instance'", String.class, userId);
    }

    /** T4.3: the subject's instance-scope tier bindings, as role names in a stable order. */
    private List<String> instanceTierRoles(String userId) {
        return jdbc.queryForList("SELECT r.name FROM role_bindings b JOIN roles r ON r.id = b.role_id"
                + " WHERE b.subject_type = 'user' AND b.subject_id = CAST(? AS UUID)"
                + " AND b.scope_type = 'instance'"
                + " AND r.name IN ('SUPER_ADMIN', 'ADMIN', 'USER') ORDER BY r.name",
                String.class, userId);
    }

    private int tokenVersion(String userId) {
        return jdbc.queryForObject("SELECT token_version FROM users WHERE id = CAST(? AS UUID)",
                Integer.class, userId);
    }

    /** I5: ACTIVE (and not soft-deleted) holders of the instance SUPER_ADMIN binding. */
    private int activeSuperAdminBindings() {
        return jdbc.queryForObject("SELECT COUNT(*) FROM role_bindings b"
                + " JOIN roles r ON r.id = b.role_id"
                + " JOIN users u ON u.id = b.subject_id"
                + " WHERE r.name = 'SUPER_ADMIN' AND b.scope_type = 'instance'"
                + " AND u.status = 'ACTIVE' AND u.deleted_at IS NULL", Integer.class);
    }

    /**
     * T4.3 failure-injection basis: the pointer + every tier binding + the two epoch columns.
     * Any difference between two snapshots means a refused transfer wrote something.
     */
    private String transferState() {
        String pointer = String.valueOf(currentOwnerId());
        String bindings = String.join(";", jdbc.queryForList(
                "SELECT subject_id || ':' || r.name FROM role_bindings b"
                        + " JOIN roles r ON r.id = b.role_id"
                        + " WHERE b.scope_type = 'instance' AND r.name IN ('SUPER_ADMIN', 'ADMIN', 'USER')"
                        + " ORDER BY subject_id, r.name", String.class));
        String epochs = String.join(";", jdbc.queryForList(
                "SELECT id || ':' || token_version FROM users ORDER BY id", String.class));
        return pointer + "|" + bindings + "|" + epochs;
    }

    private int adminCount() {
        return jdbc.queryForObject("SELECT COUNT(*) FROM users WHERE role = 'ADMIN'", Integer.class);
    }

    private int auditCount(String action) {
        return jdbc.queryForObject("SELECT COUNT(*) FROM audit_logs WHERE action = ?", Integer.class, action);
    }

    /**
     * PLAN-0610 W1a: the materialized set moved from one {@code source='default'} row to one
     * {@code source='role'} row per atom, and the Session snapshot lives under
     * {@code source='agent_default'}. The helper therefore aggregates the rows of whichever source
     * the subject type owns, in a stable order, so equal atom sets compare equal.
     */
    private String permissionsOf(String subjectType, UUID subjectId) {
        String source = "agent".equals(subjectType) ? "agent_default" : "role";
        List<String> rows = jdbc.queryForList("SELECT permissions::text FROM grants WHERE subject_type = ?"
                + " AND subject_id = ? AND source = ? ORDER BY permissions::text",
                String.class, subjectType, subjectId, source);
        return String.join("", rows);
    }

    private int atomRowCount(String subjectType, UUID subjectId) {
        // PLAN-0610 W3-3: instance-tier atoms only — a personal workspace now adds workspace-scope
        // rows for the same subject, which the workspace tests count separately.
        return jdbc.queryForObject("SELECT COUNT(*) FROM grants WHERE subject_type = ?"
                + " AND subject_id = ? AND source = 'role' AND scope_type = 'instance'",
                Integer.class, subjectType, subjectId);
    }

    /**
     * Action atoms of one seeded system role. Capability atoms are authorities, never grant rows
     * (PLAN-0610 #23), so they are filtered out here — the derivation follows the same rule the
     * materializer does instead of a hard-coded 15/8.
     */
    private static long materializableSeedAtoms(String roleName) {
        return SystemAccessRoleCatalog.roleSeeds().stream()
                .filter(seed -> roleName.equals(seed.name()))
                .findFirst()
                .orElseThrow()
                .atoms().stream()
                .filter(atom -> PermissionAtomCatalog.isActionAtom(atom.actionClass()))
                .count();
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





