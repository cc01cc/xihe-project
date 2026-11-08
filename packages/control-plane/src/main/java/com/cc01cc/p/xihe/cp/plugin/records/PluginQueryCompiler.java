package com.cc01cc.p.xihe.cp.plugin.records;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import org.springframework.http.HttpStatus;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * PLAN-0691 T2.3: turns the untrusted {@code filter}/{@code sort}/{@code limit} query parameters of
 * {@code GET /records/{collection}} into a parameterised SQL fragment (spec/data-plane.md §5 API-12).
 *
 * <p><b>Why a compiler instead of string building at the call site.</b> API-12 is a whitelist, so the
 * cheapest way to keep it is to make one place that can say "no": every operator, every field name and
 * every literal passes through here, and what leaves is a fragment whose identifiers all came from the
 * manifest projection ({@link PluginRecordSchema}) and whose values are all JDBC placeholders. No
 * caller-shaped byte ever reaches the SQL text — the compiler has no access to a
 * {@code JdbcTemplate} and cannot execute anything.
 *
 * <p><b>Comparison semantics are text, per Lead ruling 2026-11-08.</b> {@code doc->>...} yields
 * {@code text}, and {@code manifest.schema.json} declares <i>names only</i> for {@code fields}
 * (no type vocabulary), so {@code gt}/{@code gte}/{@code lt}/{@code lte} compare
 * <b>lexicographically, not numerically</b>: {@code gt(n,9)} matches {@code "99"} but not {@code "10"}
 * because {@code "10" < "9"}. The expression {@code (doc->>'f')} is byte-identical to the text
 * expression DP-2 builds its declared indexes on, so a declared index is usable by the planner.
 *
 * <p>range/prefix 为<b>字典序</b>；数值/时间语义需 manifest 字段类型词表（未冻结，见 BL 待登记）。
 *
 * <p><b>Grammar</b> (API-12 names the operators, not the syntax; this is the T2.3 wire form, documented
 * here because it is the only definition that exists):
 * <pre>
 * filter := predicate ( AND predicate )*            // "AND" case-insensitive, nothing else
 * predicate := eq|ne|gt|gte|lt|lte|prefix ( field , json-scalar )
 *            | in ( field , [ json-scalar , ... ] )
 * field  := a name declared by the manifest; also matched against ^[a-z][a-z0-9_]{0,31}$
 * scalar := JSON string | number | boolean | null
 * </pre>
 * Anything else — {@code OR}, {@code NOT}, a nested path, an undeclared field, a non-scalar value,
 * an empty or oversized {@code in} list, a malformed literal — is 400 {@code INVALID_FILTER}, which is
 * API-11's code for exactly this clause ({@code sort}: one declared field; {@code limit ≤ 200}).
 *
 * <p>{@code sort} accepts {@code <field>} or {@code <field> asc|desc} (case-insensitive). Default is
 * {@code id asc}. Multi-field, expression and {@code nulls first/last} sorts are rejected; the tie
 * breaker is always {@code id} in the same direction, which is what makes the keyset cursor total.
 *
 * <p><b>DML only.</b> The fragment is always a conjunction of predicates (plus the keyset predicate);
 * {@code GROUP BY}, {@code JOIN}, sub-selects and window functions cannot be expressed by the grammar,
 * so §5's "no aggregation / no cross-document read" is a property of the parser rather than a check.
 */
public final class PluginQueryCompiler {

    /** API-11 code for every §5 violation. */
    public static final String CODE_INVALID_FILTER = "INVALID_FILTER";

    /**
     * Manifest collection fields follow this shape ({@code manifest.schema.json} {@code $defs/field}).
     * Re-checked here even though the name already came from the manifest projection: the whitelist and
     * the identifier rule are two independent gates, and a manifest that slipped past install
     * validation must still not be able to contribute arbitrary SQL text.
     */
    private static final Pattern FIELD_NAME = Pattern.compile("^[a-z][a-z0-9_]{0,31}$");

    /** API-12's operator vocabulary, mapped to the SQL comparison each one becomes. */
    private static final Set<String> OPERATORS =
            Set.of("eq", "ne", "in", "gt", "gte", "lt", "lte", "prefix");

    /** Only used to parse the JSON scalar literals inside a predicate; never formats wire output. */
    private static final ObjectMapper LITERALS = new ObjectMapper();

    private PluginQueryCompiler() {
    }

    /** The sort clause: one field plus a direction; {@code id} is the implicit default. */
    public record Sort(String field, boolean descending) {

        public String directionSql() {
            return descending ? "DESC" : "ASC";
        }

        /** Cursor form of the sort, so a cursor cannot be replayed against a different ordering. */
        public String wire() {
            return field + ":" + (descending ? "desc" : "asc");
        }

