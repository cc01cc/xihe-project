package com.cc01cc.p.xihe.cp.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
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
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.client.RestTemplate;

/**
 * PLAN-0581 M1/M2/M3 contract tests on <b>real PostgreSQL</b> (Testcontainers,
 * Flyway on, {@code ddl-auto=validate}).
 *
 * <p>Why PG and not H2 (contract §11): the H2 profile disables Flyway, so the V86
 * CHECK constraints and the epoch columns would be built by Hibernate with no
 * constraint enforcement — every revocation assertion would be a false green.
 *
 * <p>Fixtures are created through SQL on purpose (role/status/epoch/owner are
 * database facts, not API-only state); the behaviour under test always goes
 * through the public HTTP surface, and every epoch assertion is a before/after
 * SQL snapshot.
 */
class UserAdminIntegrationTest extends AbstractIntegrationTest {

    private static final String PASSWORD = "User-admin-pass-1";

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private com.cc01cc.p.xihe.cp.config.JwtTokenProvider jwtTokenProvider;

    /** The shared RestTemplate uses HttpURLConnection: no PATCH/DELETE and it drops 401 bodies. */
    private RestTemplate api;

    /**
     * The database is shared by every method of this class (one context, one
     * container), so a literal email would collide with the previous test's row.
     * Tests keep writing "@test.com" addresses; the alias map makes each one unique
     * per method while register/login/SQL fixtures all resolve through it.
     */
    private final Map<String, String> emailAlias = new java.util.HashMap<>();

    private String actualEmail(String requested) {
        return emailAlias.computeIfAbsent(requested, key ->
                key.replace("@", "-" + UUID.randomUUID().toString().substring(0, 8) + "@"));
    }

    @BeforeEach
    void resetInstanceState() {
        api = new RestTemplate(new org.springframework.http.client.JdkClientHttpRequestFactory());
        api.setErrorHandler(new org.springframework.web.client.DefaultResponseErrorHandler() {
            @Override
            public boolean hasError(org.springframework.http.HttpStatusCode statusCode) {
                return statusCode.is5xxServerError();
            }
        });
        emailAlias.clear();
        emailAlias.clear();
        jdbc.update("UPDATE users SET role = 'USER', status = 'ACTIVE', deleted_at = NULL,"
                + " token_version = 0, session_version = 0");
        jdbc.update("UPDATE instance_owner SET owner_user_id = NULL, assigned_at = NULL, assigned_by = NULL");
    }

    // ── V2: the dual-channel matrix (contract §4) ────────────────────────────

    /**
     * Matrix row 2 — disable: the old access token dies (tv bumped), the old
     * refresh token dies (sv bumped) and a fresh login is refused. This is the row
     * the 0580 audit's P1-2 was about: without the same-transaction bump, "disable"
     * would keep the account working for 900s and keep minting access tokens via
     * refresh.
     */
    @Test
    void disableKillsBothChannelsAndBlocksLogin() throws Exception {
        String adminToken = adminWithOwner();
        String userId = userIdOf(register("victim-disable@test.com"));
        Tokens victim = login("victim-disable@test.com");
        assertEquals(0, tokenVersion(userId));
        assertEquals(0, sessionVersion(userId));

        ResponseEntity<String> response = patchStatus(adminToken, userId, "DISABLED");
        assertEquals(HttpStatus.OK, response.getStatusCode(), response.getBody());

        // Contract §4: one transaction bumps both epochs.
        assertEquals(1, tokenVersion(userId), "access epoch +1");
        assertEquals(1, sessionVersion(userId), "refresh epoch +1");

        ResponseEntity<String> staleAccess = get(victim.accessToken(), "/api/v1/auth/me");
        assertEquals(HttpStatus.UNAUTHORIZED, staleAccess.getStatusCode(),
                "old access token must be rejected: " + staleAccess.getBody());
        assertTrue(staleAccess.getBody().contains("AUTHORIZATION_REQUIRED"),
                "the rejection comes from the 0580 tv three-state path, not a new code");

        ResponseEntity<String> staleRefresh = post(Map.of("refreshToken", victim.refreshToken()),
                "/api/v1/auth/refresh", null);
        assertEquals(HttpStatus.UNAUTHORIZED, staleRefresh.getStatusCode(),
                "old refresh token must be rejected: " + staleRefresh.getBody());

        ResponseEntity<String> blockedLogin = api.postForEntity(url("/api/v1/auth/login"),
                Map.of("identifier", actualEmail("victim-disable@test.com"), "password", PASSWORD), String.class);
        assertEquals(HttpStatus.UNAUTHORIZED, blockedLogin.getStatusCode(),
                "a disabled account cannot log in");
        assertFalse(blockedLogin.getBody().contains("DISABLED"),
                "the refusal must not leak the account state: " + blockedLogin.getBody());
    }

