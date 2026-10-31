package com.cc01cc.p.xihe.cp.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doThrow;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.policy.AuthzContext;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;

/**
 * PLAN-0610 T4.3 (I5) failure injection: the transfer is one transaction over pointer + both
 * bindings + both materialized atom sets + both epochs + the audit row, so a failure anywhere
 * leaves <b>nothing</b> behind.
 *
 * <p>Method: the real {@link InstanceOwnershipService#transfer} runs in its own transaction while
 * the {@link AuditLogger} bean is a spy that throws on the {@code instance_owner_transferred} row.
 * That audit write happens <b>after</b> the binding rewrite, the materialization, the epoch bumps
 * and the pointer update, so the thrown {@link IllegalStateException} proves those writes were
 * rolled back instead of merely not reached.</p>
 *
 * <p>Why not through HTTP: the assertion is about one transaction's rollback; the controller layer
 * would only show the mapped 500 and hide which writes had already happened.</p>
 */
class InstanceOwnerTransferAtomicityTest extends AbstractIntegrationTest {

    private static final String PASSWORD = "Ownership-pass-1";

    @Autowired
    private InstanceOwnershipService ownershipService;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private PasswordEncoder passwordEncoder;

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private AuthzContext authzContext;

    @MockitoSpyBean
    private AuditLogger auditLogger;

    @BeforeEach
    void failTheTransferAuditRowOnly() {
        doThrow(new IllegalStateException("injected audit failure"))
                .when(auditLogger)
                .recordDurableChange(any(), any(), eq("instance_owner_transferred"), any(), any(),
                        any());
    }

    @AfterEach
    void resetInstanceState() {
        // PLAN-0610 W4b: users.role is gone; the instance tier is a binding, so the reset clears
        // every instance-scope binding instead.
        jdbc.update("DELETE FROM role_bindings WHERE scope_type = 'instance'");
        jdbc.update("UPDATE users SET token_version = 0");
        jdbc.update("UPDATE instance_owner SET owner_user_id = NULL, assigned_at = NULL,"
                + " assigned_by = NULL");
    }

    @Test
    void aFailureAfterTheBindingRewriteRollsBackPointerBindingsAtomsAndEpochs() {
        User owner = newUser("atomic-owner");
        User target = newUser("atomic-target");
        grantTier(owner, "SUPER_ADMIN");
        grantTier(target, "ADMIN");
        jdbc.update("UPDATE instance_owner SET owner_user_id = CAST(? AS UUID) WHERE id = 1",
                owner.getId().toString());
        authzContext.invalidateAll();

        String before = stateSnapshot();
        List<String> ownerAtomsBefore = atomRows(owner);
        List<String> targetAtomsBefore = atomRows(target);
        int ownerEpochBefore = tokenVersion(owner);
        int targetEpochBefore = tokenVersion(target);

        assertThrows(IllegalStateException.class,
                () -> ownershipService.transfer(owner.getId().toString(), target.getId(), PASSWORD,
                        "127.0.0.1"));

        assertEquals(before, stateSnapshot(),
                "a failed transfer must leave the pointer, both bindings and both epochs untouched");
        assertEquals(ownerAtomsBefore, atomRows(owner),
                "the materialized atoms roll back with the binding rewrite");
        assertEquals(targetAtomsBefore, atomRows(target));
        assertEquals(ownerEpochBefore, tokenVersion(owner));
        assertEquals(targetEpochBefore, tokenVersion(target));
        assertEquals(0, auditCount("instance_owner_transferred"),
                "the audit row is part of the same transaction, so it rolls back too");
        assertEquals(0, auditCount("authorization_instance_super_admin_transferred"),
                "the binding audit row rolls back with the binding it describes");
        authzContext.invalidateAll();
        assertTrue(authzContext.isInstanceSuper(owner.getId()),
                "the owner keeps cap:instance:super after the rollback");
        assertFalse(authzContext.isInstanceSuper(target.getId()));
        assertEquals(owner.getId().toString(), currentOwnerId());
    }

    // ── fixtures ────────────────────────────────────────────────────────────

    private User newUser(String label) {
        User user = new User(label + "-" + UUID.randomUUID() + "@test.com",
                passwordEncoder.encode(PASSWORD), label);
        return userRepository.saveAndFlush(user);
    }

    private void grantTier(User user, String roleName) {
        jdbc.update("DELETE FROM role_bindings WHERE subject_type = 'user'"
                + " AND subject_id = CAST(? AS UUID) AND scope_type = 'instance'",
                user.getId().toString());
        jdbc.update("INSERT INTO role_bindings (id, role_id, subject_type, subject_id, scope_type,"
                        + " granted_at) SELECT CAST(? AS UUID), r.id, 'user', CAST(? AS UUID),"
                        + " 'instance', NOW() FROM roles r WHERE r.name = ?",
                UUID.randomUUID().toString(), user.getId().toString(), roleName);
        authzContext.invalidate(user.getId());
    }

    private int tokenVersion(User user) {
        return jdbc.queryForObject("SELECT token_version FROM users WHERE id = CAST(? AS UUID)",
                Integer.class, user.getId().toString());
    }

    private List<String> atomRows(User user) {
        return jdbc.queryForList("SELECT permissions::text FROM grants WHERE subject_type = 'user'"
                + " AND subject_id = CAST(? AS UUID) AND source = 'role'"
                + " ORDER BY permissions::text", String.class, user.getId());
    }

    private String currentOwnerId() {
        return jdbc.queryForObject(
                "SELECT CAST(owner_user_id AS VARCHAR) FROM instance_owner WHERE id = 1",
                String.class);
    }

    private String stateSnapshot() {
        String pointer = String.valueOf(currentOwnerId());
        String bindings = String.join(";", jdbc.queryForList(
                "SELECT subject_id || ':' || r.name FROM role_bindings b"
                        + " JOIN roles r ON r.id = b.role_id"
                        + " WHERE b.scope_type = 'instance'"
                        + " AND r.name IN ('SUPER_ADMIN', 'ADMIN', 'USER')"
                        + " ORDER BY subject_id, r.name", String.class));
        String epochs = String.join(";", jdbc.queryForList(
                "SELECT id || ':' || token_version FROM users ORDER BY id", String.class));
        return pointer + "|" + bindings + "|" + epochs;
    }

    private int auditCount(String action) {
        return jdbc.queryForObject("SELECT COUNT(*) FROM audit_logs WHERE action = ?", Integer.class,
                action);
    }
}
