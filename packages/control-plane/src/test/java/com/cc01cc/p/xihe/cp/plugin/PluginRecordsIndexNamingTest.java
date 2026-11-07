package com.cc01cc.p.xihe.cp.plugin;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0691 T2.2: the naming contract that makes index cleanup recoverable.
 *
 * <p>Why a separate unit test rather than an assertion inside the PostgreSQL test: these are the
 * properties the recovery path <i>reasons</i> from, and they must be checked without a database so a
 * failure names the property, not a container error.</p>
 *
 * <ul>
 *   <li><b>Determinism</b> — same identity ⇒ same name. A retried install must not accumulate
 *       parallel indexes for one declaration.</li>
 *   <li><b>Discrimination</b> — a changed binding/collection/index ⇒ a different name, so two
 *       declarations can never share one physical index through truncation or a short hash.</li>
 *   <li><b>Recomputability</b> — the name is a function of exactly the three ledger key columns
 *       (DP-3), so {@code DROP INDEX IF EXISTS} can be derived from a ledger row after a crash.</li>
 *   <li><b>Fail-closed grammar</b> — a non-manifest-legal segment is rejected, never escaped: an
 *       identifier cannot be a bind parameter, so the only safe options are "validated" or "refused".
 *       </li>
 * </ul>
 */
class PluginRecordsIndexNamingTest {

    private static final UUID BINDING = UUID.fromString("11111111-2222-3333-4444-555555555555");
    private static final UUID OTHER_BINDING =
            UUID.fromString("66666666-7777-8888-9999-aaaaaaaaaaaa");

    @Test
    void theSameIdentityAlwaysYieldsTheSameName() {
        String first = PluginIndexNaming.physicalName(BINDING, "contacts", "by_email");
        String second = PluginIndexNaming.physicalName(BINDING, "contacts", "by_email");
        assertEquals(first, second, "index naming must be deterministic across calls");
        assertTrue(first.startsWith(PluginIndexNaming.PREFIX),
                "the name must carry the plugin-index namespace prefix: " + first);
    }

    @Test
    void aDifferentIdentityYieldsADifferentName() {
        String base = PluginIndexNaming.physicalName(BINDING, "contacts", "by_email");
        assertNotEquals(base,
                PluginIndexNaming.physicalName(OTHER_BINDING, "contacts", "by_email"),
                "two bindings must not share one physical index");
        assertNotEquals(base,
                PluginIndexNaming.physicalName(BINDING, "notes", "by_email"),
                "two collections must not share one physical index");
        assertNotEquals(base,
                PluginIndexNaming.physicalName(BINDING, "contacts", "by_phone"),
                "two declarations must not share one physical index");
    }

    @Test
    void theNameFitsTheServerIdentifierLimitEvenForTheLongestLegalSegments() {
        // The schema caps each segment at 32 chars; 32 + 32 would overflow the 63-byte identifier
        // limit, so the truncation path is not hypothetical.
        String collection = "c" + "o".repeat(31);
        String index = "i" + "n".repeat(31);
        String name = PluginIndexNaming.physicalName(BINDING, collection, index);
        assertTrue(name.length() <= PluginIndexNaming.MAX_IDENTIFIER,
                "identifier must fit NAMEDATALEN-1, got " + name.length() + ": " + name);
        // Truncation must not collapse two different long declarations onto one name: the hash
        // carries the full identity even when the readable part is cut.
        assertNotEquals(name, PluginIndexNaming.physicalName(BINDING, collection,
                index.substring(0, index.length() - 1) + "x"));
    }

    @Test
    void theNameIsRecomputableFromLedgerColumnsAlone() {
        // A ledger row is (binding_id, collection, index_name) — DP-3's primary key. Nothing else is
        // available during cleanup, so nothing else may participate in the name.
        UUID bindingId = UUID.randomUUID();
        String collection = "contacts";
        String indexName = "by_email";
        String created = PluginIndexNaming.physicalName(bindingId, collection, indexName);

        UUID recomputedFromLedgerRow = bindingId;
        assertEquals(created,
                PluginIndexNaming.physicalName(recomputedFromLedgerRow, collection, indexName),
                "cleanup recomputes the name from the ledger row, so the inputs must be exactly the"
                        + " ledger key columns");
    }

    @Test
    void anIllegalSegmentIsRejectedInsteadOfEscaped() {
        // Identifiers cannot be bound as statement parameters, so anything outside the manifest
        // grammar (spec/manifest.schema.json: ^[a-z][a-z0-9_]{0,31}$) must never reach DDL.
        for (String illegal : List.of("Upper", "1leading", "has-dash", "semi;drop", "",
                "a".repeat(33), "with space")) {
            assertFalse(PluginIndexNaming.isSafeSegment(illegal),
                    "must refuse illegal segment: " + illegal);
        }
        assertThrows(IllegalArgumentException.class,
                () -> PluginIndexNaming.physicalName(BINDING, "contacts", "by email"),
                "an illegal index name must throw instead of being spliced into DDL");
        assertThrows(IllegalArgumentException.class,
                () -> PluginIndexNaming.physicalName(BINDING, "Contacts", "by_email"),
                "an illegal collection must throw as well");
    }

    @Test
    void onlyADeclarableShapeMayReachTheExecutor() {
        assertTrue(PluginIndexNaming.isDeclarable(
                new PluginIndexDeclaration("contacts", "by_email", List.of("email"), false)));
        assertFalse(PluginIndexNaming.isDeclarable(
                        new PluginIndexDeclaration("contacts", "by_email", List.of(), false)),
                "an index with no fields is not installable");
        assertFalse(PluginIndexNaming.isDeclarable(new PluginIndexDeclaration("contacts",
                        "by_email", List.of("a", "b", "c", "d", "e"), false)),
                "QUOTA-8 caps an index at 4 fields");
        assertFalse(PluginIndexNaming.isDeclarable(new PluginIndexDeclaration("contacts",
                        "by_email", List.of("Email"), false)),
                "a non-grammar field name must be refused");
    }

    @Test
    void manifestProjectionReadsOnlyDeclaredIndexes() {
        ObjectMapper mapper = new ObjectMapper();
        ObjectNode manifest = mapper.createObjectNode();
        ArrayNode collections = manifest.putObject("storage").putArray("collections");
        ObjectNode contacts = collections.addObject();
        contacts.put("name", "contacts");
        contacts.putArray("fields").add("email");
        ObjectNode byEmail = contacts.putArray("indexes").addObject();
        byEmail.put("name", "by_email");
        byEmail.putArray("fields").add("email");
        byEmail.put("unique", true);
        ObjectNode notes = collections.addObject();
        notes.put("name", "notes");
        notes.putArray("fields").add("title");
        notes.putArray("indexes");

        List<PluginIndexDeclaration> declarations = PluginIndexDeclaration.from(manifest);
        assertEquals(1, declarations.size(),
                "only indexes that are actually declared become declarations");
        PluginIndexDeclaration declaration = declarations.get(0);
        assertEquals("contacts", declaration.collection());
        assertEquals("by_email", declaration.name());
        assertEquals(List.of("email"), declaration.fields());
        assertTrue(declaration.unique(), "the unique flag must survive the projection");
        assertEquals(List.of(), PluginIndexDeclaration.from(mapper.createObjectNode()),
                "a manifest without storage declares no indexes");
    }
}