    /**
     * Matrix row 1 plus the reverse control of the 0580/0581 boundary: a role change
     * bumps only the access epoch, so access dies but refresh still works and
     * re-issues a token carrying the new role. Getting this wrong (bumping sv too)
     * would log every user out on a routine permission change.
     */
    @Test
    void roleChangeKillsAccessButKeepsRefreshAlive() throws Exception {
        String adminToken = adminWithOwner();
        String targetId = userIdOf(register("role-keep@test.com"));
        Tokens target = login("role-keep@test.com");

        assertEquals(HttpStatus.OK, patchRole(adminToken, targetId, "ADMIN").getStatusCode());
        assertEquals(1, tokenVersion(targetId), "0580 bumps the access epoch");
        assertEquals(0, sessionVersion(targetId), "0581 must NOT bump the refresh epoch here");

        assertEquals(HttpStatus.UNAUTHORIZED, get(target.accessToken(), "/api/v1/auth/me").getStatusCode(),
                "old access token must be rejected");

        ResponseEntity<String> refreshed = post(Map.of("refreshToken", target.refreshToken()),
                "/api/v1/auth/refresh", null);
        assertEquals(HttpStatus.OK, refreshed.getStatusCode(), refreshed.getBody());
        String newAccess = objectMapper.readTree(refreshed.getBody()).path("accessToken").asText();
        assertEquals("ADMIN", jwtTokenProvider.getRoleFromToken(newAccess),
                "refresh re-issues with the current role, not the stale one");
        assertEquals(HttpStatus.OK, get(newAccess, "/api/v1/auth/me").getStatusCode());
    }

