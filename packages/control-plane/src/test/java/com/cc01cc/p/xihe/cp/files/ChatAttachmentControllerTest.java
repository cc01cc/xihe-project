package com.cc01cc.p.xihe.cp.files;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.core.io.FileSystemResource;
import org.springframework.http.*;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import org.springframework.web.client.RestTemplate;
import com.cc01cc.p.xihe.cp.AbstractH2Test;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.config.JwtTokenProvider;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
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
@ActiveProfiles("h2")
class ChatAttachmentControllerTest extends AbstractH2Test {

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private WorkspaceRepository workspaceRepository;

    @Autowired
    private WorkspaceUserRepository workspaceUserRepository;

    @Autowired
    private SessionRepository sessionRepository;

    @Autowired
    private FileRepository fileRepository;

    @Autowired
    private JwtTokenProvider jwtTokenProvider;

    @LocalServerPort
    private int serverPort;

    private String authToken;
    private String userId;
    private String workspaceId;
    private String sessionId;

    @BeforeEach
    void setUp() {
        this.baseUrl = "http://localhost:" + serverPort;
        this.restTemplate = new RestTemplate();
        restTemplate.setErrorHandler(new org.springframework.web.client.DefaultResponseErrorHandler() {
            @Override
            public boolean hasError(org.springframework.http.client.ClientHttpResponse response) throws IOException {
                HttpStatus status = HttpStatus.resolve(response.getStatusCode().value());
                return status != null && status.is5xxServerError();
            }
        });

        String email = "attach-ctrl-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        ResponseEntity<AuthResponse> reg = restTemplate.postForEntity(
                baseUrl + "/api/v1/auth/register", new RegisterRequest(email, TestDataFactory.PASSWORD, "AttachCtrl"), AuthResponse.class);
        reg.getBody().getAccessToken();

        User user = userRepository.findByEmail(email).orElseThrow();
        userId = user.getId().toString();
        Workspace ws = workspaceRepository.save(new Workspace("attach-test-workspace", userId));
        workspaceId = ws.getId().toString();
        workspaceUserRepository.save(new WorkspaceUser(workspaceId, userId, WorkspaceRole.OWNER));

        authToken = jwtTokenProvider.createAccessToken(userId, email, "USER", workspaceId);

