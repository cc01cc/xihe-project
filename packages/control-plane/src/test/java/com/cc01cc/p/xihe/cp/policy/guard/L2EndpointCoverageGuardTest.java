package com.cc01cc.p.xihe.cp.policy.guard;

import static org.assertj.core.api.Assertions.assertThat;

import com.cc01cc.p.xihe.cp.config.PolicyChecked;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.config.BeanDefinition;
import org.springframework.context.annotation.ClassPathScanningCandidateComponentProvider;
import org.springframework.core.annotation.AnnotatedElementUtils;
import org.springframework.core.type.filter.AnnotationTypeFilter;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.bind.annotation.RestController;

/**
 * task-837 L2: every implemented route must declare the atom it enforces
 * ({@code @PolicyChecked(atom=…)}) or be an intentionally public route (health / login callbacks).
 *
 * <p>Route enumeration uses <b>Spring's own annotation model</b>
 * ({@link ClassPathScanningCandidateComponentProvider} + {@code AnnotatedElementUtils} merged
 * {@link RequestMapping}), i.e. the same composed annotations Spring builds handler mappings from —
 * not a hand-rolled source regex. That keeps the gate runnable without starting the application
 * context (see the blocker below) while still seeing every annotation-registered controller.</p>
 *
 * <p><b>Blocker (2026-11-23, task-859 residue):</b> {@code WorkspaceController} now has two
 * constructors with no {@code @Autowired}, so the real application context fails with
 * {@code No default constructor found}. The live-mapping twin of this gate
 * ({@code RequestMappingHandlerMapping}, the {@code RouteContractParityTest} style) is ready to be
 * switched on the moment that one-line product fix lands; until then it cannot be green and is not
 * claimed.</p>
 *
 * <p><b>Honest state (2026-11-23):</b> task-859 annotated the endpoints it changed (14 sites); the
 * remaining ~370 routes are migrated product-side (task-863 and the per-module annotation wave), not
 * by this card. The gate therefore runs in <b>only-shrink baseline</b> mode: a route outside the
 * baseline that lacks {@code @PolicyChecked} fails immediately (the real "new endpoint without a
 * gate" case), and a baseline entry that no longer reproduces fails too. Coverage reaching 100% is
 * the exit criterion of that migration, tracked in the baseline header — not something this test can
 * fake by lowering its own bar.</p>
 *
 * <p>Falsifiability: {@link #handlerMappingIsPopulatedAndAnnotatedRoutesExist()} asserts the mapping
 * is non-trivial and that at least one handler carries the annotation, so an empty scan (a green
 * that proved nothing) cannot pass.</p>
 */
class L2EndpointCoverageGuardTest {

    private static final Path BASELINE = Path.of("src", "test", "java", "com", "cc01cc", "p",
            "xihe", "cp", "policy", "guard", "l2-unannotated-routes.txt");

    /** Framework endpoints: registered by the servlet container / springdoc, never a product API. */
    private static final Set<String> FRAMEWORK_PREFIXES = Set.of(
            "/error", "/swagger-ui", "/v3/api-docs");

    /** Intentionally public product routes (no user principal to check an atom for). */
    private static final Set<String> PUBLIC_ROUTES = Set.of(
            "GET /api/v1/health",
            "GET /api/v1/health/live",
            "GET /api/v1/health/ready",
            "GET /api/v1/auth/bootstrap-status",
            "POST /api/v1/auth/register",
            "POST /api/v1/auth/login",
            "POST /api/v1/auth/refresh");

    private static final String BASE_PACKAGE = "com.cc01cc.p.xihe.cp";

    @Test
    @DisplayName("route universe is populated and at least one route declares @PolicyChecked")
    void routeUniverseIsPopulatedAndAnnotatedRoutesExist() {
        Set<String> routes = routes().keySet();
        assertThat(routes.size())
                .as("enumerated route count (a zero/tiny scan is a false green)")
                // 2026-11-23 measured 294 annotation-registered operations (the live mapping adds
                // springdoc/framework entries on top). A collapse below this means the scan broke.
                .isGreaterThan(250);
        assertThat(annotatedRoutes(routes()))
                .as("at least the endpoints migrated by task-859 must declare their atom")
                .isNotEmpty();
    }

