package com.cc01cc.p.xihe.cp.files;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.SessionForkRequest;
import com.cc01cc.p.xihe.cp.repository.SessionForkRequestRepository;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doCallRealMethod;
import static org.mockito.Mockito.doThrow;

class SessionForkRecoveryServiceIntegrationTest extends AbstractIntegrationTest {

    private static final Path ATTACHMENT_ROOT = Paths.get(
            System.getProperty("java.io.tmpdir"), "xihe-session-fork-recovery-it-" + UUID.randomUUID());

    @DynamicPropertySource
    static void registerAttachmentRoot(DynamicPropertyRegistry registry) {
        registry.add("cp.attachments-base-path", () -> ATTACHMENT_ROOT.toString());
    }

    @Autowired private JdbcTemplate jdbcTemplate;
    @Autowired private SessionForkRecoveryService recoveryService;
    @Autowired private SessionForkRequestRepository forkRequestRepository;
    @MockitoSpyBean private ChatAttachmentService attachmentSpy;

    @AfterAll
    static void cleanupTemporaryAttachmentRoot() throws IOException {
        if (!Files.exists(ATTACHMENT_ROOT)) {
            return;
        }
        Files.walkFileTree(ATTACHMENT_ROOT, new SimpleFileVisitor<>() {
            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) throws IOException {
                Files.delete(file);
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult postVisitDirectory(Path directory, IOException error) throws IOException {
                if (error != null) {
                    throw error;
                }
                Files.delete(directory);
                return FileVisitResult.CONTINUE;
            }
        });
    }

    @AfterEach
    void restoreRealCleanup() throws IOException {
        doCallRealMethod().when(attachmentSpy).deleteForkNamespaceStrict(anyString());
    }

    @Test
    void startupScanDrainsCleanupPendingToRetryableWithoutReplay() throws Exception {
        UUID childId = UUID.randomUUID();
        Path namespace = ATTACHMENT_ROOT.resolve(childId.toString());
        Files.createDirectories(namespace);
        Files.write(namespace.resolve("orphan.bin"), "orphan bytes".getBytes(StandardCharsets.UTF_8));
        assertTrue(Files.exists(namespace));
        insertCleanupPendingRow(childId, "recovery-drain-" + UUID.randomUUID());

        recoveryService.recoverOnStartup();

        SessionForkRequest request = forkRequestRepository.findById(childId).orElseThrow();
        assertEquals(SessionForkRequest.RETRYABLE, request.getState());
        assertNull(request.getLastErrorCode());
        assertFalse(Files.exists(namespace),
                "a drained cleanup_pending row must remove its abandoned child namespace");
        assertEquals(0, jdbcTemplate.queryForObject(
                        "select count(*) from sessions where id = ?", Integer.class, childId),
                "the startup scan cleans only; it must never replay a fork");
        assertEquals(0, jdbcTemplate.queryForObject(
                        "select count(*) from session_fork_requests "
                                + "where child_session_id = ? and state = ?",
                        Integer.class, childId, SessionForkRequest.CLEANUP_PENDING));
    }

    @Test
    void startupScanKeepsCleanupPendingWhenCleanupStillFails() throws Exception {
        UUID childId = UUID.randomUUID();
        doThrow(new IOException("injected cleanup failure"))
                .when(attachmentSpy).deleteForkNamespaceStrict(anyString());
        Path namespace = ATTACHMENT_ROOT.resolve(childId.toString());
        Files.createDirectories(namespace);
        Files.write(namespace.resolve("orphan.bin"), "orphan bytes".getBytes(StandardCharsets.UTF_8));
        insertCleanupPendingRow(childId, "recovery-pending-" + UUID.randomUUID());

        recoveryService.recoverOnStartup();

        SessionForkRequest request = forkRequestRepository.findById(childId).orElseThrow();
        assertEquals(SessionForkRequest.CLEANUP_PENDING, request.getState());
        assertEquals("FORK_CLEANUP_FAILED", request.getLastErrorCode());
        assertTrue(Files.exists(namespace),
                "a failed cleanup must not claim that its child namespace was removed");
        assertEquals(0, jdbcTemplate.queryForObject(
                "select count(*) from sessions where id = ?", Integer.class, childId),
                "a pending cleanup must keep its child Session invisible");
    }

    private void insertCleanupPendingRow(UUID childId, String idempotencyKey) {
        jdbcTemplate.update(
                "insert into session_fork_requests "
                        + "(child_session_id, source_session_id, idempotency_key, request_hash, state, "
                        + "cleanup_ref, created_at, updated_at) "
                        + "values (?, ?, ?, ?, ?, ?, "
                        + "now() - interval '10 minutes', now() - interval '10 minutes')",
                childId, UUID.randomUUID(), idempotencyKey, "a".repeat(64),
                SessionForkRequest.CLEANUP_PENDING, childId.toString());
    }
}