        public static Sort parse(String wire) {
            if (wire == null || wire.isBlank()) {
                return new Sort("id", false);
            }
            String[] parts = wire.split(":", -1);
            if (parts.length != 2) {
                throw invalid("sort '" + wire + "' is not '<field>:<asc|desc>'");
            }
            boolean descending = switch (parts[1].toLowerCase(Locale.ROOT)) {
                case "asc" -> false;
                case "desc" -> true;
                default -> throw invalid("sort direction '" + parts[1] + "' must be asc or desc");
            };
            return new Sort(parts[0], descending);
        }
    }

    /**
     * The decoded cursor's position: the last row of the previous page. {@code key} is the sort field's
     * text value, {@code id} the tie breaker; both come from a MAC-verified cursor only, which is why the
     * compiler does not re-validate them beyond using them as bind arguments.
     */
    public record Anchor(String key, String id) {
    }

    /**
     * A compiled query.
     *
     * @param whereSql  conjunction of predicates, or {@code "TRUE"} when the request has no filter
     * @param whereArgs bind arguments for {@link #whereSql}, in order
     * @param orderSql  complete {@code ORDER BY} clause including the tie breaker
     * @param sort      the parsed sort, echoed so the service can embed it into the next cursor
     * @param sortKeySql the expression that yields the sort key as text, projected by the listing
     *                   query so the next cursor can carry the exact value the comparator used
     * @param limit     validated page size ({@code 1..}{@value PluginRecordsLimits#MAX_PAGE_LIMIT})
     */
    public record Plan(String whereSql, List<Object> whereArgs, String orderSql, Sort sort,
            String sortKeySql, int limit) {
        public Plan {
            whereArgs = List.copyOf(whereArgs);
        }
    }

    /**
     * Compiles one listing request.
     *
     * @param collection declared collection the path names — the whitelist for both filter and sort
     * @param filter     raw {@code filter} query parameter, may be {@code null}/blank
     * @param sort       raw {@code sort} query parameter, may be {@code null}/blank
     * @param limit      raw {@code limit} query parameter, may be {@code null} for the default
     * @param anchor     decoded cursor position, or {@code null} for the first page
     * @throws CpApiException 400 {@code INVALID_FILTER} for anything §5 forbids
     */
    public static Plan compile(PluginRecordSchema.Collection collection, String filter, String sort,
            Integer limit, Anchor anchor) {
        List<String> predicates = new ArrayList<>();
        List<Object> args = new ArrayList<>();
        parseFilter(collection, filter, predicates, args);
        Sort parsedSort = parseSort(collection, sort);
        int pageLimit = parseLimit(limit);
        if (anchor != null) {
            appendKeyset(parsedSort, anchor, predicates, args);
        }
        String where = predicates.isEmpty() ? "TRUE" : String.join(" AND ", predicates);
        String sortKey = "id".equals(parsedSort.field()) ? "id" : column(parsedSort.field());
        return new Plan(where, args, orderSql(parsedSort), parsedSort, sortKey, pageLimit);
    }

    /**
     * Parses and validates {@code sort} against the collection's declared fields.
     *
     * <p>Two spellings are accepted, {@code <field>:<asc|desc>} and {@code <field> asc} / {@code <field>
     * desc} (also {@code <field>} alone, meaning ascending). The colon form is the one to document: it
     * needs no percent-encoding in a query string, and it is the same vocabulary the cursor payload uses
     * ({@link Sort#wire()}), so a client that builds a cursor by hand cannot invent a third spelling.
     * The space form exists because "field asc" is the shape people type first.
     */
    public static Sort parseSort(PluginRecordSchema.Collection collection, String sort) {
        if (sort == null || sort.isBlank()) {
            return new Sort("id", false);
        }
        String trimmed = sort.trim();
        String[] parts = trimmed.split("\\s+");
        if (parts.length > 2) {
            throw invalid("sort '" + trimmed + "' must name exactly one field (API-12)");
        }
        if (parts.length == 1 && trimmed.indexOf(':') >= 0) {
            String[] colon = trimmed.split(":", -1);
            if (colon.length != 2 || colon[0].isEmpty() || colon[1].isEmpty()) {
                throw invalid("sort '" + trimmed + "' is not '<field>:<asc|desc>' (API-12)");
            }
            parts = colon;
        }
        String field = parts[0];
        boolean descending;
        if (parts.length == 2) {
            descending = switch (parts[1].toLowerCase(Locale.ROOT)) {
                case "asc" -> false;
                case "desc" -> true;
                default -> throw invalid("sort direction '" + parts[1] + "' must be asc or desc");
            };
        } else {
            descending = false;
        }
        // `id` is the document identity column, not a doc field, and it is the default sort. It stays
        // addressable as an explicit sort so a client can page by id without a declared field.
        if ("id".equals(field)) {
            return new Sort("id", descending);
        }
        requireDeclared(collection, field, "sort");
        return new Sort(field, descending);
    }

