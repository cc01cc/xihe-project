package com.cc01cc.p.xihe.cp.api;

import com.cc01cc.p.xihe.cp.AbstractReusableIntegrationTest;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.mvc.method.RequestMappingInfo;
import org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping;
import org.yaml.snakeyaml.Yaml;

import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.SortedSet;
import java.util.TreeSet;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * BL-320: the <b>reverse</b> half of the OpenAPI gate — {@code docs/api/openapi.yaml} must describe
 * exactly the routes the Control Plane actually registers, and nothing else.
 *
 * <p>BL-162 wired {@code scripts/validate-openapi.mjs} into {@code test:cp}, but that gate is purely
 * structural: it never looks at Spring, so "implemented route missing from the contract" and
 * "contracted path that no controller serves" were both invisible. This test closes that hole using
 * the authoritative source — the live {@code RequestMappingHandlerMapping} — compared against the
 * contract parsed with the already-present test-scope SnakeYAML (no new dependency).</p>
 *
 * <p>Comparison is <b>shape-based</b>: every path variable (including regex-constrained ones such as
 * {@code {fileId:[a-fA-F0-9\\-]{36}}}) canonicalizes to {@code {}}, trailing/duplicate slashes are
 * collapsed. Variable <i>names</i> are compared separately for matched pairs, because they are part
 * of the generated-client surface even though Spring matches on position.</p>
 *
 * <p>PLAN-0763 M5 (task-240 audit): comparison keys are {@code METHOD + shape}, not bare shape.
 * {@code implementedRoutes()} expands each mapping's methods condition
 * ({@code RequestMappingInfo.getMethodsCondition()}) across its patterns; {@code documentedRoutes()}
 * iterates each path item's operation keys. "A method the contract claims on a path nobody serves"
 * (405 at runtime) and "a method the code serves that the contract never mentions" both surface now.
 * The exemption tables stay keyed by <b>shape</b> on purpose: an exempted shape exempts every method
 * on it — the same effective semantics as before the upgrade, when method was never compared.</p>
 *
 * <p>Four explicit lists keep the test honest. Nothing here is a regex sweep; every entry is a
 * literal with a reason token:</p>
 * <ul>
 *   <li>{@link #EXEMPT_IMPLEMENTED} — routes the framework/springdoc register, never client-facing;</li>
 *   <li>{@link #EXEMPT_DOCUMENTED} — paths served by <b>another</b> XH service (the contract spans the
 *       whole platform: {@code packages/runtime} Rust serves {@code /internal/v1/runtime/**},
 *       {@code packages/agent} Python serves {@code /internal/v1/agent/**}), plus two convenience
 *       paths that resolve onto the generic config routes;</li>
 *   <li>{@link #KNOWN_GAPS} — the BL-320 backlog itself, frozen entry-by-entry. This list is
 *       <b>self-cleaning</b>: fixing a gap without removing its line turns this test red.</li>
 *   <li>{@link #PARAM_NAME_EXEMPT} — same route, different variable name (runtime-equivalent, but a
 *       client-generation inconsistency worth naming instead of hiding).</li>
 * </ul>
 */
class RouteContractParityTest extends AbstractReusableIntegrationTest {

    /** The MVC bean only (actuator's endpoint handler mappings are separate beans and are not APIs). */
    @Autowired
    @Qualifier("requestMappingHandlerMapping")
    private RequestMappingHandlerMapping handlerMapping;

    /** Reason tokens; every entry below carries exactly one. */
    private static final String RUNTIME_SERVICE = "runtime-service";   // served by packages/runtime (Rust)
    private static final String AGENT_SERVICE = "agent-service";       // served by packages/agent (Python)
    private static final String SPRINGDOC = "springdoc";              // springdoc framework endpoints
    private static final String BOOT_ERROR = "spring-boot-error";     // BasicErrorController
    private static final String KEPT_BY_DESIGN = "kept-by-design";     // contract convenience spelling, intentionally kept
    /** D-932 / PLAN-0767 M1: planted contract, CP implementation lands in M1-3. */
    private static final String PLAN_0767_M1 = "PLAN-0767-M1";

    /** Implemented by CP but intentionally not contracted (framework surfaces). */
    private static final Map<String, String> EXEMPT_IMPLEMENTED = new LinkedHashMap<>();

    /** Contracted but implemented outside this service (cross-service) or kept-by-design spellings. */
    private static final Map<String, String> EXEMPT_DOCUMENTED = new LinkedHashMap<>();

    /** BL-320 backlog: implemented-but-uncontracted routes, frozen until the batches land. */
    private static final Map<String, String> KNOWN_GAPS = new LinkedHashMap<>();

    /**
     * Planned surface (D-932): contracted paths with no implementation <b>yet</b>, admitted by a PLAN
     * and tracked to a batch. This is the extra side's counterpart of {@link #KNOWN_GAPS} — the
     * opposite direction ("documented but not implemented") and the opposite lifecycle: entries are
     * added <b>with</b> the contract change and must be removed when the code lands, so an entry here
     * never means "forgotten", it means "scheduled".
     */
    private static final Map<String, String> PLANNED_APIS = new LinkedHashMap<>();

    /** Matched shape, differing path-variable names (informational: runtime-equal, client-visible). */
    private static final Map<String, String> PARAM_NAME_EXEMPT = new LinkedHashMap<>();

    static {
        // ---- framework / springdoc: registered by the servlet container, not a product API ----
        EXEMPT_IMPLEMENTED.put("/error", BOOT_ERROR);
        EXEMPT_IMPLEMENTED.put("/swagger-ui.html", SPRINGDOC);
        EXEMPT_IMPLEMENTED.put("/v3/api-docs", SPRINGDOC);
        EXEMPT_IMPLEMENTED.put("/v3/api-docs.yaml", SPRINGDOC);
        EXEMPT_IMPLEMENTED.put("/v3/api-docs/swagger-config", SPRINGDOC);

        // ---- cross-service: the contract describes the whole XH platform; these are served by
        //      packages/runtime (Rust, 82 route references) and packages/agent (Python, 61) ----
        EXEMPT_DOCUMENTED.put("/internal/v1/runtime/capabilities/direct-attach/probe", RUNTIME_SERVICE);
        EXEMPT_DOCUMENTED.put("/internal/v1/runtime/remote-mcp/{}/{}/call", RUNTIME_SERVICE);
        EXEMPT_DOCUMENTED.put("/internal/v1/runtime/workspaces", RUNTIME_SERVICE);
        EXEMPT_DOCUMENTED.put("/internal/v1/runtime/workspaces/delete", RUNTIME_SERVICE);
        EXEMPT_DOCUMENTED.put("/internal/v1/runtime/workspaces/{}/checkpoints/blob", RUNTIME_SERVICE);
        EXEMPT_DOCUMENTED.put("/internal/v1/runtime/workspaces/{}/checkpoints/capture", RUNTIME_SERVICE);
        EXEMPT_DOCUMENTED.put("/internal/v1/runtime/workspaces/{}/checkpoints/cleanup", RUNTIME_SERVICE);
        EXEMPT_DOCUMENTED.put("/internal/v1/runtime/workspaces/{}/checkpoints/gc", RUNTIME_SERVICE);
        EXEMPT_DOCUMENTED.put("/internal/v1/runtime/workspaces/{}/checkpoints/revert", RUNTIME_SERVICE);
        EXEMPT_DOCUMENTED.put("/internal/v1/runtime/workspaces/{}/checkpoints/revert/preview", RUNTIME_SERVICE);
        EXEMPT_DOCUMENTED.put("/internal/v1/runtime/workspaces/{}/executions/{}/cancel", RUNTIME_SERVICE);
        EXEMPT_DOCUMENTED.put("/internal/v1/runtime/workspaces/{}/files/delete", RUNTIME_SERVICE);
        EXEMPT_DOCUMENTED.put("/internal/v1/runtime/workspaces/{}/files/list", RUNTIME_SERVICE);
        EXEMPT_DOCUMENTED.put("/internal/v1/runtime/workspaces/{}/files/mkdir", RUNTIME_SERVICE);
        EXEMPT_DOCUMENTED.put("/internal/v1/runtime/workspaces/{}/files/read", RUNTIME_SERVICE);
        EXEMPT_DOCUMENTED.put("/internal/v1/runtime/workspaces/{}/files/stat", RUNTIME_SERVICE);
        EXEMPT_DOCUMENTED.put("/internal/v1/runtime/workspaces/{}/files/write/{}", RUNTIME_SERVICE);
        EXEMPT_DOCUMENTED.put("/internal/v1/runtime/workspaces/{}/git-diff", RUNTIME_SERVICE);
        EXEMPT_DOCUMENTED.put("/internal/v1/runtime/workspaces/{}/git-facts", RUNTIME_SERVICE);
        EXEMPT_DOCUMENTED.put("/internal/v1/runtime/workspaces/{}/git-log", RUNTIME_SERVICE);
        EXEMPT_DOCUMENTED.put("/internal/v1/runtime/workspaces/{}/git-status", RUNTIME_SERVICE);
        EXEMPT_DOCUMENTED.put("/internal/v1/runtime/workspaces/{}/jobs/cancel", RUNTIME_SERVICE);
        EXEMPT_DOCUMENTED.put("/internal/v1/runtime/workspaces/{}/jobs/capabilities", RUNTIME_SERVICE);
        EXEMPT_DOCUMENTED.put("/internal/v1/runtime/workspaces/{}/jobs/cleanup", RUNTIME_SERVICE);
        EXEMPT_DOCUMENTED.put("/internal/v1/runtime/workspaces/{}/jobs/output", RUNTIME_SERVICE);
        EXEMPT_DOCUMENTED.put("/internal/v1/runtime/workspaces/{}/jobs/start", RUNTIME_SERVICE);
        EXEMPT_DOCUMENTED.put("/internal/v1/runtime/workspaces/{}/jobs/status", RUNTIME_SERVICE);
        EXEMPT_DOCUMENTED.put("/internal/v1/runtime/workspaces/{}/materialize", RUNTIME_SERVICE);
        EXEMPT_DOCUMENTED.put("/internal/v1/runtime/workspaces/{}/mcp", RUNTIME_SERVICE);
        EXEMPT_DOCUMENTED.put("/internal/v1/runtime/workspaces/{}/mcp/servers", RUNTIME_SERVICE);
        EXEMPT_DOCUMENTED.put("/internal/v1/runtime/workspaces/{}/mcp/servers/{}", RUNTIME_SERVICE);
        EXEMPT_DOCUMENTED.put("/internal/v1/runtime/workspaces/{}/mcp/spawn", RUNTIME_SERVICE);
        EXEMPT_DOCUMENTED.put("/internal/v1/runtime/workspaces/{}/mcp/stdio/{}", RUNTIME_SERVICE);
        EXEMPT_DOCUMENTED.put("/internal/v1/runtime/workspaces/{}/release", RUNTIME_SERVICE);
        EXEMPT_DOCUMENTED.put("/internal/v1/runtime/workspaces/{}/status", RUNTIME_SERVICE);

        EXEMPT_DOCUMENTED.put("/internal/v1/agent/approval/pending", AGENT_SERVICE);
        EXEMPT_DOCUMENTED.put("/internal/v1/agent/approval/respond", AGENT_SERVICE);
        EXEMPT_DOCUMENTED.put("/internal/v1/agent/approval/{}", AGENT_SERVICE);
        EXEMPT_DOCUMENTED.put("/internal/v1/agent/chat", AGENT_SERVICE);
        EXEMPT_DOCUMENTED.put("/internal/v1/agent/embedding-models", AGENT_SERVICE);
        EXEMPT_DOCUMENTED.put("/internal/v1/agent/health", AGENT_SERVICE);
        EXEMPT_DOCUMENTED.put("/internal/v1/agent/judge/decide", AGENT_SERVICE);
        EXEMPT_DOCUMENTED.put("/internal/v1/agent/mcp/reinit", AGENT_SERVICE);
        EXEMPT_DOCUMENTED.put("/internal/v1/agent/models", AGENT_SERVICE);
        EXEMPT_DOCUMENTED.put("/internal/v1/agent/rag/documents/{}/delete", AGENT_SERVICE);
        EXEMPT_DOCUMENTED.put("/internal/v1/agent/rag/embedding/test", AGENT_SERVICE);
        EXEMPT_DOCUMENTED.put("/internal/v1/agent/rag/ingest", AGENT_SERVICE);
        EXEMPT_DOCUMENTED.put("/internal/v1/agent/rag/search", AGENT_SERVICE);
        EXEMPT_DOCUMENTED.put("/internal/v1/agent/rag/stats", AGENT_SERVICE);
        EXEMPT_DOCUMENTED.put("/internal/v1/agent/registry/workers", AGENT_SERVICE);
        EXEMPT_DOCUMENTED.put("/internal/v1/agent/registry/workers/{}/disable", AGENT_SERVICE);
        EXEMPT_DOCUMENTED.put("/internal/v1/agent/registry/workers/{}/enable", AGENT_SERVICE);
        EXEMPT_DOCUMENTED.put("/internal/v1/agent/runs/{}/cancel", AGENT_SERVICE);
        EXEMPT_DOCUMENTED.put("/internal/v1/agent/summarize", AGENT_SERVICE);
        EXEMPT_DOCUMENTED.put("/internal/v1/agent/tools", AGENT_SERVICE);
        EXEMPT_DOCUMENTED.put("/internal/v1/agent/user-question/respond", AGENT_SERVICE);

        // ---- 有意保留（kept-by-design，BL-320 批 3 / 2026-11-05 Lead 裁定）：契约里这两条不是
        //      独立注册的路由，而是 GET /api/v1/config/{domain} 与 PUT /api/v1/config/{layer}/{domain}
        //      在 domain=api-request-templates 时的具体示例写法。它们的价值是把该 domain 的专属 query /
        //      响应/不可变修订语义写清楚 —— 删掉反而是把"契约更详细"当缺陷。契约里已各自标注 ----
        EXEMPT_DOCUMENTED.put("/api/v1/config/api-request-templates", KEPT_BY_DESIGN);
        EXEMPT_DOCUMENTED.put("/api/v1/config/{}/api-request-templates", KEPT_BY_DESIGN);

        // ---- 计划内契约（D-932，PLAN-0767 M1）：yaml 先行、CP 实现后置。条目随契约变更加入，
        //      代码落地的那一刻删除 —— 它永远表示"已排期"，不表示"忘了实现" ----
        PLANNED_APIS.put("/api/v1/instance/identity", PLAN_0767_M1);

        // ---- BL-320 冻结清单当前**为空**：批 1 把 8 条真缺契约补进 openapi.yaml，批 2 把
        //      principal-grants 退役面记为 deprecated 契约；批 5（PLAN-0763 M5）由 METHOD+path
        //      升级抓到的两条债（setWorkspaceAgentCap 轴错位、files/{fileId} 的 delete 残留）
        //      已在 task-134 修清并从本表删除。空表是**目标态**，不是"没有机制"：新缺口必须按
        //      \`BL-320 批 N\` 逐条登记在这里，而不是去放宽断言 ----
        // KNOWN_GAPS.put("<shape>", "<batch token>");

        // ---- 参数名豁免当前**为空**：批 2 已把 /api/v1/workspaces/{wsId}/mcp/servers 统一为
        //      {workspaceId}。若再出现"同形状不同变量名"，必须逐条登记并写清"为何运行时等价" ----
        // PARAM_NAME_EXEMPT.put("<shape>", "<reason token>");
    }

    @Test
    void implementedRoutesAndDocumentedPathsMatchInBothDirections() throws Exception {
        Map<String, String> implemented = mapToSample(implementedRoutes());
        Map<String, String> documented = mapToSample(documentedRoutes());

        List<String> missing = difference(implemented.keySet(), documented.keySet());
        List<String> extra = difference(documented.keySet(), implemented.keySet());

        List<String> unexpectedMissing = notExempt(missing, EXEMPT_IMPLEMENTED, KNOWN_GAPS);
        List<String> unexpectedExtra = notExempt(extra, EXEMPT_DOCUMENTED, KNOWN_GAPS, PLANNED_APIS);

        // Operational summary for the report: the diff itself is never hidden, it is bucketed.
        // Buckets are counted per candidate (classify), not per distinct shape (countIn): two methods
        // on one path share a shape, and counting shapes made total != bucketA + bucketB + unexpected
        // (observed 59 vs 58+0 on 2026-11-11). The assertion below keeps that arithmetic honest.
        int[] missingBuckets = classify(missing, EXEMPT_IMPLEMENTED, KNOWN_GAPS);
        int[] extraBuckets = classify(extra, EXEMPT_DOCUMENTED, KNOWN_GAPS, PLANNED_APIS);
        System.out.println("[bl320] implemented=" + implemented.size() + " documented=" + documented.size()
                + " | missing: total=" + missing.size() + " framework=" + missingBuckets[0]
                + " frozen-gap=" + missingBuckets[1] + " unexpected=" + unexpectedMissing.size()
                + " | extra: total=" + extra.size() + " cross-service/kept-by-design=" + extraBuckets[0]
                + " frozen-gap=" + extraBuckets[1] + " planned=" + extraBuckets[2]
                + " unexpected=" + unexpectedExtra.size()
                + " | param-name-exempt=" + PARAM_NAME_EXEMPT.size());

        assertBucketsAccountForTotal("missing", missing.size(), missingBuckets, unexpectedMissing.size());
        assertBucketsAccountForTotal("extra", extra.size(), extraBuckets, unexpectedExtra.size());

        assertEquals(List.of(), unexpectedMissing, () -> report(
                "route(s) implemented but missing from docs/api/openapi.yaml", unexpectedMissing, missing,
                implemented, EXEMPT_IMPLEMENTED, KNOWN_GAPS));
        assertEquals(List.of(), unexpectedExtra, () -> report(
                "route(s) documented in docs/api/openapi.yaml but implemented by no CP controller",
                unexpectedExtra, extra, documented, EXEMPT_DOCUMENTED, KNOWN_GAPS));

        // The frozen backlog must not drift: a fixed gap has to be deleted from KNOWN_GAPS (else the
        // list silently rots into "everything is a known gap"). M5: a gap may sit on either side —
        // "contract claims a method nobody serves" is the same debt as "code serves a method the
        // contract never mentions" (the setWorkspaceAgentCap pair is one such single debt).
        Set<String> gapHits = new TreeSet<>(intersectShapes(missing, KNOWN_GAPS.keySet()));
        gapHits.addAll(intersectShapes(extra, KNOWN_GAPS.keySet()));
        assertEquals(new TreeSet<>(KNOWN_GAPS.keySet()), gapHits,
                "KNOWN_GAPS drifted — fixed gaps must be removed from the list, new ones must be bucketed "
                        + "explicitly (see .local/evidence/bl-320-route-contract-parity.md)");

        assertVariableNamesMatch(documentedRoutes(), implementedRoutes());
    }

    // ------------------------------------------------------------------ parameter names

    private void assertVariableNamesMatch(List<String> documentedRaw, List<String> implementedRaw) {
        Map<String, List<String>> documentedByName = variablesByName(documentedRaw);
        Map<String, List<String>> implementedByName = variablesByName(implementedRaw);
        List<String> mismatches = new ArrayList<>();
        for (Map.Entry<String, List<String>> entry : documentedByName.entrySet()) {
            List<String> implementedVariables = implementedByName.get(entry.getKey());
            if (implementedVariables == null || PARAM_NAME_EXEMPT.containsKey(entry.getKey())) {
                continue;
            }
            if (!entry.getValue().equals(implementedVariables)) {
                mismatches.add(entry.getKey() + " documented=" + entry.getValue()
                        + " implemented=" + implementedVariables);
            }
        }
        assertEquals(List.of(), mismatches,
                () -> "path-variable names differ between the contract and the controllers (runtime-equal, "
                        + "but client codegen sees them); fix the contract or add an explicit "
                        + "PARAM_NAME_EXEMPT entry with a reason:\n  " + String.join("\n  ", mismatches));
    }

    private static Map<String, List<String>> variablesByName(List<String> rawRoutes) {
        Map<String, List<String>> byName = new LinkedHashMap<>();
        for (String raw : rawRoutes) {
            Parsed parsed = parse(pathOf(raw));
            byName.put(parsed.shape(), parsed.variables());
        }
        return byName;
    }

    // ------------------------------------------------------------------ sources

    /** OpenAPI path-item keys that are operations (the rest: summary/description/parameters/$ref/servers). */
    private static final Set<String> OPENAPI_OPERATIONS =
            Set.of("get", "post", "put", "delete", "options", "head", "patch", "trace");

    /**
     * Implemented side of the comparison: one {@code "METHOD /pattern"} entry per declared method per
     * pattern. Every CP handler declares methods explicitly, so {@code ANY} is a fail-loud fallback,
     * not an expected state — if it ever appears in the diff, the mapping that produced it must be
     * given an explicit reason token like everything else.
     */
    private List<String> implementedRoutes() {
        List<String> routes = new ArrayList<>();
        for (Map.Entry<RequestMappingInfo, HandlerMethod> entry : handlerMapping.getHandlerMethods().entrySet()) {
            RequestMappingInfo info = entry.getKey();
            Set<RequestMethod> methods = info.getMethodsCondition().getMethods();
            for (String pattern : info.getPatternValues()) {
                if (methods.isEmpty()) {
                    routes.add("ANY " + pattern);
                } else {
                    for (RequestMethod method : methods) {
                        routes.add(method.name() + " " + pattern);
                    }
                }
            }
        }
        return routes;
    }

    /** Documented side: one {@code "METHOD /path"} entry per operation under {@code paths}. */
    private List<String> documentedRoutes() throws Exception {
        Path contract = Path.of("..", "..", "docs", "api", "openapi.yaml");
        List<String> routes = new ArrayList<>();
        try (InputStream input = Files.newInputStream(contract)) {
            Map<?, ?> document = new Yaml().load(input);
            Map<?, ?> paths = (Map<?, ?>) document.get("paths");
            for (Map.Entry<?, ?> item : paths.entrySet()) {
                Map<?, ?> operations = (Map<?, ?>) item.getValue();
                for (Map.Entry<?, ?> operation : operations.entrySet()) {
                    String verb = String.valueOf(operation.getKey()).toLowerCase(Locale.ROOT);
                    if (OPENAPI_OPERATIONS.contains(verb)) {
                        routes.add(verb.toUpperCase(Locale.ROOT) + " " + item.getKey());
                    }
                }
            }
        }
        return routes;
    }

    // ------------------------------------------------------------------ comparison helpers

    /**
     * Comparison key = {@code METHOD + shape} (route keys are {@code "METHOD /raw/path"}); the sample
     * keeps the first raw spelling for the report.
     */
    private static Map<String, String> mapToSample(List<String> rawRoutes) {
        Map<String, String> byKey = new LinkedHashMap<>();
        for (String raw : rawRoutes) {
            byKey.putIfAbsent(methodOf(raw) + " " + parse(pathOf(raw)).shape(), raw.trim());
        }
        return byKey;
    }

    private static String methodOf(String rawRoute) {
        int space = rawRoute.indexOf(' ');
        return space < 0 ? "ANY" : rawRoute.substring(0, space).trim().toUpperCase(Locale.ROOT);
    }

    private static String pathOf(String rawRoute) {
        int space = rawRoute.indexOf(' ');
        return space < 0 ? rawRoute : rawRoute.substring(space + 1);
    }

    /** Sorted shapes present on the left and absent on the right. */
    private static List<String> difference(java.util.Set<String> left, java.util.Set<String> right) {
        SortedSet<String> diff = new TreeSet<>(left);
        diff.removeAll(right);
        return new ArrayList<>(diff);
    }

    /** Buckets are keyed by <b>shape</b>; candidates are {@code METHOD shape} keys — compare the shape. */
    private static List<String> notExempt(List<String> candidates, Map<String, String>... exempt) {
        List<String> residual = new ArrayList<>();
        for (String candidate : candidates) {
            String shape = parse(pathOf(candidate)).shape();
            boolean allowed = false;
            for (Map<String, String> bucket : exempt) {
                if (bucket.containsKey(shape)) {
                    allowed = true;
                    break;
                }
            }
            if (!allowed) {
                residual.add(candidate);
            }
        }
        return residual;
    }

    /** Shapes of the candidates that the shape-keyed bucket allows (sorted, deduplicated). */
    private static List<String> intersectShapes(List<String> candidates, java.util.Set<String> allowedShapes) {
        SortedSet<String> hits = new TreeSet<>();
        for (String candidate : candidates) {
            String shape = parse(pathOf(candidate)).shape();
            if (allowedShapes.contains(shape)) {
                hits.add(shape);
            }
        }
        return new ArrayList<>(hits);
    }

    /**
     * Per-candidate classification against shape-keyed buckets, in the <b>same</b> order of
     * precedence {@link #notExempt} uses (first match wins, so buckets must not overlap in practice —
     * an overlapping shape would be counted once, in the earliest bucket). Counting candidates (not
     * distinct shapes) is what makes {@code total == sum(buckets) + unexpected} hold;
     * {@link #countIn} deduplicates shapes and therefore under-counts when two methods share one path
     * (e.g. GET + PUT on the same shape).
     */
    private static int[] classify(List<String> candidates, Map<String, String>... buckets) {
        int[] counts = new int[buckets.length];
        for (String candidate : candidates) {
            String shape = parse(pathOf(candidate)).shape();
            for (int i = 0; i < buckets.length; i++) {
                if (buckets[i].containsKey(shape)) {
                    counts[i]++;
                    break;
                }
            }
        }
        return counts;
    }

    /** Invariant: every candidate lands in exactly one bucket, so the printed numbers add up. */
    private static void assertBucketsAccountForTotal(String axis, int total, int[] bucketCounts,
            int unexpected) {
        int sum = java.util.Arrays.stream(bucketCounts).sum();
        assertEquals(total, sum + unexpected,
                () -> axis + " bucketing does not add up: total=" + total + " buckets="
                        + java.util.Arrays.toString(bucketCounts) + " unexpected=" + unexpected);
    }
    private static int countIn(List<String> candidates, Map<String, String> bucket) {
        return intersectShapes(candidates, bucket.keySet()).size();
    }

    private static String report(String headline, List<String> unexpected, List<String> allKeys,
            Map<String, String> samples, Map<String, String> exemptA, Map<String, String> exemptB) {
        StringBuilder message = new StringBuilder(headline).append('=').append(unexpected.size()).append('\n');
        for (String key : unexpected) {
            message.append("  - ").append(key).append("   (sample: ").append(samples.get(key)).append(")\n");
        }
        message.append("  full diff (").append(allKeys.size()).append("):\n");
        for (String key : allKeys) {
            String shape = parse(pathOf(key)).shape();
            String reason = exemptA.getOrDefault(shape, exemptB.getOrDefault(shape, "UNEXPLAINED"));
            message.append("    ").append(key).append("  [").append(reason).append("]\n");
        }
        return message.toString();
    }

    /**
     * Canonical form: every path variable (regex-constrained or not, braces of a variable may nest —
     * {@code {fileId:[a-fA-F0-9\\-]{36}}} — becomes {@code {}}); slashes collapsed, trailing removed.
     */
    private static Parsed parse(String raw) {
        String path = raw.trim();
        StringBuilder shape = new StringBuilder();
        List<String> variables = new ArrayList<>();
        StringBuilder current = null;
        int depth = 0;
        for (int index = 0; index < path.length(); index++) {
            char character = path.charAt(index);
            if (character == '{') {
                depth++;
                if (depth == 1) {
                    current = new StringBuilder();
                } else {
                    current.append(character);
                }
                continue;
            }
            if (character == '}' && depth > 0) {
                depth--;
                if (depth == 0) {
                    String inner = current.toString();
                    int colon = inner.indexOf(':');
                    variables.add(colon >= 0 ? inner.substring(0, colon).trim() : inner.trim());
                    shape.append("{}");
                    current = null;
                } else {
                    current.append(character);
                }
                continue;
            }
            if (depth > 0) {
                current.append(character);
            } else {
                shape.append(character);
            }
        }
        return new Parsed(canonicalize(shape.toString()), List.copyOf(variables));
    }

    private static String canonicalize(String path) {
        String value = path;
        while (value.contains("//")) {
            value = value.replace("//", "/");
        }
        if (value.length() > 1 && value.endsWith("/")) {
            value = value.substring(0, value.length() - 1);
        }
        return value;
    }

    private record Parsed(String shape, List<String> variables) {
    }
}
