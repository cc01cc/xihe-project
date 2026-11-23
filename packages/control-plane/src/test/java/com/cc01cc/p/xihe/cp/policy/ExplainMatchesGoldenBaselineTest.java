package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * DSD-1497 (task-125) acceptance ②: the explanation agrees with the golden decision table, row by row.
 *
 * <p>The baseline itself is task-110's ({@code authz-golden-baseline.json}, 59 rows). This test does
 * not restate any verdict — every expectation is read from the baseline — and it does not restate the
 * evaluation either: the intersection rows verdict through
 * {@link GrantIntersectionEvaluator#explain}, which is the kernel
 * {@link GrantIntersectionEvaluator#allows} also runs. For each of those rows the test additionally
 * asserts {@code explain(...).allowed() == allows(...)} on the very same inputs, so a future fork of
 * the kernel would fail here instead of silently explaining a decision nobody made.</p>
 *
 * <p>Three gates, three shapes (same split as {@code AuthzGoldenBaselineTest}, kept deliberately —
 * this is the same matrix, read through the other face): {@code intersection} rows run the kernel;
 * {@code scope} rows are binding-time scope compatibility ({@code PermissionAtomCatalog}), which no
 * request decision can answer; {@code capability} rows are atoms outside the action vocabulary, and
 * there explain must refuse them (<i>unknown-action-class</i>) exactly as the decision path does.</p>
 */
class ExplainMatchesGoldenBaselineTest {

    private static final String BASELINE_RELATIVE =
            "src/test/java/com/cc01cc/p/xihe/cp/policy/authz-golden-baseline.json";

    private final ObjectMapper objectMapper = new ObjectMapper();

    @Test
    void everyIntersectionRowExplainsTheSameVerdictAsItDecides() throws Exception {
        JsonNode root = baseline();
        GrantIntersectionEvaluator evaluator = evaluatorWithScopes(root);

        List<String> failures = new ArrayList<>();
        int explained = 0;
        int explainedAllowed = 0;
        for (JsonNode row : root.withArray("rows")) {
            if (!"intersection".equals(row.path("gate").asText("intersection"))) {
                continue;
            }
            explained++;
            String id = row.path("id").asText();
            String expect = row.path("expect").asText();
            PolicyRequest request = policyRequest(row);
            List<Set<GrantIntersectionEvaluator.PermissionAtom>> path = principalPath(row, evaluator);
            List<GrantIntersectionEvaluator.PrincipalLevel> levels = labelledLevels(row, evaluator);
            // task-834: the token rows are part of the decision input. Both faces must see the very
            // same live-token list, otherwise a session-temporary grant would explain a decision the
            // kernel never made with it.
            List<GrantIntersectionEvaluator.GrantAtom> tokens = liveTokenAtoms(row, java.time.Instant.now());

            boolean decided = evaluator.allows(request, path, tokens);
            GrantIntersectionEvaluator.GrantExplanation explanation =
                    evaluator.explain(request, levels, tokens);
            if ("allow".equals(expect)) {
                explainedAllowed++;
            }
            if (decided != explanation.allowed()) {
                failures.add(id + " —— 同一输入上 allows()=" + decided + " 与 explain().allowed()="
                        + explanation.allowed() + " 不一致");
                continue;
            }
            boolean expectedAllowed = "allow".equals(expect);
            if (expectedAllowed != explanation.allowed()) {
                failures.add(id + " (" + row.path("category").asText() + ") " + row.path("intent").asText()
                        + " —— 期望 " + expect + "，explain 实测 "
                        + (explanation.allowed() ? "allow" : "deny"));
                continue;
            }
            if (explanation.allowed()) {
                if (explanation.deepestMissingLevel() != -1 || explanation.missingAtom() != null) {
                    failures.add(id + " —— 已放行却仍带缺失级 deepest="
                            + explanation.deepestMissingLevel() + " missing=" + explanation.missingAtom());
                }
                if (explanation.matchedGrantRefs().isEmpty()) {
                    failures.add(id + " —— 已放行却没有可引用的命中行");
                }
                // task-834: a pair a live token covered must be attributed to that token, never to a
                // level that does not hold the atom.
                if (!tokens.isEmpty() && explanation.matchedGrantRefs().stream()
                        .noneMatch(ref -> GrantIntersectionEvaluator.SESSION_TOKEN_LABEL
                                .equals(ref.levelLabel()))) {
                    failures.add(id + " —— live 令牌放行的行必须能在命中行里指到 "
                            + GrantIntersectionEvaluator.SESSION_TOKEN_LABEL);
                }
            } else {
                if (explanation.missingAtom() == null) {
                    failures.add(id + " —— 被拒却没有 missingAtom");
                }
                if (explanation.deepestMissingLevel() < 0 && explanation.missingAtom() != null
                        && explanation.missingAtom().level() >= 0) {
                    failures.add(id + " —— deepestMissingLevel 与 missingAtom.level 矛盾");
                }
            }
        }

        assertEquals(61, explained, "intersection 行数必须与基线一致（gate=intersection）");
        assertEquals(33, explainedAllowed, "intersection 行的放行数必须与基线一致（71 行 36 放行 - scope 门 3 行）");
        assertTrue(failures.isEmpty(), "以下基线行 explain 与裁决不一致（" + failures.size() + " 行）:\n"
                + String.join("\n", failures));
    }

    @Test
    void everyScopeRowKeepsItsBindingTimeVerdict() throws Exception {
        JsonNode root = baseline();
        List<String> failures = new ArrayList<>();
        int checked = 0;
        for (JsonNode row : root.withArray("rows")) {
            if (!"scope".equals(row.path("gate").asText("intersection"))) {
                continue;
            }
            checked++;
            String atom = row.path("atom").asText();
            String scopeType = row.path("scopeType").asText();
            String actual;
            try {
                PermissionAtomCatalog.requireScopeCompatible(atom, scopeType);
                actual = "allow";
            } catch (CpApiException rejected) {
                actual = "deny";
            }
            if (!row.path("expect").asText().equals(actual)) {
                failures.add(row.path("id").asText() + " —— 期望 " + row.path("expect").asText()
                        + "，scope 门实测 " + actual);
            }
        }
        assertEquals(6, checked, "scope 行数必须与基线一致");
        assertTrue(failures.isEmpty(), "scope 门与基线不一致:\n" + String.join("\n", failures));
    }

    @Test
    void everyCapabilityRowIsRefusedByTheExplanationKernelToo() throws Exception {
        JsonNode root = baseline();
        GrantIntersectionEvaluator evaluator = evaluatorWithScopes(root);
        List<String> failures = new ArrayList<>();
        int checked = 0;
        for (JsonNode row : root.withArray("rows")) {
            if (!"capability".equals(row.path("gate").asText("intersection"))) {
                continue;
            }
            checked++;
            String atom = row.path("atom").asText();
            boolean constructible;
            try {
                new GrantIntersectionEvaluator.PermissionAtom(atom, "*");
                constructible = true;
            } catch (IllegalArgumentException rejected) {
                constructible = false;
            }
            if (!"deny".equals(row.path("expect").asText()) || constructible) {
                failures.add(row.path("id").asText() + " —— capability 行必须 deny 且不可构造为 action 原子");
                continue;
            }
            PolicyRequest request = new PolicyRequest("test_tool", List.of(atom), List.of("*"),
                    ToolShape.OPAQUE, "user-1", null, null);
            GrantIntersectionEvaluator.GrantExplanation explanation = evaluator.explain(request, List.of(
                    new GrantIntersectionEvaluator.PrincipalLevel("user-grants", List.of(
                            // task-933: a non-import source carries no origin template
                            new GrantIntersectionEvaluator.GrantAtom("read", "*", "grant-1",
                                    "role", null)))));
            if (explanation.allowed()) {
                failures.add(row.path("id").asText() + " —— capability 原子被 explain 放行");
            }
            if (explanation.missingAtom() == null || !GrantIntersectionEvaluator.REASON_UNKNOWN_ACTION_CLASS
                    .equals(explanation.missingAtom().reason())) {
                failures.add(row.path("id").asText() + " —— 拒绝原因必须是 unknown-action-class，实测 "
                        + explanation.missingAtom());
            }
        }
        assertEquals(4, checked, "capability 行数必须与基线一致");
        assertTrue(failures.isEmpty(), "capability 面 explain 与基线不一致:\n" + String.join("\n", failures));
    }

    @Test
    void theBaselineStillHasTheExpectedSeventyOneRows() throws Exception {
        JsonNode rows = baseline().withArray("rows");
        assertEquals(71, rows.size(),
                "基线行数（task-110 交付 59，task-834 追加三源快照三组共 12 行 ⇒ 71）发生变化，需同步本测试的分布断言");
        int intersection = 0;
        int allow = 0;
        for (JsonNode row : rows) {
            if ("intersection".equals(row.path("gate").asText("intersection"))) {
                intersection++;
                if ("allow".equals(row.path("expect").asText())) {
                    allow++;
                }
            }
        }
        assertEquals(61, intersection, "intersection 行数");
        assertEquals(33, allow, "intersection 行的放行行数");
    }

    private List<GrantIntersectionEvaluator.PrincipalLevel> labelledLevels(JsonNode row,
                                                                          GrantIntersectionEvaluator evaluator) {
        List<GrantIntersectionEvaluator.PrincipalLevel> levels = new ArrayList<>();
        for (JsonNode level : row.withArray("levels")) {
            Set<GrantIntersectionEvaluator.PermissionAtom> atoms = evaluator.parse(level.get("atoms"));
            levels.add(GrantIntersectionEvaluator.PrincipalLevel.of(level.path("label").asText(), atoms));
        }
        return levels;
    }

    private List<Set<GrantIntersectionEvaluator.PermissionAtom>> principalPath(JsonNode row,
                                                                             GrantIntersectionEvaluator evaluator) {
        List<Set<GrantIntersectionEvaluator.PermissionAtom>> path = new ArrayList<>();
        for (JsonNode level : row.withArray("levels")) {
            path.add(evaluator.parse(level.get("atoms")));
        }
        return path;
    }

    /**
     * Same construction as {@code AuthzGoldenBaselineTest}: tokens become real
     * {@link SessionTemporaryGrant} rows and liveness is decided by {@code liveAt(now)}, so this face
     * cannot drift from the decision face.
     */
    private List<GrantIntersectionEvaluator.GrantAtom> liveTokenAtoms(JsonNode row, java.time.Instant now) {
        JsonNode tokens = row.get("tokens");
        if (tokens == null || !tokens.isArray() || tokens.isEmpty()) {
            return List.of();
        }
        List<GrantIntersectionEvaluator.GrantAtom> atoms = new ArrayList<>();
        for (JsonNode token : tokens) {
            String id = token.path("id").asText();
            boolean revoked = token.path("revoked").asBoolean(false);
            SessionTemporaryGrant grant = new SessionTemporaryGrant(
                    java.util.UUID.nameUUIDFromBytes(("token:" + id).getBytes(java.nio.charset.StandardCharsets.UTF_8)),
                    java.util.UUID.nameUUIDFromBytes(("token-session:" + id).getBytes(java.nio.charset.StandardCharsets.UTF_8)),
                    java.util.UUID.nameUUIDFromBytes(("token-workspace:" + id).getBytes(java.nio.charset.StandardCharsets.UTF_8)),
                    java.util.UUID.nameUUIDFromBytes(("token-principal:" + id).getBytes(java.nio.charset.StandardCharsets.UTF_8)),
                    List.of(new GrantIntersectionEvaluator.PermissionAtom(
                            token.path("actionClass").asText(), token.path("resource").asText("*"))),
                    java.util.UUID.nameUUIDFromBytes(("token-granter:" + id).getBytes(java.nio.charset.StandardCharsets.UTF_8)),
                    now.minusSeconds(60),
                    now.plusSeconds(token.path("expiresInSeconds").asLong(300)),
                    revoked ? java.util.UUID.nameUUIDFromBytes(
                            ("token-revoker:" + id).getBytes(java.nio.charset.StandardCharsets.UTF_8)) : null,
                    revoked ? now : null);
            if (!grant.liveAt(now)) {
                continue;
            }
            for (GrantIntersectionEvaluator.PermissionAtom atom : grant.atoms()) {
                atoms.add(new GrantIntersectionEvaluator.GrantAtom(atom.actionClass(), atom.resource(),
                        grant.id().toString(), GrantSources.SESSION_TEMP, null));
            }
        }
        return atoms;
    }

    private PolicyRequest policyRequest(JsonNode row) {
        JsonNode request = row.get("request");
        assertNotNull(request, "intersection 行必须有 request: " + row.path("id").asText());
        return new PolicyRequest(
                request.path("tool").asText("test_tool"),
                strings(request.get("actionClasses")),
                strings(request.get("resources")),
                ToolShape.valueOf(row.path("shape").asText("STRUCTURED")),
                "user-1",
                "workspace-1",
                "session-1");
    }

    private GrantIntersectionEvaluator evaluatorWithScopes(JsonNode root) {
        Map<String, ResourceIdentity.RootScope> scopes = new LinkedHashMap<>();
        root.path("scopes").fields().forEachRemaining(entry -> scopes.put(entry.getKey(),
                new ResourceIdentity.RootScope(
                        ResourceIdentity.ScopeKind.valueOf(entry.getValue().path("kind").asText()),
                        entry.getValue().path("path").asText())));
        GrantIntersectionEvaluator evaluator = new GrantIntersectionEvaluator();
        evaluator.useScopeResolver(scopes::get);
        return evaluator;
    }

    private JsonNode baseline() throws Exception {
        return objectMapper.readTree(Files.readString(locateBaseline()));
    }

    private static Path locateBaseline() {
        Path fromModule = Path.of(BASELINE_RELATIVE);
        if (Files.isRegularFile(fromModule)) {
            return fromModule;
        }
        Path fromRepoRoot = Path.of("packages/control-plane").resolve(BASELINE_RELATIVE);
        if (Files.isRegularFile(fromRepoRoot)) {
            return fromRepoRoot;
        }
        throw new IllegalStateException("找不到 golden 基线文件，已查 " + fromModule.toAbsolutePath()
                + " 与 " + fromRepoRoot.toAbsolutePath());
    }

    private static List<String> strings(JsonNode array) {
        assertNotNull(array, "基线里的字符串数组不得为空指针");
        List<String> values = new ArrayList<>();
        for (JsonNode node : array) {
            values.add(node.asText());
        }
        return values;
    }
}
