package com.cc01cc.p.xihe.cp.context;

import com.cc01cc.p.xihe.cp.AbstractH2Test;
import com.cc01cc.p.xihe.cp.chat.SseEmitterManager;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.policy.GrantPrincipalPathResolver;
import com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.status.HealthMonitor;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.io.IOException;
import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

/** Opt-in live CP ChatController -> Agent -> MCP -> Runtime -> CP projection chain. */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = "cp.agent-api-token=dev-token-not-secure")
class ContextToolHistoryLiveChainTest extends AbstractH2Test {

    private static final int RUNTIME_PORT = freePort();
    private static final int AGENT_PORT = freePort();
    private static final String SERVICE_TOKEN = "dev-token-not-secure";
    private static final String MARKER = "PLAN0381_LARGE_MARKER";
    private static final Path AGENT_ROOT = Path.of(System.getProperty("user.dir"))
            .getParent().resolve("agent").toAbsolutePath().normalize();
    private static final String AGENT_SERVER = "scripts/plan0381_v15_test_agent.py";

    @TempDir
    Path tempDir;

    @Autowired
    private SseEmitterManager sseEmitterManager;
    @Autowired
    private HealthMonitor healthMonitor;
    @Autowired
    private ChatRunRepository chatRunRepository;
    @Autowired
    private ObjectMapper objectMapper;
    @Autowired
    private AuthorizationGrantRepository authorizationGrantRepository;

    private Process runtimeProcess;
    private Process agentProcess;
    private String workspaceId;
    private String sessionId;
    private Path hostRoot;
    private Path runtimeLog;
    private Path agentLog;

    @DynamicPropertySource
    static void serviceProperties(DynamicPropertyRegistry registry) {
        registry.add("cp.mcp.runtime-url", () -> "http://127.0.0.1:" + RUNTIME_PORT);
        registry.add("cp.agent-url", () -> "http://127.0.0.1:" + AGENT_PORT + "/internal/v1/agent/chat");
    }

