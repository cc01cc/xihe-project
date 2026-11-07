package com.cc01cc.p.xihe.cp.plugin;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.http.HttpTimeoutException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeoutException;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0691 T1.4 L0: the connector adapter. The integration itself (a real remote MCP round trip)
 * is {@code [待窗口]} — PLAN-0681's connection layer is not delivered — so this suite pins what the
 * adapter <em>decides</em>: namespace, limits, credential request shape, frozen denials, and the
 * failure classification shared with the MCP proxy. The transport is a test-local fake; nothing
 * fake is wired into {@code src/main}.
 */
class PluginRemoteConnectorTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String DIGEST = "sha256:" + "d".repeat(64);
    private static final String ENDPOINT = "https://mcp.internal.test/plugin/v1";

    private final PluginRemoteConnector connector = new PluginRemoteConnector();

    @Test
    void planBuildsStickyNamespaceLimitsAndCredentialRequest() {
        PluginRemoteConnector.CallIntent intent =
                connector.plan(httpPlugin(), facts(PluginConnectorResolver.STATE_ENABLED),
                        "user-1", "req-1");

        assertEquals("binding-1", intent.bindingId());
        assertEquals(ENDPOINT, intent.endpoint());
        assertEquals("p.one", intent.provenance().pluginId());
        assertEquals(PluginConnectorResolver.DEFAULT_TIMEOUT_MS, intent.timeoutMs());
        assertEquals(PluginConnectorResolver.DEFAULT_MAX_CONCURRENCY, intent.maxConcurrency());
        assertEquals(List.of("plugin:invoke"), intent.effectiveAtoms());
        assertEquals("plugin_p_one__echo", intent.toolName("echo"));
        assertEquals("plugin_p_one", intent.namespace(),
                "namespace is the same backend__tool prefix the proxy already speaks");

        PluginRemoteConnector.CredentialRequest credential = intent.credential();
        assertEquals(PluginRemoteConnector.CREDENTIAL_TTL_SECONDS, credential.ttlSeconds());
        assertEquals(300, credential.ttlSeconds(), "data-plane.md SEC-1 pins the TTL at 300s");
        assertEquals("Authorization", credential.headerName());
        assertEquals("Bearer", credential.scheme());
        assertEquals("plugin-connector", credential.audience());
        assertEquals(4, credential.claims().size());
        assertEquals("binding-1", credential.claims().get("binding_id"));
        assertEquals("p.one", credential.claims().get("plugin_id"));
        assertEquals(DIGEST, credential.claims().get("digest"));
        assertEquals("plugin:invoke", credential.claims().get("scope"));
        assertEquals(1_700_000_300L, credential.expiresAt(1_700_000_000L),
                "exp is derived by the minter from issuedAt + 300s");
    }

    @Test
    void auditProjectionKeepsTheEndpointHostOnly() {
        PluginRemoteConnector.CallIntent intent =
                connector.plan(httpPlugin(), facts(PluginConnectorResolver.STATE_ENABLED), "", "");

        Map<String, Object> audit = intent.auditFields();
        assertEquals("mcp.internal.test", audit.get("endpointHost"));
        assertFalse(((String) audit.get("endpointHost")).contains("/"),
                "audit carries the host, not the full path or query");
        assertEquals(PluginConnectorResolver.DEFAULT_TIMEOUT_MS, audit.get("timeoutMs"));
        assertEquals("binding-1", audit.get("bindingId"));
        assertFalse(audit.containsKey("credential"));
    }

    @Test
    void planSurfacesTheFrozenDenialInsteadOfInventingOne() {
        CpApiException error = assertThrows(CpApiException.class,
                () -> connector.plan(httpPlugin(), facts(PluginConnectorResolver.STATE_SUSPENDED),
                        "", ""));

        assertEquals(HttpStatus.FORBIDDEN, error.getStatus());
        assertEquals("PLUGIN_BINDING_INACTIVE", error.getCode());
        assertEquals("binding is suspended", error.getMessage());
    }

    @Test
    void planReportsStdioAsUnavailableNotAsADenial() {
        CpApiException error = assertThrows(CpApiException.class,
                () -> connector.plan(stdioPlugin(), facts(PluginConnectorResolver.STATE_ENABLED),
                        "", ""));

        assertEquals(HttpStatus.BAD_GATEWAY, error.getStatus(),
                "a valid manifest this build cannot serve is not a 4xx caller error");
        assertEquals(PluginRemoteConnector.CODE_TOOLS_UNAVAILABLE, error.getCode());
        assertEquals(PluginConnectorResolver.UNAVAILABLE_RUNNER_PENDING_M2,
                error.getExtra().get("reason"));
        assertTrue(error.getMessage().contains("M2"));
    }

    @Test
    void planRefusesStdioEvenWhenTheRunnerFlagIsOnBecauseTheIntentIsRemoteOnly() {
        PluginRemoteConnector withRunner =
                new PluginRemoteConnector(new PluginConnectorResolver(true));

        CpApiException error = assertThrows(CpApiException.class, () -> withRunner.plan(
                stdioPlugin(), facts(PluginConnectorResolver.STATE_ENABLED), "", ""));

        assertEquals(PluginRemoteConnector.CODE_TOOLS_UNAVAILABLE, error.getCode(),
                "M2 stdio credentials/runner wiring is not frozen yet, so no intent is produced");
    }

    @Test
    void requestKeepsTheNamespaceAndRejectsAlienToolNames() {
        PluginRemoteConnector.CallIntent intent = connector.plan(httpPlugin(),
                facts(PluginConnectorResolver.STATE_ENABLED), "", "");
        ObjectNode arguments = MAPPER.createObjectNode().put("text", "hi");

        PluginRemoteConnector.CallRequest request = connector.request(intent, "selftest.echo", arguments);

        assertEquals("plugin_p_one__selftest.echo", request.toolName());
        assertEquals(intent, request.intent());
        assertEquals(arguments, request.arguments());
        assertThrows(IllegalArgumentException.class,
                () -> new PluginRemoteConnector.CallRequest(intent, "runtime__read_file", arguments));
        assertThrows(IllegalArgumentException.class, () -> intent.toolName(" "));
    }

    @Test
    void invokePassesThroughAndClassifiesEveryThrownFailure() {
        PluginRemoteConnector.CallIntent intent = connector.plan(httpPlugin(),
                facts(PluginConnectorResolver.STATE_ENABLED), "", "");
        PluginRemoteConnector.CallRequest request =
                connector.request(intent, "echo", MAPPER.createObjectNode());
        ObjectNode result = MAPPER.createObjectNode().put("content", "ok");

        List<PluginRemoteConnector.CallRequest> seen = new ArrayList<>();
        PluginRemoteConnector.Outcome ok = connector.invoke(call -> {
            seen.add(call);
            return PluginRemoteConnector.Outcome.success(result);
        }, request);
        assertTrue(ok.ok());
        assertEquals(result, ok.result());
        assertEquals(List.of(request), seen);

        PluginRemoteConnector.Outcome timedOut = connector.invoke(call -> {
            throw new UncheckedIOException(new HttpTimeoutException("read timed out"));
        }, request);
        assertFalse(timedOut.ok());
        assertEquals(PluginRemoteConnector.Failure.REASON_TIMEOUT, timedOut.failure().reason());
        assertTrue(timedOut.failure().retryable());

        PluginRemoteConnector.Outcome refused = connector.invoke(call -> {
            throw new UncheckedIOException(new IOException("connection reset"));
        }, request);
        assertEquals(PluginRemoteConnector.Failure.REASON_UNREACHABLE,
                refused.failure().reason());

        PluginRemoteConnector.Outcome nullOutcome = connector.invoke(call -> null, request);
        assertEquals(PluginRemoteConnector.Failure.REASON_UPSTREAM_ERROR,
                nullOutcome.failure().reason(), "a null outcome is a contract violation, not an ok");
    }

    @Test
    void failureClassifiesStatusesExactlyLikeTheMcpProxy() {
        assertEquals(PluginRemoteConnector.Failure.REASON_AUTH_FAILED,
                PluginRemoteConnector.Failure.ofStatus(401).reason());
        assertEquals(PluginRemoteConnector.Failure.REASON_AUTH_FAILED,
                PluginRemoteConnector.Failure.ofStatus(403).reason());
        assertFalse(PluginRemoteConnector.Failure.ofStatus(403).retryable(),
                "a broken credential is not retried");
        assertEquals(PluginRemoteConnector.Failure.REASON_TIMEOUT,
                PluginRemoteConnector.Failure.ofStatus(408).reason());
        assertEquals(PluginRemoteConnector.Failure.REASON_TIMEOUT,
                PluginRemoteConnector.Failure.ofStatus(504).reason());
        assertTrue(PluginRemoteConnector.Failure.ofStatus(504).retryable());
        assertEquals(PluginRemoteConnector.Failure.REASON_UPSTREAM_ERROR,
                PluginRemoteConnector.Failure.ofStatus(502).reason());
        assertTrue(PluginRemoteConnector.Failure.ofStatus(502).retryable());
        assertFalse(PluginRemoteConnector.Failure.ofStatus(404).retryable());
        assertEquals(404, PluginRemoteConnector.Failure.ofStatus(404).upstreamStatus());
    }

    @Test
    void failureClassifiesTransportFaultsAsTimeoutOrUnreachable() {
        assertEquals(PluginRemoteConnector.Failure.REASON_TIMEOUT,
                PluginRemoteConnector.Failure.ofTransport(new HttpTimeoutException("t")).reason());
        assertEquals(PluginRemoteConnector.Failure.REASON_TIMEOUT,
                PluginRemoteConnector.Failure.ofTransport(new TimeoutException("t")).reason());
        assertEquals(PluginRemoteConnector.Failure.REASON_UNREACHABLE,
                PluginRemoteConnector.Failure.ofTransport(new IllegalStateException("reset")).reason());
        assertNull(PluginRemoteConnector.Failure.ofTransport(
                new IllegalStateException("reset")).upstreamStatus());
        assertThrows(NullPointerException.class,
                () -> PluginRemoteConnector.Failure.ofTransport(null));
    }

    @Test
    void everyClassifiedFailureCountsTowardTheBreakerAndTheVocabularyIsPinned() {
        assertEquals("auth_failed", PluginRemoteConnector.Failure.REASON_AUTH_FAILED);
        assertEquals("timeout", PluginRemoteConnector.Failure.REASON_TIMEOUT);
        assertEquals("unreachable", PluginRemoteConnector.Failure.REASON_UNREACHABLE);
        assertEquals("upstream_error", PluginRemoteConnector.Failure.REASON_UPSTREAM_ERROR);
        assertTrue(PluginRemoteConnector.Failure.ofStatus(500).countsTowardSuspend(),
                "QUOTA-12: 3 consecutive failures inside 300s suspend the binding");
        assertTrue(PluginRemoteConnector.Failure.ofStatus(401).countsTowardSuspend());
        assertThrows(IllegalArgumentException.class,
                () -> new PluginRemoteConnector.Failure(" ", true, null));
    }

    @Test
    void outcomeHoldsExactlyOneOfResultOrFailure() {
        ObjectNode result = MAPPER.createObjectNode();

        assertThrows(IllegalArgumentException.class,
                () -> new PluginRemoteConnector.Outcome(null, null));
        assertThrows(IllegalArgumentException.class,
                () -> new PluginRemoteConnector.Outcome(result,
                        new PluginRemoteConnector.Failure("timeout", true, null)));
        assertThrows(NullPointerException.class, () -> PluginRemoteConnector.Outcome.success(null));
        assertTrue(PluginRemoteConnector.Outcome.success(result).ok());
    }

    @Test
    void intentRefusesLimitsOutsideTheFrozenBounds() {
        assertThrows(IllegalArgumentException.class, () -> intent(999, 4));
        assertThrows(IllegalArgumentException.class, () -> intent(60001, 4));
        assertThrows(IllegalArgumentException.class, () -> intent(5000, 0));
        assertThrows(IllegalArgumentException.class, () -> intent(5000, 33));
        assertEquals(32, intent(1000, 32).maxConcurrency());
    }

    @Test
    void credentialRequestCarriesIdentifiersOnlyAndNeverASecret() {
        PluginProvenance provenance =
                new PluginProvenance("p.one", "1.0.0", DIGEST, "binding-1", "user-1", "req-1");

        PluginRemoteConnector.CredentialRequest credential =
                PluginRemoteConnector.credentialRequest(provenance);

        assertEquals(List.of("binding_id", "plugin_id", "digest", "scope"),
                List.copyOf(credential.claims().keySet()));
        for (String forbidden : List.of("exp", "secret", "token", "authorization", "password")) {
            assertFalse(credential.claims().containsKey(forbidden));
        }
        assertTrue(credential.claims().values().stream().noneMatch(value -> value.isBlank()));
        assertEquals(300, credential.ttlSeconds());
        assertThrows(IllegalArgumentException.class,
                () -> new PluginRemoteConnector.CredentialRequest("Authorization", "Bearer",
                        "plugin-connector", 0, Map.of()));
    }

    private static PluginRemoteConnector.CallIntent intent(int timeoutMs, int maxConcurrency) {
        PluginProvenance provenance =
                new PluginProvenance("p.one", "1.0.0", DIGEST, "binding-1", "user-1", "req-1");
        return new PluginRemoteConnector.CallIntent("binding-1", provenance, ENDPOINT,
                "plugin_p_one", timeoutMs, maxConcurrency, List.of("plugin:invoke"),
                PluginRemoteConnector.credentialRequest(provenance));
    }

    private static PluginConnectorResolver.BindingFacts facts(String state) {
        return new PluginConnectorResolver.BindingFacts("binding-1", "p.one", DIGEST, state,
                "ws-1", List.of(PluginConnectorResolver.ATOM_INVOKE));
    }

    private static Plugin httpPlugin() {
        ObjectNode manifest = MAPPER.createObjectNode();
        manifest.putObject("runtime")
                .put("kind", PluginConnectorResolver.KIND_MCP_HTTP)
                .put("endpoint", ENDPOINT);
        Plugin plugin = new Plugin("p.one", DIGEST, "1.0.0", Plugin.SOURCE_BUILTIN, manifest);
        plugin.setState(Plugin.STATE_ENABLED);
        return plugin;
    }

    private static Plugin stdioPlugin() {
        ObjectNode manifest = MAPPER.createObjectNode();
        manifest.putObject("runtime")
                .put("kind", PluginConnectorResolver.KIND_MCP_STDIO)
                .put("command", "node");
        Plugin plugin = new Plugin("p.one", DIGEST, "1.0.0", Plugin.SOURCE_THIRD_PARTY, manifest);
        plugin.setState(Plugin.STATE_ENABLED);
        return plugin;
    }
}
