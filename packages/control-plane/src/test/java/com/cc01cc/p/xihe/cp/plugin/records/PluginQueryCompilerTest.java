package com.cc01cc.p.xihe.cp.plugin.records;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.function.Executable;
import org.springframework.http.HttpStatus;

import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0691 T2.3: the filter/sort/limit half of {@link PluginQueryCompiler} (spec/data-plane.md §5
 * API-12, lines 100–106).
 *
 * <p>No database here on purpose. What has to be proved is the <i>grammar</i>: which requests are
 * refused, and that every accepted request becomes placeholders plus manifest-declared identifiers. A
 * PostgreSQL test would show "a query returned rows" for the same input and tell us nothing about
 * whether a value reached the SQL text.
 *
 * <p>Group layout follows the T2.3 case list:
 * <ul>
 *   <li><b>A</b> — filter operators and the §5 whitelist (A1–A10);</li>
 *   <li><b>B</b> — sort grammar, one declared field only (B1–B4);</li>
 *   <li><b>D</b> — limits and the "no aggregation / no second statement" property (D1–D3).</li>
 * </ul>
 */
class PluginQueryCompilerTest {

    /** The manifest projection a plugin would declare; field names only, per manifest.schema.json. */
    private static final PluginRecordSchema.Collection NOTES = new PluginRecordSchema.Collection(
            "notes", Set.of("status", "name", "n", "updated_by"), null, List.of());

    // ---------------------------------------------------------------- A: filter grammar

    /** A1 (§5 L102 {@code eq}). */
    @Test
    void equalityUsesTheDeclaredTextExpression() {
        PluginQueryCompiler.Plan plan = compile("eq(status,\"active\")");
        assertEquals("doc->>'status' = ?", plan.whereSql());
        assertEquals(List.of("active"), plan.whereArgs());
    }

    /** A2 (§5 L102: {@code ne/gt/gte/lt/lte} are the only comparisons). */
    @Test
    void comparisonOperatorsMapToTheirSqlForms() {
        assertEquals("doc->>'n' <> ?", compile("ne(n,\"1\")").whereSql());
        assertEquals("doc->>'n' > ?", compile("gt(n,\"1\")").whereSql());
        assertEquals("doc->>'n' >= ?", compile("gte(n,\"1\")").whereSql());
        assertEquals("doc->>'n' < ?", compile("lt(n,\"1\")").whereSql());
        assertEquals("doc->>'n' <= ?", compile("lte(n,\"1\")").whereSql());
    }

    /**
     * A3 (§5 L102 {@code prefix}): a prefix is a {@code LIKE} with the caller's value <b>escaped</b>.
     *
     * <p>Without the escape a caller could send {@code prefix(name,"%")} and turn a bounded prefix scan
     * into a full scan, or {@code "_"} to match any character — both are semantics §5 did not grant.
     */
    @Test
    void prefixEscapesLikeMetacharacters() {
        PluginQueryCompiler.Plan plan = compile("prefix(name,\"a%b_c\\\\d\")");
        assertEquals("doc->>'name' LIKE ? ESCAPE '\\'", plan.whereSql());
        assertEquals(List.of("a\\%b\\_c\\\\d%"), plan.whereArgs());
    }

    /** A4 (§5 L102 {@code in}): one placeholder per value, never a literal list. */
    @Test
    void inBindsOnePlaceholderPerValue() {
        PluginQueryCompiler.Plan plan = compile("in(status,[\"draft\",\"live\",\"done\"])");
        assertEquals("doc->>'status' IN (?, ?, ?)", plan.whereSql());
        assertEquals(List.of("draft", "live", "done"), plan.whereArgs());
    }

    /** A5 (§5 L102: AND only — the conjunction itself is accepted in any case). */
    @Test
    void conjunctionsAreAndOnlyAndCaseInsensitive() {
        PluginQueryCompiler.Plan lower = compile("eq(status,\"live\") and gt(n,\"3\")");
        PluginQueryCompiler.Plan upper = compile("eq(status,\"live\") And gt(n,\"3\")");
        assertEquals("doc->>'status' = ? AND doc->>'n' > ?", lower.whereSql());
        assertEquals(lower.whereSql(), upper.whereSql());
        assertEquals(List.of("live", "3"), lower.whereArgs());
    }

