package com.cc01cc.p.xihe.cp.plugin;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.mcp.ToolNameRewriter;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.http.HttpStatus;

import java.io.UncheckedIOException;
import java.net.http.HttpTimeoutException;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.TimeoutException;

/**
 * PLAN-0691 T1.4: the remote MCP connector adapter — turns one plugin binding into a ready-to-send
 * invocation intent, and classifies what comes back.
 *
 * <p>Three things are deliberately <b>reused</b> rather than re-invented:</p>
 *
 * <ul>
 *   <li><b>namespace</b> — {@link ToolNameRewriter} ({@code serverId__tool}), the very class
 *       {@code McpProxyController} uses; a plugin tool is {@code plugin_<id>__<tool>}, so the
 *       existing {@code tools/list} merge, sticky alias and {@code tools/call} echo rules apply
 *       unchanged ("wire 形状与 id 回显规则不变", cross-layer matrix).</li>
 *   <li><b>failure vocabulary</b> — {@code auth_failed / timeout / unreachable / upstream_error}
 *       with a {@code retryable} flag, copied verbatim from
 *       {@code McpProxyController#classifyUpstreamStatus} / {@code #classifyTransportFailure}
 *       so a plugin failure lands in the same buckets the proxy already logs and diagnoses.</li>
 *   <li><b>error codes</b> — {@link PluginProvenance.DenialCode} only. No new code is invented;
 *       the not-yet-delivered M2 runner reuses {@code MCP_TOOLS_UNAVAILABLE}.</li>
 * </ul>
 *
 * <p>The actual HTTP call is <b>not</b> here: {@link Transport} is the seam for the connection
 * layer (PLAN-0681 / T1.6). Nothing in {@code src/main} implements it — a fake implementation in
 * the production path would fake the very integration this task must not claim. Tests supply
 * their own, which also proves the classification without touching a network.</p>
 *
 * <p>Short-lived credentials follow {@code spec/data-plane.md} SEC-1: {@code 300}s TTL and claims
 * {@code binding_id/plugin_id/digest/scope}. This class produces the <b>request</b> for such a
 * token ({@link CredentialRequest}); minting belongs to T1.5, and no secret ever appears in
 * {@link CallIntent} (B-5: CP injects the connector secret, the plugin only sees a short-lived
 * credential).</p>
 */
public class PluginRemoteConnector {

    /** {@code spec/data-plane.md} SEC-1: binding scoped service token TTL. */
    public static final int CREDENTIAL_TTL_SECONDS = 300;
    public static final String CREDENTIAL_HEADER = "Authorization";
    public static final String CREDENTIAL_SCHEME = "Bearer";
    public static final String CREDENTIAL_AUDIENCE = "plugin-connector";
    public static final String CLAIM_BINDING_ID = "binding_id";
    public static final String CLAIM_PLUGIN_ID = "plugin_id";
    public static final String CLAIM_DIGEST = "digest";
    public static final String CLAIM_SCOPE = "scope";
    public static final String CLAIM_EXP = "exp";

    /** Reused from the MCP proxy (frozen by tests); M2 runner is the only current producer. */
    public static final String CODE_TOOLS_UNAVAILABLE = "MCP_TOOLS_UNAVAILABLE";

    private final PluginConnectorResolver resolver;
    private final ToolNameRewriter names;

    public PluginRemoteConnector() {
        this(new PluginConnectorResolver(), new ToolNameRewriter());
    }

    public PluginRemoteConnector(PluginConnectorResolver resolver) {
        this(resolver, new ToolNameRewriter());
    }

    public PluginRemoteConnector(PluginConnectorResolver resolver, ToolNameRewriter names) {
        this.resolver = Objects.requireNonNull(resolver, "resolver");
        this.names = Objects.requireNonNull(names, "names");
    }

    /**
     * Resolves one binding into a call intent.
     *
     * @throws CpApiException the frozen denial (403/404/422) when the binding may not be used, or
     *     {@code 502 MCP_TOOLS_UNAVAILABLE} when the manifest is valid but this build cannot serve
     *     it yet ({@code mcp-stdio}, M2)
     */
    public CallIntent plan(Plugin plugin, PluginConnectorResolver.BindingFacts binding,
            String actor, String requestId) {
        PluginConnectorResolver.Decision decision =
                resolver.resolve(plugin, binding, actor, requestId);
        decision.requireAllowed();
        if (decision.kind() != PluginConnectorResolver.Kind.REMOTE_MCP_HTTP) {
            throw unavailable(decision);
        }
        PluginProvenance provenance = decision.provenance();
        return new CallIntent(
                provenance.bindingId(),
                provenance,
                decision.endpoint(),
                decision.namespace(),
                decision.timeoutMs(),
                decision.maxConcurrency(),
                binding.effectiveAtoms(),
                credentialRequest(provenance));
    }

