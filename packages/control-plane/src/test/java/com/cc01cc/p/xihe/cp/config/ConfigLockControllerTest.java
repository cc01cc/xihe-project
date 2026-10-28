package com.cc01cc.p.xihe.cp.config;

import com.cc01cc.p.xihe.cp.AbstractH2Test;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.repository.ConfigJpaRepository;
import com.cc01cc.p.xihe.cp.repository.ConfigLockRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0556: the admin-only HTTP surface — catalog, lock/unlock, revision
 * conflict, NOT_LOCKABLE, and the non-admin 403 that must not leak key names.
 */
class ConfigLockControllerTest extends AbstractH2Test {

    @Autowired
    private ConfigLockRepository lockRepo;

    @Autowired
    private ConfigJpaRepository configRepo;

    @BeforeEach
    void cleanLocks() {
        lockRepo.deleteAll();
        configRepo.deleteAll(configRepo.findByLayerAndDomain("instance", "rag"));
    }

    @Test
    void catalogAsAdminListsKeysWithLockability() {
        ResponseEntity<Map> resp = restTemplate.exchange(
                url("/api/v1/config-locks?domain=rag"), HttpMethod.GET,
                new HttpEntity<>(authHeaders(adminToken())), Map.class);

        assertEquals(HttpStatus.OK, resp.getStatusCode());
        assertEquals("rag", resp.getBody().get("domain"));
        List<Map<String, Object>> keys = (List<Map<String, Object>>) resp.getBody().get("keys");
        assertNotNull(keys);
        assertFalse(keys.isEmpty());
        assertTrue(keys.stream().anyMatch(k -> "chunkSize".equals(k.get("key"))
                && Boolean.TRUE.equals(k.get("lockable"))));
    }

    @Test
    void catalogRejectsUnknownDomain() {
        ResponseEntity<Map> resp = restTemplate.exchange(
                url("/api/v1/config-locks?domain=pricing"), HttpMethod.GET,
                new HttpEntity<>(authHeaders(adminToken())), Map.class);

        assertEquals(HttpStatus.BAD_REQUEST, resp.getStatusCode());
        assertEquals("INVALID_DOMAIN", resp.getBody().get("code"));
    }

    @Test
    void nonAdminIsForbiddenWithoutKeyNames() {
        String userToken = userToken();

        ResponseEntity<Map> catalog = restTemplate.exchange(
                url("/api/v1/config-locks?domain=rag"), HttpMethod.GET,
                new HttpEntity<>(authHeaders(userToken)), Map.class);
        assertEquals(HttpStatus.FORBIDDEN, catalog.getStatusCode());
        assertFalse(String.valueOf(catalog.getBody()).contains("chunkSize"));

        ResponseEntity<Map> put = restTemplate.exchange(
                url("/api/v1/config-locks/rag/chunkSize"), HttpMethod.PUT,
                new HttpEntity<>(Map.of("reason", "x", "value", "1", "revision", 0),
                        authHeaders(userToken)), Map.class);
        assertEquals(HttpStatus.FORBIDDEN, put.getStatusCode());

        ResponseEntity<Map> delete = restTemplate.exchange(
                url("/api/v1/config-locks/rag/chunkSize?revision=0"), HttpMethod.DELETE,
                new HttpEntity<>(authHeaders(userToken)), Map.class);
        assertEquals(HttpStatus.FORBIDDEN, delete.getStatusCode());
    }

    @Test
    void adminLocksAndUnlocksWithRevisionGuard() {
        HttpHeaders admin = authHeaders(adminToken());

        ResponseEntity<Map> envKey = restTemplate.exchange(
                url("/api/v1/config-locks/job-policy/defaultTimeoutSecs"), HttpMethod.PUT,
                new HttpEntity<>(Map.of("reason", "x", "value", "10", "revision", 0), admin), Map.class);
        assertEquals(HttpStatus.BAD_REQUEST, envKey.getStatusCode());
        assertEquals("NOT_LOCKABLE", envKey.getBody().get("code"));

        ResponseEntity<Map> locked = restTemplate.exchange(
                url("/api/v1/config-locks/rag/chunkSize"), HttpMethod.PUT,
                new HttpEntity<>(Map.of("reason", "统一分块", "value", "4096", "revision", 0), admin),
                Map.class);
        assertEquals(HttpStatus.OK, locked.getStatusCode());
        assertEquals("统一分块", locked.getBody().get("reason"));
        long revision = ((Number) locked.getBody().get("revision")).longValue();
        assertTrue(revision > 0);

        ResponseEntity<Map> stale = restTemplate.exchange(
                url("/api/v1/config-locks/rag/chunkSize"), HttpMethod.PUT,
                new HttpEntity<>(Map.of("reason", "again", "value", "2048", "revision", 0), admin),
                Map.class);
        assertEquals(HttpStatus.CONFLICT, stale.getStatusCode());
        assertEquals("CONFIG_LOCK_CONFLICT", stale.getBody().get("code"));

        // Locked key writes are rejected for every layer, including instance.
        ResponseEntity<Map> instanceWrite = restTemplate.exchange(
                url("/api/v1/config/instance/rag"), HttpMethod.PUT,
                new HttpEntity<>(Map.of("chunkSize", "1"), admin), Map.class);
        assertEquals(HttpStatus.CONFLICT, instanceWrite.getStatusCode());
        assertEquals("CONFIG_KEY_LOCKED", instanceWrite.getBody().get("code"));

        ResponseEntity<Map> meta = restTemplate.exchange(
                url("/api/v1/config/rag/meta?layer=instance"), HttpMethod.GET,
                new HttpEntity<>(admin), Map.class);
        List<Map<String, Object>> keys = (List<Map<String, Object>>) meta.getBody().get("keys");
        Map<String, Object> chunk = keys.stream()
                .filter(k -> "chunkSize".equals(k.get("key"))).findFirst().orElseThrow();
        assertEquals(Boolean.TRUE, chunk.get("adminLocked"));
        assertEquals("统一分块", chunk.get("lockReason"));
        assertEquals(Boolean.FALSE, chunk.get("writable"));

        ResponseEntity<Map> unlocked = restTemplate.exchange(
                url("/api/v1/config-locks/rag/chunkSize?revision=" + revision + "&clearValue=true"),
                HttpMethod.DELETE, new HttpEntity<>(admin), Map.class);
        assertEquals(HttpStatus.OK, unlocked.getStatusCode());

        ResponseEntity<Map> again = restTemplate.exchange(
                url("/api/v1/config-locks/rag/chunkSize?revision=0"), HttpMethod.DELETE,
                new HttpEntity<>(admin), Map.class);
        assertEquals(HttpStatus.OK, again.getStatusCode());
    }

    private HttpHeaders authHeaders(String token) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        return headers;
    }

    private String userToken() {
        ResponseEntity<Map> reg = restTemplate.postForEntity(
                url("/api/v1/auth/register"),
                Map.of("email", "lock-user-" + System.nanoTime() + "@test.com",
                        "password", TestDataFactory.PASSWORD, "name", "LockUser"),
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
        return (String) login.getBody().get("accessToken");
    }
}