    /** A6 (§5 L102 未声明字段): the manifest projection is the whitelist, not a naming convention. */
    @Test
    void undeclaredFieldIsRefused() {
        assertInvalidFilter("eq(secret,\"x\")");
        assertInvalidFilter("prefix(secret,\"x\")");
        assertInvalidFilter("in(secret,[\"x\"])");
    }

    /** A7 (§5 L102: 禁 OR/NOT/任意 JSON path). */
    @Test
    void booleanOperatorsAndPathsAreRefused() {
        assertInvalidFilter("eq(status,\"live\") OR eq(status,\"done\")");
        assertInvalidFilter("not(eq(status,\"live\"))");
        assertInvalidFilter("eq(status,\"live\") and not(eq(n,\"1\"))");
        // A dotted path is not a declared field name, so it dies on the whitelist before any SQL.
        assertInvalidFilter("eq(owner.name,\"x\")");
        // Emphatically not a JSON-path operator: `->` would be a second expression language.
        assertInvalidFilter("eq(status->>name,\"x\")");
    }

    /** A8 (§5 L102: a malformed request is 400 rather than a silently widened filter). */
    @Test
    void malformedFiltersAreRefused() {
        assertInvalidFilter("eq(status)");
        assertInvalidFilter("eq(status,)");
        assertInvalidFilter("eq(status,\"live\"");
        assertInvalidFilter("(status,\"live\")");
        assertInvalidFilter("like(status,\"live\")");
        assertInvalidFilter("eq(status,{\"a\":1})");
        assertInvalidFilter("eq(status,[\"a\"])");
        assertInvalidFilter("in(status,\"live\")");
        assertInvalidFilter("in(status,[])");
        assertInvalidFilter("in(status,[null])");
        assertInvalidFilter("in(status,[[\"a\"]])");
        assertInvalidFilter("eq(status,\"live\") eq(n,\"1\")");
    }

    /**
     * A8b (§5 L102): a blank {@code filter} is <b>no filter</b>, not an empty predicate.
     *
     * <p>§5 gives no syntax for "match everything", so the only reading of {@code filter=} (or all
     * spaces) that neither invents a literal nor silently drops rows is "the caller sent no filter".
     * This is stated as its own case because the opposite choice — refusing it — would also be
     * defensible and someone reading A8 might assume it was made.
     */
    @Test
    void blankFilterMeansNoFilter() {
        for (String blank : new String[] {null, "", "   "}) {
            PluginQueryCompiler.Plan plan = PluginQueryCompiler.compile(NOTES, blank, null, null, null);
            assertEquals("TRUE", plan.whereSql(), "blank filter must not add a predicate");
            assertTrue(plan.whereArgs().isEmpty());
        }
    }

    /**
     * A9 (§5 L102, Lead ruling 2026-11-08): only {@code eq}/{@code ne} may test for absence, and they
     * become {@code IS NULL}/{@code IS NOT NULL} rather than a comparison against a JSON literal.
     *
     * <p>{@code ne} is documented as SQL three-valued on purpose: SQL {@code <>} does not match a
     * missing field, so "not equal to x" returns documents where the field exists and differs. §5 fixes
     * no other meaning, and inventing "or absent" would be a semantic the spec never granted.
     */
    @Test
    void nullComparisonsAreIsNullForms() {
        assertEquals("doc->>'status' IS NULL", compile("eq(status,null)").whereSql());
        assertTrue(compile("eq(status,null)").whereArgs().isEmpty());
        assertEquals("doc->>'status' IS NOT NULL", compile("ne(status,null)").whereSql());
        assertTrue(compile("ne(status,null)").whereArgs().isEmpty());
        for (String operator : List.of("gt", "gte", "lt", "lte", "prefix")) {
            assertInvalidFilter(operator + "(status,null)");
        }
    }

    /**
     * A10 (§5 L102, dynamic-SQL discipline): a value that looks like SQL is still just a value.
     *
     * <p>This is the case that would fail if anyone "optimised" the compiler by interpolating literals:
     * the comparison text must be unchanged and the whole payload must sit in the bind arguments.
     */
    @Test
    void hostileValuesStayBindArguments() {
        String hostile = "x' OR 1=1; DROP TABLE plugin_records; --";
        PluginQueryCompiler.Plan plan = compile("eq(status," + quote(hostile) + ")");
        assertEquals("doc->>'status' = ?", plan.whereSql());
        assertEquals(List.of(hostile), plan.whereArgs());
        assertNoSecondStatement(plan);
    }

