package com.cc01cc.p.xihe.cp.plugin;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import org.springframework.http.HttpStatus;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * PLAN-0691 T1.4: the frozen identity of one plugin binding surface — "which plugin version,
 * bound where, on whose behalf".
 *
 * <p>Two disjoint projections on purpose:</p>
 *
 * <ul>
 *   <li>{@link #wireFields()} — exactly {@code pluginId/version/digest}, the three keys
 *       `spec/cross-layer-matrix.md` L44 adds to {@code GET /api/v1/mcp} {@code tools/list} items.
 *       It must stay a plain scalar projection: the binding id and the acting principal are
 *       control-plane facts, not client facts, and no Jackson-2 {@code JsonNode} may ever leave
 *       (PLAN-0633 C1).</li>
 *   <li>{@link #auditFields()} — {@code bindingId} + {@code actor} for {@code audit_logs}. Only
 *       identifiers: never arguments, never tool results, never a credential (DEV-004 / CP
 *       AGENTS "Policy、audit 记录不得写入原始 arguments").</li>
 * </ul>
 *
 * <p>{@link DenialCode} is a verbatim copy of the frozen code set in
 * {@code plans/PLAN-0691-XH-plugin-mechanism/spec/data-plane.md} API-11 — this class adds
 * <b>no</b> new code. The 412 pair is carried here so T1.5 (KV CAS) reuses one table instead of
 * re-declaring it; the connector face itself only ever emits the 403/404/422 members.</p>
 */
public record PluginProvenance(
        String pluginId,
        String version,
        String digest,
        String bindingId,
        String actor,
        String requestId) {

    /** Characters of {@code digest} kept in log lines; the full digest stays in audit fields. */
    public static final int DIGEST_SHORT_CHARS = 12;

    public PluginProvenance {
        pluginId = requireText(pluginId, "pluginId");
        version = requireText(version, "version");
        digest = requireText(digest, "digest");
        bindingId = requireText(bindingId, "bindingId");
        actor = actor == null ? "" : actor;
        requestId = requestId == null ? "" : requestId;
    }

    /** Projects one registry row; {@code bindingId} comes from the binding, not from the row. */
    public static PluginProvenance of(Plugin plugin, String bindingId, String actor, String requestId) {
        Objects.requireNonNull(plugin, "plugin");
        return new PluginProvenance(plugin.getId(), plugin.getVersion(), plugin.getDigest(),
                bindingId, actor, requestId);
    }

    /** The three keys allowed on the wire (cross-layer matrix L44). Never more. */
    public Map<String, Object> wireFields() {
        Map<String, Object> fields = new LinkedHashMap<>();
        fields.put("pluginId", pluginId);
        fields.put("version", version);
        fields.put("digest", digest);
        return fields;
    }

    /** Structured audit columns; identifiers only. */
    public Map<String, Object> auditFields() {
        Map<String, Object> fields = new LinkedHashMap<>();
        fields.put("pluginId", pluginId);
        fields.put("pluginVersion", version);
        fields.put("pluginDigest", digest);
        fields.put("bindingId", bindingId);
        if (!actor.isEmpty()) {
            fields.put("actor", actor);
        }
        return fields;
    }

    /** Short digest for log lines — never the tool arguments and never a credential. */
    public String digestShort() {
        return digest.length() <= DIGEST_SHORT_CHARS ? digest : digest.substring(0, DIGEST_SHORT_CHARS);
    }

    /** Wraps one frozen code into a problem-shaped denial carrying this provenance. */
    public Denial deny(DenialCode code, String detail) {
        Objects.requireNonNull(code, "code");
        Map<String, Object> extra = auditFields();
        if (!requestId.isEmpty()) {
            extra.put("requestId", requestId);
        }
        return new Denial(code.status(), code.name(), detail, extra);
    }

    private static String requireText(String value, String name) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(name + " is required");
        }
        return value;
    }

    /**
     * One denial fact: frozen code + HTTP status + detail + problem-details extras, already in the
     * shape {@link CpApiException} carries. Holds no provenance object on purpose — a missing
     * plugin row has no version/digest to project, yet still has to be denied with
     * {@code PLUGIN_NOT_FOUND}.
     */
    public record Denial(HttpStatus httpStatus, String code, String detail,
                         Map<String, Object> extra) {

        public Denial {
            Objects.requireNonNull(httpStatus, "httpStatus");
            code = requireText(code, "code");
            detail = detail == null || detail.isBlank() ? code : detail;
            extra = extra == null ? Map.of() : Collections.unmodifiableMap(new LinkedHashMap<>(extra));
        }

        public int status() {
            return httpStatus.value();
        }

        /** The single conversion point into the project's RFC 9457 error carrier. */
        public CpApiException toException() {
            CpApiException error = new CpApiException(httpStatus, code, detail);
            return error.withExtra(extra);
        }
    }

    /**
     * Frozen plugin error codes (data-plane.md API-11). Status numbers are pinned by tests so a
     * silent re-classification cannot slip through.
     */
    public enum DenialCode {

        PLUGIN_NOT_FOUND(404),
        PLUGIN_BINDING_INACTIVE(403),
        PLUGIN_GRANT_DENIED(403),
        PLUGIN_MANIFEST_INVALID(422),
        /** T1.5 KV CAS: existing key written without {@code If-Match}. */
        PLUGIN_PRECONDITION_REQUIRED(412),
        /** T1.5 KV CAS: {@code If-Match} does not match the current version. */
        PLUGIN_PRECONDITION_FAILED(412);

        private final int status;

        DenialCode(int status) {
            this.status = status;
        }

        public HttpStatus status() {
            return HttpStatus.valueOf(status);
        }

        public int statusCode() {
            return status;
        }
    }
}