    @Test
    @DisplayName("no new route may be added without @PolicyChecked or a public-route declaration")
    void everyRouteIsAnnotatedOrBaselineListed() throws IOException {
        List<String> unannotated = unannotatedRoutes(routes());
        // Printed on purpose: the baseline is maintained by copying these lines (with owner /
        // reviewDate / reason) and must shrink as the annotation wave lands.
        unannotated.forEach(route -> System.out.println("[L2-BASELINE] " + route));

        List<String> problems = coverageProblems(unannotated, readBaseline());
        assertThat(problems).as("route coverage gate").isEmpty();
    }

    @Test
    @DisplayName("the coverage gate is falsifiable: a new unannotated route and a stale entry both fail")
    void coverageGateIsFalsifiable() {
        List<String> problems = coverageProblems(
                List.of("GET /api/v1/newly-added-without-a-gate"),
                Map.of("GET /api/v1/already-annotated", new BaselineEntry("task-863",
                        "2026-12-15", "stale")));
        assertThat(problems)
                .as("an empty result here would mean the gate cannot fail")
                .anyMatch(problem -> problem.contains("newly-added-without-a-gate"))
                .anyMatch(problem -> problem.contains("already-annotated"));
    }

    @Test
    @DisplayName("baseline entries carry owner + reviewDate + reason, and never owner=task-859")
    void baselineIsWitnessedAnd859Free() throws IOException {
        List<String> problems = new ArrayList<>();
        for (Map.Entry<String, BaselineEntry> entry : readBaseline().entrySet()) {
            BaselineEntry value = entry.getValue();
            if (value.owner().isBlank() || "task-859".equals(value.owner())) {
                problems.add(entry.getKey() + " owner=" + value.owner());
            }
            if (!value.reviewDate().matches("^\\d{4}-\\d{2}-\\d{2}$")) {
                problems.add(entry.getKey() + " reviewDate=" + value.reviewDate());
            }
            if (value.reason().isBlank()) {
                problems.add(entry.getKey() + " reason is blank");
            }
        }
        assertThat(problems).as("baseline entry contract").isEmpty();
    }

    // ------------------------------------------------------------------ helpers

    private record RouteHandler(boolean annotated) {
    }

    private record BaselineEntry(String owner, String reviewDate, String reason) {
    }

    private Map<String, RouteHandler> routes() {
        Map<String, RouteHandler> routes = new LinkedHashMap<>();
        for (Class<?> controller : controllerClasses()) {
            boolean typeAnnotated = AnnotatedElementUtils.findMergedAnnotation(
                    controller, PolicyChecked.class) != null;
            String[] typePaths = pathsOf(AnnotatedElementUtils.findMergedAnnotation(
                    controller, RequestMapping.class));
            for (java.lang.reflect.Method method : controller.getDeclaredMethods()) {
                RequestMapping mapping = AnnotatedElementUtils.findMergedAnnotation(
                        method, RequestMapping.class);
                if (mapping == null) {
                    continue;
                }
                boolean annotated = typeAnnotated || AnnotatedElementUtils.findMergedAnnotation(
                        method, PolicyChecked.class) != null;
                Set<RequestMethod> verbs = Set.of(mapping.method());
                for (String typePath : typePaths) {
                    for (String methodPath : pathsOf(mapping)) {
                        String full = combine(typePath, methodPath);
                        if (verbs.isEmpty()) {
                            routes.put("ANY " + full, new RouteHandler(annotated));
                        } else {
                            for (RequestMethod verb : verbs) {
                                routes.put(verb.name().toUpperCase(Locale.ROOT) + " " + full,
                                        new RouteHandler(annotated));
                            }
                        }
                    }
                }
            }
        }
        return routes;
    }

