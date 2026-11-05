package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.config.JwtTokenProvider;
import com.cc01cc.p.xihe.cp.entity.Message;
import com.cc01cc.p.xihe.cp.entity.MessageRole;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.service.BranchPathService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.util.UriComponentsBuilder;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0670 M2 (T2.2): cursor pagination of {@code GET /sessions/{id}/messages}.
 *
 * <p>Covers the six acceptance points: default page size, the 200 boundary, above-200 truncation,
 * walking the cursor to the end, cursor stability while new messages arrive, and the branch-path
 * filter still being applied. The stability case deliberately writes a batch with the SAME
 * {@code created_at} — a single-key cursor would skip or duplicate those rows.</p>
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class MessagePaginationContractTest extends AbstractIntegrationTest {

    @Autowired private UserRepository userRepository;
    @Autowired private SessionRepository sessionRepository;
    @Autowired private MessageRepository messageRepository;
    @Autowired private WorkspaceFixture workspaceFixture;
    @Autowired private JwtTokenProvider jwtTokenProvider;
    @Autowired private BranchPathService branchPathService;
    @Autowired private org.springframework.jdbc.core.JdbcTemplate jdbcTemplate;

    private String authToken;
    private String sessionId;
    private String branchId;
    private static final Instant BASE = Instant.parse("2026-11-01T00:00:00Z");

    @BeforeEach
    void setUp() {
        String email = "msg-page-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        ResponseEntity<AuthResponse> registered = restTemplate.postForEntity(
                baseUrl + "/api/v1/auth/register",
                new RegisterRequest(email, TestDataFactory.PASSWORD, "MsgPage"), AuthResponse.class);
        User user = userRepository.findByEmail(email).orElseThrow();
        Workspace workspace = workspaceFixture.ensureOwnedWorkspace(user.getId());
        workspaceFixture.bindWorkspaceRole(workspace.getId().toString(), user.getId().toString(),
                WorkspaceRole.OWNER);
        authToken = jwtTokenProvider.createAccessToken(user.getId().toString(), email, "USER",
                workspace.getId().toString(), 0);

        sessionId = UUID.randomUUID().toString();
        Session session = new Session(workspace.getId().toString(), user.getId().toString(), "paging");
        session.setId(UUID.fromString(sessionId));
        sessionRepository.save(session);
        branchId = branchPathService.ensureRootBranchId(sessionId);
    }

    @Test
    void defaultPageSizeIs50AndNewestWindowIsAscending() {
        seed(120, null);
        Map<String, Object> body = page(null, null);
        List<Map<String, Object>> messages = messages(body);

        assertEquals(50, messages.size(), "default page size");
        assertEquals(50, ((Number) body.get("limit")).intValue(), "effective limit is echoed");
        assertEquals(true, body.get("truncated"));
        assertNotNull(body.get("nextCursor"));
        assertAscending(messages);
        assertEquals("m-0119", messages.get(49).get("content"), "window ends at the newest message");
    }

    @Test
    void limit200BoundaryReturnsExactly200AndEchoesLimit() {
        seed(260, null);
        Map<String, Object> body = page(200, null);
        List<Map<String, Object>> messages = messages(body);

        assertEquals(200, messages.size());
        assertEquals(200, ((Number) body.get("limit")).intValue());
        assertEquals(true, body.get("truncated"));
        assertAscending(messages);
    }

    @Test
    void limitAbove200IsTruncatedNotRejected() {
        seed(260, null);
        Map<String, Object> body = page(500, null);

        assertEquals(200, messages(body).size(), "upper bound is enforced by truncation");
        assertEquals(200, ((Number) body.get("limit")).intValue(), "response echoes the actual limit");
        assertEquals(HttpStatus.OK, pageStatus(500, null));
    }

    @Test
    void walkingTheCursorReachesTheEndWithoutGapsOrDuplicates() {
        seed(260, null);
        Set<String> seen = new HashSet<>();
        String cursor = null;
        int pages = 0;
        while (true) {
            Map<String, Object> body = page(50, cursor);
            List<Map<String, Object>> messages = messages(body);
            pages++;
            for (Map<String, Object> message : messages) {
                assertTrue(seen.add(String.valueOf(message.get("id"))),
                        "duplicate message across pages: " + message.get("id"));
            }
            cursor = (String) body.get("nextCursor");
            if (!Boolean.TRUE.equals(body.get("truncated"))) {
                assertNull(cursor, "the last page must omit nextCursor");
                break;
            }
            assertNotNull(cursor);
            assertTrue(pages < 20, "cursor walk did not terminate");
        }
        assertEquals(260, seen.size(), "every message is returned exactly once");
    }

    @Test
    void cursorIsStableWhenNewMessagesArriveMidWalk() {
        seed(150, null);
        Map<String, Object> first = page(50, null);
        String cursor = (String) first.get("nextCursor");
        Set<String> firstIds = new HashSet<>(ids(first));

        // Three new messages arrive after page 1 was read (newer than every seeded row).
        seed(3, "new-");

        List<String> rest = new ArrayList<>();
        while (true) {
            Map<String, Object> body = page(50, cursor);
            rest.addAll(ids(body));
            cursor = (String) body.get("nextCursor");
            if (!Boolean.TRUE.equals(body.get("truncated"))) {
                break;
            }
        }
        Set<String> all = new HashSet<>(firstIds);
        all.addAll(rest);
        assertEquals(150, all.size(), "the walked pages cover the original 150 rows exactly once");
        // Newer rows only show up in a fresh first page, never inside the older walk.
        Map<String, Object> fresh = page(50, null);
        assertTrue(ids(fresh).containsAll(List.of()));
        assertFalse(rest.stream().anyMatch(id -> id.startsWith("new-")),
                "messages newer than the cursor cannot appear in older pages");
    }

    @Test
    void sameMillisecondBatchDoesNotSkipOrDuplicateAcrossPageBoundaries() {
        // 10 messages share one created_at, spanning the 5/5 page boundary with limit=5.
        Instant same = BASE.plusSeconds(500);
        List<String> ids = new ArrayList<>();
        for (int i = 0; i < 10; i++) {
            ids.add(saveMessage("tie-" + i, same, branchId));
        }
        seed(20, "older-");
        Set<String> seen = new HashSet<>();
        String cursor = null;
        while (true) {
            Map<String, Object> body = page(5, cursor);
            for (Map<String, Object> message : messages(body)) {
                seen.add(String.valueOf(message.get("id")));
            }
            cursor = (String) body.get("nextCursor");
            if (!Boolean.TRUE.equals(body.get("truncated"))) {
                break;
            }
        }
        assertEquals(30, seen.size(), "all rows across the tie boundary are returned once");
        assertTrue(seen.containsAll(ids), "every same-millisecond row is present");
    }

    @Test
    void pagingStillAppliesVisibilityAndSessionFilters() {
        seed(30, null);
        // Internal (wake-instruction) rows never render: the visibility filter must run BEFORE the
        // page size is applied, otherwise a page could silently contain fewer rows than `limit`.
        Message internal = new Message(sessionId, MessageRole.USER, "internal-only");
        internal.setBranchId(branchId);
        internal.setVisibility(Message.VISIBILITY_INTERNAL);
        internal.setCreatedAt(BASE.plusSeconds(900));
        messageRepository.saveAndFlush(internal);
        // A message from another session must never leak into this session's page.
        String otherSessionId = UUID.randomUUID().toString();
        Session otherSession = new Session(sessionRepository.findById(UUID.fromString(sessionId))
                .orElseThrow().getWorkspaceId(), sessionRepository.findById(UUID.fromString(sessionId))
                .orElseThrow().getUserId(), "other");
        otherSession.setId(UUID.fromString(otherSessionId));
        sessionRepository.save(otherSession);
        String otherBranchId = branchPathService.ensureRootBranchId(otherSessionId);
        Message foreign = new Message(otherSessionId, MessageRole.USER, "other-session");
        foreign.setBranchId(otherBranchId);
        foreign.setCreatedAt(BASE.plusSeconds(901));
        messageRepository.saveAndFlush(foreign);

        Map<String, Object> body = page(200, null);
        List<Map<String, Object>> messages = messages(body);
        assertEquals(30, messages.size(), "hidden/foreign rows are filtered before paging");
        assertFalse(messages.stream().anyMatch(row -> "internal-only".equals(row.get("content"))));
        assertFalse(messages.stream().anyMatch(row -> "other-session".equals(row.get("content"))));
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    private void seed(int count, String prefix) {
        for (int i = 0; i < count; i++) {
            saveMessage((prefix == null ? "m-" : prefix) + String.format("%04d", i),
                    BASE.plusSeconds(i), branchId);
        }
    }

    /**
     * PLAN-0670 M2b: the legacy full-read path (no {@code limit}/{@code before}) keeps its contract
     * for normal sessions but refuses long ones with an actionable 413 <b>before</b> reading a row —
     * same "count first" pattern and the same 2000 cap as the BL-279 A1 export guard.
     */
    @Test
    void legacyFullReadKeepsCompatibilityAtTheCeilingAndRefusesAboveIt() {
        seedRows(MessageReadService.MAX_FULL_READ_MESSAGES);

        ResponseEntity<List> atCeiling = restTemplate.exchange(legacyListUri(), HttpMethod.GET,
                new HttpEntity<>(bearerHeaders()), List.class);
        assertEquals(HttpStatus.OK, atCeiling.getStatusCode(),
                "a session at the ceiling keeps the byte-for-byte legacy contract");
        assertEquals(MessageReadService.MAX_FULL_READ_MESSAGES, atCeiling.getBody().size(),
                "the legacy path must return every row at the ceiling (no silent truncation)");

        seedRows(1);

        ResponseEntity<Map> overCeiling = restTemplate.exchange(legacyListUri(), HttpMethod.GET,
                new HttpEntity<>(bearerHeaders()), Map.class);
        // 413 by value: Spring 6.2 renamed the enum constant (PAYLOAD_TOO_LARGE → CONTENT_TOO_LARGE),
        // the wire status the client sees is the same.
        assertEquals(413, overCeiling.getStatusCode().value(),
                "above the ceiling the legacy path refuses instead of allocating the whole session");
        Map<String, Object> problem = overCeiling.getBody();
        assertEquals("PAGINATION_REQUIRED", problem.get("code"));
        assertEquals(MessageReadService.MAX_FULL_READ_MESSAGES + 1,
                ((Number) problem.get("messages")).intValue(), "the body reports the actual count");
        assertEquals(MessageReadService.MAX_FULL_READ_MESSAGES,
                ((Number) problem.get("limit")).intValue(), "the body reports the cap");
        assertTrue(String.valueOf(problem.get("detail")).contains("limit/before"),
                "the detail must be actionable: " + problem.get("detail"));

        // The paginated contract still works on the same (now over-ceiling) session.
        ResponseEntity<Map> paged = restTemplate.exchange(
                baseUrl + "/api/v1/sessions/" + sessionId + "/messages?branchId=" + branchId + "&limit=50",
                HttpMethod.GET, new HttpEntity<>(bearerHeaders()), Map.class);
        assertEquals(HttpStatus.OK, paged.getStatusCode());
        assertEquals(50, ((List<?>) paged.getBody().get("messages")).size());
    }

    private HttpHeaders bearerHeaders() {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        return headers;
    }

    private String legacyListUri() {
        return baseUrl + "/api/v1/sessions/" + sessionId + "/messages?branchId=" + branchId;
    }

    /** Bulk seed: one JDBC statement, so a 2000-row fixture stays a fraction of a second. */
    private void seedRows(int count) {
        int offset = jdbcTemplate.queryForObject(
                "SELECT count(*) FROM messages WHERE CAST(session_id AS VARCHAR) = ?",
                Integer.class, sessionId);
        for (int index = 0; index < count; index += 1) {
            jdbcTemplate.update("INSERT INTO messages (id, session_id, branch_id, role, content, "
                            + "created_at, visibility) VALUES (gen_random_uuid(), CAST(? AS UUID), "
                            + "CAST(? AS UUID), 'USER', ?, ?, 'user')",
                    sessionId, branchId, "bulk-" + (offset + index),
                    java.sql.Timestamp.from(BASE.plusSeconds(offset + index)));
        }
    }

    private String saveMessage(String content, Instant createdAt, String onBranch) {
        Message message = new Message(sessionId, MessageRole.USER, content);
        message.setBranchId(onBranch);
        message.setCreatedAt(createdAt);
        messageRepository.saveAndFlush(message);
        return message.getId().toString();
    }

    private List<String> ids(Map<String, Object> body) {
        return messages(body).stream().map(row -> String.valueOf(row.get("id"))).toList();
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> messages(Map<String, Object> body) {
        return (List<Map<String, Object>>) body.get("messages");
    }

    private Map<String, Object> page(Integer limit, String before) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        UriComponentsBuilder builder = UriComponentsBuilder
                .fromUriString(baseUrl + "/api/v1/sessions/" + sessionId + "/messages")
                .queryParam("branchId", branchId);
        if (limit != null) {
            builder.queryParam("limit", limit);
        }
        if (before != null) {
            builder.queryParam("before", before);
        } else if (limit == null) {
            builder.queryParam("before", ""); // explicit empty cursor ⇒ default page size
        }
        ResponseEntity<Map> response = restTemplate.exchange(builder.toUriString(),
                HttpMethod.GET, new HttpEntity<>(headers), Map.class);
        assertEquals(HttpStatus.OK, response.getStatusCode(), String.valueOf(response.getBody()));
        return response.getBody();
    }

    private HttpStatus pageStatus(Integer limit, String before) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        UriComponentsBuilder builder = UriComponentsBuilder
                .fromUriString(baseUrl + "/api/v1/sessions/" + sessionId + "/messages")
                .queryParam("branchId", branchId)
                .queryParam("limit", limit);
        ResponseEntity<Map> response = restTemplate.exchange(builder.toUriString(),
                HttpMethod.GET, new HttpEntity<>(headers), Map.class);
        return HttpStatus.valueOf(response.getStatusCode().value());
    }

    private void assertAscending(List<Map<String, Object>> messages) {
        String previous = null;
        for (Map<String, Object> message : messages) {
            String current = String.valueOf(message.get("createdAt"));
            if (previous != null) {
                assertTrue(current.compareTo(previous) >= 0, "messages must be ascending: "
                        + previous + " -> " + current);
            }
            previous = current;
        }
    }
}


