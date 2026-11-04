package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractH2Test;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.MessageRole;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.SessionBranch;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.repository.SessionBranchRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.service.BranchPathService;
import com.cc01cc.p.xihe.cp.service.SessionService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * BL-295: the export cap is expressed by the renderer's bounded artifact, not by a session-wide
 * count refusal. These are real controller + renderer + database tests (H2 lane; PostgreSQL schema
 * gate for the migration itself is covered by the regular PG tests):
 *
 * <ul>
 *   <li>a session with 20k visible messages ⇒ HTTP 200, 2000 exported, {@code messagesTruncated:true};</li>
 *   <li>a session with 20k messages where the exported branch has only 50 visible ⇒ HTTP 200,
 *       50 exported, no truncation — the exact case the removed session-wide 413 refused.</li>
 * </ul>
 */
class SessionExportSemanticsIntegrationTest extends AbstractH2Test {

    private static final int TOTAL = 20_000;
    private static final int SMALL_BRANCH_VISIBLE = 50;

    @org.springframework.beans.factory.annotation.Autowired
    private SessionRepository sessions;
    @org.springframework.beans.factory.annotation.Autowired
    private UserRepository userRepository;
    @org.springframework.beans.factory.annotation.Autowired
    private WorkspaceFixture workspaceFixture;
    @org.springframework.beans.factory.annotation.Autowired
    private BranchPathService branchPathService;
    @org.springframework.beans.factory.annotation.Autowired
    private SessionBranchRepository branchRepository;
    @org.springframework.beans.factory.annotation.Autowired
    private SessionService sessionService;
    @org.springframework.beans.factory.annotation.Autowired
    private SessionExportStreamRenderer streamRenderer;
    @org.springframework.beans.factory.annotation.Autowired
    private JdbcTemplate jdbcTemplate;

    private String userId;
    private String workspaceId;

    @BeforeEach
    void setUpData() {
        String email = "export-bl295-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        ResponseEntity<AuthResponse> reg = restTemplate.postForEntity(
                baseUrl + "/api/v1/auth/register",
                new RegisterRequest(email, TestDataFactory.PASSWORD, "Export Probe"),
                AuthResponse.class);
        assertTrue(reg.getStatusCode().is2xxSuccessful());
        User user = userRepository.findByEmail(email).orElseThrow();
        userId = user.getId().toString();
        workspaceId = workspaceFixture.ensureOwnedWorkspace(UUID.fromString(userId)).getId().toString();
        TenantContext.setUserId(userId);
        TenantContext.setWorkspaceId(workspaceId);
    }

    @AfterEach
    void clearTenant() {
        TenantContext.clear();
    }

    private String createSession() {
        Session session = new Session(workspaceId, userId, "Export BL-295 session");
        session.setId(UUID.randomUUID());
        return sessions.saveAndFlush(session).getId().toString();
    }

    private void seedMessages(String sessionId, String branchId, int count, int startIndex) {
        List<Object[]> rows = new ArrayList<>(count);
        Instant createdAt = Instant.parse("2026-11-05T00:00:00Z");
        for (int index = 0; index < count; index++) {
            rows.add(new Object[]{UUID.randomUUID(), sessionId, branchId, MessageRole.USER.name(),
                    "m-" + (startIndex + index), createdAt.plusMillis(startIndex + index)});
        }
        jdbcTemplate.batchUpdate(
                "insert into messages (id, session_id, branch_id, role, content, created_at, visibility) "
                        + "values (?, ?, ?, ?, ?, ?, 'user')",
                rows);
    }

    private String exportBody(String sessionId, String branchId) throws IOException {
        SessionExportController controller = new SessionExportController(sessionService,
                branchPathService, streamRenderer);
        MockHttpServletResponse response = new MockHttpServletResponse();
        StreamingResponseBody body = controller.export(sessionId, branchId, response);
        body.writeTo(response.getOutputStream());
        assertEquals(200, response.getStatus());
        return response.getContentAsString(StandardCharsets.UTF_8);
    }

    private static long documentSections(String markdown) {
        return markdown.lines().filter(line -> line.matches("^## \\d+\\. .*")).count();
    }

    @Test
    void twentyThousandVisibleMessagesExportTheNewestLimitWithDisclosure() throws IOException {
        String sessionId = createSession();
        String rootBranchId = branchPathService.ensureRootBranchId(sessionId);
        seedMessages(sessionId, rootBranchId, TOTAL, 0);

        String markdown = exportBody(sessionId, rootBranchId);

        assertEquals(SessionExportService.MAX_MESSAGES, documentSections(markdown),
                "2000 messages must be exported (no 413)");
        assertTrue(markdown.contains("- messages: 2000"), markdown);
        assertTrue(markdown.contains("- messagesTruncated: true"),
                "the renderer is the only place the cap is expressed");
    }

    @Test
    void smallBranchOfLargeSessionExportsVisibleMessagesOnlyWithoutTruncation() throws IOException {
        String sessionId = createSession();
        String rootBranchId = branchPathService.ensureRootBranchId(sessionId);
        seedMessages(sessionId, rootBranchId, SMALL_BRANCH_VISIBLE, 0);

        // A sibling branch carries the other 19,950 rows; they are outside the exported branch path.
        String otherBranchId = UUID.randomUUID().toString();
        SessionBranch other = new SessionBranch(UUID.fromString(otherBranchId), sessionId);
        other.setParentBranchId(rootBranchId);
        other.setForkPointSequence(0L);
        other.setIdempotencyKey("bl295-" + UUID.randomUUID());
        other.setRequestHash("bl295-" + UUID.randomUUID());
        branchRepository.saveAndFlush(other);
        seedMessages(sessionId, otherBranchId, TOTAL - SMALL_BRANCH_VISIBLE, SMALL_BRANCH_VISIBLE);

        String markdown = exportBody(sessionId, rootBranchId);

        assertEquals(SMALL_BRANCH_VISIBLE, documentSections(markdown),
                "only the branch-visible messages may be exported");
        assertTrue(markdown.contains("- messages: 50"), markdown);
        assertTrue(markdown.contains("- messagesTruncated: false"),
                "a small branch is not a truncated export — this is the case the old 413 refused");
    }
}
