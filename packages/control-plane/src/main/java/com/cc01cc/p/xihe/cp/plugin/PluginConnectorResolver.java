package com.cc01cc.p.xihe.cp.plugin;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.regex.Pattern;

/**
 * PLAN-0691 T1.4: decides <em>whether</em> and <em>how</em> one plugin binding may reach its
 * declared runtime — the pure judgement half of the remote MCP connector adapter.
 *
 * <p>Everything here is frozen contract, nothing is invented:</p>
 *
 * <ul>
 *   <li>runtime shape — {@code spec/manifest.schema.json} {@code $defs/mcpHttp}
 *       ({@code kind=mcp-http}, {@code endpoint}) and {@code $defs/mcpStdio}
 *       ({@code kind=mcp-stdio}, {@code command}); any other {@code kind} is a manifest fault
 *       ({@code 422 PLUGIN_MANIFEST_INVALID}).</li>
 *   <li>limits — same file {@code $defs/limits}: {@code timeoutMs} 1000..60000 default 5000,
 *       {@code maxConcurrency} 1..32 default 4. The install-time validator already enforces them;
 *       the clamp here is defence in depth for rows written before that validator existed.</li>
 *   <li>binding states — {@code spec/data-plane.md} SEC-2, lowercase
 *       {@code pending|enabled|degraded|suspended|disabled}; anything but {@code enabled}/
 *       {@code degraded} is {@code 403 PLUGIN_BINDING_INACTIVE}.</li>
 *   <li>invocation atom — {@code spec/authz-plugin-atoms.md} {@code plugin:invoke}. The atom set
 *       itself is T1.3's output; this class only consumes it.</li>
 * </ul>
 *
 * <p>No IO, no Spring, no database: the resolver takes the registry row plus the binding facts and
 * returns a {@link Decision}. {@code pending}/{@code suspended}/{@code disabled} bindings are
 * denied here, which is the read-side half of D-62 (a global disable takes effect at the
 * invocation point; in-flight runs keep their snapshot).</p>
 */
public class PluginConnectorResolver {

    /** {@code $defs/limits.timeoutMs}: default / inclusive bounds. */
    public static final int DEFAULT_TIMEOUT_MS = 5000;
    public static final int MIN_TIMEOUT_MS = 1000;
    public static final int MAX_TIMEOUT_MS = 60000;
    /** {@code $defs/limits.maxConcurrency}: default / inclusive bounds. */
    public static final int DEFAULT_MAX_CONCURRENCY = 4;
    public static final int MIN_MAX_CONCURRENCY = 1;
    public static final int MAX_MAX_CONCURRENCY = 32;

    /** {@code $defs/mcpHttp} / {@code $defs/mcpStdio} discriminators. */
    public static final String KIND_MCP_HTTP = "mcp-http";
    public static final String KIND_MCP_STDIO = "mcp-stdio";
    /** {@code $defs/mcpHttp.endpoint}: {@code ^https?://[^\s]+$}, maxLength 512. */
    public static final int ENDPOINT_MAX_CHARS = 512;
    private static final Pattern ENDPOINT_PATTERN = Pattern.compile("^https?://\\S+$");

    /** {@code spec/data-plane.md} SEC-2 binding state vocabulary (authoritative, lowercase). */
    public static final String STATE_PENDING = "pending";
    public static final String STATE_ENABLED = "enabled";
    public static final String STATE_DEGRADED = "degraded";
    public static final String STATE_SUSPENDED = "suspended";
    public static final String STATE_DISABLED = "disabled";

    /** {@code spec/authz-plugin-atoms.md}: the only atom that opens a plugin tool surface. */
    public static final String ATOM_INVOKE = "plugin:invoke";

    /** Namespace prefix for plugin tools, so they can never collide with {@code backend__tool}. */
    public static final String NAMESPACE_PREFIX = "plugin_";
    /**
     * Longest id segment kept in the namespace. {@code plugin_} + 48 + {@code __} + a 64-char tool
     * name stays inside the 128-char MCP tool-name budget.
     */
    public static final int NAMESPACE_ID_MAX_CHARS = 48;
    private static final Pattern NAMESPACE_UNSAFE = Pattern.compile("[^a-z0-9_-]");

    /** M2 (local stdio runner) is not delivered: recorded as a reason, never as a new wire code. */
    public static final String UNAVAILABLE_RUNNER_PENDING_M2 = "runner_pending_m2";

    private final boolean runnerAvailable;

    public PluginConnectorResolver() {
        this(false);
    }

    /**
     * @param runnerAvailable whether the local {@code mcp-stdio} runner exists in this build; it
     *     stays {@code false} until M2 delivers the Runtime-managed process host.
     */
    public PluginConnectorResolver(boolean runnerAvailable) {
        this.runnerAvailable = runnerAvailable;
    }