    /** Matrix row 5: an administrator password reset kills both channels and rotates the password. */
    @Test
    void passwordResetRotatesAndRevokesBothChannels() throws Exception {
        String adminToken = adminWithOwner();
        String userId = userIdOf(register("reset-victim@test.com"));
        Tokens victim = login("reset-victim@test.com");

        ResponseEntity<String> reset = post(null, "/api/v1/users/" + userId + "/password-reset", adminToken);
        assertEquals(HttpStatus.OK, reset.getStatusCode(), reset.getBody());
        String temporaryPassword = objectMapper.readTree(reset.getBody()).path("temporaryPassword").asText();
        assertFalse(temporaryPassword.isBlank(), "the one-time password must be returned once");

        assertEquals(1, tokenVersion(userId));
        assertEquals(1, sessionVersion(userId));
        assertEquals(HttpStatus.UNAUTHORIZED, get(victim.accessToken(), "/api/v1/auth/me").getStatusCode());
        assertEquals(HttpStatus.UNAUTHORIZED, post(Map.of("refreshToken", victim.refreshToken()),
                "/api/v1/auth/refresh", null).getStatusCode());

        // Old password is dead, the temporary one works.
        assertEquals(HttpStatus.UNAUTHORIZED, api.postForEntity(url("/api/v1/auth/login"),
                Map.of("identifier", actualEmail("reset-victim@test.com"), "password", PASSWORD), String.class)
                .getStatusCode());
        assertEquals(HttpStatus.OK, api.postForEntity(url("/api/v1/auth/login"),
                Map.of("identifier", actualEmail("reset-victim@test.com"), "password", temporaryPassword), String.class)
                .getStatusCode());

        // I4: the plaintext never reaches the audit trail.
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM audit_logs WHERE action ="
                        + " 'user_password_reset' AND details LIKE ?", Integer.class,
                "%" + temporaryPassword + "%"),
                "audit rows must not contain the temporary password");
    }

    /** Matrix row 4: soft delete sets deletedAt + DISABLED, revokes both channels and hides the row. */
    @Test
    void softDeleteRevokesBothChannelsAndHidesTheRow() throws Exception {
        String adminToken = adminWithOwner();
        String userId = userIdOf(register("soft-deleted@test.com"));
        Tokens victim = login("soft-deleted@test.com");

        assertEquals(HttpStatus.NO_CONTENT,
                delete("/api/v1/users/" + userId, adminToken).getStatusCode());

        Map<String, Object> row = jdbc.queryForMap(
                "SELECT status, deleted_at, token_version, session_version FROM users WHERE id = CAST(? AS UUID)",
                userId);
        assertEquals("DISABLED", row.get("status"));
        assertNotNull(row.get("deleted_at"));
        assertEquals(1, ((Number) row.get("token_version")).intValue());
        assertEquals(1, ((Number) row.get("session_version")).intValue());
        assertEquals(HttpStatus.UNAUTHORIZED, get(victim.accessToken(), "/api/v1/auth/me").getStatusCode());
        assertEquals(HttpStatus.UNAUTHORIZED, post(Map.of("refreshToken", victim.refreshToken()),
                "/api/v1/auth/refresh", null).getStatusCode());
        assertEquals(HttpStatus.UNAUTHORIZED, api.postForEntity(url("/api/v1/auth/login"),
                Map.of("identifier", actualEmail("soft-deleted@test.com"), "password", PASSWORD), String.class)
                .getStatusCode());

        // Default list hides it; includeDeleted shows it with a non-null deletedAt.
        assertFalse(listBody(adminToken, "").path("items").toString().contains(userId),
                "the default list must not return soft-deleted rows");
        JsonNode withDeleted = listBody(adminToken, "?includeDeleted=true");
        boolean found = false;
        for (JsonNode item : withDeleted.path("items")) {
            if (userId.equals(item.path("id").asText())) {
                assertFalse(item.path("deletedAt").isNull());
                found = true;
            }
        }
        assertTrue(found, "includeDeleted=true must return the soft-deleted row");
    }

    /**
     * Merge-audit P1-1: a soft-deleted row is terminal in v1, so re-enabling it must
     * be a contract 409 — not the DB CHECK violation that used to surface as an
     * unmapped 500 (the row is reachable from {@code GET /users?includeDeleted=true},
     * so an operator can really click "enable" on it).
     */
    @Test
    void softDeletedAccountCannotBeModified() throws Exception {
        String adminToken = adminWithOwner();
        String userId = userIdOf(register("deleted-guard@test.com"));
        assertEquals(HttpStatus.NO_CONTENT,
                delete("/api/v1/users/" + userId, adminToken).getStatusCode());

        ResponseEntity<String> reEnable = patchStatus(adminToken, userId, "ACTIVE");
        assertEquals(HttpStatus.CONFLICT, reEnable.getStatusCode(), reEnable.getBody());
        assertTrue(reEnable.getBody().contains("USER_DELETED"), reEnable.getBody());
        assertFalse(reEnable.getBody().contains("\"status\":500"), "must never be a 500");

        ResponseEntity<String> reset = post(null, "/api/v1/users/" + userId + "/password-reset", adminToken);
        assertEquals(HttpStatus.CONFLICT, reset.getStatusCode(), reset.getBody());
        assertTrue(reset.getBody().contains("USER_DELETED"), reset.getBody());

        // The row is untouched: still deleted and still DISABLED.
        Map<String, Object> row = jdbc.queryForMap(
                "SELECT status, deleted_at FROM users WHERE id = CAST(? AS UUID)", userId);
        assertEquals("DISABLED", row.get("status"));
        assertNotNull(row.get("deleted_at"));
        // Idempotent soft delete stays a no-op (no second epoch bump on a retry).
        assertEquals(HttpStatus.NO_CONTENT,
                delete("/api/v1/users/" + userId, adminToken).getStatusCode());
        assertEquals(1, tokenVersion(userId));
    }

    /**
     * Merge-audit P2-1: the last-admin threshold only applies when the target is
     * still usable. Soft-deleting an already-DISABLED ADMIN removes nothing from the
     * usable set, so it must be allowed instead of a misleading 409 LAST_ADMIN.
     */
    @Test
    void removingAnAlreadyDisabledAdminIsNotBlockedAsLastAdmin() throws Exception {
        String adminToken = adminWithOwner();
        String disabledAdminId = userIdOf(register("dormant-admin@test.com"));
        jdbc.update("UPDATE users SET role = 'ADMIN' WHERE id = CAST(? AS UUID)", disabledAdminId);
        assertEquals(HttpStatus.OK, patchStatus(adminToken, disabledAdminId, "DISABLED").getStatusCode());
        assertEquals(1, usableAdminCount(), "only the owner is usable now");

        ResponseEntity<String> deleted = delete("/api/v1/users/" + disabledAdminId, adminToken);
        assertEquals(HttpStatus.NO_CONTENT, deleted.getStatusCode(), deleted.getBody());
        assertNotNull(jdbc.queryForObject(
                "SELECT deleted_at FROM users WHERE id = CAST(? AS UUID)", Object.class, disabledAdminId));
    }

    /** Matrix row 3: re-enabling does not revive the dead credentials — the user logs in again. */
    @Test
    void enableDoesNotReviveOldCredentials() throws Exception {
        String adminToken = adminWithOwner();
        String userId = userIdOf(register("re-enable@test.com"));
        Tokens victim = login("re-enable@test.com");
        assertEquals(HttpStatus.OK, patchStatus(adminToken, userId, "DISABLED").getStatusCode());
        assertEquals(HttpStatus.OK, patchStatus(adminToken, userId, "ACTIVE").getStatusCode());

        assertEquals(1, tokenVersion(userId), "re-enabling must not bump the epoch");
        assertEquals(1, sessionVersion(userId));
        assertEquals(HttpStatus.UNAUTHORIZED, get(victim.accessToken(), "/api/v1/auth/me").getStatusCode());
        assertEquals(HttpStatus.UNAUTHORIZED, post(Map.of("refreshToken", victim.refreshToken()),
                "/api/v1/auth/refresh", null).getStatusCode());
        assertEquals(HttpStatus.OK, api.postForEntity(url("/api/v1/auth/login"),
                Map.of("identifier", actualEmail("re-enable@test.com"), "password", PASSWORD), String.class)
                .getStatusCode(), "the account works again through a fresh login");
    }

    /** Matrix row 6: 0558 lockout and admin disable are different semantics — lockout does not revoke. */
    @Test
    void failedLoginsDoNotRevokeTokens() throws Exception {
        adminWithOwner();
        String userId = userIdOf(register("lockout-victim@test.com"));
        Tokens victim = login("lockout-victim@test.com");

        for (int attempt = 0; attempt < 3; attempt++) {
            assertEquals(HttpStatus.UNAUTHORIZED, api.postForEntity(url("/api/v1/auth/login"),
                    Map.of("identifier", actualEmail("lockout-victim@test.com"), "password", "wrong-password"),
                    String.class).getStatusCode());
        }
        assertEquals(0, tokenVersion(userId), "lockout must not bump the access epoch");
        assertEquals(0, sessionVersion(userId), "lockout must not bump the refresh epoch");
        assertEquals(HttpStatus.OK, get(victim.accessToken(), "/api/v1/auth/me").getStatusCode());
    }

    // ── V1/V7: queries and admin provisioning ───────────────────────────────

    /** V1: list total matches SQL, filters apply, ordering is createdAt DESC, 404 and 403 hold. */
    @Test
    void listMatchesSqlAndRespectsFilters() throws Exception {
        String adminToken = adminWithOwner();
        String first = userIdOf(register("list-a@test.com"));
        register("list-b@test.com");
        String promoted = userIdOf(register("list-admin@test.com"));
        jdbc.update("UPDATE users SET role = 'ADMIN' WHERE id = CAST(? AS UUID)", promoted);

        JsonNode all = listBody(adminToken, "?size=100");
        long expectedTotal = jdbc.queryForObject(
                "SELECT COUNT(*) FROM users WHERE deleted_at IS NULL", Long.class);
        assertEquals(expectedTotal, all.path("total").asLong(), "total must equal the SQL count");
        assertEquals(0, all.path("page").asInt());
        assertEquals(100, all.path("size").asInt());

        JsonNode admins = listBody(adminToken, "?role=ADMIN&size=100");
        assertEquals(jdbc.queryForObject("SELECT COUNT(*) FROM users WHERE deleted_at IS NULL"
                + " AND role = 'ADMIN'", Long.class), admins.path("total").asLong());
        for (JsonNode item : admins.path("items")) {
            assertEquals("ADMIN", item.path("role").asText());
        }

        JsonNode filtered = listBody(adminToken, "?q=" + actualEmail("list-a@test.com").split("@")[0]);
        assertTrue(filtered.path("total").asLong() >= 1);
        assertEquals(first, filtered.path("items").get(0).path("id").asText());

        // createdAt DESC: the newest row (promoted) comes first in an unfiltered list.
        assertEquals(promoted, all.path("items").get(0).path("id").asText());

        // The management view carries no credential material and no epoch columns.
        assertFalse(all.toString().contains("password"), "no password material in the view");
        assertFalse(all.toString().contains("Version"), "epoch columns are internal");

        assertEquals(HttpStatus.NOT_FOUND,
                get(adminToken, "/api/v1/users/" + UUID.randomUUID()).getStatusCode());
        String plainUser = register("plain-list@test.com");
        assertEquals(HttpStatus.FORBIDDEN, get(plainUser, "/api/v1/users").getStatusCode(),
                "the management surface is ADMIN-only");
    }

    /** V7: closed-mode provisioning — 201 with a one-time password, then duplicate handling. */
    @Test
    void adminCreatesUserWithOneTimePassword() throws Exception {
        String adminToken = adminWithOwner();

        ResponseEntity<String> created = post(Map.of("email", actualEmail("provisioned@test.com"), "role", "USER"),
                "/api/v1/users", adminToken);
        assertEquals(HttpStatus.CREATED, created.getStatusCode(), created.getBody());
        JsonNode body = objectMapper.readTree(created.getBody());
        String temporaryPassword = body.path("temporaryPassword").asText();
        String newUserId = body.path("user").path("id").asText();
        assertFalse(temporaryPassword.isBlank());

        assertEquals(HttpStatus.OK, api.postForEntity(url("/api/v1/auth/login"),
                Map.of("identifier", actualEmail("provisioned@test.com"), "password", temporaryPassword), String.class)
                .getStatusCode(), "the provisioned account can log in with the generated password");

        ResponseEntity<String> duplicateEmail = post(
                Map.of("email", actualEmail("provisioned@test.com")), "/api/v1/users", adminToken);
        assertEquals(HttpStatus.CONFLICT, duplicateEmail.getStatusCode());
        assertTrue(duplicateEmail.getBody().contains("EMAIL_TAKEN"));

        ResponseEntity<String> firstWithUsername = post(
                Map.of("email", actualEmail("dup-owner@test.com"), "username", "dupuser"), "/api/v1/users", adminToken);
        assertEquals(HttpStatus.CREATED, firstWithUsername.getStatusCode(), firstWithUsername.getBody());
        ResponseEntity<String> duplicateUsername = post(
                Map.of("email", actualEmail("another@test.com"), "username", "dupuser"), "/api/v1/users", adminToken);
        assertEquals(HttpStatus.CONFLICT, duplicateUsername.getStatusCode());
        assertTrue(duplicateUsername.getBody().contains("USERNAME_TAKEN"));

        ResponseEntity<String> invalidUsername = post(
                Map.of("email", actualEmail("another2@test.com"), "username", "BadName"), "/api/v1/users", adminToken);
        assertEquals(HttpStatus.BAD_REQUEST, invalidUsername.getStatusCode());
        assertTrue(invalidUsername.getBody().contains("USERNAME_INVALID"));

        // A caller-supplied password is honoured and never echoed back.
        ResponseEntity<String> withPassword = post(Map.of("email", actualEmail("explicit-pw@test.com"),
                "password", "explicit-pass-1"), "/api/v1/users", adminToken);
        assertEquals(HttpStatus.CREATED, withPassword.getStatusCode());
        assertFalse(withPassword.getBody().contains("temporaryPassword"),
                "no temporary password is returned when the caller supplies one");
        assertEquals(HttpStatus.OK, api.postForEntity(url("/api/v1/auth/login"),
                Map.of("identifier", actualEmail("explicit-pw@test.com"), "password", "explicit-pass-1"), String.class)
                .getStatusCode());

        assertNotNull(newUserId);
        assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM audit_logs WHERE action = 'user_created'"
                + " AND resource_id = ?", Integer.class, newUserId));
    }

    // ── V5: guards ──────────────────────────────────────────────────────────

    /**
     * V5: self / owner / last-admin guards in the frozen priority order, each
     * refusal audited.
     *
     * <p>Two notes on reachability. (a) The owner guard must answer before the
     * last-admin guard, so the owner is targeted while another usable ADMIN exists.
     * (b) LAST_ADMIN is <b>unreachable through a consistent API flow</b>: the caller
     * must itself be a usable ADMIN (a non-active account no longer authenticates),
     * so disabling another ADMIN always leaves the caller. It is therefore probed
     * the way PLAN-0580 probes its own branch — with a degenerate state: a token
     * whose {@code role} claim is ADMIN while the row is USER (the shape a stale
     * grant would produce) acting on the only usable ADMIN.
     */
    @Test
    void guardsBlockSelfOwnerAndLastAdmin() throws Exception {
        String ownerToken = adminWithOwner();
        String ownerId = userIdOf(ownerToken);
        String secondAdminToken = loginToken(promoteNewAdmin("guard-admin@test.com"));
        String secondAdminId = userIdOf(secondAdminToken);
        int denialsBefore = auditCount("user_admin_action_denied");

        ResponseEntity<String> self = patchStatus(ownerToken, ownerId, "DISABLED");
        assertEquals(HttpStatus.CONFLICT, self.getStatusCode());
        assertTrue(self.getBody().contains("SELF_OPERATION_FORBIDDEN"), self.getBody());

        ResponseEntity<String> ownerGuard = patchStatus(secondAdminToken, ownerId, "DISABLED");
        assertEquals(HttpStatus.CONFLICT, ownerGuard.getStatusCode());
        assertTrue(ownerGuard.getBody().contains("INSTANCE_OWNER_PROTECTED"), ownerGuard.getBody());

        // Degenerate state for LAST_ADMIN: the actor's JWT says ADMIN (passes
        // @PreAuthorize) but the row is USER, and the target is the only usable ADMIN.
        jdbc.update("UPDATE users SET role = 'USER' WHERE id = CAST(? AS UUID)", ownerId);
        jdbc.update("UPDATE users SET role = 'ADMIN', status = 'ACTIVE' WHERE id = CAST(? AS UUID)",
                secondAdminId);
        String claimAdminToken = jwtTokenProvider.createAccessToken(
                ownerId, "instance-owner-admin@test.com", "ADMIN", tokenVersion(ownerId));
        ResponseEntity<String> lastAdmin = patchStatus(claimAdminToken, secondAdminId, "DISABLED");
        assertEquals(HttpStatus.CONFLICT, lastAdmin.getStatusCode());
        assertTrue(lastAdmin.getBody().contains("LAST_ADMIN"), lastAdmin.getBody());
        assertEquals(1, usableAdminCount(), "the only usable ADMIN must survive");

        assertTrue(auditCount("user_admin_action_denied") >= denialsBefore + 3,
                "every refusal writes a durable audit row");
    }

    /**
     * V5 concurrency: "demote the other ADMIN" and "disable the owner" race. Both
     * paths take the same instance lock and count only usable admins, so the
     * terminal state keeps at least one usable ADMIN and nothing answers 503/500.
     */
    @Test
    void concurrentDemoteAndDisableKeepOneUsableAdmin() throws Exception {
        String ownerToken = adminWithOwner();
        String ownerId = userIdOf(ownerToken);
        String otherToken = loginToken(promoteNewAdmin("race-admin@test.com"));
        String otherId = userIdOf(otherToken);
        assertEquals(2, usableAdminCount());

        String demoting = ownerToken;
        String disabling = otherToken;
        String demoteTarget = otherId;
        String disableTarget = ownerId;
        CyclicBarrier barrier = new CyclicBarrier(2);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        List<Integer> statuses = new ArrayList<>();
        try {
            List<Callable<ResponseEntity<String>>> tasks = new ArrayList<>();
            tasks.add(() -> {
                barrier.await(10, TimeUnit.SECONDS);
                return patchRole(demoting, demoteTarget, "USER");
            });
            tasks.add(() -> {
                barrier.await(10, TimeUnit.SECONDS);
                return patchStatus(disabling, disableTarget, "DISABLED");
            });
            List<Future<ResponseEntity<String>>> futures = pool.invokeAll(tasks, 30, TimeUnit.SECONDS);
            for (Future<ResponseEntity<String>> future : futures) {
                statuses.add(future.get(30, TimeUnit.SECONDS).getStatusCode().value());
            }
        } finally {
            pool.shutdownNow();
        }
        assertFalse(statuses.contains(503), "lock wait exceeded cp.lock-timeout-ms: " + statuses);
        assertFalse(statuses.contains(500), "no guard may surface as a 500: " + statuses);
        assertTrue(statuses.contains(409), "disabling the owner must be refused: " + statuses);
        assertTrue(usableAdminCount() >= 1,
                "the instance must keep at least one usable ADMIN, statuses=" + statuses
                        + " owner=" + ownerId);
    }

    // ── 0580 V6 handover: instance ADMIN vs workspace OWNER do not cross ────

    /**
     * Handover from PLAN-0580's V6 (Lead ruling 2026-10-31): the two admin planes
     * are disjoint. A workspace OWNER never reaches instance-level endpoints, and
     * an instance ADMIN may read/emergency-remove workspace members but may not add
     * them or change their workspace role.
     */
    @Test
    void instanceAdminAndWorkspaceOwnerDoNotCrossPlanes() throws Exception {
        String instanceAdminToken = adminWithOwner();
        String workspaceOwnerToken = register("ws-owner@test.com");
        String workspaceOwnerId = userIdOf(workspaceOwnerToken);
        String workspaceId = workspaceOf(workspaceOwnerId);
        String memberId = userIdOf(register("ws-member@test.com"));
        jdbc.update("INSERT INTO workspace_users (workspace_id, user_id, role, created_at)"
                + " VALUES (CAST(? AS UUID), CAST(? AS UUID), 'VIEWER', NOW())", workspaceId, memberId);

        // workspace OWNER: own plane OK, instance plane refused.
        assertEquals(HttpStatus.OK,
                get(workspaceOwnerToken, "/api/v1/workspaces/" + workspaceId + "/members").getStatusCode());
        assertEquals(HttpStatus.FORBIDDEN, patchRole(workspaceOwnerToken, workspaceOwnerId, "ADMIN")
                .getStatusCode(), "a workspace OWNER must not reach the instance role surface");
        assertEquals(HttpStatus.FORBIDDEN, patchStatus(workspaceOwnerToken, workspaceOwnerId, "DISABLED")
                .getStatusCode(), "a workspace OWNER must not reach the instance status surface");
        ResponseEntity<String> ownerAttempt = api.exchange(url("/api/v1/instance/owner"), HttpMethod.PUT,
                new HttpEntity<>(Map.of("targetUserId", workspaceOwnerId, "password", PASSWORD),
                        authHeaders(workspaceOwnerToken)), String.class);
        assertEquals(HttpStatus.FORBIDDEN, ownerAttempt.getStatusCode());
        assertTrue(ownerAttempt.getBody().contains("NOT_INSTANCE_OWNER"), ownerAttempt.getBody());

        // instance ADMIN: may read the member list (0565 ruling #3) …
        assertEquals(HttpStatus.OK,
                get(instanceAdminToken, "/api/v1/workspaces/" + workspaceId + "/members").getStatusCode());
        // … but must not change workspace roles …
        ResponseEntity<String> adminPatchMember = api.exchange(
                url("/api/v1/workspaces/" + workspaceId + "/members/" + memberId), HttpMethod.PATCH,
                new HttpEntity<>(Map.of("role", "EDITOR"), authHeaders(instanceAdminToken)), String.class);
        assertEquals(HttpStatus.FORBIDDEN, adminPatchMember.getStatusCode(),
                "an instance ADMIN must not change workspace member roles");
        // … and the emergency removal path stays available.
        ResponseEntity<String> adminRemove = delete(
                "/api/v1/workspaces/" + workspaceId + "/members/" + memberId, instanceAdminToken);
        assertTrue(adminRemove.getStatusCode().is2xxSuccessful(),
                "emergency removal must stay available to the instance ADMIN: " + adminRemove.getBody());
        // The instance guards themselves are untouched by these workspace calls.
        assertEquals(HttpStatus.OK, get(instanceAdminToken, "/api/v1/instance/owner").getStatusCode());
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    private record Tokens(String accessToken, String refreshToken) {}

    private String adminWithOwner() throws Exception {
        String token = register("instance-owner-admin@test.com");
        String userId = userIdOf(token);
        jdbc.update("UPDATE users SET role = 'ADMIN' WHERE id = CAST(? AS UUID)", userId);
        jdbc.update("UPDATE instance_owner SET owner_user_id = CAST(? AS UUID), assigned_at = NOW()"
                + " WHERE id = 1", userId);
        return loginToken("instance-owner-admin@test.com");
    }

    /** Promotes a freshly registered account to ADMIN and returns its email (for a re-login). */
    private String promoteNewAdmin(String email) throws Exception {
        register(email);
        jdbc.update("UPDATE users SET role = 'ADMIN' WHERE email = ?", actualEmail(email));
        return email;
    }

    private String register(String email) throws Exception {
        ResponseEntity<String> response = api.postForEntity(url("/api/v1/auth/register"),
                Map.of("email", actualEmail(email), "password", PASSWORD, "name", "UserAdmin"), String.class);
        assertEquals(HttpStatus.CREATED, response.getStatusCode(), response.getBody());
        return objectMapper.readTree(response.getBody()).path("accessToken").asText();
    }

    private String loginToken(String email) throws Exception {
        return login(email).accessToken();
    }

    private Tokens login(String email) throws Exception {
        ResponseEntity<String> response = api.postForEntity(url("/api/v1/auth/login"),
                Map.of("identifier", actualEmail(email), "password", PASSWORD), String.class);
        assertEquals(HttpStatus.OK, response.getStatusCode(), response.getBody());
        JsonNode body = objectMapper.readTree(response.getBody());
        return new Tokens(body.path("accessToken").asText(), body.path("refreshToken").asText());
    }

    private String userIdOf(String accessToken) {
        return jwtTokenProvider.getUserIdFromToken(accessToken);
    }

    private String workspaceOf(String userId) {
        return jdbc.queryForObject("SELECT workspace_id FROM workspace_users WHERE user_id = ? LIMIT 1",
                String.class, UUID.fromString(userId));
    }

    private int tokenVersion(String userId) {
        return jdbc.queryForObject("SELECT token_version FROM users WHERE id = CAST(? AS UUID)",
                Integer.class, userId);
    }

    private int sessionVersion(String userId) {
        return jdbc.queryForObject("SELECT session_version FROM users WHERE id = CAST(? AS UUID)",
                Integer.class, userId);
    }

    private int usableAdminCount() {
        return jdbc.queryForObject("SELECT COUNT(*) FROM users WHERE role = 'ADMIN'"
                + " AND status = 'ACTIVE' AND deleted_at IS NULL", Integer.class);
    }

    private int auditCount(String action) {
        return jdbc.queryForObject("SELECT COUNT(*) FROM audit_logs WHERE action = ?", Integer.class, action);
    }

    private HttpHeaders authHeaders(String token) {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.setBearerAuth(token);
        return headers;
    }

    private JsonNode listBody(String token, String queryString) throws Exception {
        ResponseEntity<String> response = get(token, "/api/v1/users" + queryString);
        assertEquals(HttpStatus.OK, response.getStatusCode(), response.getBody());
        return objectMapper.readTree(response.getBody());
    }

    private ResponseEntity<String> get(String token, String path) {
        return api.exchange(url(path), HttpMethod.GET, new HttpEntity<>(authHeaders(token)), String.class);
    }

    private ResponseEntity<String> post(Object body, String path, String token) {
        HttpHeaders headers = token == null ? new HttpHeaders() : authHeaders(token);
        headers.setContentType(MediaType.APPLICATION_JSON);
        return api.exchange(url(path), HttpMethod.POST, new HttpEntity<>(body, headers), String.class);
    }

    private ResponseEntity<String> patchStatus(String token, String targetUserId, String status) {
        return api.exchange(url("/api/v1/users/" + targetUserId + "/status"), HttpMethod.PATCH,
                new HttpEntity<>(Map.of("status", status), authHeaders(token)), String.class);
    }

    private ResponseEntity<String> patchRole(String token, String targetUserId, String role) {
        return api.exchange(url("/api/v1/users/" + targetUserId + "/role"), HttpMethod.PATCH,
                new HttpEntity<>(Map.of("role", role), authHeaders(token)), String.class);
    }

    private ResponseEntity<String> delete(String path, String token) {
        return api.exchange(url(path), HttpMethod.DELETE, new HttpEntity<>(authHeaders(token)), String.class);
    }
}
