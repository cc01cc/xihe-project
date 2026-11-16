package com.cc01cc.p.xihe.cp.architecture;

import com.tngtech.archunit.core.domain.JavaClass;
import com.tngtech.archunit.core.domain.JavaClasses;
import com.tngtech.archunit.core.domain.JavaMethod;
import com.tngtech.archunit.core.domain.JavaParameter;
import com.tngtech.archunit.core.domain.JavaField;
import com.tngtech.archunit.core.importer.ClassFileImporter;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * task-67 / D-1720: the <b>inbound</b> twin of {@link Jackson2NodeWireScanTest} (PLAN-0633 C1-3,
 * D33-10). That gate covers Jackson-2 nodes leaving the CP in a response; this one covers Jackson-2
 * nodes <em>entering</em> through a request body.
 *
 * <p><b>Why this gate exists.</b> Boot 4 binds request bodies with <b>Jackson 3</b>
 * ({@code tools.jackson}). A record component typed with a <b>Jackson-2</b>
 * {@code com.fasterxml.jackson.databind.JsonNode} cannot be constructed by the Jackson-3
 * {@code ObjectMapper}: every request that actually carries that field fails with
 * {@code InvalidDefinitionException: Cannot construct instance ... (no Creators)} — an HTTP 500
 * that no unit test sees, because unit tests build the record themselves and never cross the
 * mapper. That is exactly how {@code targetKind=job_dispatch} (the only kind that needs
 * {@code payload}) shipped broken on {@code develop} while {@code session_wakeup} stayed green.
 *
 * <p><b>What the rule is, precisely.</b> Reading a file's imports is not the question — Jackson 2
 * is the CP's mainstream ({@code JacksonNodeExit} documents the split as deliberate architecture),
 * and a file that imports it may never put a node on the wire at all. The question is narrower:
 * <em>is a Jackson-2 node part of the type Spring will bind for an {@code @RequestBody} parameter?</em>
 * So this gate resolves the actual declared parameter type and walks its record components, which
 * is a type-graph question — the reason it is expressed with ArchUnit's reflection model instead of
 * a source regex (the regex sweep this gate replaces produced two false answers before the type
 * graph was consulted).
 *
 * <p><b>What must keep passing.</b> A {@code tools.jackson} (Jackson 3) node in a request body is
 * legal and stays legal — {@code SkillController} and {@code ChatRunContinuationController} bind
 * {@code @RequestBody tools.jackson.databind.JsonNode} directly. The defect is the <em>wrong
 * version</em>, never "a JsonNode in a request body".
 *
 * <p><b>What must not be flagged.</b> {@code AgentPrincipalWireBody.CreateBody} carries Jackson-2
 * nodes but is never bound by Spring: every controller accepts {@code Map<String, Object>} and
 * calls {@code parseCreate(...)} by hand. A gate keyed on "this file imports Jackson 2" would
 * condemn that hand-parse — the escape hatch the team invented before any gate existed. Being
 * invisible to this rule is correct there: no deserialisation happens, so no defect can.
 *
 * <p><b>Known limit — test-scope controllers, and it does bite.</b> This gate imports production
 * classes only ({@code test-classes} is filtered out), because test fixtures never cross the wire.
 * That leaves one blind spot with real consequences, measured rather than assumed: a <em>test</em>
 * controller that binds a Jackson-2 node is <b>not</b> exempt from the defect itself. MockMvc's
 * standalone setup uses the same Boot 4 Jackson-3 converter as production, so a
 * {@code @RequestBody J2Body} in test code throws the identical
 * {@code InvalidDefinitionException: Cannot construct instance of com.fasterxml.jackson.databind.JsonNode}
 * — the request errors before the handler runs (probed 2026-11-16: Jackson-2-bound body threw,
 * Jackson-3-bound body answered 200 {@code ok:node}). The harm is therefore not "silently allowed":
 * such a test fails loudly, and because it fails on its own fixture it can make otherwise-correct
 * production code look red. Widening the scan to {@code test-classes} was rejected as the wrong
 * scope — the rule is about what Spring BINDS, and a test fake is not a wire surface; the honest
 * handling is to record the limit and let the natural failure point at the fixture. Anyone who
 * needs a Jackson-2 node in a test controller can retype the fixture to
 * {@code tools.jackson} (the wire type) exactly as production must.
 */