        sessionId = UUID.randomUUID().toString();
        Session session = new Session(workspaceId, userId, "Attachment Test");
        session.setId(UUID.fromString(sessionId));
        sessionRepository.save(session);
    }

    @AfterEach
    void tearDown() throws IOException {
        String basePath = System.getProperty("java.io.tmpdir") + "/xihe-test/attachments";
        Path root = Path.of(basePath);
        if (Files.exists(root)) {
            Files.walk(root).sorted((a, b) -> -a.compareTo(b)).forEach(p -> {
                try {
                    Files.deleteIfExists(p);
                } catch (IOException e) {
                    // ignore cleanup errors
                }
            });
        }
    }

    @Test
    void uploadAttachments_withValidFiles_returnsSuccess() throws IOException {
        Path tempDir = Files.createTempDirectory("attach");
        Path tempFile = tempDir.resolve("test.png");
        Files.write(tempFile, "image-data".getBytes());

        MultiValueMap<String, Object> body = new LinkedMultiValueMap<>();
        body.add("files", new FileSystemResource(tempFile));

        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        headers.setContentType(MediaType.MULTIPART_FORM_DATA);
        HttpEntity<MultiValueMap<String, Object>> request = new HttpEntity<>(body, headers);

        ResponseEntity<Map> response = restTemplate.exchange(
                baseUrl + "/api/v1/sessions/" + sessionId + "/attachments",
                HttpMethod.POST, request, Map.class);

        assertEquals(HttpStatus.OK, response.getStatusCode());
        Map<String, Object> result = response.getBody();
        assertNotNull(result);
        List<?> success = (List<?>) result.get("success");
        assertEquals(1, success.size());
        Map<String, Object> file = (Map<String, Object>) success.get(0);
        assertNotNull(file.get("id"));
        assertEquals("test.png", file.get("name"));
        assertEquals("/api/v1/files/" + file.get("id"), file.get("url"));
        assertEquals(0, ((List<?>) result.get("failed")).size());

        assertFalse(fileRepository.findBySessionId(sessionId).isEmpty());
    }

    @Test
    void uploadAttachments_withDisallowedExtension_returnsPartialFailure() throws IOException {
        Path tempDir = Files.createTempDirectory("attach");
        Path goodFile = tempDir.resolve("good.txt");
        Files.write(goodFile, "text".getBytes());
        Path badFile = tempDir.resolve("bad.exe");
        Files.write(badFile, "binary".getBytes());

        MultiValueMap<String, Object> body = new LinkedMultiValueMap<>();
        body.add("files", new FileSystemResource(goodFile));
        body.add("files", new FileSystemResource(badFile));

        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        headers.setContentType(MediaType.MULTIPART_FORM_DATA);
        HttpEntity<MultiValueMap<String, Object>> request = new HttpEntity<>(body, headers);

        ResponseEntity<Map> response = restTemplate.exchange(
                baseUrl + "/api/v1/sessions/" + sessionId + "/attachments",
                HttpMethod.POST, request, Map.class);

        assertEquals(HttpStatus.OK, response.getStatusCode());
        Map<String, Object> result = response.getBody();
        assertNotNull(result);
        assertEquals(1, ((List<?>) result.get("success")).size());
        assertEquals(1, ((List<?>) result.get("failed")).size());
        Map<String, Object> failed = (Map<String, Object>) ((List<?>) result.get("failed")).get(0);
        assertEquals("bad.exe", failed.get("fileName"));
    }

    @Test
    void getAttachmentMetadata_returnsFileInfo() throws IOException {
        Path tempDir = Files.createTempDirectory("attach");
        Path tempFile = tempDir.resolve("meta.pdf");
        Files.write(tempFile, "pdf-data".getBytes());

        MultiValueMap<String, Object> body = new LinkedMultiValueMap<>();
        body.add("files", new FileSystemResource(tempFile));

        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        headers.setContentType(MediaType.MULTIPART_FORM_DATA);
        HttpEntity<MultiValueMap<String, Object>> uploadRequest = new HttpEntity<>(body, headers);

        ResponseEntity<Map> uploadResponse = restTemplate.exchange(
                baseUrl + "/api/v1/sessions/" + sessionId + "/attachments",
                HttpMethod.POST, uploadRequest, Map.class);
        Map<String, Object> file = (Map<String, Object>) ((List<?>) uploadResponse.getBody().get("success")).get(0);
        String fileId = (String) file.get("id");

        ResponseEntity<Map> response = restTemplate.exchange(
                baseUrl + "/api/v1/sessions/" + sessionId + "/attachments/" + fileId,
                HttpMethod.GET, new HttpEntity<>(authHeaders()), Map.class);

        assertEquals(HttpStatus.OK, response.getStatusCode());
        Map<String, Object> meta = response.getBody();
        assertNotNull(meta);
        assertEquals(fileId, meta.get("id"));
        assertEquals("meta.pdf", meta.get("name"));
    }

    @Test
    void deleteAttachment_removesFileAndMetadata() throws IOException {
        Path tempDir = Files.createTempDirectory("attach");
        Path tempFile = tempDir.resolve("del.jpg");
        Files.write(tempFile, "image".getBytes());

        MultiValueMap<String, Object> body = new LinkedMultiValueMap<>();
        body.add("files", new FileSystemResource(tempFile));

        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        headers.setContentType(MediaType.MULTIPART_FORM_DATA);
        HttpEntity<MultiValueMap<String, Object>> uploadRequest = new HttpEntity<>(body, headers);

        ResponseEntity<Map> uploadResponse = restTemplate.exchange(
                baseUrl + "/api/v1/sessions/" + sessionId + "/attachments",
                HttpMethod.POST, uploadRequest, Map.class);
        Map<String, Object> file = (Map<String, Object>) ((List<?>) uploadResponse.getBody().get("success")).get(0);
        String fileId = (String) file.get("id");
        assertTrue(fileRepository.findById(UUID.fromString(fileId)).isPresent());

        ResponseEntity<Map> response = restTemplate.exchange(
                baseUrl + "/api/v1/sessions/" + sessionId + "/attachments/" + fileId,
                HttpMethod.DELETE, new HttpEntity<>(authHeaders()), Map.class);

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertEquals(fileId, response.getBody().get("deleted"));
        assertFalse(fileRepository.findById(UUID.fromString(fileId)).isPresent());
    }

    @Test
    void attachmentMetadata_rejectsDifferentSessionOwner() {
        com.cc01cc.p.xihe.cp.entity.File owned = new com.cc01cc.p.xihe.cp.entity.File(
                userId, "owned.txt", "/tmp/owned-attachment.txt");
        owned.setWorkspaceId(workspaceId);
        owned.setSessionId(sessionId);
        owned.setMimeType("text/plain");
        fileRepository.save(owned);

        String otherEmail = "attach-other-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        restTemplate.postForEntity(baseUrl + "/api/v1/auth/register",
                new RegisterRequest(otherEmail, TestDataFactory.PASSWORD, "Other"), AuthResponse.class);
        User other = userRepository.findByEmail(otherEmail).orElseThrow();
        workspaceUserRepository.save(new WorkspaceUser(workspaceId, other.getId().toString(), WorkspaceRole.MEMBER));
        String otherToken = jwtTokenProvider.createAccessToken(other.getId().toString(), otherEmail, "USER", workspaceId);

        ResponseEntity<Map> response = restTemplate.exchange(
                baseUrl + "/api/v1/sessions/" + sessionId + "/attachments/" + owned.getId().toString(),
                HttpMethod.GET, new HttpEntity<>(authHeaders(otherToken)), Map.class);

        assertEquals(HttpStatus.NOT_FOUND, response.getStatusCode());
    }

    @Test
    void uploadAttachments_withoutAuth_returns401() {
        ResponseEntity<Map> response = restTemplate.postForEntity(
                baseUrl + "/api/v1/sessions/" + sessionId + "/attachments",
                new LinkedMultiValueMap<>(), Map.class);
        assertEquals(HttpStatus.UNAUTHORIZED, response.getStatusCode());
    }

    private HttpHeaders authHeaders() {
        return authHeaders(authToken);
    }

    private HttpHeaders authHeaders(String token) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        return headers;
    }
}
