package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * DSD-1497 三件保险之二：授权决策表 golden 基线。
 *
 * <p>基线数据在 {@code authz-golden-baseline.json}（同包目录，人可读，每行带 intent）。本测试只做两件事：
 * ①核对矩阵覆盖面（行数、允许/拒绝平衡、八个类别都在）；②逐行按 {@code (principalPath, atom, resource)}
 * 断言求值裁决与基线一致。期望值一律从基线读，测试里不写死任何一行裁决 —— 这样基线被改动时，
 * 测试只会跟着基线走，覆盖面的约束仍由 {@link #baselineCoversTheRequiredMatrix()} 挡住。</p>
 *
 * <p>三档判据来源：交集语义 {@code GrantIntersectionEvaluator.allows:98-121}；scope 门
 * {@code PermissionAtomCatalog.requireScopeCompatible:438-445}；capability/词汇表门
 * {@code GrantIntersectionEvaluator.PermissionAtom:18-34}（capability 原子不是 action 原子，构造即抛）。</p>
 */
class AuthzGoldenBaselineTest {

    private static final String BASELINE_RELATIVE =
            "src/test/java/com/cc01cc/p/xihe/cp/policy/authz-golden-baseline.json";

    private final ObjectMapper objectMapper = new ObjectMapper();

    @Test
    void baselineCoversTheRequiredMatrix() throws Exception {
        JsonNode root = baseline();
        JsonNode rows = root.withArray("rows");

        assertTrue(rows.size() >= 40, "基线场景必须 >= 40 行，实测 " + rows.size());

        Map<String, Integer> allowByCategory = new LinkedHashMap<>();
        Map<String, Integer> denyByCategory = new LinkedHashMap<>();
        int allow = 0;
        int deny = 0;
        for (JsonNode row : rows) {
            String category = row.path("category").asText();
            assertFalse(category.isBlank(), "每行必须带 category: " + row.path("id").asText());
            assertFalse(row.path("intent").asText().isBlank(),
                    "每行必须带人可读 intent: " + row.path("id").asText());
            String expect = row.path("expect").asText();
            assertTrue("allow".equals(expect) || "deny".equals(expect),
                    "expect 只能是 allow/deny: " + row.path("id").asText() + " = " + expect);
            if ("allow".equals(expect)) {
                allow++;
                allowByCategory.merge(category, 1, Integer::sum);
            } else {
                deny++;
                denyByCategory.merge(category, 1, Integer::sum);
            }
        }

        assertTrue(allow >= 20, "允许行必须 >= 20，实测 " + allow);
        assertTrue(deny >= 20, "拒绝行必须 >= 20，实测 " + deny);
        assertTrue(Math.abs(allow - deny) <= 6, "允许/拒绝必须大致各半，实测 allow=" + allow + " deny=" + deny);

        Set<String> required = new LinkedHashSet<>(List.of(
                "single-level", "parent-chain", "fs-prefix", "empty-grants",
                "snapshot-drift", "instance-only-scope", "capability-atom"));
        Set<String> seen = new LinkedHashSet<>();
        seen.addAll(allowByCategory.keySet());
        seen.addAll(denyByCategory.keySet());
        for (String category : required) {
            assertTrue(seen.contains(category), "缺少必覆盖类别: " + category);
            int total = allowByCategory.getOrDefault(category, 0) + denyByCategory.getOrDefault(category, 0);
            assertTrue(total >= 4, "类别 " + category + " 至少要 4 行，实测 " + total);
        }

        // fs 前置：实例级 + 工作区级两种声明写法都有，否则「同一物理目录」这条判据没被真正走到。
        assertNotNull(root.path("scopes").path("ws-root").path("path").asText());
        assertEquals("WORKSPACE", root.path("scopes").path("ws-root").path("kind").asText());
        assertEquals("INSTANCE", root.path("scopes").path("inst-root").path("kind").asText());
    }

    @Test
    void everyRowMatchesItsExpectedVerdict() throws Exception {
        JsonNode root = baseline();
        GrantIntersectionEvaluator evaluator = evaluatorWithScopes(root);

        List<String> failures = new ArrayList<>();
        int checked = 0;
        for (JsonNode row : root.withArray("rows")) {
            checked++;
            String id = row.path("id").asText();
            String expect = row.path("expect").asText();
            String actual = verdict(row, evaluator);
            if (!expect.equals(actual)) {
                failures.add(id + " (" + row.path("category").asText() + ") " + row.path("intent").asText()
                        + " —— 期望 " + expect + "，实测 " + actual);
            }
        }
        assertEquals(root.withArray("rows").size(), checked, "基线行数必须与核对行数一致");
        assertTrue(failures.isEmpty(), "以下基线行与求值裁决不一致（" + failures.size() + " 行）:\n"
                + String.join("\n", failures));
    }

    @Test
    void capabilityAtomsAreNotActionAtoms() {
        // 反向钉子：capability 原子既不在 action 词汇表里，也不能被当成 action 原子建出来。
        for (String capability : List.of("instance:super", "instance:admin", "workspace:admin")) {
            assertTrue(PermissionAtomCatalog.isCapabilityAtom(capability), capability + " 必须是 capability 原子");
            assertFalse(PermissionAtomCatalog.isActionAtom(capability), capability + " 不得是 action 原子");
        }
    }

    private String verdict(JsonNode row, GrantIntersectionEvaluator evaluator) {
        String gate = row.path("gate").asText("intersection");
        if ("scope".equals(gate)) {
            String atom = row.path("atom").asText();
            String scopeType = row.path("scopeType").asText();
            try {
                PermissionAtomCatalog.requireScopeCompatible(atom, scopeType);
                return "allow";
            } catch (CpApiException rejected) {
                return "deny";
            }
        }
        if ("capability".equals(gate)) {
            String atom = row.path("atom").asText();
            try {
                new GrantIntersectionEvaluator.PermissionAtom(atom, "*");
                return "allow";
            } catch (IllegalArgumentException rejected) {
                return "deny";
            }
        }

        List<Set<GrantIntersectionEvaluator.PermissionAtom>> principalPath = new ArrayList<>();
        for (JsonNode level : row.withArray("levels")) {
            principalPath.add(evaluator.parse(level.get("atoms")));
        }
        JsonNode request = row.get("request");
        assertNotNull(request, "intersection 行必须有 request: " + row.path("id").asText());
        PolicyRequest policyRequest = new PolicyRequest(
                request.path("tool").asText("test_tool"),
                strings(request.get("actionClasses")),
                strings(request.get("resources")),
                ToolShape.valueOf(row.path("shape").asText("STRUCTURED")),
                "user-1",
                "workspace-1",
                "session-1");
        return evaluator.allows(policyRequest, principalPath) ? "allow" : "deny";
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
        Path path = locateBaseline();
        return objectMapper.readTree(Files.readString(path));
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
                + " 与 " + fromRepoRoot.toAbsolutePath() + "（user.dir=" + Path.of("").toAbsolutePath() + "）");
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