    @Test
    @EnabledIfSystemProperty(named = "xihe.run.v15.live", matches = "true")
    void realChatToolRuntimeProjectionAndNextRound() throws Exception {
        Path runtimeProject = Path.of(System.getProperty("user.dir")).getParent()
                .resolve("runtime").toAbsolutePath().normalize();
        boolean windows = System.getProperty("os.name").toLowerCase().contains("win");
        Path runtimeBinary = runtimeProject.resolve("target/debug/xihe-runtime" + (windows ? ".exe" : ""));
        assertThat(Files.isRegularFile(runtimeBinary))
                .as("Required Runtime binary; build packages/runtime first").isTrue();
        assertThat(Files.isRegularFile(AGENT_ROOT.resolve(AGENT_SERVER)))
                .as("Required real Agent test server").isTrue();

        hostRoot = Files.createDirectories(tempDir.resolve("workspace-root"));
        runtimeLog = tempDir.resolve("runtime.log");
        agentLog = tempDir.resolve("agent.log");
        Files.createFile(runtimeLog);
        Files.createFile(agentLog);
        runtimeProcess = startRuntime(runtimeBinary, runtimeProject);
        awaitEndpoint(runtimeProcess, runtimeLog, "http://127.0.0.1:" + RUNTIME_PORT + "/ready", "Runtime");

        ResponseEntity<Map> registration = restTemplate.postForEntity(
                url("/api/v1/auth/register"),
                Map.of("email", "v15-" + UUID.randomUUID() + "@test.com",
                        "password", "V15-Test-0427!", "name", "PLAN-0381 V15"),
                Map.class);
        assertThat(registration.getStatusCode().is2xxSuccessful()).isTrue();
        Map<String, Object> registerBody = registration.getBody();
        assertThat(registerBody).isNotNull();
        String userToken = String.valueOf(registerBody.get("accessToken"));
        workspaceId = String.valueOf(registerBody.get("workspaceId"));
        @SuppressWarnings("unchecked")
        Map<String, Object> user = (Map<String, Object>) registerBody.get("user");
        registrationUser = user;
        String userId = String.valueOf(user.get("id"));
        assertThat(userToken).isNotBlank();
        assertThat(workspaceId).isNotBlank();
        assertThat(userId).isNotBlank();

        seedOperatorCapabilities(userId);
        String principalId = createAndBindReadOnlyPrincipal(userToken);
        sessionId = createAgentSession(userToken, principalId);
        JsonNode initial = serviceGet("/internal/v1/context/" + sessionId + "/snapshot");
        String branchId = initial.path("branch_id").asText();
        assertThat(branchId).isNotBlank();

        Path capture = tempDir.resolve("provider-requests.jsonl");
        agentProcess = startAgentServer(capture, true);
        awaitEndpoint(agentProcess, agentLog,
                "http://127.0.0.1:" + AGENT_PORT + "/internal/v1/agent/health", "Agent");
        healthMonitor.pollHealth();
        assertThat(healthMonitor.getAgentLlmReady()).as("Agent llmReady must be ready").isEqualTo("ready");
        assertThat(healthMonitor.getAgentBreaker().allowRequest()).isTrue();

        writeLargeFixture();
        sseEmitterManager.createEmitter(sessionId);
        try {
            String firstRunId = submitChat(userToken, sessionId, branchId, principalId,
                    "Read large.txt and summarize its marker.");
            ChatRun firstRun = awaitTerminal(firstRunId);
            assertSuccessful(firstRun, "first chat run");

            JsonNode afterFirst = serviceGet("/internal/v1/context/" + sessionId
                    + "/snapshot?branchId=" + branchId);
            JsonNode messages = afterFirst.path("messages");
            JsonNode assistant = findAssistantToolCall(messages);
            assertThat(assistant).as("projected assistant tool call; snapshot=" + afterFirst).isNotNull();
            JsonNode call = assistant.path("tool_calls").get(0);
            String callId = call.path("call_id").asText();
            JsonNode result = findToolResult(messages, callId);
            assertThat(callId).isNotBlank();
            assertThat(result).as("projected paired tool result").isNotNull();
            String preview = result.path("content").asText();
            assertThat(preview).contains(MARKER).containsIgnoringCase("truncated");
            assertThat(preview.length()).isLessThan(12_000);
            int calledBefore = countEvents(sessionId, "tool.called");
            int resultBefore = countEvents(sessionId, "tool.result");
            assertThat(calledBefore).isEqualTo(1);
            assertThat(resultBefore).isEqualTo(1);

            String secondRunId = submitChat(userToken, sessionId, branchId, principalId,
                    "Continue from the previous result; do not reread the file.");
            ChatRun secondRun = awaitTerminal(secondRunId);
            assertSuccessful(secondRun, "second chat run");
            JsonNode afterSecond = serviceGet("/internal/v1/context/" + sessionId
                    + "/snapshot?branchId=" + branchId);

            await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> {
                assertThat(Files.readAllLines(capture)).hasSize(3);
            });
            JsonNode secondRequest = objectMapper.readTree(Files.readAllLines(capture).get(2));
            JsonNode wireAssistant = findAssistantToolCall(secondRequest.path("messages"));
            assertThat(wireAssistant).isNotNull();
            JsonNode wireCall = wireAssistant.path("tool_calls").get(0);
            assertThat(wireCall.path("id").asText()).isEqualTo(callId);
            JsonNode wireResult = findWireToolResult(secondRequest.path("messages"), callId);
            assertThat(wireResult).isNotNull();
            assertThat(wireResult.path("content").asText()).contains(MARKER);
            assertThat(countEvents(sessionId, "tool.called")).isEqualTo(calledBefore);
            assertThat(countEvents(sessionId, "tool.result")).isEqualTo(resultBefore);

            // PLAN-0381 V17 rollback drill (isolated test stack): after V2
            // events exist, stop the writer-on Agent, restart the real Agent
            // app with the V2 writer gate OFF, then run one more Chat. The
            // rolled-back reader must consume existing V2 history and the new
            // write must use the legacy wire shape.
            JsonNode v2Snapshot = afterSecond;
            stopChild(agentProcess, "Agent writer-on");
            agentProcess = startAgentServer(capture, false);
            awaitEndpoint(agentProcess, agentLog,
                    "http://127.0.0.1:" + AGENT_PORT + "/internal/v1/agent/health", "Agent writer-off");
            healthMonitor.pollHealth();
            assertThat(healthMonitor.getAgentLlmReady()).isEqualTo("ready");

            String rollbackRunId = submitChat(userToken, sessionId, branchId, principalId,
                    "Read large.txt again and report the marker.");
            assertSuccessful(awaitTerminal(rollbackRunId), "writer-off rollback chat");

            await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> {
                assertThat(Files.readAllLines(capture)).hasSize(5);
            });
            JsonNode rollbackProviderRequest = objectMapper.readTree(Files.readAllLines(capture).get(3));
            JsonNode rollbackHistoryCall = findAssistantToolCall(rollbackProviderRequest.path("messages"));
            assertThat(rollbackHistoryCall).as("writer-off reader still receives pre-rollback V2 history").isNotNull();
            assertThat(rollbackHistoryCall.path("tool_calls").get(0).path("id").asText()).isEqualTo(callId);

