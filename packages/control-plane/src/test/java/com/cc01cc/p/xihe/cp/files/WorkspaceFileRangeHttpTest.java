package com.cc01cc.p.xihe.cp.files;

import com.cc01cc.p.xihe.cp.AbstractH2Test;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.config.JwtTokenProvider;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.TestPropertySource;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0683 T1.2 (BL-381): real-HTTP coverage for the attachment Range contract
 * (E1/E2/E3/E4) plus explicit rejection of multi-range and malformed headers.
 */
@TestPropertySource(properties = {
        "spring.servlet.multipart.max-file-size=16MB",
        "spring.servlet.multipart.max-request-size=32MB"})
class WorkspaceFileRangeHttpTest extends AbstractH2Test {

    private static final long PREVIEW_BUDGET_BYTES = 8L * 1024 * 1024;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private WorkspaceFixture workspaceFixture;

    @Autowired
    private SessionRepository sessionRepository;

    @Autowired
    private JwtTokenProvider jwtTokenProvider;

    private String authToken;
    private String sessionId;

    @BeforeEach
    void createFixture() {
        String email = "range-http-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        ResponseEntity<AuthResponse> registration = restTemplate.postForEntity(
                url("/api/v1/auth/register"),
                new RegisterRequest(email, TestDataFactory.PASSWORD, "RangeHttp"),
                AuthResponse.class);
        assertNotNull(registration.getBody());

        User user = userRepository.findByEmail(email).orElseThrow();
        String userId = user.getId().toString();
        Workspace workspace = workspaceFixture.createOwnedWorkspace("range-http-workspace", userId);
        workspaceFixture.bindWorkspaceRole(workspace.getId().toString(), userId, WorkspaceRole.OWNER);
        authToken = jwtTokenProvider.createAccessToken(
                userId, email, "USER", workspace.getId().toString(), 0);

