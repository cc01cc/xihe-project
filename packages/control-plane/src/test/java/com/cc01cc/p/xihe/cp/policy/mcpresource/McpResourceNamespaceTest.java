package com.cc01cc.p.xihe.cp.policy.mcpresource;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.cc01cc.p.xihe.cp.policy.ResourceNamespaces;
import com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry;
import org.junit.jupiter.api.Test;

/**
 * task-870 / D-1921: the {@code mcp:} namespace row, canonicalization, and the channel-gate rule.
 *
 * <p>The gate must not be implied by {@code *}: every preset (including every agent preset) holds
 * {@code write@*}, so if a bare wildcard covered {@code mcp:<id>} the per-server default would be
 * decorative.</p>
 */
class McpResourceNamespaceTest {

    private static final String SERVER_UUID = "11111111-1111-4111-8111-111111111111";

    @Test
    void registryDeclaresMcpAsAnExactGrantableNamespace() {
        assertEquals(ResourceNamespaces.Matcher.EXACT,
                ResourceNamespaces.matcherOf("mcp:" + SERVER_UUID));
        assertEquals(ResourceNamespaces.Grantability.GRANTABLE,
                ResourceNamespaces.grantabilityOf("mcp:" + SERVER_UUID));
        assertEquals(ResourceNamespaces.Grantability.GRANTABLE,
                ResourceNamespaces.grantabilityOf(ResourceNamespaces.MCP_WILDCARD));
        assertFalse(ResourceNamespaces.isPathResource("mcp:" + SERVER_UUID),
                "a server id is an identity, never a filesystem path");
        assertTrue(ResourceNamespaces.isPathResource("fs:" + SERVER_UUID + "/src"));
        assertTrue(ResourceNamespaces.isPathResource("notes/today.md"));
    }

    @Test
    void uuidServerIdsAreCanonicalAndStable() {
        assertEquals(SERVER_UUID, ResourceNamespaces.canonicalMcpServerId(SERVER_UUID));
        assertEquals(SERVER_UUID,
                ResourceNamespaces.canonicalMcpServerId("  " + SERVER_UUID.toUpperCase() + "  "));
        assertEquals("mcp:" + SERVER_UUID,
                ResourceNamespaces.mcpServerResource(SERVER_UUID));
    }

    @Test
    void nonUuidIdsBecomeIdempotentStableSlugs() {
        // An already-canonical key is returned unchanged, so the write face can accept what the
        // listing shows without a second transformation.
        assertEquals("github", ResourceNamespaces.canonicalMcpServerId("github"));
        assertEquals("github", ResourceNamespaces.canonicalMcpServerId(" GitHub "));
        assertEquals("github", ResourceNamespaces.canonicalMcpServerId("github"));

        // A lossy reduction gets the hash suffix. Same raw -> same id; different raw that would
        // otherwise collapse to the same slug stays distinct.
        String spaced = ResourceNamespaces.canonicalMcpServerId("My Server");
        String dashed = ResourceNamespaces.canonicalMcpServerId("my-server");
        assertEquals(spaced, ResourceNamespaces.canonicalMcpServerId("My Server"),
                "canonicalization must be deterministic");
        assertNotEquals(spaced, dashed,
                "a lossy slug must not collide with a naturally dashed key");
        assertTrue(spaced.startsWith("my-server~"), spaced);
        assertEquals(spaced, ResourceNamespaces.canonicalMcpServerId(spaced),
                "the function must be idempotent");
    }

    @Test
    void builtInGatewayIdsAreNeverResources() {
        assertTrue(ResourceNamespaces.isBuiltinMcpServerId("__system__"));
        assertTrue(ResourceNamespaces.isBuiltinMcpServerId("__cp__"));
        assertNull(ResourceNamespaces.mcpServerResource("__system__"));
        assertNull(ResourceNamespaces.mcpServerResource("__cp__"));
        assertFalse(ResourceNamespaces.isBuiltinMcpServerId("github"));
    }

    @Test
    void theChannelGateRequiresAnExplicitMcpCeiling() {
        assertTrue(ToolFaceRegistry.resourceCovers("write", ResourceNamespaces.MCP_WILDCARD,
                "mcp:github"));
        assertTrue(ToolFaceRegistry.resourceCovers("write", "mcp:github", "mcp:github"));
        assertFalse(ToolFaceRegistry.resourceCovers("write", "mcp:github", "mcp:other"),
                "EXACT does not prefix-match");
        assertFalse(ToolFaceRegistry.resourceCovers("write", "*", "mcp:github"),
                "a bare wildcard must not imply the MCP channel");
        assertFalse(ToolFaceRegistry.resourceCovers("write", "fs:" + SERVER_UUID, "mcp:github"),
                "a path ceiling must not imply the MCP channel");

        assertFalse(ResourceNamespaces.matches(ResourceNamespaces.Matcher.EXACT, "*", "mcp:github"),
                "the registry matcher repeats the same rule for direct callers");
    }
}
