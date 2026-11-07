package com.cc01cc.p.xihe.cp.plugin;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0691 T1.4 L0: the provenance projections. The load-bearing assertions are the wire/audit
 * split (only {@code pluginId/version/digest} may reach a client) and the pinned code↔status table
 * (data-plane.md API-11). Pure JUnit — no Spring, no database.
 */
class PluginProvenanceTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String DIGEST = "sha256:" + "a".repeat(64);

    @Test
    void projectsTheRegistryRowAndEmitsOnlyTheThreeWireKeys() {
        Plugin plugin = plugin("official.kv-selftest", DIGEST, Plugin.STATE_ENABLED);

        PluginProvenance provenance =
                PluginProvenance.of(plugin, "binding-1", "user-1", "req-1");

        assertEquals("official.kv-selftest", provenance.pluginId());
        assertEquals("1.0.0", provenance.version());
        assertEquals(DIGEST, provenance.digest());
        assertEquals("binding-1", provenance.bindingId());

        Map<String, Object> wire = provenance.wireFields();
        assertEquals(List.of("pluginId", "version", "digest"), List.copyOf(wire.keySet()),
                "tools/list provenance is exactly the three frozen keys, in order");
        assertEquals("official.kv-selftest", wire.get("pluginId"));
        assertFalse(wire.containsKey("bindingId"), "binding identity is a CP fact, not a client fact");
        assertFalse(wire.containsKey("actor"));
        assertFalse(wire.containsKey("requestId"));
    }

    @Test
    void auditFieldsCarryBindingAndActorButNeverRequestBodies() {
        PluginProvenance provenance =
                PluginProvenance.of(plugin("p.one", DIGEST, Plugin.STATE_ENABLED),
                        "binding-1", "agent-principal", "req-1");

        Map<String, Object> audit = provenance.auditFields();

        assertEquals("binding-1", audit.get("bindingId"));
        assertEquals("agent-principal", audit.get("actor"));
        assertEquals(DIGEST, audit.get("pluginDigest"));
        for (String forbidden : List.of("arguments", "payload", "result", "credential", "token")) {
            assertFalse(audit.containsKey(forbidden), "audit must not carry " + forbidden);
        }
    }

    @Test
    void emptyActorIsOmittedRatherThanWrittenAsNull() {
        PluginProvenance anonymous = new PluginProvenance("p.one", "1.0.0", DIGEST, "binding-1", null, null);

        assertEquals("", anonymous.actor());
        assertEquals("", anonymous.requestId());
        assertFalse(anonymous.auditFields().containsKey("actor"));
    }

    @Test
    void everyFrozenCodeKeepsItsStatusCodeAndName() {
        Map<PluginProvenance.DenialCode, Integer> expected = Map.of(
                PluginProvenance.DenialCode.PLUGIN_NOT_FOUND, 404,
                PluginProvenance.DenialCode.PLUGIN_BINDING_INACTIVE, 403,
                PluginProvenance.DenialCode.PLUGIN_GRANT_DENIED, 403,
                PluginProvenance.DenialCode.PLUGIN_MANIFEST_INVALID, 422,
                PluginProvenance.DenialCode.PLUGIN_PRECONDITION_REQUIRED, 412,
                PluginProvenance.DenialCode.PLUGIN_PRECONDITION_FAILED, 412);

        assertEquals(expected.size(), PluginProvenance.DenialCode.values().length,
                "no code may be added or removed without updating data-plane.md API-11");
        expected.forEach((code, status) -> {
            assertEquals(status.intValue(), code.statusCode());
            assertEquals(status.intValue(), code.status().value());
        });
    }

    @Test
    void denialConvertsToTheProblemCarrierWithIdentifierExtras() {
        PluginProvenance provenance =
                PluginProvenance.of(plugin("p.one", DIGEST, Plugin.STATE_ENABLED),
                        "binding-1", "user-1", "req-1");

        CpApiException error = provenance
                .deny(PluginProvenance.DenialCode.PLUGIN_BINDING_INACTIVE, "binding is suspended")
                .toException();

        assertEquals(HttpStatus.FORBIDDEN, error.getStatus());
        assertEquals("PLUGIN_BINDING_INACTIVE", error.getCode());
        assertEquals("binding is suspended", error.getMessage());
        assertEquals("binding-1", error.getExtra().get("bindingId"));
        assertEquals("p.one", error.getExtra().get("pluginId"));
        assertEquals("req-1", error.getExtra().get("requestId"));
    }

    @Test
    void denialDefaultsItsDetailToTheCode() {
        PluginProvenance provenance =
                PluginProvenance.of(plugin("p.one", DIGEST, Plugin.STATE_ENABLED), "b", "", "");

        PluginProvenance.Denial denial =
                provenance.deny(PluginProvenance.DenialCode.PLUGIN_GRANT_DENIED, "  ");

        assertEquals("PLUGIN_GRANT_DENIED", denial.detail());
        assertFalse(denial.extra().containsKey("requestId"),
                "an empty requestId must not become a problem field");
    }

    @Test
    void digestShortIsTwelveCharactersOrTheWholeDigest() {
        PluginProvenance longDigest =
                new PluginProvenance("p", "1.0.0", "0123456789abcdef0123", "b", "", "");
        PluginProvenance shortDigest = new PluginProvenance("p", "1.0.0", "abc", "b", "", "");

        assertEquals("0123456789ab", longDigest.digestShort());
        assertEquals("abc", shortDigest.digestShort());
    }

    @Test
    void blankIdentityIsRejectedAtConstruction() {
        assertThrows(IllegalArgumentException.class,
                () -> new PluginProvenance(" ", "1.0.0", DIGEST, "b", "", ""));
        assertThrows(IllegalArgumentException.class,
                () -> new PluginProvenance("p", null, DIGEST, "b", "", ""));
        assertThrows(IllegalArgumentException.class,
                () -> new PluginProvenance("p", "1.0.0", "", "b", "", ""));
        assertThrows(NullPointerException.class,
                () -> new PluginProvenance("p", "1.0.0", DIGEST, "b", "", "").deny(null, "x"));
    }

    private static Plugin plugin(String id, String digest, String state) {
        Plugin plugin = new Plugin(id, digest, "1.0.0", Plugin.SOURCE_BUILTIN,
                MAPPER.createObjectNode());
        plugin.setState(state);
        assertTrue(plugin.getManifest().isObject());
        return plugin;
    }
}
