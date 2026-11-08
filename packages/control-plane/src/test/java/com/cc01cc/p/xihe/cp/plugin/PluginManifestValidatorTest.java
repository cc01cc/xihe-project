package com.cc01cc.p.xihe.cp.plugin;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0691 T1.1 L0: the manifest validation chain (shape → cross-field → digest → source) and the
 * §3 canonical digest. Pure JUnit — no Spring, no database.
 */
class PluginManifestValidatorTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Test
    void builtinManifestPassesAndFillsQuotaDefaults() throws Exception {
        ObjectNode node = minimal("official.kv-selftest", "1.0.0", "builtin");
        PluginManifest manifest = PluginManifestValidator.validate(bytes(node), "builtin");

        assertEquals("official.kv-selftest", manifest.id());
        assertEquals("1.0.0", manifest.version());
        assertEquals("builtin", manifest.source());
        assertEquals("1", manifest.manifestVersion());
        assertEquals(1, manifest.actions().size());
        assertEquals("selftest.echo", manifest.actions().get(0).name());
        assertEquals("read", manifest.actions().get(0).actionClass());
        assertEquals(5000, manifest.limits().timeoutMs());
        assertEquals(4, manifest.limits().maxConcurrency());
        assertNotNull(node.get("digest"));
    }

    @Test
    void declaredSourceMustMatchThePackageDirectory() throws Exception {
        ObjectNode node = minimal("official.kv-selftest", "1.0.0", "third-party");
        CpApiException failure = assertThrows(CpApiException.class,
                () -> PluginManifestValidator.validate(bytes(node), "builtin"));
        assertEquals(PluginManifestValidator.ERROR_CODE, failure.getCode());
        assertEquals("source third-party does not match the package directory",
                failure.getMessage());
    }

    @Test
    void builtinPackageRequiresOfficialPrefix() throws Exception {
        ObjectNode node = minimal("com.example.demo", "1.0.0", "builtin");
        CpApiException failure = assertThrows(CpApiException.class,
                () -> PluginManifestValidator.validate(bytes(node), "builtin"));
        assertEquals("a builtin plugin id must start with official.", failure.getMessage());

        ObjectNode official = minimal("official.demo", "1.0.0", "third-party");
        CpApiException reserved = assertThrows(CpApiException.class,
                () -> PluginManifestValidator.validate(bytes(official), "third-party"));
        assertEquals("the official. prefix is reserved for builtin packages",
                reserved.getMessage());
    }

    @Test
    void unknownTopLevelFieldIsRejected() throws Exception {
        ObjectNode node = minimal("official.kv-selftest", "1.0.0", "builtin");
        node.put("surprise", true);
        CpApiException failure = assertThrows(CpApiException.class,
                () -> PluginManifestValidator.validate(bytes(node), "builtin"));
        assertEquals(PluginManifestValidator.ERROR_CODE, failure.getCode());
        assertTrue(failure.getMessage().contains("unknown field surprise"));
    }

    @Test
    void declaredDigestMustMatchCanonicalForm() throws Exception {
        ObjectNode node = minimal("official.kv-selftest", "1.0.0", "builtin");
        node.put("digest", "sha256:" + "f".repeat(64));
        CpApiException failure = assertThrows(CpApiException.class,
                () -> PluginManifestValidator.validate(bytes(node), "builtin"));
        assertTrue(failure.getMessage().startsWith("digest mismatch"));
    }

    @Test
    void digestIsOrderInsensitiveAndExcludesTopLevelDigest() throws Exception {
        ObjectNode first = minimal("official.kv-selftest", "1.0.0", "builtin");
        String digest = PluginManifestValidator.computeDigest(first);
        assertTrue(digest.matches("sha256:[a-f0-9]{64}"));

        // Same document, every field copied in reverse order and only the declared digest changed:
        // the canonical form must not depend on insertion order, and must ignore the digest itself.
        List<String> names = new ArrayList<>();
        first.fieldNames().forEachRemaining(names::add);
        Collections.reverse(names);
        ObjectNode reordered = MAPPER.createObjectNode();
        for (String name : names) {
            reordered.set(name, first.get(name).deepCopy());
        }
        reordered.put("digest", "sha256:" + "0".repeat(64));

        assertEquals(digest, PluginManifestValidator.computeDigest(reordered));
    }

    @Test
    void codePointOrderDiffersFromUtf16OrderForAstralKeys() {
        String astral = "\uD83D\uDE00";
        String bmpHigh = "\uFFFD";
        assertTrue(PluginManifestValidator.compareCodePoints(astral, bmpHigh) > 0);
        assertEquals(0, PluginManifestValidator.compareCodePoints("abc", "abc"));
    }

    @Test
    void duplicateActionNamesAreRejected() throws Exception {
        ObjectNode node = minimal("official.kv-selftest", "1.0.0", "builtin");
        ((ArrayNode) node.get("actions")).addObject().put("name", "selftest.echo")
                .put("actionClass", "read");
        node.put("digest", PluginManifestValidator.computeDigest(node));
        CpApiException failure = assertThrows(CpApiException.class,
                () -> PluginManifestValidator.validate(bytes(node), "builtin"));
        assertTrue(failure.getMessage().contains("action names must be unique"));
    }

    @Test
    void reservedActionPrefixIsRejected() throws Exception {
        ObjectNode node = minimal("official.kv-selftest", "1.0.0", "builtin");
        ((ObjectNode) node.get("actions").get(0)).put("name", "sys_secret");
        node.put("digest", PluginManifestValidator.computeDigest(node));
        CpApiException failure = assertThrows(CpApiException.class,
                () -> PluginManifestValidator.validate(bytes(node), "builtin"));
        assertTrue(failure.getMessage().contains("reserved prefix"));
    }

    @Test
    void tooManyRequestedAtomsAreRejected() throws Exception {
        ObjectNode node = minimal("official.kv-selftest", "1.0.0", "builtin");
        node.putArray("requestedAtoms").add("plugin:manage").add("plugin:bind")
                .add("plugin:invoke").add("plugin:data").add("plugin:data");
        node.put("digest", PluginManifestValidator.computeDigest(node));
        CpApiException failure = assertThrows(CpApiException.class,
                () -> PluginManifestValidator.validate(bytes(node), "builtin"));
        assertTrue(failure.getMessage().contains("requestedAtoms allows at most 4"));
    }

    @Test
    void oversizedManifestIsRejectedBeforeParsing() {
        CpApiException failure = assertThrows(CpApiException.class,
                () -> PluginManifestValidator.validate(new byte[262_145], "builtin"));
        assertTrue(failure.getMessage().contains("exceeds 262144 bytes"));
    }

    @Test
    void semverComparisonOnlyAcceptsStrictlyNewerVersions() {
        assertTrue(PluginManifestValidator.isNewerVersion("1.1.0", "1.0.0"));
        assertTrue(PluginManifestValidator.isNewerVersion("2.0.0", "1.99.99"));
        assertFalse(PluginManifestValidator.isNewerVersion("1.0.0", "1.0.0"));
        assertFalse(PluginManifestValidator.isNewerVersion("1.0.0", "1.0.1"));
    }

    // ------------------------------------------------------------------ fixtures

    /**
     * task-172 / PLAN-0691 §5.2: {@code storage.collections[].fields[]} carries
     * {@code {name, type}}, and the type reaches the index declaration from the collection — never
     * from the index (DP-3: the ledger keeps names, the manifest is the single type source).
     */
    @Test
    void collectionFieldsAcceptExactlyTheFourFrozenScalarTypes() throws Exception {
        ObjectNode node = minimal("official.kv-selftest", "1.0.0", "builtin");
        ObjectNode collection = storageCollection(node);
        ArrayNode fields = collection.putArray("fields");
        for (String type : List.of("string", "number", "boolean", "date")) {
            fields.addObject().put("name", "f_" + type).put("type", type);
        }
        collection.putArray("indexes").addObject().put("name", "by_kind")
                .putArray("fields").add("f_date");
        node.put("digest", PluginManifestValidator.computeDigest(node));

        PluginManifest manifest = PluginManifestValidator.validate(bytes(node), "builtin");

        List<PluginIndexDeclaration> declarations = PluginIndexDeclaration.from(manifest.raw());
        assertEquals(1, declarations.size());
        assertEquals(List.of(new PluginIndexDeclaration.DeclaredField("f_date", "date")),
                declarations.get(0).fields(),
                "the index's string field reference resolves to the declared type");
    }

    /** A type outside the frozen four has no cast, so it must be a 422 naming field and position. */
    @Test
    void aFieldTypeOutsideTheFrozenFourIsRefusedWithItsNameAndPosition() throws Exception {
        ObjectNode node = minimal("official.kv-selftest", "1.0.0", "builtin");
        ObjectNode collection = storageCollection(node);
        ArrayNode fields = collection.putArray("fields");
        fields.addObject().put("name", "status").put("type", "string");
        fields.addObject().put("name", "created_at").put("type", "text");
        node.put("digest", PluginManifestValidator.computeDigest(node));

        CpApiException failure = assertThrows(CpApiException.class,
                () -> PluginManifestValidator.validate(bytes(node), "builtin"));

        assertEquals(PluginManifestValidator.ERROR_CODE, failure.getCode());
        String detail = failure.getMessage();
        assertTrue(detail.contains("storage.collections[0].fields[1].type"),
                "the position of the refused declaration must be in the error: " + detail);
        assertTrue(detail.contains("created_at"),
                "the field name must be in the error: " + detail);
        assertTrue(detail.contains("text"), "and the refused value: " + detail);
    }

    /** The pre-§5.2 string form is not silently upgraded: it is refused, not guessed. */
    @Test
    void thePreTypeStringArrayFieldFormIsNoLongerAccepted() throws Exception {
        ObjectNode node = minimal("official.kv-selftest", "1.0.0", "builtin");
        ObjectNode collection = storageCollection(node);
        collection.putArray("fields").add("status");
        node.put("digest", PluginManifestValidator.computeDigest(node));

        CpApiException failure = assertThrows(CpApiException.class,
                () -> PluginManifestValidator.validate(bytes(node), "builtin"));

        String detail = failure.getMessage();
        assertTrue(detail.contains("storage.collections[0].fields[0]"),
                "the error must point at the first field entry: " + detail);
        assertTrue(detail.contains("must be an object with name and type"),
                "and must not invent a type for a bare string: " + detail);
    }

    /** {@code {"storage":{"collections":[{name, fields}]}}}, the shape task-172 validates. */
    private static ObjectNode storageCollection(ObjectNode manifest) {
        return manifest.putObject("storage").putArray("collections").addObject().put("name",
                "notes");
    }

    static ObjectNode minimal(String id, String version, String source) {
        ObjectNode node = MAPPER.createObjectNode();
        node.put("manifestVersion", "1");
        node.put("id", id);
        node.put("version", version);
        node.put("title", "KV selftest");
        if (source != null) {
            node.put("source", source);
        }
        node.putObject("runtime").put("kind", "mcp-http").put("endpoint",
                "https://plugins.example.test/mcp");
        node.putArray("actions").addObject().put("name", "selftest.echo").put("actionClass",
                "read");
        node.putArray("requestedAtoms").add("plugin:invoke");
        node.putObject("compatibility").put("xhApi", "1.4");
        node.put("digest", PluginManifestValidator.computeDigest(node));
        return node;
    }

    static byte[] bytes(ObjectNode node) throws Exception {
        return MAPPER.writeValueAsBytes(node);
    }

    static void assertNoDigestLeak(PluginManifest manifest) {
        assertNull(manifest.raw().get("nothing"));
    }
}