    // ---------------------------------------------------------------- B: sort grammar

    /** B1 (§5 L103 + API-12 default): no {@code sort} means {@code id ASC}. */
    @Test
    void defaultSortIsIdAscending() {
        PluginQueryCompiler.Plan plan = compile(null);
        assertEquals("ORDER BY id ASC", plan.orderSql());
        assertEquals("id", plan.sort().field());
        assertFalse(plan.sort().descending());
        assertEquals("id", plan.sortKeySql());
    }

    /**
     * B2 (§5 L103: one declared field, asc/desc): the tie breaker repeats the direction so the keyset
     * cursor stays total — with a mixed direction the anchor tuple would not be comparable.
     */
    @Test
    void declaredFieldSortAppendsIdTieBreaker() {
        PluginQueryCompiler.Plan plan = PluginQueryCompiler.compile(NOTES, null, "name desc", null,
                null);
        assertEquals("ORDER BY doc->>'name' DESC, id DESC", plan.orderSql());
        assertEquals("doc->>'name'", plan.sortKeySql());
        PluginQueryCompiler.Plan ascending =
                PluginQueryCompiler.compile(NOTES, null, "name", null, null);
        assertEquals("ORDER BY doc->>'name' ASC, id ASC", ascending.orderSql());
    }

    /**
     * B2b (§5 L103): the colon spelling is accepted and equivalent to the space spelling.
     *
     * <p>It is the documentation form because a space has to be percent-encoded in a query string, and
     * a client that percent-encodes it twice would otherwise get a 400 for a correct-looking sort. It is
     * also the spelling the cursor payload carries ({@link PluginQueryCompiler.Sort#wire()}), so one
     * vocabulary covers both.
     */
    @Test
    void colonSortSpellingMatchesSpaceSpelling() {
        PluginQueryCompiler.Plan colon =
                PluginQueryCompiler.compile(NOTES, null, "name:desc", null, null);
        PluginQueryCompiler.Plan space =
                PluginQueryCompiler.compile(NOTES, null, "name desc", null, null);
        assertEquals(space.orderSql(), colon.orderSql());
        assertEquals("name:desc", colon.sort().wire());
        assertEquals(colon.orderSql(),
                PluginQueryCompiler.compile(NOTES, null, "name:DESC", null, null).orderSql());
    }

    /** B3 (§5 L103): multi-field, expressions, unknown fields and bad directions are refused. */
    @Test
    void undecodableSortsAreRefused() {
        assertInvalidFilter(() -> PluginQueryCompiler.compile(NOTES, null, "name,status", null, null));
        assertInvalidFilter(() -> PluginQueryCompiler.compile(NOTES, null, "name status", null, null));
        assertInvalidFilter(() -> PluginQueryCompiler.compile(NOTES, null, "secret", null, null));
        assertInvalidFilter(() -> PluginQueryCompiler.compile(NOTES, null, "name sideways", null,
                null));
        assertInvalidFilter(() -> PluginQueryCompiler.compile(NOTES, null, "doc->>'name'", null,
                null));
        assertInvalidFilter(() -> PluginQueryCompiler.compile(NOTES, null, "name:", null, null));
        assertInvalidFilter(() -> PluginQueryCompiler.compile(NOTES, null, ":desc", null, null));
        assertInvalidFilter(() -> PluginQueryCompiler.compile(NOTES, null, "name:desc:extra", null,
                null));
        assertInvalidFilter(() -> PluginQueryCompiler.compile(NOTES, null, "secret:desc", null,
                null));
    }

    /** B4 ({@code sort=id desc}): paging by identity is a supported ordering, not only the default. */
    @Test
    void idIsSortableExplicitly() {
        PluginQueryCompiler.Plan plan = PluginQueryCompiler.compile(NOTES, null, "id desc", null,
                null);
        assertEquals("ORDER BY id DESC", plan.orderSql());
        assertTrue(plan.sort().descending());
    }

    // ---------------------------------------------------------------- D: limits and DML-only