    /** Builds the wire-level call from an intent; the tool name keeps the sticky namespace. */
    public CallRequest request(CallIntent intent, String declaredTool, JsonNode arguments) {
        Objects.requireNonNull(intent, "intent");
        return new CallRequest(intent, names.addPrefix(intent.namespace(), declaredTool), arguments);
    }

    /**
     * Runs one invocation through the transport and classifies any thrown failure. A transport that
     * returns {@code null} is a contract violation and is reported as {@code upstream_error}
     * instead of leaking a {@link NullPointerException}.
     */
    public Outcome invoke(Transport transport, CallRequest request) {
        Objects.requireNonNull(transport, "transport");
        Objects.requireNonNull(request, "request");
        try {
            Outcome outcome = transport.invoke(request);
            if (outcome != null) {
                return outcome;
            }
            return Outcome.failed(new Failure(Failure.REASON_UPSTREAM_ERROR, true, null));
        } catch (RuntimeException e) {
            return Outcome.failed(Failure.ofTransport(e));
        }
    }

    /**
     * Credential request for one binding. {@code exp} is not a claim here: the minter derives it as
     * {@code issuedAt + ttlSeconds} (SEC-1: 300s, binding scoped only — a global
     * {@code ROLE_INTERNAL_SERVICE} token must never be used for this face).
     */
    public static CredentialRequest credentialRequest(PluginProvenance provenance) {
        Map<String, String> claims = new LinkedHashMap<>();
        claims.put(CLAIM_BINDING_ID, provenance.bindingId());
        claims.put(CLAIM_PLUGIN_ID, provenance.pluginId());
        claims.put(CLAIM_DIGEST, provenance.digest());
        claims.put(CLAIM_SCOPE, PluginConnectorResolver.ATOM_INVOKE);
        return new CredentialRequest(CREDENTIAL_HEADER, CREDENTIAL_SCHEME, CREDENTIAL_AUDIENCE,
                CREDENTIAL_TTL_SECONDS, claims);
    }

    /**
     * 502 for "valid plugin, capability not delivered in this build" — not a caller error, so it
     * must not be a 4xx ({@code mcp-stdio} until M2 delivers the local runner).
     */
    private static CpApiException unavailable(PluginConnectorResolver.Decision decision) {
        String reason = decision.unavailableReason() == null
                ? PluginConnectorResolver.UNAVAILABLE_RUNNER_PENDING_M2
                : decision.unavailableReason();
        String detail = PluginConnectorResolver.UNAVAILABLE_RUNNER_PENDING_M2.equals(reason)
                ? "plugin " + decision.provenance().pluginId()
                        + " needs the local stdio runner, which is not delivered yet (M2)"
                : "plugin " + decision.provenance().pluginId() + " is unavailable: " + reason;
        Map<String, Object> extra = decision.provenance().auditFields();
        extra.put("reason", reason);
        return new CpApiException(HttpStatus.BAD_GATEWAY, CODE_TOOLS_UNAVAILABLE, detail)
                .withExtra(extra);
    }

    /** One resolved remote invocation: endpoint, sticky namespace, limits and credential request. */
    public record CallIntent(
            String bindingId,
            PluginProvenance provenance,
            String endpoint,
            String namespace,
            int timeoutMs,
            int maxConcurrency,
            List<String> effectiveAtoms,
            CredentialRequest credential) {

        private static final ToolNameRewriter REWRITER = new ToolNameRewriter();

        public CallIntent {
            Objects.requireNonNull(provenance, "provenance");
            endpoint = requireText(endpoint, "endpoint");
            namespace = requireText(namespace, "namespace");
            if (timeoutMs < PluginConnectorResolver.MIN_TIMEOUT_MS
                    || timeoutMs > PluginConnectorResolver.MAX_TIMEOUT_MS) {
                throw new IllegalArgumentException("timeoutMs out of range: " + timeoutMs);
            }
            if (maxConcurrency < PluginConnectorResolver.MIN_MAX_CONCURRENCY
                    || maxConcurrency > PluginConnectorResolver.MAX_MAX_CONCURRENCY) {
                throw new IllegalArgumentException(
                        "maxConcurrency out of range: " + maxConcurrency);
            }
            Objects.requireNonNull(credential, "credential");
            effectiveAtoms = effectiveAtoms == null ? List.of() : List.copyOf(effectiveAtoms);
        }

        /** Namespaced tool name, identical to the proxy's {@code backend__tool} convention. */
        public String toolName(String declaredTool) {
            return REWRITER.addPrefix(namespace, requireText(declaredTool, "declaredTool"));
        }

        /** Audit projection: identifiers only, never arguments and never a credential value. */
        public Map<String, Object> auditFields() {
            Map<String, Object> fields = provenance.auditFields();
            fields.put("endpointHost", hostOf(endpoint));
            fields.put("timeoutMs", timeoutMs);
            return fields;
        }
    }

