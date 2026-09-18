package com.cc01cc.p.xihe.cp.mcp;

import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.ActiveProfiles;

import static org.junit.jupiter.api.Assertions.*;

@SpringBootTest
@ActiveProfiles("h2")
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class McpProxyControllerTest {

    @Autowired
    private McpProxyController controller;

    @Autowired
    private com.cc01cc.p.xihe.cp.repository.McpToolAliasRepository aliasRepository;

    @Autowired
    private com.cc01cc.p.xihe.cp.service.WorkspaceService workspaceService;

    @Test
    void controllerLoads() {
        assertNotNull(controller);
    }

    @Test
    void extractToolName_returnsNullOnNonToolCall() {
        String body = "{\"method\":\"initialize\"}";
        String toolName = invokeExtractToolName(body);
        assertNull(toolName);
    }

    @Test
    void extractToolName_returnsNameOnToolCall() {
        String body = "{\"method\":\"tools/call\",\"params\":{\"name\":\"read_file\"}}";
        String toolName = invokeExtractToolName(body);
        assertEquals("read_file", toolName);
    }

    @Test
    void extractMethod_parsesCorrectly() {
        String body = "{\"method\":\"tools/list\"}";
        String method = invokeExtractMethod(body);
        assertEquals("tools/list", method);
    }

    private String invokeExtractToolName(String body) {
        try {
            var field = McpProxyController.class.getDeclaredMethod("extractToolName", String.class);
            field.setAccessible(true);
            return (String) field.invoke(controller, body);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    @Test
    void tenantContext_workspacePath_storedAndRetrieved() {
        com.cc01cc.p.xihe.cp.config.TenantContext.setWorkspacePath("/data/xihe/workspaces/test123");
        com.cc01cc.p.xihe.cp.config.TenantContext.setWorkspaceId("ws-test123");

        assertEquals("/data/xihe/workspaces/test123", com.cc01cc.p.xihe.cp.config.TenantContext.getWorkspacePath());
        assertEquals("ws-test123", com.cc01cc.p.xihe.cp.config.TenantContext.getWorkspaceId());

        com.cc01cc.p.xihe.cp.config.TenantContext.clear();
    }

    @Test
    void tenantContext_nullWorkspacePath_afterClear() {
        com.cc01cc.p.xihe.cp.config.TenantContext.clear();
        assertNull(com.cc01cc.p.xihe.cp.config.TenantContext.getWorkspacePath());
        assertNull(com.cc01cc.p.xihe.cp.config.TenantContext.getWorkspaceId());
    }

    private String invokeExtractMethod(String body) {
        try {
            var field = McpProxyController.class.getDeclaredMethod("extractMethod", String.class);
            field.setAccessible(true);
            return (String) field.invoke(controller, body);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    @Test
    void signSessionId_producesDotSeparatedHmac() {
        String signed = invokeSignSessionId("ws-1", "jwt-token");
        assertNotNull(signed);
        assertTrue(signed.contains("."), "HMAC-signed session-id must contain '.' separator");
        String[] parts = signed.split("\\.");
        assertEquals(2, parts.length);
        assertFalse(parts[0].isEmpty(), "payload must not be empty");
        assertFalse(parts[1].isEmpty(), "signature must not be empty");
    }

    @Test
    void signThenVerify_roundTrip_returnsCorrectWsId() {
        String signed = invokeSignSessionId("ws-roundtrip", "auth-token");
        String wsId = invokeVerifySessionId(signed);
        assertEquals("ws-roundtrip", wsId);
    }

    @Test
    void verifySessionId_rejectsTamperedPayload() throws Exception {
        String signed = invokeSignSessionId("ws-1", "token");
        String[] parts = signed.split("\\.");
        // Replace payload with re-encoded "ws-2:token:0" but keep old signature
        String tamperedPayload = java.util.Base64.getUrlEncoder().withoutPadding()
            .encodeToString("ws-2:token:0".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        String tampered = tamperedPayload + "." + parts[1];
        assertNull(invokeVerifySessionId(tampered), "Tampered payload must be rejected");
    }

    @Test
    void verifySessionId_rejectsInvalidFormat() {
        assertNull(invokeVerifySessionId("no-dot-separator"));
    }

    @Test
    void verifySessionId_rejectsEmptyString() {
        assertNull(invokeVerifySessionId(""));
    }

    @Test
    void signSessionId_producesDifferentSignaturesForDifferentWsIds() {
        String s1 = invokeSignSessionId("ws-a", "token");
        String s2 = invokeSignSessionId("ws-b", "token");
        assertNotEquals(s1, s2, "Different ws_id must produce different signatures");
    }

    private String invokeSignSessionId(String wsId, String rawSessionId) {
        try {
            var field = McpProxyController.class.getDeclaredMethod("signSessionId", String.class, String.class);
            field.setAccessible(true);
            return (String) field.invoke(controller, wsId, rawSessionId);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    private String invokeVerifySessionId(String signedSessionId) {
        try {
            var field = McpProxyController.class.getDeclaredMethod("verifySessionId", String.class);
            field.setAccessible(true);
            return (String) field.invoke(controller, signedSessionId);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    // PLAN-242 M2: sticky naming is conflict-only and deterministic.
    @Test
    void stickyIssuedName_bareWhenFree() {
        assertEquals("read_file", McpProxyController.stickyIssuedName("github", "read_file", true));
    }

    @Test
    void stickyIssuedName_qualifiedOnConflict() {
        assertEquals("github__read_file", McpProxyController.stickyIssuedName("github", "read_file", false));
    }

    @Test
    void backendFromIssued_roundTrip() {
        assertEquals("read_file", McpProxyController.backendFromIssued("github__read_file"));
        assertEquals("read_file", McpProxyController.backendFromIssued("read_file"));
        assertNull(McpProxyController.backendFromIssued(null));
    }

    // PLAN-242 M2.4: alias rows persist (sticky source of truth) and bare +
    // prefixed issues for one backend coexist without promotion.
    @Test
    void aliasRepository_roundTrip() {
        String owner = java.util.UUID.randomUUID().toString();
        String wsId = workspaceService.createWorkspace("alias-test", owner).getId().toString();
        java.util.UUID wsUuid = java.util.UUID.fromString(wsId);

        aliasRepository.save(new com.cc01cc.p.xihe.cp.entity.McpToolAlias(
                wsId, "ask_question", java.util.UUID.nameUUIDFromBytes("deepwiki".getBytes()).toString(), "ask_question", 1L));
        aliasRepository.save(new com.cc01cc.p.xihe.cp.entity.McpToolAlias(
                wsId, "github__ask_question", java.util.UUID.nameUUIDFromBytes("github".getBytes()).toString(), "ask_question", 1L));

        assertTrue(aliasRepository.findByWorkspaceIdAndIssuedName(UUID.fromString(wsId), "ask_question").isPresent());
        assertEquals(2, aliasRepository.findByWorkspaceId(wsUuid).size());
    }

    // ── PLAN-0366 T1.2：toolServerCache 非 2xx 失效 ────────────────────────

    @Test
    void stdioToolsFailureEvictsOnlyThatServerMappings() {
        Map<String, String> mapping = new ConcurrentHashMap<>();
        mapping.put("sys_tool", "__system__");
        mapping.put("a_tool", "server-a");
        mapping.put("b_tool", "server-b");
        List<Map<String, Object>> allTools = new ArrayList<>();
        Set<String> seenNames = new HashSet<>(Set.of("sys_tool", "a_tool", "b_tool"));

        controller.mergeStdioServerTools("ws-1", "server-a",
                ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body("{\"error\":\"boom\"}"),
                mapping, allTools, seenNames);

        assertFalse(mapping.containsKey("a_tool"), "failed server must not keep stale mappings");
        assertEquals("server-b", mapping.get("b_tool"), "other servers keep their mappings");
        assertEquals("__system__", mapping.get("sys_tool"));
        assertTrue(seenNames.contains("b_tool"));
        assertTrue(allTools.isEmpty(), "a failed server contributes no tools");
    }

    @Test
    void stdioToolsSuccessMergesAndKeepsOtherServers() {
        Map<String, String> mapping = new ConcurrentHashMap<>();
        mapping.put("b_tool", "server-b");
        List<Map<String, Object>> allTools = new ArrayList<>();
        Set<String> seenNames = new HashSet<>(Set.of("b_tool"));
        String body = "{\"result\":{\"tools\":[{\"name\":\"a_new\",\"description\":\"x\"}]}}";

        controller.mergeStdioServerTools("ws-1", "server-a",
                ResponseEntity.ok(body), mapping, allTools, seenNames);

        assertEquals("server-a", mapping.get("a_new"));
        assertEquals("server-b", mapping.get("b_tool"));
        assertEquals(1, allTools.size());
        assertEquals("a_new", allTools.get(0).get("name"));
    }
}
