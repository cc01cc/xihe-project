package com.cc01cc.p.xihe.cp.files;

import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.core.io.FileSystemResource;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.config.JwtTokenProvider;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.repository.FileRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.SessionParticipantRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class ChatAttachmentIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private WorkspaceRepository workspaceRepository;

    @Autowired
    private SessionRepository sessionRepository;

    @Autowired
    private SessionParticipantRepository sessionParticipantRepository;

    @Autowired
    private FileRepository fileRepository;

    @Autowired
    private AuthorizationGrantRepository authorizationGrantRepository;

    @Autowired
    private WorkspaceFixture workspaceFixture;

    @Autowired
    private JwtTokenProvider jwtTokenProvider;

    private static Path attachmentsRoot;

    private String authToken;
    private String userId;
    private String workspaceId;
    private String sessionId;

    @BeforeEach
    void setUp() {
        String email = "attach-int-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        ResponseEntity<AuthResponse> reg = restTemplate.postForEntity(
                baseUrl + "/api/v1/auth/register", new RegisterRequest(email, TestDataFactory.PASSWORD, "AttachInt"), AuthResponse.class);
        String baseToken = reg.getBody().getAccessToken();

        User user = userRepository.findByEmail(email).orElseThrow();
        userId = user.getId().toString();
        Workspace ws = workspaceFixture.ensureOwnedWorkspace(UUID.fromString(userId));
        workspaceId = ws.getId().toString();
        workspaceFixture.bindWorkspaceRole(workspaceId, userId, WorkspaceRole.OWNER);
        authToken = jwtTokenProvider.createAccessToken(userId, email, "USER", workspaceId, 0);

        sessionId = UUID.randomUUID().toString();
        Session session = new Session(workspaceId, userId, "Attachment Int Test");
        session.setId(UUID.fromString(sessionId));
        sessionRepository.save(session);
    }

    @DynamicPropertySource
    static void configureAttachments(DynamicPropertyRegistry registry) {
        try {
            attachmentsRoot = Files.createTempDirectory("xihe-attachments-int");
        } catch (IOException e) {
            throw new RuntimeException(e);
        }
        registry.add("cp.attachments-base-path", attachmentsRoot::toString);
    }

    @AfterEach
    void tearDown() throws IOException {
        if (attachmentsRoot != null && Files.exists(attachmentsRoot)) {
            Files.walk(attachmentsRoot).sorted((a, b) -> -a.compareTo(b)).forEach(p -> {
                try {
                    Files.deleteIfExists(p);
                } catch (IOException e) {
                    // ignore
                }
            });
        }
    }

    @Test
    void uploadAndServeAttachment_fullFlow() throws IOException {
        sessionRepository.deleteById(UUID.fromString(sessionId));
        sessionId = UUID.randomUUID().toString();
        java.io.File tempFile = java.io.File.createTempFile("int", ".txt");
        Files.write(tempFile.toPath(), "integration test content".getBytes());

        MultiValueMap<String, Object> body = new LinkedMultiValueMap<>();
        body.add("files", new FileSystemResource(tempFile));

        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        headers.setContentType(MediaType.MULTIPART_FORM_DATA);
        HttpEntity<MultiValueMap<String, Object>> request = new HttpEntity<>(body, headers);

        ResponseEntity<Map> uploadResponse = restTemplate.exchange(
                baseUrl + "/api/v1/sessions/" + sessionId + "/attachments",
                HttpMethod.POST, request, Map.class);

        assertEquals(HttpStatus.OK, uploadResponse.getStatusCode());
        Session placeholder = sessionRepository.findById(UUID.fromString(sessionId)).orElseThrow();
        assertTrue(sessionParticipantRepository.primaryPrincipalId(placeholder.getId()).isEmpty(),
                "PLAN-0689 A7: an upload-only placeholder carries no PRIMARY participant");
        assertNull(placeholder.getAgentPermissionsSnapshot());
        assertEquals(0L, authorizationGrantRepository.countBySubjectTypeAndSubjectIdAndSource(
                "agent", UUID.fromString(sessionId), "default"));
        Map<String, Object> result = uploadResponse.getBody();
        List<?> success = (List<?>) result.get("success");
        assertEquals(1, success.size());
        Map<String, Object> file = (Map<String, Object>) success.get(0);
        String fileId = (String) file.get("id");

        ResponseEntity<byte[]> fileResponse = restTemplate.exchange(
                baseUrl + "/api/v1/files/" + fileId,
                HttpMethod.GET, new HttpEntity<>(authHeaders()), byte[].class);
        assertEquals(HttpStatus.OK, fileResponse.getStatusCode());
        assertEquals("integration test content", new String(fileResponse.getBody()));
    }

    @Test
    void deleteSession_cascadeDeletesAttachments() throws IOException {
        java.io.File tempFile = java.io.File.createTempFile("cascade", ".pdf");
        Files.write(tempFile.toPath(), "pdf content".getBytes());

        MultiValueMap<String, Object> body = new LinkedMultiValueMap<>();
        body.add("files", new FileSystemResource(tempFile));

        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        headers.setContentType(MediaType.MULTIPART_FORM_DATA);
        HttpEntity<MultiValueMap<String, Object>> request = new HttpEntity<>(body, headers);

        ResponseEntity<Map> uploadResponse = restTemplate.exchange(
                baseUrl + "/api/v1/sessions/" + sessionId + "/attachments",
                HttpMethod.POST, request, Map.class);
        Map<String, Object> file = (Map<String, Object>) ((List<?>) uploadResponse.getBody().get("success")).get(0);
        String fileId = (String) file.get("id");
        assertTrue(fileRepository.findById(UUID.fromString(fileId)).isPresent());

        // deleteSessionAttachments takes the per-File pessimistic lock (same lock/order as an in-flight
        // fork copy). Since BL-180 the service owns that transaction boundary itself; this wrapper is
        // kept on purpose as a second layer of defence (and as a guard against the boundary silently
        // regressing) — see deleteSessionAttachments_ownsItsTransactionBoundary for the no-wrapper case.
        new org.springframework.transaction.support.TransactionTemplate(transactionManager)
                .executeWithoutResult(status -> chatAttachmentService.deleteSessionAttachments(sessionId));

        assertFalse(fileRepository.findById(UUID.fromString(fileId)).isPresent());
    }

    /**
     * BL-180 regression: {@code deleteSessionAttachments} takes a per-File pessimistic lock
     * ({@code SELECT … FOR UPDATE}), which is only legal inside a transaction. The method used to have
     * no transaction boundary of its own, so this call — **no outer transaction**, exactly what a new
     * caller or a script would do — failed with "no transaction is in progress" (PLAN-0615 had to wrap
     * the test in a TransactionTemplate to hide it). The service now owns the boundary (default
     * {@code REQUIRED}: it joins the session-delete transaction when there is one).
     */
    @Test
    void deleteSessionAttachments_ownsItsTransactionBoundary() throws IOException {
        java.io.File tempFile = java.io.File.createTempFile("own-tx", ".txt");
        Files.write(tempFile.toPath(), "own transaction boundary".getBytes());

        MultiValueMap<String, Object> body = new LinkedMultiValueMap<>();
        body.add("files", new FileSystemResource(tempFile));

        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        headers.setContentType(MediaType.MULTIPART_FORM_DATA);
        HttpEntity<MultiValueMap<String, Object>> request = new HttpEntity<>(body, headers);

        ResponseEntity<Map> uploadResponse = restTemplate.exchange(
                baseUrl + "/api/v1/sessions/" + sessionId + "/attachments",
                HttpMethod.POST, request, Map.class);
        Map<String, Object> file = (Map<String, Object>) ((List<?>) uploadResponse.getBody().get("success")).get(0);
        String fileId = (String) file.get("id");
        assertTrue(fileRepository.findById(UUID.fromString(fileId)).isPresent());

        // Deliberately no TransactionTemplate here: the service must supply the boundary.
        chatAttachmentService.deleteSessionAttachments(sessionId);

        assertFalse(fileRepository.findById(UUID.fromString(fileId)).isPresent(),
                "the attachment row must be gone when the service owns the transaction");
    }

    @Autowired
    private ChatAttachmentService chatAttachmentService;

    @Autowired
    private org.springframework.transaction.PlatformTransactionManager transactionManager;

    private HttpHeaders authHeaders() {
        HttpHeaders h = new HttpHeaders();
        h.setBearerAuth(authToken);
        return h;
    }
}