        sessionId = UUID.randomUUID().toString();
        Session session = new Session(workspace.getId().toString(), userId, "Range HTTP Test");
        session.setId(UUID.fromString(sessionId));
        sessionRepository.save(session);
    }

    @AfterEach
    void tearDown() throws IOException {
        // Keep the same expression as `application-test.properties`
        // (`cp.attachments-base-path=...attachments-${surefire.forkNumber:0}`); a hardcoded
        // `/xihe-test/attachments` would leave this fork's files behind and target a
        // directory another shard may own.
        Path root = Path.of(System.getProperty("java.io.tmpdir") + "/xihe-test/attachments-"
                + System.getProperty("surefire.forkNumber", "0"));
        if (Files.exists(root)) {
            try (var walk = Files.walk(root)) {
                walk.sorted((a, b) -> -a.compareTo(b)).forEach(path -> {
                    try {
                        Files.deleteIfExists(path);
                    } catch (IOException e) {
                        // best-effort cleanup only
                    }
                });
            }
        }
    }

    @Test
    void range_returnsExactByteSliceWithTruthfulContentRange() throws IOException {
        byte[] fixture = fixture(1000);
        String fileId = upload("range.txt", fixture);

        ResponseEntity<byte[]> response = getFile(fileId, "bytes=100-199");

        assertEquals(HttpStatus.PARTIAL_CONTENT, response.getStatusCode());
        assertEquals("bytes 100-199/1000", response.getHeaders().getFirst(HttpHeaders.CONTENT_RANGE));
        assertEquals("bytes", response.getHeaders().getFirst(HttpHeaders.ACCEPT_RANGES));
        assertEquals(100L, response.getHeaders().getContentLength());
        assertArrayEquals(slice(fixture, 100, 100), body(response));
    }

    @Test
    void range_openEndedAndSuffixFollowRfcSemantics() throws IOException {
        byte[] fixture = fixture(1000);
        String fileId = upload("open-ended.txt", fixture);

        ResponseEntity<byte[]> openEnded = getFile(fileId, "bytes=500-");
        assertEquals(HttpStatus.PARTIAL_CONTENT, openEnded.getStatusCode());
        assertEquals("bytes 500-999/1000", openEnded.getHeaders().getFirst(HttpHeaders.CONTENT_RANGE));
        assertArrayEquals(slice(fixture, 500, 500), body(openEnded));

        ResponseEntity<byte[]> suffix = getFile(fileId, "bytes=-100");
        assertEquals(HttpStatus.PARTIAL_CONTENT, suffix.getStatusCode());
        assertEquals("bytes 900-999/1000", suffix.getHeaders().getFirst(HttpHeaders.CONTENT_RANGE));
        assertArrayEquals(slice(fixture, 900, 100), body(suffix));

        ResponseEntity<byte[]> beyondEnd = getFile(fileId, "bytes=900-2000");
        assertEquals(HttpStatus.PARTIAL_CONTENT, beyondEnd.getStatusCode());
        assertEquals("bytes 900-999/1000", beyondEnd.getHeaders().getFirst(HttpHeaders.CONTENT_RANGE));
        assertArrayEquals(slice(fixture, 900, 100), body(beyondEnd));
    }

    @Test
    void range_keepsNoRangeFullBodyResponseByteIdentical() throws IOException {
        byte[] fixture = fixture(1000);
        String fileId = upload("full.txt", fixture);

        ResponseEntity<byte[]> response = getFile(fileId, null);

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertEquals("bytes", response.getHeaders().getFirst(HttpHeaders.ACCEPT_RANGES));
        assertEquals("text/plain", response.getHeaders().getContentType().toString());
        assertArrayEquals(fixture, body(response));
    }

    @Test
    void range_clampsResponseToPreviewBudgetAndKeepsRealFileTotal() throws IOException {
        byte[] fixture = fixture((int) PREVIEW_BUDGET_BYTES + 4096);
        String fileId = upload("over-budget.txt", fixture);

        ResponseEntity<byte[]> response = getFile(fileId, "bytes=0-");

        assertEquals(HttpStatus.PARTIAL_CONTENT, response.getStatusCode());
        assertEquals("bytes 0-" + (PREVIEW_BUDGET_BYTES - 1) + "/" + fixture.length,
                response.getHeaders().getFirst(HttpHeaders.CONTENT_RANGE));
        assertEquals(PREVIEW_BUDGET_BYTES, body(response).length);
        assertArrayEquals(slice(fixture, 0, (int) PREVIEW_BUDGET_BYTES), body(response));
    }

    @Test
    void range_atNonZeroOffsetAlsoClampsLength() throws IOException {
        byte[] fixture = fixture((int) PREVIEW_BUDGET_BYTES + 4096);
        String fileId = upload("offset-budget.txt", fixture);

        ResponseEntity<byte[]> response = getFile(fileId, "bytes=1000-");

        long expectedEnd = 1000 + PREVIEW_BUDGET_BYTES - 1;
        assertEquals(HttpStatus.PARTIAL_CONTENT, response.getStatusCode());
        assertEquals("bytes 1000-" + expectedEnd + "/" + fixture.length,
                response.getHeaders().getFirst(HttpHeaders.CONTENT_RANGE));
        assertEquals(PREVIEW_BUDGET_BYTES, body(response).length);
        assertArrayEquals(slice(fixture, 1000, (int) PREVIEW_BUDGET_BYTES), body(response));
    }

    @Test
    void range_beyondFileReturns416WithUnsatisfiedContentRange() throws IOException {
        byte[] fixture = fixture(1000);
        String fileId = upload("beyond.txt", fixture);

        ResponseEntity<byte[]> response = getFile(fileId, "bytes=1000-");

        assertEquals(HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE, response.getStatusCode());
        assertEquals("bytes */1000", response.getHeaders().getFirst(HttpHeaders.CONTENT_RANGE));
        assertEquals("bytes", response.getHeaders().getFirst(HttpHeaders.ACCEPT_RANGES));
        Map<String, Object> problem = problemBody(response);
        assertEquals("RANGE_NOT_SATISFIABLE", problem.get("code"));
        assertEquals(416, problem.get("status"));
    }

    @Test
    void range_multiRangeAndMalformedAreRejectedExplicitly() throws IOException {
        byte[] fixture = fixture(1000);
        String fileId = upload("invalid.txt", fixture);

        ResponseEntity<byte[]> multi = getFile(fileId, "bytes=0-9,20-29");
        assertEquals(HttpStatus.BAD_REQUEST, multi.getStatusCode());
        assertEquals("bytes */1000", multi.getHeaders().getFirst(HttpHeaders.CONTENT_RANGE));
        assertEquals("INVALID_RANGE", problemBody(multi).get("code"));

        ResponseEntity<byte[]> malformed = getFile(fileId, "bytes=abc");
        assertEquals(HttpStatus.BAD_REQUEST, malformed.getStatusCode());
        assertEquals("INVALID_RANGE", problemBody(malformed).get("code"));

        ResponseEntity<byte[]> nonBytesUnit = getFile(fileId, "items=0-9");
        assertEquals(HttpStatus.BAD_REQUEST, nonBytesUnit.getStatusCode());
        assertEquals("INVALID_RANGE", problemBody(nonBytesUnit).get("code"));
    }

    /**
     * Audit B1 regression: `HttpRange.parseRanges` normalizes these headers into a valid
     * single range (sign dropped, trailing empty list element dropped), which used to answer
     * 206 with a body the client never asked for.
     */
    @Test
    void range_silentlyNormalizedHeadersAreRejectedExplicitly() throws IOException {
        byte[] fixture = fixture(1000);
        String fileId = upload("normalized.txt", fixture);

        for (String header : List.of(
                "bytes=+0-9", "bytes=0-9,", "bytes=,0-9", "bytes=,", "bytes=", "bytes=-")) {
            ResponseEntity<byte[]> response = getFile(fileId, header);
            assertEquals(HttpStatus.BAD_REQUEST, response.getStatusCode(), "header: " + header);
            assertEquals("bytes */1000",
                    response.getHeaders().getFirst(HttpHeaders.CONTENT_RANGE), "header: " + header);
            assertEquals("bytes", response.getHeaders().getFirst(HttpHeaders.ACCEPT_RANGES));
            assertEquals("INVALID_RANGE", problemBody(response).get("code"), "header: " + header);
        }
    }

    private String upload(String name, byte[] data) {
        MultiValueMap<String, Object> body = new LinkedMultiValueMap<>();
        body.add("files", new ByteArrayResource(data) {
            @Override
            public String getFilename() {
                return name;
            }
        });
        HttpHeaders headers = authHeaders();
        headers.setContentType(MediaType.MULTIPART_FORM_DATA);
        ResponseEntity<Map> response = restTemplate.exchange(
                url("/api/v1/sessions/" + sessionId + "/attachments"),
                HttpMethod.POST, new HttpEntity<>(body, headers), Map.class);
        assertNotNull(response.getBody());
        List<?> success = (List<?>) response.getBody().get("success");
        assertNotNull(success);
        assertEquals(1, success.size());
        return String.valueOf(((Map<?, ?>) success.get(0)).get("id"));
    }

    private ResponseEntity<byte[]> getFile(String fileId, String range) {
        HttpHeaders headers = authHeaders();
        if (range != null) {
            headers.set(HttpHeaders.RANGE, range);
        }
        return restTemplate.exchange(
                url("/api/v1/files/" + fileId), HttpMethod.GET,
                new HttpEntity<>(headers), byte[].class);
    }

    private HttpHeaders authHeaders() {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        return headers;
    }

    private static byte[] body(ResponseEntity<byte[]> response) {
        byte[] body = response.getBody();
        assertNotNull(body);
        return body;
    }

    private static Map<String, Object> problemBody(ResponseEntity<byte[]> response) throws IOException {
        String json = new String(body(response), StandardCharsets.UTF_8);
        assertTrue(json.contains("\"code\""), "expected RFC 9457 problem body, got: " + json);
        return new ObjectMapper().readValue(json, new TypeReference<>() { });
    }

    private static byte[] fixture(int size) {
        byte[] data = new byte[size];
        for (int i = 0; i < size; i++) {
            data[i] = (byte) ((i * 31 + 7) & 0xff);
        }
        return data;
    }

    private static byte[] slice(byte[] source, int offset, int length) {
        byte[] result = new byte[length];
        System.arraycopy(source, offset, result, 0, length);
        return result;
    }
}