    /** D1 (§5 L104 + API-12: {@code limit ≤ 200}, no offset). */
    @Test
    void limitIsBoundedAndDefaultsToTheCeiling() {
        assertEquals(PluginRecordsLimits.DEFAULT_PAGE_LIMIT, compile(null).limit());
        assertEquals(200, PluginRecordsLimits.MAX_PAGE_LIMIT);
        assertEquals(1, PluginQueryCompiler.compile(NOTES, null, null, 1, null).limit());
        assertEquals(200, PluginQueryCompiler.compile(NOTES, null, null, 200, null).limit());
        assertInvalidFilter(() -> PluginQueryCompiler.compile(NOTES, null, null, 0, null));
        assertInvalidFilter(() -> PluginQueryCompiler.compile(NOTES, null, null, 201, null));
        assertInvalidFilter(() -> PluginQueryCompiler.compile(NOTES, null, null, -5, null));
    }

    /**
     * D2 (§5 L105 不做聚合 / L106 单文档原子): the compiled fragment cannot express a second statement
     * or an aggregation.
     *
     * <p>The assertions are negative and cheap: no statement terminator, no comment opener, no
     * {@code SELECT}/{@code JOIN}/{@code UNION}/{@code GROUP BY} and no {@code OFFSET}. The
     * <i>row-level</i> half — one row touched, another collection untouched — needs a database and lives
     * in the integration test, because a compiler assertion cannot prove what the executor did.
     */
    @Test
    void compiledQueryIsOneDmlFragment() {
        PluginQueryCompiler.Plan plan = compile(
                "eq(status,\"live\") and in(name,[\"a\",\"b\"])");
        assertNoSecondStatement(plan);
        assertFalse(plan.whereSql().contains("--"));
        assertFalse(plan.whereSql().contains("/*"));
        assertFalse(plan.orderSql().contains("OFFSET"));
        assertFalse(plan.orderSql().contains(";"));
    }

    /**
     * D3 (keyset, §5 L104 "不透明 cursor，禁 offset 深翻页"): the anchor enters as a row comparison, and
     * its direction follows the sort. Nothing about it can be expressed as an offset.
     */
    @Test
    void keysetAnchorIsARowComparison() {
        PluginQueryCompiler.Plan ascending = PluginQueryCompiler.compile(NOTES, null, "name",
                10, new PluginQueryCompiler.Anchor("m", "id-3"));
        assertTrue(ascending.whereSql().contains("(doc->>'name', id) > (?, ?)"));
        assertEquals(List.of("m", "id-3"), ascending.whereArgs());

        PluginQueryCompiler.Plan descending = PluginQueryCompiler.compile(NOTES, null, "name desc",
                10, new PluginQueryCompiler.Anchor("m", "id-3"));
        assertTrue(descending.whereSql().contains("(doc->>'name', id) < (?, ?)"));

        PluginQueryCompiler.Plan byId = PluginQueryCompiler.compile(NOTES, null, "id", 10,
                new PluginQueryCompiler.Anchor(null, "id-3"));
        assertTrue(byId.whereSql().contains("id > ?"));
        assertEquals(List.of("id-3"), byId.whereArgs());
    }

    // ---------------------------------------------------------------- helpers

    private static PluginQueryCompiler.Plan compile(String filter) {
        return PluginQueryCompiler.compile(NOTES, filter, null, null, null);
    }

    /** Quotes one Java string as a JSON string literal for the grammar's value slot. */
    private static String quote(String raw) {
        return "\"" + raw.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
    }

    private static void assertInvalidFilter(String filter) {
        assertInvalidFilter(() -> PluginQueryCompiler.compile(NOTES, filter, null, null, null));
    }

    private static void assertInvalidFilter(Executable call) {
        CpApiException e = assertThrows(CpApiException.class, call);
        assertEquals(HttpStatus.BAD_REQUEST, e.getStatus());
        assertEquals(PluginQueryCompiler.CODE_INVALID_FILTER, e.getCode());
    }

    private static void assertNoSecondStatement(PluginQueryCompiler.Plan plan) {
        String compiled = plan.whereSql() + " " + plan.orderSql();
        assertFalse(compiled.contains(";"));
        assertFalse(compiled.contains("--"));
        assertFalse(compiled.contains("/*"));
        for (String forbidden : List.of("SELECT", "JOIN", "UNION", "GROUP BY", "INTERSECT", "OFFSET")) {
            assertFalse(compiled.toUpperCase(java.util.Locale.ROOT).contains(forbidden), forbidden);
        }
    }
}
