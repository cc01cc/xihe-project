package com.cc01cc.p.xihe.cp.architecture;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0633 C1-3 (D33-10): the static mechanical gate for "a Jackson-2 {@code JsonNode} must never
 * reach an HTTP response".
 *
 * <p>Why not ArchUnit: ArchUnit sees types and dependencies, not values, so it cannot express "this
 * expression, whatever its static type, ends up inside the response map" (generic erasure plus no
 * data flow). This gate therefore scans sources in two passes:
 *
 * <ol>
 *   <li><b>pass 1</b> builds the set of <em>method names that return a Jackson-2 node</em> in this
 *       module — required because {@code response.put("hooks", view.hooks())} only looks innocent
 *       until you know {@code hooks()} returns a node (that is exactly how {@code a1219a21} leaked);</li>
 *   <li><b>pass 2</b> inspects every exit expression ({@code .put("k", EXPR)}, {@code return EXPR})
 *       and flags it when EXPR is a node-typed identifier, a node-returning call, or a
 *       {@code .get(}/{@code .path(} chain on a node-typed receiver.</li>
 * </ol>
 *
 * <p>Three allow mechanisms, and the last one is never silent:
 * <ul>
 *   <li>sanctioned lowering — {@code JacksonNodeExit.}{@code …}, {@code toDocument(}, {@code convertValue(};</li>
 *   <li>scalar projection — the chain ends in {@code .asText(/.asInt(/.asLong(/.asBoolean(/.asDouble(/.isNull(/.isMissingNode(/.toString(};</li>
 *   <li>inline exemption — {@code // jackson2-wire-ok: <reason>} on the offending or preceding line.
 *       Every exemption is <b>printed by the test</b> and bounded by {@link #EXEMPTION_BUDGET}, so the
 *       gate cannot be quietly eroded one comment at a time.</li>
 * </ul>
 *
 * <p>Known limits (documented, not hidden): single-line expressions only (a {@code put(} split across
 * lines is not seen), {@code Map.of(} / {@code putAll(} are not scanned, and no cross-file type
 * inference. The runtime gate ({@code Jackson2NodeWireInterceptor}, C1-4) is the authoritative net
 * for those shapes.
 */
class Jackson2NodeWireScanTest {

    /** Package-private for the fixtures test: how many exemptions the gate tolerates before failing. */
    static final int EXEMPTION_BUDGET = 10;

    private static final Path MAIN_SOURCES = Path.of("src/main/java");

    private static final String NODE_TYPES = "(?:com\\.fasterxml\\.jackson\\.databind\\.)?(?:JsonNode|ObjectNode|ArrayNode)";

    /** Matches a method whose return type is a Jackson-2 node: {@code JsonNode hooks(...)}. */
    private static final Pattern METHOD_RETURNING_NODE = Pattern.compile(
            "(^|[;{}]\\s*|\\s)(?:public\\s+|protected\\s+|private\\s+|static\\s+|final\\s+|synchronized\\s+)*"
                    + NODE_TYPES + "\\s+(\\w+)\\s*\\(");

    /** Matches a node-typed declaration (local, parameter, field): {@code JsonNode node = ...}. */
    private static final Pattern NODE_DECLARATION = Pattern.compile(
            NODE_TYPES + "\\s+(\\w+)\\s*[=;,)]");

    private static final Pattern PUT_EXIT = Pattern.compile("\\.put\\(\\s*\"([^\"]*)\"\\s*,\\s*(.+?)\\s*\\)\\s*;");

    private static final Pattern RETURN_EXIT = Pattern.compile("^\\s*return\\s+(.+?)\\s*;\\s*$");

    private static final Pattern SANCTIONED = Pattern.compile(
            "^(?:JacksonNodeExit\\.[a-zA-Z]+|toDocument\\(|objectMapper\\.convertValue\\(|mapper\\.convertValue\\(|"
                    + "[a-zA-Z_][\\w.]*\\.convertValue\\()");

    private static final Pattern SCALAR_SUFFIX = Pattern.compile(
            "\\.(?:asText|asInt|asLong|asBoolean|asDouble|isNull|isMissingNode|toString|size|length|hashCode)"
                    + "\\(.*\\)$");

    private static final String EXEMPTION_MARKER = "jackson2-wire-ok:";

    private static final Pattern HTTP_FACE = Pattern.compile("@(?:Rest)?Controller\\b");

    record Violation(String where, String expression, String kind) {
        @Override
        public String toString() {
            return where + " [" + kind + "] -> " + expression;
        }
    }

    record Report(List<Violation> violations, List<String> exemptions) {}

    // ------------------------------------------------------------------ gate

    @Test
    void productionSourcesNeverPutAJackson2NodeOnTheWire() throws IOException {
        Report report = scan(MAIN_SOURCES);

        String message = "A Jackson-2 JsonNode must leave the CP through JacksonNodeExit only. "
                + "Found " + report.violations().size() + " raw exit(s); exemptions in effect: "
                + report.exemptions();
        assertEquals(List.of(), report.violations(), message);
        assertTrue(report.exemptions().size() <= EXEMPTION_BUDGET,
                "Jackson2 wire exemptions exceeded the budget (" + EXEMPTION_BUDGET + "): "
                        + report.exemptions());
        // The exemptions are printed on every run: the gate must never hide what it lets through.
        System.out.println("[jackson2-wire] exemptions in effect (" + report.exemptions().size() + "):");
        report.exemptions().forEach(exemption -> System.out.println("  " + exemption));
    }

    // ------------------------------------------------------- fixtures (3 states)

    /**
     * The gate must be able to fail. These three fixtures are the historical shapes, verbatim in
     * spirit: {@code a1219a21} (node-typed local), {@code a3e8d90a}/Gap J (node-returning method),
     * and C1-1's {@code node.get(...)} chain.
     */
    @Test
    void detectsTheThreeHistoricalShapes() {
        Map<String, String> fixtures = new LinkedHashMap<>();
        fixtures.put("controller/NodeTypedLocalFixture.java", String.join("\n",
                "@RestController", "class NodeTypedLocalFixture {",
                "    void view(ObjectMapper objectMapper, Object raw) {",
                "        Map<String, Object> response = new java.util.LinkedHashMap<>();",
                "        JsonNode hooks = objectMapper.valueToTree(raw);",
                "        response.put(\"hooks\", hooks);",
                "    }",
                "}"));
        fixtures.put("service/NodeReturningMethodFixture.java", String.join("\n",
                "class NodeReturningMethodFixture {",
                "    JsonNode hooks() {",
                "        return null;",
                "    }",
                "}"));
        fixtures.put("controller/CallSiteFixture.java", String.join("\n",
                "@RestController", "class CallSiteFixture {",
                "    void view(NodeReturningMethodFixture view) {",
                "        Map<String, Object> result = new java.util.LinkedHashMap<>();",
                "        result.put(\"hooks\", view.hooks());",
                "    }",
                "}"));
        fixtures.put("controller/NodeGetChainFixture.java", String.join("\n",
                "@RestController", "class NodeGetChainFixture {",
                "    void view(JsonNode capability) {",
                "        Map<String, Object> view = new java.util.LinkedHashMap<>();",
                "        JsonNode node = capability;",
                "        view.put(\"fileOperations\", node.get(\"fileOperations\"));",
                "    }",
                "}"));

        Report report = scanSources(fixtures);

        assertEquals(3, report.violations().size(),
                "expected exactly the three historical shapes to be reported, got: " + report.violations());
        assertEquals(List.of(), report.exemptions(), "fixtures must not need exemptions");
    }

    /** A sanctioned lower, a scalar projection and an inline exemption are all allowed — visibly. */
    @Test
    void allowsLoweredScalarAndExplicitlyExemptedExits() {
        Map<String, String> fixtures = new LinkedHashMap<>();
        fixtures.put("controller/CleanFixture.java", String.join("\n",
                "@RestController", "class CleanFixture {",
                "    void view(ObjectMapper objectMapper, JsonNode node) {",
                "        Map<String, Object> response = new java.util.LinkedHashMap<>();",
                "        response.put(\"lowered\", JacksonNodeExit.toDocument(objectMapper, node));",
                "        response.put(\"scalar\", node.path(\"state\").asText(\"\"));",
                "        response.put(\"missing\", node.path(\"state\").isMissingNode());",
                "        // jackson2-wire-ok: fixture proving the marker is honoured and reported",
                "        response.put(\"exempted\", node.get(\"payload\"));",
                "    }",
                "}"));

        Report report = scanSources(fixtures);

        assertEquals(List.of(), report.violations(), "sanctioned exits must not be flagged");
        assertEquals(1, report.exemptions().size(), "the inline exemption must be reported");
        assertTrue(report.exemptions().get(0).contains("exempted"),
                "the report must name the exempted expression: " + report.exemptions());
    }

    /** No exemption may bypass reporting: the real tree's exemptions are enumerated. */
    @Test
    void everyExemptionInTheRealTreeIsEnumerated() throws IOException {
        Report report = scan(MAIN_SOURCES);

        for (String exemption : report.exemptions()) {
            assertTrue(exemption.contains(EXEMPTION_MARKER),
                    "exemption report entry must carry the marker for traceability: " + exemption);
        }
        assertFalse(report.exemptions().stream().anyMatch(entry -> entry.isBlank()),
                "exemption entries must not be blank");
    }

    // -------------------------------------------------------------- scanner

    /** A method signature that opens a body (not a control-flow block). */
    private static final Pattern SIGNATURE_LINE = Pattern.compile(
            "^\\s{0,8}(?:(?:public|private|protected|static|final|synchronized|abstract|default|native)\\s+)*"
                    + "[\\w.<>\\[\\],?\\s]+\\s+\\w+\\s*\\(.*\\{\\s*$");

    private static final Pattern CONTROL_KEYWORD = Pattern.compile(
            "^\\s*(?:if|for|while|switch|catch|try|else|do)\\b");

    private static final Pattern MAPPING_ANNOTATION = Pattern.compile("@\\w+Mapping\\b");

    private static final Pattern DECLARATION = Pattern.compile(
            "(?:^|[\\s(,])([A-Z][\\w.]*|JsonNode|ObjectNode|ArrayNode|Map<[^>]+>|var)\\s+(\\w+)\\s*[=;,)]");

    private static final Pattern PUT_RECEIVER = Pattern.compile("(\\w+)\\.put\\(\\s*\"");

    private static final Pattern CALL_HEAD = Pattern.compile("^(\\w+)\\.(\\w+)\\(");

    private static final Pattern INLINE_PRODUCER = Pattern.compile(
            "^(?:[\\w.]+\\.)?(?:readTree|valueToTree)\\(");

    private static final Set<String> NODE_TYPE_NAMES = Set.of("JsonNode", "ObjectNode", "ArrayNode");

    private static final Set<String> NODE_CHAIN_METHODS = Set.of("get", "path", "getNode", "fieldNames", "elements");

    private static final Pattern JACKSON2_SERIALISATION = Pattern.compile("writeValueAs(?:String|Bytes)\\(");

    static Report scan(Path root) throws IOException {
        Map<String, String> sources = new LinkedHashMap<>();
        try (Stream<Path> files = Files.walk(root)) {
            for (Path file : files.filter(path -> path.toString().endsWith(".java")).toList()) {
                sources.put(root.relativize(file).toString().replace('\\', '/'), Files.readString(file));
            }
        }
        return scanSources(sources);
    }

    static Report scanSources(Map<String, String> sources) {
        // pass 1: every method that returns a Jackson-2 node, class-qualified where possible.
        Set<String> nodeMethodNames = new LinkedHashSet<>();
        Set<String> nodeQualifiedMethods = new LinkedHashSet<>();
        for (String source : sources.values()) {
            List<String> declaredTypes = declaredTypes(source);
            Matcher matcher = METHOD_RETURNING_NODE.matcher(source);
            while (matcher.find()) {
                String method = matcher.group(2);
                nodeMethodNames.add(method);
                for (String type : declaredTypes) {
                    nodeQualifiedMethods.add(type + "." + method);
                }
            }
        }

        List<Violation> violations = new ArrayList<>();
        List<String> exemptions = new ArrayList<>();
        for (Map.Entry<String, String> entry : sources.entrySet()) {
            String source = entry.getValue();
            // pass 2: only HTTP-facing classes can put a node on the wire.
            if (!HTTP_FACE.matcher(source).find()) {
                continue;
            }
            String[] lines = source.split("\n", -1);
            // Field declarations are in scope for every method of the class; method-locals win.
            Map<String, String> fileTypes = scopeTypes(lines, 0, lines.length);
            for (int index = 0; index < lines.length; index++) {
                int start = methodStart(lines, index);
                boolean handler = isHandler(lines, start);
                String expression = exitExpression(lines[index], handler);
                if (expression == null) {
                    continue;
                }
                Map<String, String> scopeTypes = new LinkedHashMap<>(fileTypes);
                scopeTypes.putAll(scopeTypes(lines, start, index + 1));
                String receiver = putReceiver(lines[index]);
                boolean jackson2Body = isJackson2Serialised(lines, start, index);
                String kind = classify(expression, receiver, scopeTypes, nodeQualifiedMethods,
                        nodeMethodNames, jackson2Body);
                if (kind == null) {
                    continue;
                }
                String where = entry.getKey() + ":" + (index + 1);
                String key = putKey(lines[index]);
                String label = key == null ? expression : "\"" + key + "\" <- " + expression;
                if (isExempt(lines, index)) {
                    exemptions.add(where + " [" + kind + "] -> " + label);
                } else {
                    violations.add(new Violation(where, label, kind));
                }
            }
        }
        return new Report(violations, exemptions);
    }

    /** {@code null} = allowed; otherwise a short rule name for the report. */
    private static String classify(String expression, String putReceiver, Map<String, String> scopeTypes,
                                   Set<String> nodeQualifiedMethods, Set<String> nodeMethodNames,
                                   boolean jackson2Body) {
        if (SANCTIONED.matcher(expression).find() || SCALAR_SUFFIX.matcher(expression).find()) {
            return null;
        }
        if (putReceiver != null) {
            String receiverType = scopeTypes.getOrDefault(putReceiver, "");
            // Building a Jackson-2 tree (ObjectNode/ArrayNode) keeps the value inside Jackson 2.
            if (NODE_TYPE_NAMES.contains(receiverType)) {
                return null;
            }
            // The body is produced by Jackson 2 itself (writeValueAsString) — Jackson 3 never sees it.
            if (jackson2Body) {
                return null;
            }
        }
        String root = rootIdentifier(expression);
        String rootType = scopeTypes.getOrDefault(root, "");
        if (expression.equals(root) && NODE_TYPE_NAMES.contains(rootType)) {
            return "node-typed identifier";
        }
        Matcher call = CALL_HEAD.matcher(expression);
        if (call.find()) {
            String method = call.group(2);
            boolean qualifiedHit = !rootType.isEmpty() && nodeQualifiedMethods.contains(rootType + "." + method);
            boolean untypedNameHit = rootType.isEmpty() && nodeMethodNames.contains(method);
            if (qualifiedHit || untypedNameHit) {
                return "node-returning method";
            }
            if (NODE_TYPE_NAMES.contains(rootType) && NODE_CHAIN_METHODS.contains(method)) {
                return "node chain on a node-typed receiver";
            }
        }
        if (INLINE_PRODUCER.matcher(expression).find()) {
            return "inline node producer";
        }
        return null;
    }

    private static List<String> declaredTypes(String source) {
        List<String> types = new ArrayList<>();
        Matcher matcher = Pattern.compile("\\b(?:class|record|interface|enum)\\s+(\\w+)").matcher(source);
        while (matcher.find()) {
            types.add(matcher.group(1));
        }
        return types;
    }

    private static Map<String, String> scopeTypes(String[] lines, int start, int endExclusive) {
        Map<String, String> types = new LinkedHashMap<>();
        for (int index = start; index < endExclusive && index < lines.length; index++) {
            Matcher matcher = DECLARATION.matcher(lines[index]);
            while (matcher.find()) {
                types.putIfAbsent(matcher.group(2), simpleType(matcher.group(1)));
            }
        }
        return types;
    }

    private static String simpleType(String raw) {
        String value = raw;
        if (value.startsWith("Map<") || value.startsWith("var")) {
            return value.startsWith("var") ? "var" : "Map";
        }
        int generic = value.indexOf('<');
        if (generic >= 0) {
            value = value.substring(0, generic);
        }
        int dot = value.lastIndexOf('.');
        return dot >= 0 ? value.substring(dot + 1) : value;
    }

    /** Nearest enclosing method body start (line index), by walking up to an opening signature. */
    private static int methodStart(String[] lines, int exitIndex) {
        for (int cursor = exitIndex; cursor >= 0; cursor--) {
            String trimmed = lines[cursor].trim();
            if (!trimmed.endsWith("{")) {
                continue;
            }
            if (CONTROL_KEYWORD.matcher(trimmed).find()) {
                continue;
            }
            if (SIGNATURE_LINE.matcher(lines[cursor]).matches()) {
                return cursor;
            }
        }
        return 0;
    }

    /** A {@code return} only leaves the wire from a request-mapping handler. */
    private static boolean isHandler(String[] lines, int methodStart) {
        for (int cursor = methodStart; cursor >= 0 && cursor >= methodStart - 30; cursor--) {
            String line = lines[cursor];
            if (MAPPING_ANNOTATION.matcher(line).find()) {
                return true;
            }
            if (line.trim().equals("}")) {
                return false;
            }
        }
        return false;
    }

    private static boolean isJackson2Serialised(String[] lines, int start, int exitIndex) {
        for (int index = start; index < lines.length; index++) {
            if (JACKSON2_SERIALISATION.matcher(lines[index]).find()) {
                return true;
            }
            if (index > exitIndex + 40) {
                return false;
            }
        }
        return false;
    }

    private static String putReceiver(String line) {
        Matcher matcher = PUT_RECEIVER.matcher(line);
        return matcher.find() ? matcher.group(1) : null;
    }

    /** The JSON key of a {@code put("key", …)} exit, for a report that names what leaked. */
    private static String putKey(String line) {
        Matcher matcher = Pattern.compile("\\.put\\(\\s*\"([^\"]*)\"").matcher(line);
        return matcher.find() ? matcher.group(1) : null;
    }

    /**
     * Returns the expression that leaves the module on this line, or {@code null}. {@code return} is a
     * wire exit only inside a request-mapping handler.
     */
    private static String exitExpression(String line, boolean handler) {
        Matcher put = PUT_EXIT.matcher(line);
        if (put.find()) {
            return put.group(2).trim();
        }
        if (!handler) {
            return null;
        }
        Matcher returned = RETURN_EXIT.matcher(line);
        if (returned.find()) {
            return returned.group(1).trim();
        }
        return null;
    }

    private static String rootIdentifier(String expression) {
        Matcher matcher = Pattern.compile("^(\\w+)").matcher(expression);
        return matcher.find() ? matcher.group(1) : "";
    }

    private static boolean isExempt(String[] lines, int index) {
        if (lines[index].contains(EXEMPTION_MARKER)) {
            return true;
        }
        int previous = index - 1;
        return previous >= 0 && lines[previous].contains(EXEMPTION_MARKER);
    }
}