            JsonNode finalSnapshot = serviceGet("/internal/v1/context/" + sessionId
                    + "/snapshot?branchId=" + branchId);
            assertThat(countProjectedToolCalls(finalSnapshot.path("messages")))
                    .as("one new tool call is expected from the rollback chat")
                    .isEqualTo(2);
            JsonNode rawEvents = serviceGet("/internal/v1/context/" + sessionId + "/events?afterSequence=0");
            assertThat(countEventSchemaVersion(rawEvents, "tool.called", true)).isEqualTo(1);
            assertThat(countEventSchemaVersion(rawEvents, "tool.called", false)).isEqualTo(1);

            // Feed the actual post-V2/post-rollback CP snapshot to the actual
            // pre-0381 AgentContext reader source; it must recover a safe,
            // non-empty truncated text fact rather than an empty ToolMessage.
            Path snapshotFile = tempDir.resolve("snapshot-after-writer-rollback.json");
            Path legacyProbeOutput = tempDir.resolve("legacy-reader-rollback.json");
            Files.writeString(snapshotFile, objectMapper.writeValueAsString(finalSnapshot));
            Process legacyProbe = new ProcessBuilder("uv", "run", "python",
                    "scripts/plan0381_v17_legacy_reader_probe.py",
                    snapshotFile.toAbsolutePath().toString(), legacyProbeOutput.toAbsolutePath().toString(),
                    "365d3d73b15cfd4e7d645cc05adb63bfba9a81b5")
                    .directory(AGENT_ROOT.toFile()).redirectErrorStream(true)
                    .redirectOutput(tempDir.resolve("legacy-reader.log").toFile()).start();
            if (!legacyProbe.waitFor(60, TimeUnit.SECONDS)) {
                legacyProbe.destroyForcibly();
                throw new AssertionError("legacy reader rollback probe timed out");
            }
            assertThat(legacyProbe.exitValue()).as("legacy reader rollback probe").isZero();
            JsonNode legacyReaderResult = objectMapper.readTree(legacyProbeOutput.toFile());
            assertThat(legacyReaderResult.path("safeTextFallback").asBoolean()).isTrue();
            assertThat(legacyReaderResult.path("noEmptyToolMessages").asBoolean()).isTrue();

