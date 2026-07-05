package com.cc01cc.p.xihe.cp.files;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.core.io.FileSystemResource;
import org.springframework.http.*;
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
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.repository.FileRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class ChatAttachmentIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private WorkspaceRepository workspaceRepository;

    @Autowired
    private SessionRepository sessionRepository;

    @Autowired
    private FileRepository fileRepository;

    @Autowired
    private WorkspaceUserRepository workspaceUserRepository;

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
                baseUrl + "/auth/register", new RegisterRequest(email, "Test1234!", "AttachInt"), AuthResponse.class);
        String baseToken = reg.getBody().getAccessToken();

        User user = userRepository.findByEmail(email).orElseThrow();
        userId = user.getId();
        Workspace ws = workspaceRepository.save(new Workspace("attach-int-workspace", userId));
        workspaceId = ws.getId();
        workspaceUserRepository.save(new WorkspaceUser(workspaceId, userId, WorkspaceRole.OWNER));
        authToken = jwtTokenProvider.createAccessToken(userId, email, "USER", workspaceId);

        sessionId = UUID.randomUUID().toString();
        Session session = new Session(workspaceId, userId, "Attachment Int Test");
        session.setId(sessionId);
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
        Map<String, Object> result = uploadResponse.getBody();
        List<?> success = (List<?>) result.get("success");
        assertEquals(1, success.size());
        Map<String, Object> file = (Map<String, Object>) success.get(0);
        String fileId = (String) file.get("id");

        ResponseEntity<byte[]> fileResponse = restTemplate.exchange(
                baseUrl + "/files/" + fileId,
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
        assertTrue(fileRepository.findById(fileId).isPresent());

        chatAttachmentService.deleteSessionAttachments(sessionId);

        assertFalse(fileRepository.findById(fileId).isPresent());
    }

    @Autowired
    private ChatAttachmentService chatAttachmentService;

    private HttpHeaders authHeaders() {
        HttpHeaders h = new HttpHeaders();
        h.setBearerAuth(authToken);
        return h;
    }
}