    private static List<Class<?>> controllerClasses() {
        ClassPathScanningCandidateComponentProvider scanner =
                new ClassPathScanningCandidateComponentProvider(false);
        scanner.addIncludeFilter(new AnnotationTypeFilter(RestController.class));
        List<Class<?>> controllers = new ArrayList<>();
        for (BeanDefinition candidate : scanner.findCandidateComponents(BASE_PACKAGE)) {
            try {
                Class<?> type = Class.forName(candidate.getBeanClassName());
                // Test-classpath fixtures (e.g. architectureprobe) are not product routes; a gate
                // that counted them would either fail on test code or mask a real controller.
                if (!isTestClasspath(type)) {
                    controllers.add(type);
                }
            } catch (ClassNotFoundException e) {
                throw new IllegalStateException("scanned controller is not loadable: "
                        + candidate.getBeanClassName(), e);
            }
        }
        assertThat(controllers)
                .as("controller class scan (a zero-class scan would be a false green)")
                .isNotEmpty();
        return controllers;
    }

    private static boolean isTestClasspath(Class<?> type) {
        var source = type.getProtectionDomain().getCodeSource();
        return source != null && source.getLocation() != null
                && source.getLocation().toString().contains("test-classes");
    }

    private static String[] pathsOf(RequestMapping mapping) {
        if (mapping == null) {
            return new String[] {""};
        }
        String[] paths = mapping.path().length > 0 ? mapping.path() : mapping.value();
        return paths.length > 0 ? paths : new String[] {""};
    }

    private static String combine(String typePath, String methodPath) {
        String left = typePath == null ? "" : typePath.trim();
        String right = methodPath == null ? "" : methodPath.trim();
        String joined = (left.endsWith("/") ? left.substring(0, left.length() - 1) : left)
                + (right.startsWith("/") || right.isEmpty() ? right : "/" + right);
        return joined.isEmpty() ? "/" : joined.replaceAll("/{2,}", "/");
    }

    private static Set<String> annotatedRoutes(Map<String, RouteHandler> routes) {
        Set<String> annotated = new LinkedHashSet<>();
        routes.forEach((route, handler) -> {
            if (handler.annotated()) {
                annotated.add(route);
            }
        });
        return annotated;
    }

    private static List<String> unannotatedRoutes(Map<String, RouteHandler> routes) {
        List<String> unannotated = new ArrayList<>();
        for (Map.Entry<String, RouteHandler> route : routes.entrySet()) {
            if (!isExempt(route.getKey()) && !route.getValue().annotated()) {
                unannotated.add(route.getKey());
            }
        }
        return unannotated;
    }

    /**
     * The gate itself, split out so {@link #coverageGateIsFalsifiable()} can prove it reports both
     * directions: a new unannotated route (unexpected) and a baseline entry that no longer
     * reproduces (stale).
     */
    private static List<String> coverageProblems(List<String> unannotated,
                                                 Map<String, BaselineEntry> baseline) {
        List<String> problems = new ArrayList<>();
        unannotated.stream()
                .filter(route -> !baseline.containsKey(route))
                .forEach(route -> problems.add("missing @PolicyChecked and not baseline-listed: " + route));
        baseline.keySet().stream()
                .filter(route -> !unannotated.contains(route))
                .forEach(route -> problems.add("stale baseline entry (annotated or removed): " + route));
        return problems;
    }

    private static boolean isExempt(String route) {
        String path = route.substring(route.indexOf(' ') + 1);
        for (String prefix : FRAMEWORK_PREFIXES) {
            if (path.equals(prefix) || path.startsWith(prefix + "/")) {
                return true;
            }
        }
        return PUBLIC_ROUTES.contains(route);
    }

    private static Map<String, BaselineEntry> readBaseline() throws IOException {
        assertThat(Files.exists(BASELINE))
                .as("L2 baseline missing: %s", BASELINE.toAbsolutePath())
                .isTrue();
        Map<String, BaselineEntry> entries = new LinkedHashMap<>();
        List<String> lines = Files.readAllLines(BASELINE, StandardCharsets.UTF_8);
        for (String line : lines) {
            String trimmed = line.trim();
            if (trimmed.isEmpty() || trimmed.startsWith("#")) {
                continue;
            }
            String[] parts = trimmed.split("\\|", -1);
            assertThat(parts.length).as("baseline line must be 'METHOD /path | owner | reviewDate | reason': " + line)
                    .isEqualTo(4);
            entries.put(parts[0].trim(), new BaselineEntry(parts[1].trim(), parts[2].trim(),
                    parts[3].trim()));
        }
        return entries;
    }
}
