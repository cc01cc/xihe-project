package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Set;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class GrantIntersectionTest {

    private final ObjectMapper objectMapper = new ObjectMapper();
    private final GrantIntersectionEvaluator evaluator = new GrantIntersectionEvaluator();

    @Test
    void lowerPermissionHumanConstrainsHigherPermissionAgent() throws Exception {
        Set<GrantIntersectionEvaluator.PermissionAtom> human = parse("""
                [{"actionClass":"read"},{"actionClass":"write","resource":"src/**"}]
                """);
        Set<GrantIntersectionEvaluator.PermissionAtom> agent = parse("""
                [{"actionClass":"read"},{"actionClass":"write"},{"actionClass":"delete"}]
                """);

        assertTrue(evaluator.allows(request("write", "src/main.java"), List.of(human, agent)));
        assertFalse(evaluator.allows(request("write", "secrets/key.txt"), List.of(human, agent)));
        assertFalse(evaluator.allows(request("delete", "src/main.java"), List.of(human, agent)));
    }

    @Test
    void permissionRowsForOnePrincipalUnionWithoutSourcePrecedence() throws Exception {
        AuthorizationGrant defaults = grant("default", "[{\"actionClass\":\"read\"}]");
        AuthorizationGrant direct = grant("direct", "[{\"actionClass\":\"write\",\"resource\":\"notes/**\"}]");
        Set<GrantIntersectionEvaluator.PermissionAtom> user = evaluator.union(List.of(defaults, direct));

        assertTrue(evaluator.allows(request("read", "anything"), List.of(user)));
        assertTrue(evaluator.allows(request("write", "notes/today.md"), List.of(user)));
        assertFalse(evaluator.allows(request("write", "src/main.java"), List.of(user)));
    }

    @Test
    void defaultPermissionPathDoesNotGiveAdminAChainCeiling() throws Exception {
        Set<GrantIntersectionEvaluator.PermissionAtom> userDefault = parse("""
                [
                  {"actionClass":"read"},
                  {"actionClass":"write"},
                  {"actionClass":"delete"},
                  {"actionClass":"exec"},
                  {"actionClass":"network"}
                ]
                """);
        Set<GrantIntersectionEvaluator.PermissionAtom> adminDefault = parse("""
                [
                  {"actionClass":"read"},
                  {"actionClass":"write"},
                  {"actionClass":"delete"},
                  {"actionClass":"exec"},
                  {"actionClass":"network"},
                  {"actionClass":"credential"}
                ]
                """);

        assertFalse(evaluator.allows(request("credential", "provider_connections/*"),
                List.of(userDefault, adminDefault)));
        assertTrue(evaluator.allows(request("credential", "provider_connections/*"), List.of(adminDefault)));
    }

    @Test
    void allActionsAndResourcesMustBeCoveredByEveryPrincipal() throws Exception {
        Set<GrantIntersectionEvaluator.PermissionAtom> first = parse("""
                [{"actionClass":"write","resource":"src/**"},{"actionClass":"delete","resource":"src/**"}]
                """);
        Set<GrantIntersectionEvaluator.PermissionAtom> second = parse("""
                [{"actionClass":"write"},{"actionClass":"delete","resource":"src/a.java"}]
                """);

        assertTrue(evaluator.allows(request(List.of("write", "delete"), List.of("src/a.java")),
                List.of(first, second)));
        assertFalse(evaluator.allows(request(List.of("write", "delete"), List.of("src/a.java", "src/b.java")),
                List.of(first, second)));
    }

    @Test
    void emptyPathOrEmptyPrincipalSetFailsClosed() throws Exception {
        Set<GrantIntersectionEvaluator.PermissionAtom> read = parse("[{\"actionClass\":\"read\"}]");

        assertFalse(evaluator.allows(request("read", "file.txt"), List.of()));
        assertFalse(evaluator.allows(request("read", "file.txt"), List.of(read, Set.of())));
        assertFalse(evaluator.allows(new PolicyRequest("test_tool", List.of("read"), List.of(),
                ToolShape.STRUCTURED, "user-1", "workspace-1", "session-1"), List.of(read)));
    }

    @Test
    void malformedAndUnknownPermissionAtomsAreRejected() throws Exception {
        assertThrows(IllegalArgumentException.class, () -> evaluator.parse(objectMapper.readTree("{}")));
        assertThrows(IllegalArgumentException.class,
                () -> evaluator.parse(objectMapper.readTree("[{\"actionClass\":\"unknown\"}]")));
        assertThrows(IllegalArgumentException.class,
                () -> evaluator.parse(objectMapper.readTree("[{\"actionClass\":\"read\",\"effect\":\"allow\"}]")));
    }

    private Set<GrantIntersectionEvaluator.PermissionAtom> parse(String json) throws Exception {
        return evaluator.parse(objectMapper.readTree(json));
    }

    private AuthorizationGrant grant(String source, String permissions) throws Exception {
        AuthorizationGrant grant = new AuthorizationGrant();
        grant.setId(UUID.randomUUID());
        grant.setSource(source);
        grant.setSubjectType("user");
        grant.setSubjectId(UUID.randomUUID());
        JsonNode json = objectMapper.readTree(permissions);
        grant.setPermissions(json);
        return grant;
    }

    private static PolicyRequest request(String actionClass, String resource) {
        return request(List.of(actionClass), List.of(resource));
    }

    private static PolicyRequest request(List<String> actionClasses, List<String> resources) {
        return new PolicyRequest("test_tool", actionClasses, resources, ToolShape.STRUCTURED,
                "user-1", "workspace-1", "session-1");
    }
}
