package com.cc01cc.p.xihe.cp.plugin;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0691 T1.4 L0: the resolution table — which binding states may call, which runtime kinds are
 * servable, and where each denial lands in the frozen code set. Pure JUnit, no Spring, no database,
 * no network: the resolver is a judgement function over (registry row, binding facts).
 */
class PluginConnectorResolverTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String DIGEST = "sha256:" + "b".repeat(64);
    private static final String ENDPOINT = "https://mcp.internal.test/plugin/v1";

    private final PluginConnectorResolver resolver = new PluginConnectorResolver();

    @Test
    void remoteHttpBindingResolvesEndpointNamespaceAndSchemaDefaults() {
        Plugin plugin = httpPlugin("official.kv-selftest", null);

        PluginConnectorResolver.Decision decision =
                resolver.resolve(plugin, facts(PluginConnectorResolver.STATE_ENABLED), "user-1", "req-1");

        assertEquals(PluginConnectorResolver.Kind.REMOTE_MCP_HTTP, decision.kind());
        assertTrue(decision.allowed());
        assertNull(decision.denial());
        assertEquals(ENDPOINT, decision.endpoint());
        assertEquals("plugin_official_kv-selftest", decision.namespace());
        assertEquals(PluginConnectorResolver.DEFAULT_TIMEOUT_MS, decision.timeoutMs());
        assertEquals(PluginConnectorResolver.DEFAULT_MAX_CONCURRENCY, decision.maxConcurrency());
        assertEquals("binding-1", decision.provenance().bindingId());
        assertEquals("req-1", decision.provenance().requestId());
    }

    @Test
    void unknownPluginRowIsNotFoundRatherThanForbidden() {
        PluginConnectorResolver.Decision decision = resolver.resolve(
                null, facts(PluginConnectorResolver.STATE_ENABLED), "user-1", "");

        assertEquals(PluginConnectorResolver.Kind.DENIED, decision.kind());
        assertEquals(PluginProvenance.DenialCode.PLUGIN_NOT_FOUND.statusCode(),
                decision.denial().status());
        assertEquals("PLUGIN_NOT_FOUND", decision.denial().code());
        assertEquals("p.one", decision.denial().extra().get("pluginId"));
        assertThrows(CpApiException.class, decision::requireAllowed);
    }

    @Test
    void bindingPinnedToAnotherDigestIsNotFoundBecauseThatRowIsGone() {
        Plugin plugin = httpPlugin("p.one", null);
        PluginConnectorResolver.BindingFacts stale = new PluginConnectorResolver.BindingFacts(
                "binding-1", "p.one", "sha256:" + "c".repeat(64),
                PluginConnectorResolver.STATE_ENABLED, "ws-1", List.of("plugin:invoke"));

        PluginConnectorResolver.Decision decision = resolver.resolve(plugin, stale, "", "");

        assertEquals("PLUGIN_NOT_FOUND", decision.denial().code());
        assertEquals(404, decision.denial().status());
    }

    @Test
    void disabledPluginAndEveryNonCallableBindingStateAreInactive() {
        Plugin enabled = httpPlugin("p.one", null);
        Plugin disabled = httpPlugin("p.one", null);
        disabled.setState(Plugin.STATE_DISABLED);

        assertEquals("plugin p.one is disabled",
                resolver.resolve(disabled, facts(PluginConnectorResolver.STATE_ENABLED), "", "")
                        .denial().detail());
        for (String state : List.of(PluginConnectorResolver.STATE_PENDING,
                PluginConnectorResolver.STATE_SUSPENDED, PluginConnectorResolver.STATE_DISABLED)) {
            PluginConnectorResolver.Decision decision = resolver.resolve(enabled, facts(state), "", "");
            assertEquals(403, decision.denial().status(), state + " must be 403");
            assertEquals("PLUGIN_BINDING_INACTIVE", decision.denial().code());
            assertEquals("binding is " + state, decision.denial().detail());
        }
        // Unknown future state fails closed instead of falling back to "callable".
        assertEquals("PLUGIN_BINDING_INACTIVE",
                resolver.resolve(enabled, facts("quarantined"), "", "").denial().code());
    }

    @Test
    void degradedBindingStaysCallable() {
        PluginConnectorResolver.Decision decision = resolver.resolve(
                httpPlugin("p.one", null), facts(PluginConnectorResolver.STATE_DEGRADED), "", "");

        assertTrue(decision.allowed(), "degraded is a health signal, not a lock");
    }

    @Test
    void missingInvokeAtomIsGrantDenied() {
        PluginConnectorResolver.Decision none = resolver.resolve(
                httpPlugin("p.one", null),
                new PluginConnectorResolver.BindingFacts("binding-1", "p.one", DIGEST,
                        PluginConnectorResolver.STATE_ENABLED, "ws-1", List.of()),
                "", "");
        PluginConnectorResolver.Decision otherAtom = resolver.resolve(
                httpPlugin("p.one", null),
                new PluginConnectorResolver.BindingFacts("binding-1", "p.one", DIGEST,
                        PluginConnectorResolver.STATE_ENABLED, "ws-1", List.of("plugin:data")),
                "", "");

        assertEquals("PLUGIN_GRANT_DENIED", none.denial().code());
        assertEquals(403, none.denial().status());
        assertEquals("PLUGIN_GRANT_DENIED", otherAtom.denial().code());
        assertTrue(none.denial().detail().contains("plugin:invoke"));
    }

    @Test
    void stdioPluginIsValidButUnavailableUntilM2() {
        Plugin stdio = stdioPlugin("p.stdio");
        PluginConnectorResolver.Decision unavailable = resolver.resolve(
                stdio, facts(PluginConnectorResolver.STATE_ENABLED), "", "");

        assertEquals(PluginConnectorResolver.Kind.UNAVAILABLE, unavailable.kind());
        assertFalse(unavailable.allowed());
        assertNull(unavailable.denial(), "a valid manifest is not a denial");
        assertEquals(PluginConnectorResolver.UNAVAILABLE_RUNNER_PENDING_M2,
                unavailable.unavailableReason());

        PluginConnectorResolver.Decision withRunner = new PluginConnectorResolver(true).resolve(
                stdio, facts(PluginConnectorResolver.STATE_ENABLED), "", "");
        assertEquals(PluginConnectorResolver.Kind.LOCAL_STDIO_RUNNER, withRunner.kind());
        assertEquals("node", withRunner.command());
        assertNull(withRunner.endpoint());
    }

    @Test
    void missingOrUnknownRuntimeKindIsAManifestFault() {
        Plugin noRuntime = new Plugin("p.one", DIGEST, "1.0.0", Plugin.SOURCE_THIRD_PARTY,
                MAPPER.createObjectNode());
        noRuntime.setState(Plugin.STATE_ENABLED);
        ObjectNode websocket = MAPPER.createObjectNode();
        websocket.putObject("runtime").put("kind", "mcp-ws");
        Plugin unknown = new Plugin("p.one", DIGEST, "1.0.0", Plugin.SOURCE_THIRD_PARTY, websocket);
        unknown.setState(Plugin.STATE_ENABLED);

        for (Plugin plugin : List.of(noRuntime, unknown)) {
            PluginConnectorResolver.Decision decision =
                    resolver.resolve(plugin, facts(PluginConnectorResolver.STATE_ENABLED), "", "");
            assertEquals("PLUGIN_MANIFEST_INVALID", decision.denial().code());
            assertEquals(422, decision.denial().status());
        }
    }

    @Test
    void malformedEndpointIsAManifestFault() {
        for (String endpoint : List.of("ftp://host/mcp", "http://", "http://a b/c",
                "https://" + "x".repeat(PluginConnectorResolver.ENDPOINT_MAX_CHARS))) {
            PluginConnectorResolver.Decision decision = resolver.resolve(
                    httpPlugin("p.one", endpoint),
                    facts(PluginConnectorResolver.STATE_ENABLED), "", "");
            assertEquals("PLUGIN_MANIFEST_INVALID", decision.denial().code(), endpoint);
            assertTrue(decision.denial().detail().contains("runtime.endpoint"));
        }
        assertTrue(PluginConnectorResolver.validEndpoint("http://127.0.0.1:8080/mcp"));
        assertFalse(PluginConnectorResolver.validEndpoint(null));
    }

    @Test
    void limitsAreClampedIntoTheFrozenSchemaBounds() {
        assertEquals(new PluginConnectorResolver.Limits(1000, 1),
                PluginConnectorResolver.limits(manifest(0, 0)));
        assertEquals(new PluginConnectorResolver.Limits(60000, 32),
                PluginConnectorResolver.limits(manifest(120000, 99)));
        assertEquals(new PluginConnectorResolver.Limits(7000, 8),
                PluginConnectorResolver.limits(manifest(7000, 8)));
        assertEquals(new PluginConnectorResolver.Limits(
                        PluginConnectorResolver.DEFAULT_TIMEOUT_MS,
                        PluginConnectorResolver.DEFAULT_MAX_CONCURRENCY),
                PluginConnectorResolver.limits(MAPPER.createObjectNode()));
        assertEquals(new PluginConnectorResolver.Limits(
                        PluginConnectorResolver.DEFAULT_TIMEOUT_MS,
                        PluginConnectorResolver.DEFAULT_MAX_CONCURRENCY),
                PluginConnectorResolver.limits(null));
    }

    @Test
    void namespaceIsLowercasedSanitizedAndCapped() {
        assertEquals("plugin_official_kv-selftest",
                PluginConnectorResolver.namespace("official.kv-selftest"));
        assertEquals("plugin_plugin_a_b", PluginConnectorResolver.namespace("Plugin A.B"));
        assertEquals("plugin_", PluginConnectorResolver.namespace(null));

        String longId = "x".repeat(120);
        String namespace = PluginConnectorResolver.namespace(longId);
        assertEquals(PluginConnectorResolver.NAMESPACE_PREFIX.length()
                        + PluginConnectorResolver.NAMESPACE_ID_MAX_CHARS,
                namespace.length());
        assertTrue(namespace.startsWith(PluginConnectorResolver.NAMESPACE_PREFIX));
    }

    @Test
    void bindingFactsNormalizeAtomsAndRejectBlankIdentity() {
        PluginConnectorResolver.BindingFacts facts = new PluginConnectorResolver.BindingFacts(
                "binding-1", "p.one", DIGEST, PluginConnectorResolver.STATE_ENABLED, null, null);

        assertEquals(List.of(), facts.effectiveAtoms());
        assertEquals("", facts.workspaceId());
        assertThrows(IllegalArgumentException.class, () -> new PluginConnectorResolver.BindingFacts(
                "", "p.one", DIGEST, PluginConnectorResolver.STATE_ENABLED, "ws-1", null));
        assertThrows(IllegalArgumentException.class, () -> new PluginConnectorResolver.BindingFacts(
                "binding-1", "p.one", DIGEST, " ", "ws-1", null));
    }

    private static PluginConnectorResolver.BindingFacts facts(String state) {
        return new PluginConnectorResolver.BindingFacts("binding-1", "p.one", DIGEST, state,
                "ws-1", List.of(PluginConnectorResolver.ATOM_INVOKE));
    }

    private static Plugin httpPlugin(String id, String endpoint) {
        ObjectNode manifest = MAPPER.createObjectNode();
        manifest.putObject("runtime")
                .put("kind", PluginConnectorResolver.KIND_MCP_HTTP)
                .put("endpoint", endpoint == null ? ENDPOINT : endpoint);
        Plugin plugin = new Plugin(id, DIGEST, "1.0.0", Plugin.SOURCE_BUILTIN, manifest);
        plugin.setState(Plugin.STATE_ENABLED);
        return plugin;
    }

    private static Plugin stdioPlugin(String id) {
        ObjectNode manifest = MAPPER.createObjectNode();
        manifest.putObject("runtime")
                .put("kind", PluginConnectorResolver.KIND_MCP_STDIO)
                .put("command", "node");
        Plugin plugin = new Plugin(id, DIGEST, "1.0.0", Plugin.SOURCE_THIRD_PARTY, manifest);
        plugin.setState(Plugin.STATE_ENABLED);
        return plugin;
    }

    private static ObjectNode manifest(int timeoutMs, int maxConcurrency) {
        ObjectNode manifest = MAPPER.createObjectNode();
        manifest.putObject("limits")
                .put("timeoutMs", timeoutMs)
                .put("maxConcurrency", maxConcurrency);
        return manifest;
    }
}