            // Archive-facing evidence kept in target; plan wrapper copies it to
            // review/evidence after this test succeeds.
            var providerRequests = objectMapper.createArrayNode();
            for (String line : Files.readAllLines(capture)) {
                providerRequests.add(objectMapper.readTree(line));
            }
            Path providerEvidence = Path.of("target", "plan0381-v15-provider-requests.jsonl");
            Files.copy(capture, providerEvidence, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            ObjectNode evidence = objectMapper.createObjectNode();
            evidence.put("workspaceId", workspaceId);
            evidence.put("sessionId", sessionId);
            evidence.put("callId", callId);
            evidence.put("providerRequestCount", providerRequests.size());
            evidence.put("writerGateRollback", "on -> off");
            evidence.set("providerRequests", providerRequests);
            evidence.set("v2Snapshot", v2Snapshot);
            evidence.set("finalSnapshot", finalSnapshot);
            evidence.set("legacyReader", legacyReaderResult);
            evidence.set("rawToolEvents", rawEvents);
            Files.writeString(Path.of("target", "plan0381-v15-live-evidence.json"),
                    objectMapper.writerWithDefaultPrettyPrinter().writeValueAsString(evidence));
        } finally {
            sseEmitterManager.complete(sessionId);
        }
    }

    private void seedOperatorCapabilities(String userId) {
        // This isolated H2 fixture grants only the prerequisite account/agent
        // administration capabilities. Principal creation, workspace binding,
        // Session binding and the subsequent tool/MCP authorization all go
        // through their real production APIs and policy checks.
        AuthorizationGrant grant = new AuthorizationGrant();
        grant.setGranterType(GrantPrincipalPathResolver.USER);
        grant.setGranterId(UUID.fromString(userId));
        grant.setSubjectType(GrantPrincipalPathResolver.USER);
        grant.setSubjectId(UUID.fromString(userId));
        grant.setSource("direct");
        grant.setReadState("read");
        grant.setPermissions(objectMapper.valueToTree(java.util.List.of(
                Map.of("actionClass", ToolFaceRegistry.ACTION_CREATE_ACCOUNT, "resource", "*"),
                Map.of("actionClass", ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_AGENTS, "resource", "*"))));
        authorizationGrantRepository.saveAndFlush(grant);
    }

    private String createAndBindReadOnlyPrincipal(String userToken) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(userToken);
        headers.setContentType(MediaType.APPLICATION_JSON);
        ResponseEntity<Map> principalResponse = restTemplate.postForEntity(
                url("/api/v1/agent-principals"),
                new HttpEntity<>(Map.of("name", "PLAN-0381 V15 reader"), headers),
                Map.class);
        assertThat(principalResponse.getStatusCode().is2xxSuccessful()).as("principal API create").isTrue();
        String principalId = String.valueOf(principalResponse.getBody().get("principalId"));
        assertThat(principalId).isNotBlank();

        // Ensure the principal has the read action in its own effective grant;
        // workspace binding below narrows the capability to read only.
        AuthorizationGrant principalRead = new AuthorizationGrant();
        principalRead.setGranterType(GrantPrincipalPathResolver.USER);
        principalRead.setGranterId(UUID.fromString((String) ((Map<?, ?>) registrationUser).get("id")));
        principalRead.setSubjectType(GrantPrincipalPathResolver.AGENT_PRINCIPAL);
        principalRead.setSubjectId(UUID.fromString(principalId));
        principalRead.setSource("direct");
        principalRead.setReadState("read");
        principalRead.setPermissions(objectMapper.valueToTree(
                java.util.List.of(Map.of("actionClass", ToolFaceRegistry.ACTION_READ, "resource", "*"))));
        authorizationGrantRepository.saveAndFlush(principalRead);

        ResponseEntity<Map> binding = restTemplate.exchange(
                url("/api/v1/workspaces/" + workspaceId + "/agents/" + principalId),
                org.springframework.http.HttpMethod.PUT,
                new HttpEntity<>(Map.of("permissions", java.util.List.of(
                        Map.of("actionClass", ToolFaceRegistry.ACTION_READ))), headers),
                Map.class);
        assertThat(binding.getStatusCode().is2xxSuccessful()).as("workspace read-only Agent cap").isTrue();
        return principalId;
    }

    private Map<String, Object> registrationUser;

    private String createAgentSession(String userToken, String principalId) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(userToken);
        headers.setContentType(MediaType.APPLICATION_JSON);
        ResponseEntity<Map> response = restTemplate.postForEntity(url("/api/v1/sessions"),
                new HttpEntity<>(Map.of("title", "PLAN-0381 V15", "agentPrincipalId", principalId), headers),
                Map.class);
        assertThat(response.getStatusCode().is2xxSuccessful()).as("Session bound to explicit Agent principal").isTrue();
        return String.valueOf(response.getBody().get("id"));
    }

    private Process startRuntime(Path binary, Path runtimeProject) throws IOException {
        ProcessBuilder builder = new ProcessBuilder(binary.toString())
                .directory(runtimeProject.toFile()).redirectErrorStream(true)
                .redirectOutput(runtimeLog.toFile());
        Map<String, String> env = builder.environment();
        env.put("XIHE_ENV", "dev");
        env.put("XIHE_RUNTIME_PORT", Integer.toString(RUNTIME_PORT));
        env.put("XIHE_WORKSPACE_HOST_ROOT", hostRoot.toString());
        env.put("XIHE_CP_URL", baseUrl);
        env.put("XIHE_CP_API_TOKEN", SERVICE_TOKEN);
        return builder.start();
    }

    private Process startAgentServer(Path capture, boolean writerGateV2) throws IOException {
        ProcessBuilder builder = new ProcessBuilder("uv", "run", "python", AGENT_SERVER)
                .directory(AGENT_ROOT.toFile()).redirectErrorStream(true).redirectOutput(agentLog.toFile());
        Map<String, String> env = builder.environment();
        env.put("XIHE_CP_URL", baseUrl);
        env.put("XIHE_CP_API_TOKEN", SERVICE_TOKEN);
        env.put("XIHE_CONTEXT_EVENT_WRITER_V2", writerGateV2 ? "1" : "0");
        env.put("XIHE_AGENT_PORT", Integer.toString(AGENT_PORT));
        env.put("XIHE_V15_PROVIDER_CAPTURE", capture.toAbsolutePath().toString());
        return builder.start();
    }

    private void writeLargeFixture() throws Exception {
        String content = MARKER + "\n" + "bounded-evidence-content-".repeat(700);
        assertThat(content.length()).isGreaterThan(12_000);
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(SERVICE_TOKEN);
        ResponseEntity<String> response = restTemplate.exchange(
                "http://127.0.0.1:" + RUNTIME_PORT + "/internal/v1/runtime/workspaces/" + workspaceId
                        + "/files/write/large.txt",
                org.springframework.http.HttpMethod.POST,
                new HttpEntity<>(content.getBytes(java.nio.charset.StandardCharsets.UTF_8), headers), String.class);
        assertThat(response.getStatusCode().is2xxSuccessful()).as("Runtime fixture write").isTrue();
    }

    private String submitChat(String token, String id, String branchId, String principalId, String content) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        headers.setContentType(MediaType.APPLICATION_JSON);
        ResponseEntity<Map> response = restTemplate.postForEntity(url("/api/v1/chat"), new HttpEntity<>(Map.of(
                "sessionId", id, "branchId", branchId, "agentPrincipalId", principalId,
                "content", content, "toolMode", "workspace"), headers), Map.class);
        assertThat(response.getStatusCode().value()).as("public chat accepted: " + response.getBody()).isEqualTo(202);
        assertThat(response.getBody()).isNotNull();
        return String.valueOf(response.getBody().get("runId"));
    }

    private ChatRun awaitTerminal(String runId) {
        await().atMost(Duration.ofMinutes(4)).pollInterval(Duration.ofMillis(250)).untilAsserted(() -> {
            ChatRun run = chatRunRepository.findById(UUID.fromString(runId)).orElseThrow();
            assertThat(run.getTerminalAt()).as("ChatRun terminalAt, status=" + run.getStatus()
                    + " error=" + run.getErrorCode() + " detail=" + run.getErrorDetail()).isNotNull();
        });
        return chatRunRepository.findById(UUID.fromString(runId)).orElseThrow();
    }

    private void assertSuccessful(ChatRun run, String label) {
        assertThat(run.getStatus()).as(label + " status, outcome=" + run.getTerminalOutcome()
                + " error=" + run.getErrorCode() + " detail=" + run.getErrorDetail()).isEqualTo("succeeded");
        assertThat(run.getTerminalOutcome()).isEqualTo("success");
    }

    private JsonNode serviceGet(String path) throws Exception {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(SERVICE_TOKEN);
        ResponseEntity<String> response = restTemplate.exchange(url(path), org.springframework.http.HttpMethod.GET,
                new HttpEntity<>(headers), String.class);
        assertThat(response.getStatusCode().is2xxSuccessful()).as("service GET " + path).isTrue();
        return objectMapper.readTree(response.getBody());
    }

    private int countEvents(String id, String eventType) throws Exception {
        JsonNode events = serviceGet("/internal/v1/context/" + id + "/events?afterSequence=0");
        int count = 0;
        for (JsonNode event : events) {
            if (eventType.equals(event.path("eventType").asText())) {
                count++;
            }
        }
        return count;
    }

    private int countProjectedToolCalls(JsonNode messages) {
        int count = 0;
        for (JsonNode message : messages) {
            if (("assistant".equals(message.path("role").asText())
                    || "ai".equals(message.path("role").asText()))
                    && message.path("tool_calls").isArray()) {
                count += message.path("tool_calls").size();
            }
        }
        return count;
    }

    private int countEventSchemaVersion(JsonNode events, String eventType, boolean v2) {
        int count = 0;
        for (JsonNode event : events) {
            if (!eventType.equals(event.path("eventType").asText())) {
                continue;
            }
            JsonNode payload = event.path("payload");
            // ContextEvent stores JSONB in a String field for H2/PostgreSQL
            // parity, so the REST view serializes payload as JSON text.
            if (payload.isTextual()) {
                try {
                    payload = objectMapper.readTree(payload.asText());
                } catch (Exception malformedPayload) {
                    throw new AssertionError("Malformed context event payload: " + payload.asText(),
                            malformedPayload);
                }
            }
            boolean hasV2Schema = payload.path("schemaVersion").asInt(-1) == 2;
            if (hasV2Schema == v2) {
                count++;
            }
        }
        return count;
    }

    private JsonNode findAssistantToolCall(JsonNode messages) {
        for (JsonNode message : messages) {
            String role = message.path("role").asText();
            if (("assistant".equals(role) || "ai".equals(role)) && message.path("tool_calls").isArray()
                    && !message.path("tool_calls").isEmpty()) {
                return message;
            }
        }
        return null;
    }

    private JsonNode findToolResult(JsonNode messages, String callId) {
        for (JsonNode message : messages) {
            if ("tool".equals(message.path("role").asText()) && callId.equals(message.path("tool_call_id").asText())) {
                return message;
            }
        }
        return null;
    }

    private JsonNode findWireToolResult(JsonNode messages, String callId) {
        for (JsonNode message : messages) {
            if ("tool".equals(message.path("role").asText()) && callId.equals(message.path("tool_call_id").asText())) {
                return message;
            }
        }
        return null;
    }

    private void awaitEndpoint(Process process, Path log, String endpoint, String name) {
        HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build();
        await().atMost(Duration.ofSeconds(90)).pollInterval(Duration.ofMillis(250)).until(() -> {
            if (!process.isAlive()) {
                throw new AssertionError(name + " exited before readiness; log=" + Files.readString(log));
            }
            try {
                HttpResponse<String> response = client.send(HttpRequest.newBuilder(URI.create(endpoint))
                                .timeout(Duration.ofSeconds(2)).GET().build(), HttpResponse.BodyHandlers.ofString());
                return response.statusCode() == 200;
            } catch (IOException e) {
                return false;
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new AssertionError("Interrupted waiting for " + name, e);
            }
        });
    }

    private static int freePort() {
        try (ServerSocket socket = new ServerSocket(0)) {
            socket.setReuseAddress(true);
            return socket.getLocalPort();
        } catch (IOException e) {
            throw new IllegalStateException("Could not reserve an ephemeral test port", e);
        }
    }

    @AfterEach
    void teardownChildren() throws Exception {
        if (sessionId != null) {
            sseEmitterManager.complete(sessionId);
        }
        try {
            if (workspaceId != null && runtimeProcess != null && runtimeProcess.isAlive()) {
                HttpHeaders headers = new HttpHeaders();
                headers.setBearerAuth(SERVICE_TOKEN);
                ResponseEntity<String> response = restTemplate.postForEntity(
                        "http://127.0.0.1:" + RUNTIME_PORT + "/internal/v1/runtime/workspaces/delete",
                        new HttpEntity<>(Map.of("workspaceId", workspaceId), headers), String.class);
                assertThat(response.getStatusCode().is2xxSuccessful()).as("Runtime workspace cleanup").isTrue();
            }
        } finally {
            stopChild(agentProcess, "Agent");
            stopChild(runtimeProcess, "Runtime");
        }
    }

    private void stopChild(Process process, String name) throws InterruptedException {
        if (process == null) {
            return;
        }
        var descendants = new ArrayList<>(process.descendants().toList());
        descendants.sort((left, right) -> Integer.compare(processDepth(right), processDepth(left)));
        descendants.forEach(ProcessHandle::destroy);
        for (ProcessHandle descendant : descendants) {
            try {
                descendant.onExit().get(5, TimeUnit.SECONDS);
            } catch (java.util.concurrent.TimeoutException e) {
                descendant.destroyForcibly();
            } catch (java.util.concurrent.ExecutionException e) {
                throw new IllegalStateException("Failed waiting for " + name + " descendant " + descendant.pid(), e);
            }
        }
        process.destroy();
        if (!process.waitFor(10, TimeUnit.SECONDS)) {
            descendants.stream().filter(ProcessHandle::isAlive).forEach(ProcessHandle::destroyForcibly);
            process.destroyForcibly();
            process.waitFor(10, TimeUnit.SECONDS);
        }
        assertThat(process.isAlive()).as(name + " child teardown").isFalse();
    }

    private int processDepth(ProcessHandle process) {
        int depth = 0;
        var parent = process.parent();
        while (parent.isPresent()) {
            depth++;
            parent = parent.orElseThrow().parent();
        }
        return depth;
    }
}
