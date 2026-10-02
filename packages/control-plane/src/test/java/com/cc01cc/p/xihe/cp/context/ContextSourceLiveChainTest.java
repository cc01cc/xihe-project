package com.cc01cc.p.xihe.cp.context;

import com.cc01cc.p.xihe.cp.AbstractH2Test;
import com.cc01cc.p.xihe.cp.context.service.ContextProjectionService;
import com.cc01cc.p.xihe.cp.context.service.ContextService;
import com.cc01cc.p.xihe.cp.context.service.ContextSourceRefreshService;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.web.client.RestTemplate;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * PLAN-0382 T3.3: real Runtime → CP chain evidence (verify V11).
 *
 * <p>Runs against the LIVE Runtime at localhost:12645 (facts + files routes,
 * PLAN-0427 found semantics) and the LIVE dev CP at 12631 (workspace
 * registration + execution-spec), while the refresh/projection code under test
 * is this branch's Spring context on an isolated H2 database.
 *
 * <p>Gated by JUnit assumptions: when either live dependency is unreachable the
 * class reports SKIPPED (never a silent pass); the captured chain evidence is
 * persisted to the evidence directory so V11 is judged from artifacts.
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {
            "cp.mcp.runtime-url=http://localhost:12645",
            "cp.agent-api-token=dev-token-not-secure",
        })
