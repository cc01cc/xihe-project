package com.cc01cc.p.xihe.cp.policy.mcpresource;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.policy.GrantAuthorizationService;
import com.cc01cc.p.xihe.cp.policy.GrantResourcePattern;
import com.cc01cc.p.xihe.cp.policy.PermissionAtomCatalog;
import com.cc01cc.p.xihe.cp.policy.PolicyContext;
import com.cc01cc.p.xihe.cp.policy.PolicyContextProvider;
import com.cc01cc.p.xihe.cp.policy.PolicyEngine;
import com.cc01cc.p.xihe.cp.policy.PolicyLayer;
import com.cc01cc.p.xihe.cp.policy.PolicyRequest;
import com.cc01cc.p.xihe.cp.policy.RequesterAuthority;
import com.cc01cc.p.xihe.cp.policy.ResourceNamespaces;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;

/**
 * task-870 / D-1921: the gateway appends {@code mcp:<sid>} to the object resources (never replaces
 * them), the built-in ids add nothing, and the write face accepts only canonical {@code mcp:}
 * patterns.
 */
class McpGatewayResourceAppendTest {

    private static final String WS = "11111111-1111-4111-8111-111111111111";
    private static final String BODY = "{\"params\":{\"arguments\":{\"path\":\"src/a.txt\"}}}";

    private final AuditLogger audit = mock(AuditLogger.class);
    private final PolicyContextProvider provider = mock(PolicyContextProvider.class);
    private final GrantAuthorizationService grants = mock(GrantAuthorizationService.class);
    private final PolicyEngine engine = new PolicyEngine(audit, provider, grants);
    private final PolicyContext context =
            new PolicyContext(Map.of(), "manual", PolicyLayer.BUILTIN, "manual");

    @Test
    void theServerResourceIsAppendedToTheObjectResources() {
        AtomicReference<PolicyRequest> captured = new AtomicReference<>();
        when(grants.allows(any())).thenAnswer(invocation -> {
            captured.set(invocation.getArgument(0));
            return true;
        });

        assertTrue(engine.allowsByGrant(context, "write_file", BODY, "session", "user", WS,
                false, List.of("mcp:github")));
        assertTrue(captured.get().resources().contains("src/a.txt"),
                "the object resource must survive: append, never replace");
        assertTrue(captured.get().resources().contains("mcp:github"));
    }

    @Test
    void withoutTheExtraResourceTheRequestCarriesOnlyTheObject() {
        // Control reading: the same call without the gateway resource does not contain `mcp:`.
        // This proves the denial/allow difference is this pair, not an unrelated gate.
        AtomicReference<PolicyRequest> captured = new AtomicReference<>();
        when(grants.allows(any())).thenAnswer(invocation -> {
            captured.set(invocation.getArgument(0));
            return true;
        });

        assertTrue(engine.allowsByGrant(context, "write_file", BODY, "session", "user", WS, false));
        assertFalse(captured.get().resources().stream().anyMatch(r -> r.startsWith("mcp:")));
    }

    @Test
    void builtInGatewayIdsNeverProduceAResource() {
        assertNull(ResourceNamespaces.mcpServerResource("__system__"));
        assertNull(ResourceNamespaces.mcpServerResource("__cp__"));
    }

    @Test
    void theWriteFaceAcceptsOnlyCanonicalMcpPatterns() {
        GrantResourcePattern pattern = new GrantResourcePattern(
                mock(WorkspaceRepository.class), mock(RequesterAuthority.class));
        PermissionAtomCatalog.Atom write = PermissionAtomCatalog.atom("write");

        assertTrue(ResourceNamespaces.MCP_WILDCARD.equals(pattern.resolve(write, "mcp:*")));
        assertTrue("mcp:github".equals(pattern.resolve(write, "mcp:github")));

        CpApiException nonCanonical = assertThrows(CpApiException.class,
                () -> pattern.resolve(write, "mcp:My Server"));
        assertTrue(nonCanonical.getMessage().contains("mcp:my-server~"),
                "the refusal must name the canonical suggestion: " + nonCanonical.getMessage());

        assertThrows(CpApiException.class, () -> pattern.resolve(write, "mcp:__system__"),
                "a built-in gateway id is not a grantable server");
    }
}
