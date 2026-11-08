package com.cc01cc.p.xihe.cp.api;

import com.cc01cc.p.xihe.cp.AbstractReusableIntegrationTest;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
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
import java.util.Map;
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

    /** Implemented by CP but intentionally not contracted (framework surfaces). */
    private static final Map<String, String> EXEMPT_IMPLEMENTED = new LinkedHashMap<>();

    /** Contracted but implemented outside this service (cross-service) or kept-by-design spellings. */
    private static final Map<String, String> EXEMPT_DOCUMENTED = new LinkedHashMap<>();

    /** BL-320 backlog: implemented-but-uncontracted routes, frozen until the batches land. */
    private static final Map<String, String> KNOWN_GAPS = new LinkedHashMap<>();

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
        EXEMPT_DOCUMENTED.put("/internal/v1/agent/summarize", AGENT_SERVICE);
        EXEMPT_DOCUMENTED.put("/internal/v1/agent/tools", AGENT_SERVICE);
        EXEMPT_DOCUMENTED.put("/internal/v1/agent/user-question/respond", AGENT_SERVICE);

        // ---- 有意保留（kept-by-design，BL-320 批 3 / 2026-11-05 Lead 裁定）：契约里这两条不是
        //      独立注册的路由，而是 GET /api/v1/config/{domain} 与 PUT /api/v1/config/{layer}/{domain}
        //      在 domain=api-request-templates 时的具体示例写法。它们的价值是把该 domain 的专属 query /
        //      响应/不可变修订语义写清楚 —— 删掉反而是把"契约更详细"当缺陷。契约里已各自标注 ----
        EXEMPT_DOCUMENTED.put("/api/v1/config/api-request-templates", KEPT_BY_DESIGN);
        EXEMPT_DOCUMENTED.put("/api/v1/config/{}/api-request-templates", KEPT_BY_DESIGN);

        // ---- BL-320 冻结清单当前**为空**：批 1 把 8 条真缺契约补进 openapi.yaml，批 2 把
        //      principal-grants 退役面记为 deprecated 契约。空表是**目标态**，不是"没有机制"：
        //      新缺口必须按 `BL-320 批 N` 逐条登记在这里，而不是去放宽断言 ----
        // KNOWN_GAPS.put("<shape>", "<batch token>");

        // ---- 参数名豁免当前**为空**：批 2 已把 /api/v1/workspaces/{wsId}/mcp/servers 统一为
        //      {workspaceId}。若再出现"同形状不同变量名"，必须逐条登记并写清"为何运行时等价" ----
        // PARAM_NAME_EXEMPT.put("<shape>", "<reason token>");
    }

    @Test
    void implementedRoutesAndDocumentedPathsMatchInBothDirections() throws Exception {
        Map<String, String> implemented = mapToSample(implementedPaths());
        Map<String, String> documented = mapToSample(documentedPaths());

        List<String> missing = difference(implemented.keySet(), documented.keySet());
        List<String> extra = difference(documented.keySet(), implemented.keySet());

        List<String> unexpectedMissing = notExempt(missing, EXEMPT_IMPLEMENTED, KNOWN_GAPS);
        List<String> unexpectedExtra = notExempt(extra, EXEMPT_DOCUMENTED, Map.of());

        // Operational summary for the report: the diff itself is never hidden, it is bucketed.
        System.out.println("[bl320] implemented=" + implemented.size() + " documented=" + documented.size()
                + " | missing: total=" + missing.size() + " framework=" + countIn(missing, EXEMPT_IMPLEMENTED)
                + " frozen-gap=" + KNOWN_GAPS.size() + " unexpected=" + unexpectedMissing.size()
                + " | extra: total=" + extra.size() + " cross-service/kept-by-design="
                + countIn(extra, EXEMPT_DOCUMENTED) + " unexpected=" + unexpectedExtra.size()
                + " | param-name-exempt=" + PARAM_NAME_EXEMPT.size());

        assertEquals(List.of(), unexpectedMissing, () -> report(
                "route(s) implemented but missing from docs/api/openapi.yaml", unexpectedMissing, missing,
                implemented, EXEMPT_IMPLEMENTED, KNOWN_GAPS));
        assertEquals(List.of(), unexpectedExtra, () -> report(
                "path(s) documented in docs/api/openapi.yaml but implemented by no CP controller",
                unexpectedExtra, extra, documented, EXEMPT_DOCUMENTED, Map.of()));

        // The frozen backlog must not drift: a fixed gap has to be deleted from KNOWN_GAPS (else the
        // list silently rots into "everything is a known gap").
        assertEquals(new TreeSet<>(KNOWN_GAPS.keySet()), new TreeSet<>(intersect(missing, KNOWN_GAPS.keySet())),
                "KNOWN_GAPS drifted — fixed gaps must be removed from the list, new ones must be bucketed "
                        + "explicitly (see .local/evidence/bl-320-route-contract-parity.md)");

        assertVariableNamesMatch(documentedPaths(), implementedPaths());
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

    private static Map<String, List<String>> variablesByName(List<String> rawPaths) {
        Map<String, List<String>> byName = new LinkedHashMap<>();
        for (String raw : rawPaths) {
            Parsed parsed = parse(raw);
            byName.put(parsed.shape(), parsed.variables());
        }
        return byName;
    }

    // ------------------------------------------------------------------ sources

    private List<String> implementedPaths() {
        List<String> paths = new ArrayList<>();
        for (Map.Entry<RequestMappingInfo, HandlerMethod> entry : handlerMapping.getHandlerMethods().entrySet()) {
            paths.addAll(entry.getKey().getPatternValues());
        }
        return paths;
    }

    private List<String> documentedPaths() throws Exception {
        Path contract = Path.of("..", "..", "docs", "api", "openapi.yaml");
        try (InputStream input = Files.newInputStream(contract)) {
            Map<?, ?> document = new Yaml().load(input);
            Map<?, ?> paths = (Map<?, ?>) document.get("paths");
            return paths.keySet().stream().map(String::valueOf).toList();
        }
    }

    // ------------------------------------------------------------------ comparison helpers

    private static Map<String, String> mapToSample(List<String> rawPaths) {
        Map<String, String> byShape = new LinkedHashMap<>();
        for (String raw : rawPaths) {
            byShape.putIfAbsent(parse(raw).shape(), raw.trim());
        }
        return byShape;
    }

    /** Sorted shapes present on the left and absent on the right. */
    private static List<String> difference(java.util.Set<String> left, java.util.Set<String> right) {
        SortedSet<String> diff = new TreeSet<>(left);
        diff.removeAll(right);
        return new ArrayList<>(diff);
    }

    private static List<String> notExempt(List<String> candidates, Map<String, String> exempt,
            Map<String, String> alsoAllowed) {
        List<String> residual = new ArrayList<>();
        for (String candidate : candidates) {
            if (!exempt.containsKey(candidate) && !alsoAllowed.containsKey(candidate)) {
                residual.add(candidate);
            }
        }
        return residual;
    }

    private static List<String> intersect(List<String> candidates, java.util.Set<String> allowed) {
        List<String> hits = new ArrayList<>();
        for (String candidate : candidates) {
            if (allowed.contains(candidate)) {
                hits.add(candidate);
            }
        }
        return hits;
    }

    private static int countIn(List<String> candidates, Map<String, String> bucket) {
        return intersect(candidates, bucket.keySet()).size();
    }

    private static String report(String headline, List<String> unexpected, List<String> allShapes,
            Map<String, String> samples, Map<String, String> exemptA, Map<String, String> exemptB) {
        StringBuilder message = new StringBuilder(headline).append('=').append(unexpected.size()).append('\n');
        for (String shape : unexpected) {
            message.append("  - ").append(shape).append("   (sample: ").append(samples.get(shape)).append(")\n");
        }
        message.append("  full diff (").append(allShapes.size()).append("):\n");
        for (String shape : allShapes) {
            String reason = exemptA.getOrDefault(shape, exemptB.getOrDefault(shape, "UNEXPLAINED"));
            message.append("    ").append(shape).append("  [").append(reason).append("]\n");
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