    /** Binding facts as the (not yet delivered) T1.2 store will expose them. */
    public record BindingFacts(
            String bindingId,
            String pluginId,
            String digest,
            String state,
            String workspaceId,
            List<String> effectiveAtoms) {

        public BindingFacts {
            bindingId = requireText(bindingId, "bindingId");
            pluginId = requireText(pluginId, "pluginId");
            digest = requireText(digest, "digest");
            state = requireText(state, "state");
            workspaceId = workspaceId == null ? "" : workspaceId;
            effectiveAtoms = effectiveAtoms == null ? List.of() : List.copyOf(effectiveAtoms);
        }

        public boolean callableState() {
            return STATE_ENABLED.equals(state) || STATE_DEGRADED.equals(state);
        }

        public boolean grantsInvoke() {
            return effectiveAtoms.contains(ATOM_INVOKE);
        }
    }

    /** What the connector may do for this binding. */
    public enum Kind {
        /** {@code mcp-http}: CP forwards to the declared endpoint. */
        REMOTE_MCP_HTTP,
        /** {@code mcp-stdio}: local runner, M2. */
        LOCAL_STDIO_RUNNER,
        /** Valid manifest, capability not delivered in this build — not a caller error. */
        UNAVAILABLE,
        /** Denied: {@link Decision#denial()} says why. */
        DENIED
    }

    /**
     * One resolution outcome. Exactly one of {@code denial} / {@code unavailableReason} is set for
     * the two non-callable kinds; {@code endpoint} is set only for {@link Kind#REMOTE_MCP_HTTP} and
     * {@code command} only for {@link Kind#LOCAL_STDIO_RUNNER}.
     */
    public record Decision(
            Kind kind,
            PluginProvenance provenance,
            String endpoint,
            String command,
            String namespace,
            int timeoutMs,
            int maxConcurrency,
            PluginProvenance.Denial denial,
            String unavailableReason) {

        public Decision {
            Objects.requireNonNull(kind, "kind");
        }

        static Decision remote(PluginProvenance provenance, String endpoint, String namespace,
                int timeoutMs, int maxConcurrency) {
            return new Decision(Kind.REMOTE_MCP_HTTP, provenance, endpoint, null, namespace,
                    timeoutMs, maxConcurrency, null, null);
        }

        static Decision localRunner(PluginProvenance provenance, String command, String namespace,
                int timeoutMs, int maxConcurrency) {
            return new Decision(Kind.LOCAL_STDIO_RUNNER, provenance, null, command, namespace,
                    timeoutMs, maxConcurrency, null, null);
        }

        static Decision unavailable(PluginProvenance provenance, String namespace, String reason,
                int timeoutMs, int maxConcurrency) {
            return new Decision(Kind.UNAVAILABLE, provenance, null, null, namespace,
                    timeoutMs, maxConcurrency, null, reason);
        }

        static Decision denied(PluginProvenance provenance, PluginProvenance.Denial denial) {
            return new Decision(Kind.DENIED, provenance, null, null, null, 0, 0, denial, null);
        }

        public boolean allowed() {
            return kind == Kind.REMOTE_MCP_HTTP || kind == Kind.LOCAL_STDIO_RUNNER;
        }

        /** Throws the problem-shaped denial; {@link Kind#UNAVAILABLE} is not a denial. */
        public Decision requireAllowed() {
            if (denial != null) {
                throw denial.toException();
            }
            return this;
        }
    }

