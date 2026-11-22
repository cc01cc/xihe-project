package com.cc01cc.p.xihe.cp.policy.mcpresource;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.mcp.McpProxyCatalogService;
import com.cc01cc.p.xihe.cp.repository.McpServerRepository;
import com.cc01cc.p.xihe.cp.repository.McpStdioServerRepository;
import com.cc01cc.p.xihe.cp.repository.McpToolAliasRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;

/**
 * task-870 / D-1921 (Lead hard condition): a user-writable server name must not start with
 * {@code __}. Otherwise a holder of {@code MANAGE_WORKSPACE_MCP} could register a server literally
 * named {@code __system__}, inherit the built-in exclusion, and bypass the {@code mcp:} gate.
 *
 * <p>The check lives in the catalog service so every door (the legacy {@code mcp-config} PUT and
 * the stdio/remote editors) is covered by one place.</p>
 */
class McpServerNameWriteFaceTest {

    private final McpProxyCatalogService service = new McpProxyCatalogService(
            mock(McpStdioServerRepository.class),
            mock(McpServerRepository.class),
            mock(McpToolAliasRepository.class));

    @Test
    void stdioNamesMustNotUseTheReservedPrefix() {
        var entry = new ObjectMapper().createObjectNode().put("command", "npx");
        CpApiException refusal = assertThrows(CpApiException.class,
                () -> service.replaceStdioConfigs("ws", Map.of("__system__", entry)));
        assertEquals(HttpStatus.BAD_REQUEST, refusal.getStatus());
        assertTrue(refusal.getMessage().contains("__"), refusal.getMessage());
    }

    @Test
    void remoteNamesMustNotUseTheReservedPrefix() {
        var input = new McpProxyCatalogService.RemoteEndpointInput(
                "https://example.invalid/mcp", null, null, null, null, null);
        CpApiException refusal = assertThrows(CpApiException.class,
                () -> service.saveRemoteEndpoints("ws", Map.of("__cp__", input)));
        assertEquals(HttpStatus.BAD_REQUEST, refusal.getStatus());
        assertTrue(refusal.getMessage().contains("__"), refusal.getMessage());
    }
}