class Jackson2NodeInboundScanTest {

    private static JavaClasses production;

    /** The Jackson-2 node types that a Jackson-3 mapper cannot construct. */
    private static final Set<String> JACKSON2_NODE_TYPES = Set.of(
            "com.fasterxml.jackson.databind.JsonNode",
            "com.fasterxml.jackson.databind.node.ObjectNode",
            "com.fasterxml.jackson.databind.node.ArrayNode");

    private static final String TOOLS_JACKSON_NODE = "tools.jackson.databind.JsonNode";

    private static final String REQUEST_BODY = "org.springframework.web.bind.annotation.RequestBody";

    private static final String CONTROLLER_REST =
            "org.springframework.web.bind.annotation.RestController";

    private static final String CONTROLLER_STEREOTYPE =
            "org.springframework.stereotype.Controller";

    @BeforeAll
    static void importProduction() {
        production = new ClassFileImporter()
                .withImportOption(location -> !location.contains("test-classes"))
                .importPackages("com.cc01cc.p.xihe.cp");
        assertTrue(production.contain("com.cc01cc.p.xihe.cp.scheduled.ScheduledTaskApiService"),
                "production import must include the scheduled-task service this gate was written for");
        assertTrue(production.contain("com.cc01cc.p.xihe.cp.chat.ChatRunContinuationController"),
                "production import must include the Jackson-3 request-body precedent");
    }

    /**
     * The rule: no {@code @RequestBody} parameter may be, or declare, a Jackson-2 node type.
     *
     * <p>On failure the message lists every offending parameter and its component, so the fix is
     * obvious (retype the component to {@code tools.jackson}, or convert at the boundary).
     */
    @Test
    void everyRequestBodyBindsAJackson3CompatibleType() {
        List<String> violations = inboundViolations(production);

        assertEquals(List.of(), violations,
                "A Jackson-2 JsonNode inside an @RequestBody type graph cannot be built by the "
                        + "Jackson-3 mapper Boot 4 binds with: the request 500s before any handler "
                        + "runs. Retype that component to tools.jackson.databind.JsonNode, or keep "
                        + "the wire type Jackson 3 and convert to a Jackson-2 domain node at the "
                        + "boundary (see ScheduledTaskApiService#domainPayload). Offending: "
                        + violations);
    }

    /**
     * Guard against a vacuous green: if this gate found no {@code @RequestBody} parameters at all,
     * "no violations" would mean "nothing was looked at". The precedent parameters below must be
     * seen and must pass.
     */
    @Test
    void theRuleActuallyLooksAtTheControllersItClaims() {
        List<String> seen = new ArrayList<>();
        for (JavaClass type : controllerTypes(production)) {
            for (JavaMethod method : type.getMethods()) {
                for (JavaParameter parameter : method.getParameters()) {
                    if (parameter.isAnnotatedWith(REQUEST_BODY)) {
                        seen.add(method.getOwner().getName() + "#" + method.getName());
                    }
                }
            }
        }
        assertTrue(seen.size() >= 40,
                "expected the CP's full @RequestBody surface (dozens of handlers), saw " + seen.size());
        // The two Jackson-3 legal uses that a "ban JsonNode inbound" rule would have broken.
        assertTrue(seen.contains("com.cc01cc.p.xihe.cp.skill.SkillController#updateSkill")
                || seen.stream().anyMatch(s -> s.contains("cp.skill.SkillController")),
                "SkillController binds a Jackson-3 node inbound and must stay legal, saw: " + seen);
        assertTrue(seen.stream().anyMatch(s -> s.contains("cp.chat.ChatRunContinuationController")),
                "ChatRunContinuationController binds a Jackson-3 node inbound, saw: " + seen);
        System.out.println("[jackson2-inbound] @RequestBody parameters seen: " + seen.size());
    }

