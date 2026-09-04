package com.cc01cc.p.xihe.cp.mcp;

import org.junit.jupiter.api.Test;
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
}
