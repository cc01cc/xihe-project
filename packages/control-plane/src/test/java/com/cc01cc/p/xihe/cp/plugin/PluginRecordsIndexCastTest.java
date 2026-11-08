package com.cc01cc.p.xihe.cp.plugin;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0691 task-172/203: the {@code fields[].type} → index-expression face, asserted as SQL <b>text</b>.
 *
 * <p>The forms are the ones frozen in {@code plans/PLAN-0691-XH-plugin-mechanism/data-plane.md} (DP-2):
 * {@code string} stays text, {@code number} ⇒ {@code ::numeric}, {@code boolean} ⇒
 * {@code ::boolean}, and {@code date} also stays text (date lane, direction B) — the type stores a
 * normalized fixed-width UTC instant, so plain text ordering is chronological ordering. {@code date}
 * cannot be cast: {@code timestamptz_in} is {@code STABLE}, and PostgreSQL refuses to build an index
 * over it ({@code functions in index expression must be marked IMMUTABLE}, measured on PG 17). A
 * database round-trip cannot serve as this evidence: {@code pg_get_indexdef} re-prints the expression
 * (it adds {@code ::text} to the {@code ->>} result and re-parenthesises it), so only the statement the
 * executor builds can be compared character for character with the contract.</p>
 */
class PluginRecordsIndexCastTest {

    private static final UUID BINDING = UUID.fromString("11111111-2222-3333-4444-555555555555");
    private static final String NAME = "pi_contacts_by_tag_0123456789ab";
    private static final String PREDICATE = " WHERE binding_id = '" + BINDING
            + "' AND collection = 'contacts'";

    @Test
    void everyFrozenTypeProducesItsDocumentedExpression() {
        assertEquals("CREATE INDEX IF NOT EXISTS " + NAME
                        + " ON plugin_records ((doc ->> 'tag'))" + PREDICATE,
                statement("string", false), "string: (doc ->> 'f')");
        assertEquals("CREATE INDEX IF NOT EXISTS " + NAME
                        + " ON plugin_records (((doc ->> 'tag')::numeric))" + PREDICATE,
                statement("number", false), "number: ((doc ->> 'f')::numeric)");
        assertEquals("CREATE INDEX IF NOT EXISTS " + NAME
                        + " ON plugin_records (((doc ->> 'tag')::boolean))" + PREDICATE,
                statement("boolean", false), "boolean: ((doc ->> 'f')::boolean)");
        assertEquals("CREATE INDEX IF NOT EXISTS " + NAME
                        + " ON plugin_records ((doc ->> 'tag'))" + PREDICATE,
                statement("date", false), "date: (doc ->> 'f') — no cast, the stored form is canonical"
                        + " fixed-width UTC text");
    }

    /**
     * <b>Ruling C1 (2026-11-08)</b>: with {@code date} uncrasted, a {@code string} field and a
     * {@code date} field build <b>the same</b> index element, so the physical definition cannot tell
     * them apart — right down to the statement text. That is not a defect of the comparison in
     * {@link PluginIndexDdlExecutor#physicalCastsMatch}: there is no physical difference to see, and
     * C1 therefore requires no rebuild and no rename when the two types trade places. The difference
     * between them lives on the write side, which re-reads the persisted manifest on every write.
     */
    @Test
    void aStringAndADateFieldBuildTheSamePhysicalElement() {
        assertEquals(statement("string", false), statement("date", false),
                "date must be indistinguishable from string on the physical side (lane B)");
    }

    @Test
    void uniqueStaysAPartialUniqueIndexOverTheSameExpression() {
        String statement = PluginIndexDdlExecutor.createStatement(BINDING, declaration(
                List.of(new PluginIndexDeclaration.DeclaredField("email", "date")), true), NAME);

        assertEquals("CREATE UNIQUE INDEX IF NOT EXISTS " + NAME
                + " ON plugin_records ((doc ->> 'email'))" + PREDICATE, statement,
                "DP-2 §6.3: a single uncrasted element is the documented unique sample");
        assertTrue(statement.contains("WHERE binding_id = '" + BINDING + "'"),
                "DP-2: the partial predicate is what keeps two workspaces from colliding");
    }