    private static int parseLimit(Integer limit) {
        if (limit == null) {
            return PluginRecordsLimits.DEFAULT_PAGE_LIMIT;
        }
        if (limit < 1 || limit > PluginRecordsLimits.MAX_PAGE_LIMIT) {
            throw invalid("limit " + limit + " is outside 1.." + PluginRecordsLimits.MAX_PAGE_LIMIT
                    + " (API-12)");
        }
        return limit;
    }

    private static void parseFilter(PluginRecordSchema.Collection collection, String filter,
            List<String> predicates, List<Object> args) {
        if (filter == null || filter.isBlank()) {
            return;
        }
        Scanner scanner = new Scanner(filter);
        while (true) {
            String operator = scanner.readIdentifier("filter operator").toLowerCase(Locale.ROOT);
            if (!OPERATORS.contains(operator)) {
                throw invalid("filter operator '" + operator + "' is not one of "
                        + String.join("/", List.of("eq", "ne", "in", "gt", "gte", "lt", "lte",
                                "prefix")) + " (API-12)");
            }
            scanner.expect('(');
            String field = scanner.readIdentifier("filter field");
            if (!"id".equals(field)) {
                requireDeclared(collection, field, "filter");
            }
            scanner.expect(',');
            String literal = scanner.readLiteral();
            scanner.expect(')');
            appendPredicate(operator, field, literal, predicates, args);
            scanner.skipWhitespace();
            if (scanner.done()) {
                return;
            }
            String conjunction = scanner.readIdentifier("filter conjunction");
            if (!"and".equalsIgnoreCase(conjunction)) {
                throw invalid("filter conjunction '" + conjunction
                        + "' is not supported; only AND combinations are allowed (API-12)");
            }
        }
    }

    private static void appendPredicate(String operator, String field, String literal,
            List<String> predicates, List<Object> args) {
        String column = column(field);
        if ("in".equals(operator)) {
            appendIn(column, literal, predicates, args);
            return;
        }
        JsonNode value = literal(literal, operator);
        if ("prefix".equals(operator)) {
            if (!value.isTextual()) {
                throw invalid("prefix() requires a JSON string");
            }
            predicates.add(column + " LIKE ? ESCAPE '\\'");
            args.add(likeEscape(value.asText()) + "%");
            return;
        }
        boolean isNull = value.isNull();
        if (isNull && !"eq".equals(operator) && !"ne".equals(operator)) {
            throw invalid(operator + "() does not accept null");
        }
        if (isNull) {
            predicates.add(column + ("eq".equals(operator) ? " IS NULL" : " IS NOT NULL"));
            return;
        }
        String text = scalarText(value, operator);
        String sqlOperator = switch (operator) {
            case "eq" -> "=";
            case "ne" -> "<>";
            case "gt" -> ">";
            case "gte" -> ">=";
            case "lt" -> "<";
            case "lte" -> "<=";
            default -> throw invalid("filter operator '" + operator + "' has no comparison");
        };
        predicates.add(column + " " + sqlOperator + " ?");
        args.add(text);
    }

    private static void appendIn(String column, String literal, List<String> predicates,
            List<Object> args) {
        JsonNode value = literal(literal, "in");
        if (!value.isArray()) {
            throw invalid("in() requires a JSON array, e.g. in(status,[\"a\",\"b\"])");
        }
        if (value.isEmpty()) {
            throw invalid("in() requires at least one value (API-12: no unbounded scan)");
        }
        if (value.size() > PluginRecordsLimits.MAX_IN_VALUES) {
            throw invalid("in() accepts at most " + PluginRecordsLimits.MAX_IN_VALUES + " values");
        }
        List<String> placeholders = new ArrayList<>();
        for (JsonNode element : value) {
            if (element.isNull()) {
                // Rejected instead of being mapped to IS NULL: §5 has no "in including absent" form and
                // silently widening the match would be a semantic the spec did not grant.
                throw invalid("in() does not accept null; use eq(field,null) for absent values");
            }
            placeholders.add("?");
            args.add(scalarText(element, "in"));
        }
        predicates.add(column + " IN (" + String.join(", ", placeholders) + ")");
    }

    /** The one place a column expression is formed, so the DP-2 index expression stays byte-identical. */
    private static String column(String field) {
        if (!FIELD_NAME.matcher(field).matches()) {
            throw invalid("field '" + field + "' does not match the manifest field-name pattern");
        }
        return "doc->>'" + field + "'";
    }

    private static String orderSql(Sort sort) {
        if ("id".equals(sort.field())) {
            return "ORDER BY id " + sort.directionSql();
        }
        return "ORDER BY " + column(sort.field()) + " " + sort.directionSql() + ", id "
                + sort.directionSql();
    }