    /**
     * The regression fixture for the false positive that shaped this rule.
     *
     * <p>{@code AgentPrincipalWireBody.CreateBody} holds Jackson-2 nodes but is constructed by
     * {@code parseCreate(Map, ObjectMapper)}, never bound by Spring. A gate keyed on imports flags
     * it; a gate keyed on the {@code @RequestBody} type graph does not. Both halves are asserted:
     * the type is not bound inbound <b>and</b> it does carry Jackson-2 nodes, so "not flagged"
     * cannot quietly become "carries no nodes".
     */
    @Test
    void theHandParsedWireBodyIsCarriedByAJackson2NodeYetIsNotBoundInbound() {
        JavaClass createBody = production.get(
                "com.cc01cc.p.xihe.cp.controller.AgentPrincipalWireBody$CreateBody");
        assertEquals(true, carriesJackson2Node(createBody),
                "fixture premise: CreateBody must still be a Jackson-2 holder, otherwise this "
                        + "regression test has gone stale and can no longer prove anything");

        // No @RequestBody parameter anywhere may name this type: it is hand-parsed.
        boolean boundInbound = false;
        for (String violation : inboundViolations(production)) {
            boundInbound |= violation.contains("AgentPrincipalWireBody");
        }
        boolean declaredAsRequestBody = controllerTypes(production).stream()
                .flatMap(type -> type.getMethods().stream())
                .flatMap(method -> method.getParameters().stream())
                .filter(parameter -> parameter.isAnnotatedWith(REQUEST_BODY))
                .anyMatch(parameter -> "com.cc01cc.p.xihe.cp.controller.AgentPrincipalWireBody$CreateBody"
                        .equals(parameter.getRawType().getName()));
        assertEquals(false, declaredAsRequestBody,
                "CreateBody must stay hand-parsed: if it becomes an @RequestBody type, this gate "
                        + "must start reporting it (and the hand parse is gone)");
    }

    // ------------------------------------------------------------------ gate

    private static List<String> inboundViolations(JavaClasses classes) {
        Set<String> violations = new LinkedHashSet<>();
        for (JavaClass controller : controllerTypes(classes)) {
            for (JavaMethod method : controller.getMethods()) {
                for (JavaParameter parameter : method.getParameters()) {
                    if (!parameter.isAnnotatedWith(REQUEST_BODY)) {
                        continue;
                    }
                    JavaClass bound = parameter.getRawType();
                    String direct = jackson2NodeKind(bound.getName());
                    if (direct != null) {
                        violations.add(describe(method, parameter, bound.getName(), direct));
                        continue;
                    }
                    for (JavaField component : bound.getFields()) {
                        String componentKind = jackson2NodeKind(component.getRawType().getName());
                        if (componentKind != null) {
                            violations.add(describe(method, parameter, component.getRawType().getName(),
                                    "component \"" + component.getName() + "\" is a " + componentKind));
                        }
                    }
                }
            }
        }
        return List.copyOf(violations);
    }

    private static String describe(JavaMethod method, JavaParameter parameter, String typeName,
                                   String detail) {
        return method.getOwner().getSimpleName() + "#" + method.getName()
                + " parameter \"" + parameter.getIndex() + "\" (" + typeName + "): " + detail;
    }

    /** @return a short label when the type is one of the Jackson-2 node types, else {@code null}. */
    private static String jackson2NodeKind(String typeName) {
        if (!JACKSON2_NODE_TYPES.contains(typeName)) {
            return null;
        }
        return typeName.endsWith("JsonNode") ? "Jackson-2 JsonNode"
                : (typeName.endsWith("ObjectNode") ? "Jackson-2 ObjectNode" : "Jackson-2 ArrayNode");
    }

    private static boolean carriesJackson2Node(JavaClass type) {
        for (JavaField component : type.getFields()) {
            if (jackson2NodeKind(component.getRawType().getName()) != null) {
                return true;
            }
        }
        return false;
    }

    private static List<JavaClass> controllerTypes(JavaClasses classes) {
        List<JavaClass> controllers = new ArrayList<>();
        for (JavaClass type : classes) {
            if (type.isAnnotatedWith(CONTROLLER_REST) || type.isAnnotatedWith(CONTROLLER_STEREOTYPE)) {
                controllers.add(type);
            }
        }
        return controllers;
    }
}