    @Test
    void severalFieldsKeepDeclarationOrderAndTheirOwnExpressions() {
        assertEquals("CREATE INDEX IF NOT EXISTS " + NAME + " ON plugin_records"
                        + " ((doc ->> 'status'), (doc ->> 'created_at'))" + PREDICATE,
                PluginIndexDdlExecutor.createStatement(BINDING, declaration(List.of(
                        new PluginIndexDeclaration.DeclaredField("status", "string"),
                        new PluginIndexDeclaration.DeclaredField("created_at", "date")), false),
                        NAME),
                "one column-list paren wraps elements separated by ', '");
    }

    @Test
    void anUndefinedFieldTypeCannotBecomeADeclaredFieldAtAll() {
        assertThrows(IllegalArgumentException.class, () ->
                new PluginIndexDeclaration.DeclaredField("tag", "text"),
                "a type outside the frozen four has no expression to build, so it may not be declared");
    }

    /**
     * The physical definition is the only evidence of a field's type (DP-3 stores names only), so the
     * comparison must bind each cast to <b>its</b> field. These two {@code indexdef} strings are exact
     * PostgreSQL 17 reprints (measured in task-172 evidence) of the statements the executor builds for
     * {@code (tag: string, score: number)} and for the same declaration with the two types swapped —
     * the cast <b>set</b> is identical ({@code ::numeric}) in both, so a set comparison would leave the
     * stale ordering in place.
     */
    @Test
    void thePhysicalCastIsComparedPerFieldNotAsASet() {
        String stringThenNumber = "CREATE INDEX pi_x ON public.plugin_records USING btree"
                + " (((doc ->> 'tag'::text)), (((doc ->> 'score'::text))::numeric))";
        String numberThenString = "CREATE INDEX pi_x ON public.plugin_records USING btree"
                + " ((((doc ->> 'tag'::text))::numeric), ((doc ->> 'score'::text)))";
        PluginIndexDeclaration declared = declaration(List.of(
                new PluginIndexDeclaration.DeclaredField("tag", "string"),
                new PluginIndexDeclaration.DeclaredField("score", "number")), false);

        assertTrue(PluginIndexDdlExecutor.physicalCastsMatch(stringThenNumber, declared),
                "the definition the declaration asks for must be accepted");
        assertFalse(PluginIndexDdlExecutor.physicalCastsMatch(numberThenString, declared),
                "same cast set, wrong field: the swap must be seen as a different definition");
        assertFalse(PluginIndexDdlExecutor.physicalCastsMatch(
                "CREATE INDEX pi_x ON public.plugin_records USING btree (((doc ->> 'tag'::text)))",
                declared), "a definition missing one declared element cannot be the declared index");
    }

    /**
     * A {@code date} asks for <b>no</b> cast, so an index that still carries one is a different
     * definition and must be rebuilt. This is the lane that a {@code number}→{@code date} upgrade
     * takes, and the case the old {@code ::timestamptz} form would have needed had PostgreSQL been
     * willing to build it.
     */
    @Test
    void aDateFieldRejectsAStaleCastOnItsElement() {
        PluginIndexDeclaration declared = declaration(List.of(
                new PluginIndexDeclaration.DeclaredField("when", "date")), false);

        assertFalse(PluginIndexDdlExecutor.physicalCastsMatch(
                "CREATE INDEX pi_x ON public.plugin_records USING btree"
                        + " ((((doc ->> 'when'::text))::timestamptz))", declared),
                "a cast the date lane no longer asks for is a stale definition");
        assertFalse(PluginIndexDdlExecutor.physicalCastsMatch(
                "CREATE INDEX pi_x ON public.plugin_records USING btree"
                        + " ((((doc ->> 'when'::text))::numeric))", declared),
                "a numeric cast left behind by a number→date upgrade must not survive");
        assertTrue(PluginIndexDdlExecutor.physicalCastsMatch(
                "CREATE INDEX pi_x ON public.plugin_records USING btree"
                        + " (((doc ->> 'when'::text)))", declared),
                "the uncrasted element is the date lane's definition");
    }

    private static String statement(String type, boolean unique) {
        return PluginIndexDdlExecutor.createStatement(BINDING,
                declaration(List.of(new PluginIndexDeclaration.DeclaredField("tag", type)), unique),
                NAME);
    }

    private static PluginIndexDeclaration declaration(
            List<PluginIndexDeclaration.DeclaredField> fields, boolean unique) {
        return new PluginIndexDeclaration("contacts", "by_tag", fields, unique);
    }
}