    /** Transport-level call: immutable, no secret, no credential value. */
    public record CallRequest(CallIntent intent, String toolName, JsonNode arguments) {

        public CallRequest {
            Objects.requireNonNull(intent, "intent");
            toolName = requireText(toolName, "toolName");
            if (!toolName.startsWith(intent.namespace() + "__")) {
                throw new IllegalArgumentException(
                        "toolName must be namespaced under " + intent.namespace());
            }
        }
    }

    /**
     * What a credential minter needs (T1.5). Holds claim <em>names</em> and non-secret values only.
     */
    public record CredentialRequest(
            String headerName,
            String scheme,
            String audience,
            int ttlSeconds,
            Map<String, String> claims) {

        public CredentialRequest {
            headerName = requireText(headerName, "headerName");
            scheme = requireText(scheme, "scheme");
            audience = requireText(audience, "audience");
            if (ttlSeconds <= 0) {
                throw new IllegalArgumentException("ttlSeconds must be positive");
            }
            Objects.requireNonNull(claims, "claims");
            // Insertion order is preserved on purpose: claim order must be deterministic so audit
            // logs and tests do not differ per JVM run (an immutable Map's order is unspecified).
            claims = Collections.unmodifiableMap(new LinkedHashMap<>(claims));
        }

        /** {@code exp} claim value the minter must set for a token issued at the given second. */
        public long expiresAt(long issuedAtEpochSecond) {
            return issuedAtEpochSecond + ttlSeconds;
        }
    }

    /** Connection-layer seam (PLAN-0681 / T1.6); no production implementation in T1.4. */
    public interface Transport {

        Outcome invoke(CallRequest request);
    }

    /** Result of one transport call: exactly one of {@code result} / {@code failure} is set. */
    public record Outcome(JsonNode result, Failure failure) {

        public Outcome {
            if ((result == null) == (failure == null)) {
                throw new IllegalArgumentException("exactly one of result/failure must be set");
            }
        }

        public static Outcome success(JsonNode result) {
            return new Outcome(Objects.requireNonNull(result, "result"), null);
        }

        public static Outcome failed(Failure failure) {
            return new Outcome(null, Objects.requireNonNull(failure, "failure"));
        }

        public boolean ok() {
            return failure == null;
        }
    }

    /**
     * Failure classification, same vocabulary and thresholds as the MCP proxy
     * ({@code McpProxyController:679-693}).
     */
    public record Failure(String reason, boolean retryable, Integer upstreamStatus) {

        public static final String REASON_AUTH_FAILED = "auth_failed";
        public static final String REASON_TIMEOUT = "timeout";
        public static final String REASON_UNREACHABLE = "unreachable";
        public static final String REASON_UPSTREAM_ERROR = "upstream_error";

        public Failure {
            reason = requireText(reason, "reason");
        }

        /**
         * Non-2xx from the remote endpoint: {@code 401/403} is a credential fault (never retried),
         * {@code 408/504} is a timeout, everything else is an upstream error (5xx retryable).
         */
        public static Failure ofStatus(int status) {
            if (status == 401 || status == 403) {
                return new Failure(REASON_AUTH_FAILED, false, status);
            }
            if (status == 408 || status == 504) {
                return new Failure(REASON_TIMEOUT, true, status);
            }
            return new Failure(REASON_UPSTREAM_ERROR, status >= 500, status);
        }

        /**
         * Transport faults are unreachable/timeout; never a caller error, always retryable. Checked
         * transport exceptions ({@link HttpTimeoutException} is an {@code IOException}) arrive
         * wrapped, so the wrapper is unwrapped once before classifying.
         */
        public static Failure ofTransport(Throwable error) {
            Objects.requireNonNull(error, "error");
            Throwable cause = error;
            if (cause instanceof UncheckedIOException && cause.getCause() != null) {
                cause = cause.getCause();
            }
            boolean timeout = cause instanceof HttpTimeoutException
                    || cause instanceof TimeoutException;
            return new Failure(timeout ? REASON_TIMEOUT : REASON_UNREACHABLE, true, null);
        }

        /**
         * Every classified failure is a binding-level fault, so it counts toward the QUOTA-12
         * breaker (3 consecutive failures within 300s → {@code suspended}). A tool-level error
         * never becomes a {@link Failure}: it is a successful invocation with {@code isError}.
         */
        public boolean countsTowardSuspend() {
            return true;
        }
    }

    private static String hostOf(String endpoint) {
        int schemeEnd = endpoint.indexOf("://");
        int start = schemeEnd < 0 ? 0 : schemeEnd + 3;
        int pathStart = endpoint.indexOf('/', start);
        return pathStart < 0 ? endpoint.substring(start) : endpoint.substring(start, pathStart);
    }

    private static String requireText(String value, String name) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(name + " is required");
        }
        return value;
    }
}