    private static void appendKeyset(Sort sort, Anchor anchor, List<String> predicates,
            List<Object> args) {
        String comparison = sort.descending() ? "<" : ">";
        if ("id".equals(sort.field())) {
            predicates.add("id " + comparison + " ?");
            args.add(anchor.id());
            return;
        }
        predicates.add("(" + column(sort.field()) + ", id) " + comparison + " (?, ?)");
        args.add(anchor.key());
        args.add(anchor.id());
    }

    private static void requireDeclared(PluginRecordSchema.Collection collection, String field,
            String what) {
        if (!collection.declares(field)) {
            throw invalid(what + " field '" + field + "' is not declared by the manifest (API-12: "
                    + "未声明字段)");
        }
    }

    private static JsonNode literal(String raw, String operator) {
        try {
            return LITERALS.readTree(raw);
        } catch (JacksonException e) {
            throw invalid(operator + "() value is not a JSON literal: " + raw);
        }
    }

    /**
     * Text form of a scalar, which is what {@code doc->>...} compares against.
     *
     * <p>Objects and arrays are rejected rather than stringified: turning {@code {"a":1}} into a
     * comparison string would silently reinterpret the document shape, which §5 forbids (no arbitrary
     * JSON path semantics).
     */
    private static String scalarText(JsonNode node, String operator) {
        if (node.isTextual() || node.isNumber() || node.isBoolean()) {
            return node.asText();
        }
        throw invalid(operator + "() accepts JSON scalars only, got " + node.getNodeType());
    }

    /** {@code LIKE} metacharacters of a literal prefix, escaped against the default escape char. */
    static String likeEscape(String value) {
        StringBuilder escaped = new StringBuilder(value.length() + 8);
        for (int i = 0; i < value.length(); i++) {
            char ch = value.charAt(i);
            if (ch == '\\' || ch == '%' || ch == '_') {
                escaped.append('\\');
            }
            escaped.append(ch);
        }
        return escaped.toString();
    }

    private static CpApiException invalid(String detail) {
        return new CpApiException(HttpStatus.BAD_REQUEST, CODE_INVALID_FILTER, detail);
    }

    /**
     * Minimal scanner for the grammar above: identifiers, {@code (},{@code ,},{@code )} and one JSON
     * literal per predicate. Deliberately not a general expression parser — anything it cannot read is a
     * 400, which is the bound API-12 asks for.
     */
    private static final class Scanner {

        private final String text;
        private int pos;

        Scanner(String text) {
            this.text = text;
        }

        boolean done() {
            skipWhitespace();
            return pos >= text.length();
        }

        void skipWhitespace() {
            while (pos < text.length() && Character.isWhitespace(text.charAt(pos))) {
                pos++;
            }
        }

        void expect(char expected) {
            skipWhitespace();
            if (pos >= text.length() || text.charAt(pos) != expected) {
                throw invalid("expected '" + expected + "' at position " + pos);
            }
            pos++;
        }

        String readIdentifier(String what) {
            skipWhitespace();
            int start = pos;
            if (pos >= text.length() || !Character.isLetter(text.charAt(pos))) {
                throw invalid(what + " expected at position " + pos);
            }
            while (pos < text.length()) {
                char ch = text.charAt(pos);
                if (!Character.isLetterOrDigit(ch) && ch != '_') {
                    break;
                }
                pos++;
            }
            return text.substring(start, pos);
        }

        /** Consumes one JSON literal, stopping at the {@code )} that closes the predicate. */
        String readLiteral() {
            skipWhitespace();
            int start = pos;
            boolean inString = false;
            int depth = 0;
            while (pos < text.length()) {
                char ch = text.charAt(pos);
                if (inString) {
                    if (ch == '\\') {
                        pos += 2;
                        continue;
                    }
                    if (ch == '"') {
                        inString = false;
                    }
                    pos++;
                    continue;
                }
                if (ch == '"') {
                    inString = true;
                    pos++;
                    continue;
                }
                if (ch == '[' || ch == '{') {
                    depth++;
                    pos++;
                    continue;
                }
                if (ch == ']' || ch == '}') {
                    if (depth == 0) {
                        throw invalid("filter value has an unbalanced '" + ch + "'");
                    }
                    depth--;
                    pos++;
                    continue;
                }
                if (ch == ')') {
                    if (depth == 0) {
                        break;
                    }
                    throw invalid("filter value has an unbalanced ')'");
                }
                pos++;
            }
            if (inString || depth != 0) {
                throw invalid("filter value is not a balanced JSON literal");
            }
            String raw = text.substring(start, Math.min(pos, text.length())).trim();
            if (raw.isEmpty()) {
                throw invalid("filter predicate is missing its value");
            }
            return raw;
        }
    }
}
