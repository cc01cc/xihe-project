package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.UserRole;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.ClientHttpResponse;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.TestPropertySource;
import org.springframework.web.client.DefaultResponseErrorHandler;
import org.springframework.web.client.RestTemplate;

import javax.sql.DataSource;
import java.io.IOException;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * PLAN-0585 decision #9: the target-user row lock is bounded by {@code cp.lock-timeout-ms} and a
 * timed-out wait must surface as 503 {@code OPERATION_LOCK_TIMEOUT} (never as a silent success or a
 * generic 500). A short timeout keeps the test fast; the holder connection locks the target row.
 *
 * <p><b>Isolation:</b> the property override makes Spring build one extra context variant, confined
 * to this class. {@link AbstractIntegrationTest} already closes the context after the class; the
 * annotation is repeated here to state the intent, so the variant never enters another class's
 * cache and the default 5000 ms timeout stays untouched elsewhere. The PostgreSQL container is the
 * shared static one from the base class — no second container, no second JVM.</p>
 */
@TestPropertySource(properties = "cp.lock-timeout-ms=250")
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class PrincipalGrantLockTimeoutContractTest extends AbstractIntegrationTest {

    @Autowired private UserRepository userRepository;
    @Autowired private AuthorizationGrantRepository grantRepository;
    @Autowired private JdbcTemplate jdbcTemplate;
    @Autowired private DataSource dataSource;

    private UUID adminId;
    private UUID targetId;
    private String targetUsername;
    private String adminToken;
    private RestTemplate patchClient;

    @AfterEach
    void cleanFixtures() {
        for (UUID id : new UUID[] {targetId, adminId}) {
            if (id != null) {
                jdbcTemplate.update("DELETE FROM audit_logs WHERE resource_type = 'principal_grant' "
                        + "AND resource_id = ?", id.toString());
                grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId("user", id));
                jdbcTemplate.update("DELETE FROM users WHERE id = ?::uuid", id.toString());
            }
        }
        adminId = null;
        targetId = null;
        targetUsername = null;
        adminToken = null;
    }

    @Test
    void targetRowLockTimeoutIsReportedAs503() throws Exception {
        fixture();
        patchClient = new RestTemplate(new JdkClientHttpRequestFactory());
        // The 503 is the assertion target, so the client must hand back the problem body instead of
        // throwing an HttpServerErrorException.
        patchClient.setErrorHandler(new DefaultResponseErrorHandler() {
            @Override
            public boolean hasError(ClientHttpResponse response) throws IOException {
                return false;
            }
        });

        try (Connection holder = dataSource.getConnection()) {
            holder.setAutoCommit(false);
            try (PreparedStatement lock = holder.prepareStatement(
                    "SELECT id FROM users WHERE id = ?::uuid FOR UPDATE")) {
                lock.setString(1, targetId.toString());
                lock.executeQuery().close();
            }

            HttpHeaders headers = new HttpHeaders();
            headers.setBearerAuth(adminToken);
            headers.setContentType(MediaType.APPLICATION_JSON);
            ResponseEntity<Map> response = patchClient.exchange(
                    url("/api/v1/principal-grants/" + targetUsername), HttpMethod.PATCH,
                    new HttpEntity<>(Map.of("add",
                            List.of(Map.of("actionClass", "CREATE_ACCOUNT"))), headers), Map.class);

            assertEquals(HttpStatus.SERVICE_UNAVAILABLE, response.getStatusCode(),
                    String.valueOf(response.getBody()));
            assertEquals("OPERATION_LOCK_TIMEOUT", response.getBody().get("code"));
            holder.rollback();
        }

        // Nothing was written by the timed-out request.
        assertEquals(0, jdbcTemplate.queryForObject(
                "SELECT count(*) FROM grants WHERE subject_type = 'user' AND subject_id = ?::uuid "
                        + "AND source = 'direct'", Integer.class, targetId.toString()));
        assertEquals(0, jdbcTemplate.queryForObject(
                "SELECT count(*) FROM audit_logs WHERE resource_type = 'principal_grant' "
                        + "AND resource_id = ?", Integer.class, targetId.toString()));
    }

    private void fixture() {
        User admin = new User("pg-lock-admin-" + UUID.randomUUID() + "@test.com", "hash",
                UserRole.ADMIN, "Lock admin", "pglockadmin" + shortId());
        admin = userRepository.saveAndFlush(admin);
        adminId = admin.getId();
        adminToken = TestDataFactory.createGlobalToken(adminId.toString(), admin.getEmail(), "ADMIN", 0);

        User target = userRepository.saveAndFlush(new User("pg-lock-target-" + UUID.randomUUID()
                + "@test.com", "hash", UserRole.USER, "Lock target", "pglock" + shortId()));
        targetId = target.getId();
        targetUsername = target.getUsername();
    }

    private static String shortId() {
        return UUID.randomUUID().toString().replace("-", "").substring(0, 8);
    }
}