    /**
     * Resolves one invocation attempt.
     *
     * @param plugin the current registry row, or {@code null} when the id is not installed
     * @param binding the binding facts (T1.2 shape)
     * @param actor the acting principal for the audit projection; may be empty
     * @param requestId the request correlation id; may be empty
     */
    public Decision resolve(Plugin plugin, BindingFacts binding, String actor, String requestId) {
        Objects.requireNonNull(binding, "binding");
        if (plugin == null) {
            return Decision.denied(null, pluginMissing(binding));
        }
        PluginProvenance provenance =
                PluginProvenance.of(plugin, binding.bindingId(), actor, requestId);
        if (!binding.digest().equals(plugin.getDigest())) {
            // The binding pins a version row; if that row is gone, the surface is gone too.
            return Decision.denied(provenance, pluginMissing(binding));
        }
        if (!Plugin.STATE_ENABLED.equals(plugin.getState())) {
            return Decision.denied(provenance, provenance.deny(
                    PluginProvenance.DenialCode.PLUGIN_BINDING_INACTIVE,
                    "plugin " + plugin.getId() + " is " + plugin.getState()));
        }
        if (!binding.callableState()) {
            return Decision.denied(provenance, provenance.deny(
                    PluginProvenance.DenialCode.PLUGIN_BINDING_INACTIVE,
                    "binding is " + binding.state()));
        }
        if (!binding.grantsInvoke()) {
            return Decision.denied(provenance, provenance.deny(
                    PluginProvenance.DenialCode.PLUGIN_GRANT_DENIED,
                    ATOM_INVOKE + " is not granted to this binding"));
        }

        JsonNode manifest = plugin.getManifest();
        Limits limits = limits(manifest);
        String namespace = namespace(plugin.getId());
        JsonNode runtime = manifest == null ? null : manifest.path("runtime");
        String kind = runtime != null && runtime.isObject() ? runtime.path("kind").asText("") : "";
        if (KIND_MCP_HTTP.equals(kind)) {
            String endpoint = runtime.path("endpoint").asText("");
            if (!validEndpoint(endpoint)) {
                return Decision.denied(provenance, provenance.deny(
                        PluginProvenance.DenialCode.PLUGIN_MANIFEST_INVALID,
                        "runtime.endpoint must be an http(s) URL of at most "
                                + ENDPOINT_MAX_CHARS + " characters"));
            }
            return Decision.remote(provenance, endpoint, namespace,
                    limits.timeoutMs(), limits.maxConcurrency());
        }
        if (KIND_MCP_STDIO.equals(kind)) {
            String command = runtime.path("command").asText("");
            if (command.isBlank()) {
                return Decision.denied(provenance, provenance.deny(
                        PluginProvenance.DenialCode.PLUGIN_MANIFEST_INVALID,
                        "runtime.command is required for " + KIND_MCP_STDIO));
            }
            if (!runnerAvailable) {
                return Decision.unavailable(provenance, namespace, UNAVAILABLE_RUNNER_PENDING_M2,
                        limits.timeoutMs(), limits.maxConcurrency());
            }
            return Decision.localRunner(provenance, command, namespace,
                    limits.timeoutMs(), limits.maxConcurrency());
        }
        return Decision.denied(provenance, provenance.deny(
                PluginProvenance.DenialCode.PLUGIN_MANIFEST_INVALID,
                "runtime.kind must be " + KIND_MCP_HTTP + " or " + KIND_MCP_STDIO));
    }

    /** Effective limits after clamp; defaults come from the frozen schema. */
    public static Limits limits(JsonNode manifest) {
        JsonNode node = manifest == null ? null : manifest.path("limits");
        int timeoutMs = clamp(
                node != null && node.isObject() ? node.path("timeoutMs").asInt(DEFAULT_TIMEOUT_MS)
                        : DEFAULT_TIMEOUT_MS,
                MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
        int maxConcurrency = clamp(
                node != null && node.isObject()
                        ? node.path("maxConcurrency").asInt(DEFAULT_MAX_CONCURRENCY)
                        : DEFAULT_MAX_CONCURRENCY,
                MIN_MAX_CONCURRENCY, MAX_MAX_CONCURRENCY);
        return new Limits(timeoutMs, maxConcurrency);
    }

    /** Clamped {@code timeoutMs} / {@code maxConcurrency} pair. */
    public record Limits(int timeoutMs, int maxConcurrency) {
    }

    /**
     * Sticky tool namespace for a plugin id: {@code plugin_<id>} with everything outside
     * {@code [a-z0-9_-]} folded to {@code _} and the id segment capped at
     * {@value #NAMESPACE_ID_MAX_CHARS} characters.
     */
    public static String namespace(String pluginId) {
        String raw = pluginId == null ? "" : pluginId.toLowerCase(Locale.ROOT);
        String normalized = NAMESPACE_UNSAFE.matcher(raw).replaceAll("_");
        if (normalized.length() > NAMESPACE_ID_MAX_CHARS) {
            normalized = normalized.substring(0, NAMESPACE_ID_MAX_CHARS);
        }
        return NAMESPACE_PREFIX + normalized;
    }

    /** {@code $defs/mcpHttp.endpoint} pattern, applied again because rows outlive validators. */
    public static boolean validEndpoint(String endpoint) {
        return endpoint != null
                && !endpoint.isEmpty()
                && endpoint.length() <= ENDPOINT_MAX_CHARS
                && ENDPOINT_PATTERN.matcher(endpoint).matches();
    }

    private static PluginProvenance.Denial pluginMissing(BindingFacts binding) {
        return new PluginProvenance.Denial(
                PluginProvenance.DenialCode.PLUGIN_NOT_FOUND.status(),
                PluginProvenance.DenialCode.PLUGIN_NOT_FOUND.name(),
                "plugin " + binding.pluginId() + " is not installed at digest " + binding.digest(),
                Map.of(
                        "pluginId", binding.pluginId(),
                        "bindingId", binding.bindingId(),
                        "digest", binding.digest()));
    }

    private static int clamp(int value, int min, int max) {
        return Math.min(max, Math.max(min, value));
    }

    private static String requireText(String value, String name) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(name + " is required");
        }
        return value;
    }
}