@ActiveProfiles("h2")
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class ContextSourceLiveChainTest extends AbstractH2Test {

    private static final String RUNTIME_URL = "http://localhost:12645";
    private static final String DEV_CP_URL = "http://localhost:12631";
    private static final String SERVICE_TOKEN = "dev-token-not-secure";

    @Autowired
    private ContextSourceRefreshService refreshService;

    @Autowired
    private ContextProjectionService projectionService;

    @Autowired
    private ContextService contextService;

    @Autowired
    private ObjectMapper objectMapper;

    private final RestTemplate runtimeClient = new RestTemplate();

    private boolean reachable(String probeUrl) {
        try {
            return new RestTemplate().getForEntity(probeUrl, String.class)
                    .getStatusCode().is2xxSuccessful();
        } catch (Exception e) {
            return false;
        }
    }

    private String registerWorkspace() {
        RestTemplate cp = new RestTemplate();
        Map<String, String> body = Map.of(
                "email", "live-chain-" + UUID.randomUUID() + "@test.com",
                "password", "LiveChain-0427x!",
                "name", "Live Chain");
        ResponseEntity<Map> response = cp.postForEntity(
                DEV_CP_URL + "/api/v1/auth/register", body, Map.class);
        assertThat(response.getStatusCode().is2xxSuccessful()).isTrue();
        String workspaceId = String.valueOf(response.getBody().get("workspaceId"));
        assertThat(workspaceId).isNotBlank();
        return workspaceId;
    }

    private void writeFile(String workspaceId, String path, String content) {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_OCTET_STREAM);
        headers.setBearerAuth(SERVICE_TOKEN);
        runtimeClient.exchange(
                RUNTIME_URL + "/internal/v1/runtime/workspaces/" + workspaceId + "/files/write/" + path,
                HttpMethod.POST,
                new HttpEntity<>(content.getBytes(StandardCharsets.UTF_8), headers),
                String.class);
    }

    private String gitFactsRaw(String workspaceId) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(SERVICE_TOKEN);
        ResponseEntity<String> response = runtimeClient.exchange(
                RUNTIME_URL + "/internal/v1/runtime/workspaces/" + workspaceId + "/git-facts",
                HttpMethod.GET,
                new HttpEntity<>(headers),
                String.class);
        return response.getBody();
    }

    private ObjectNode projectEpoch(String sessionId) {
        ObjectNode context = projectionService.project(sessionId, 0L);
        return (ObjectNode) context.get("epoch");
    }

    private void dumpEvidence(String fileName, Object payload) throws Exception {
        String dir = System.getProperty("xihe.evidence.dir", "target");
        Path out = Path.of(dir, fileName);
        Files.createDirectories(out.getParent());
        Files.writeString(out, objectMapper.writerWithDefaultPrettyPrinter().writeValueAsString(payload));
    }

    @Test
    void liveRuntimeRefreshProjectsRealEnvAndSourceStates() throws Exception {
        Assumptions.assumeTrue(reachable(RUNTIME_URL + "/ready"),
                "LIVE Runtime not reachable at " + RUNTIME_URL + " — live-chain evidence run aborted (reported as skipped)");
        Assumptions.assumeTrue(reachable(DEV_CP_URL + "/actuator/health"),
                "LIVE dev CP not reachable at " + DEV_CP_URL + " — workspace registration unavailable");

        // --- Leg 1: workspace with AGENTS.md → CONTENT/ok + real facts ----
        String wsOk = registerWorkspace();
        writeFile(wsOk, "AGENTS.md", "# live chain rules\nUse Runtime facts only.");
        String factsRaw = gitFactsRaw(wsOk);
        assertThat(factsRaw).contains("\"cwd\"").contains("\"observedAt\"")
                .contains("\"platform\"").contains("\"shell\"");

        String sessionOk = UUID.randomUUID().toString();
        String userOk = UUID.randomUUID().toString();
        contextService.appendEvent(sessionOk, wsOk, userOk, "session.created", Map.of(
                "workspace_id", wsOk, "user_id", userOk,
                "epoch_id", "epoch-live-1", "baseline_hash", "h0",
                "system_messages", java.util.List.of("You are xihe")));

        String statusOk = refreshService.refresh(sessionOk, wsOk, userOk);
        ObjectNode epochOk = projectEpoch(sessionOk);

        assertThat(statusOk).isIn("created", "updated");
        assertThat(epochOk.get("l1_status").asText()).isEqualTo("ok");
        assertThat(epochOk.get("l1_rendered").asText()).contains("live chain rules");
        // Real facts (docker mode value-source table, spec §2.1). The fresh
        // workspace is intentionally NOT a git repo → the frozen enum value
        // not_repository is the correct live reading (repo-ok is covered by
        // the hermetic stubFacts(true) test).
        assertThat(epochOk.get("env_status").asText()).isEqualTo("not_repository");
        assertThat(epochOk.get("env_cwd").asText()).isEqualTo("/workspace");
        assertThat(epochOk.get("env_platform").asText()).isEqualTo("linux");
        assertThat(epochOk.get("env_shell").asText()).isEqualTo("xihe-shell");
        assertThat(epochOk.get("env_observed_at").asText()).isNotBlank();
        assertThat(epochOk.get("env_is_repository").asBoolean()).isFalse();

        // --- Leg 2: workspace without AGENTS.md → ABSENT/missing ----------
        String wsMissing = registerWorkspace();
        String sessionMissing = UUID.randomUUID().toString();
        String userMissing = UUID.randomUUID().toString();
        contextService.appendEvent(sessionMissing, wsMissing, userMissing, "session.created", Map.of(
                "workspace_id", wsMissing, "user_id", userMissing,
                "epoch_id", "epoch-live-2", "baseline_hash", "h0",
                "system_messages", java.util.List.of("You are xihe")));

        String statusMissing = refreshService.refresh(sessionMissing, wsMissing, userMissing);
        ObjectNode epochMissing = projectEpoch(sessionMissing);

        assertThat(statusMissing).isEqualTo("missing");
        assertThat(epochMissing.get("l1_status").asText()).isEqualTo("missing");
        assertThat(epochMissing.get("l1_rendered").asText()).isEmpty();

        // --- Persist workspace-scoped evidence for verify V11 ---------------
        ObjectNode evidence = objectMapper.createObjectNode();
        evidence.put("capturedAt", java.time.Instant.now().toString());
        evidence.put("workspaceIdOk", wsOk);
        evidence.put("sessionIdOk", sessionOk);
        evidence.put("workspaceIdMissing", wsMissing);
        evidence.put("sessionIdMissing", sessionMissing);
        evidence.set("gitFactsRaw", objectMapper.readTree(factsRaw));
        evidence.set("epochWithAgentsMd", epochOk);
        evidence.set("epochMissingAgentsMd", epochMissing);
        dumpEvidence("t3-live-chain-evidence.json", evidence);
    }
}
