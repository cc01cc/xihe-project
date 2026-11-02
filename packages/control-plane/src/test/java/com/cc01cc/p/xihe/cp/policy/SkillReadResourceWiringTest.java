package com.cc01cc.p.xihe.cp.policy;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Set;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0628 M2b 收尾 A: the bridge from {@code params.arguments.skill} to the authorization gate.
 *
 * <p>What this pins: the resource the grant gate evaluates is {@code skill:<uuid>}, the V87 default
 * seed ({@code read + *}) still covers it, and a read grant narrowed to a different skill does not.
 * The positive control at the end proves the second assertion is not passing merely because the
 * request is malformed.</p>
 *
 * <p>What this <b>cannot</b> pin today: a policy rule with {@code effect=DENY}. PLAN-0407 T2.8
 * retired rule adjudication ({@code PolicyEngine} no longer reads {@code policy_rules}), so the only
 * denial in the current architecture is "no grant covers the resource". That is the second case
 * below; an {@code effect=DENY} rule is inert storage until a separate decision re-wires it.</p>
 */
class SkillReadResourceWiringTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private final GrantIntersectionEvaluator evaluator = new GrantIntersectionEvaluator();

    @Test
    void defaultSeedReadWildcardStillAllowsTheSkillResource() throws Exception {
        UUID skillId = UUID.randomUUID();

        // V87 seeds every access role with read + *, and the default path must keep working after
        // the extractor starts emitting skill:<uuid>.
        assertTrue(evaluator.allows(requestFor(skillId),
                        List.of(parse("[{\"actionClass\":\"read\",\"resource\":\"*\"}]"))),
                "the default `read + *` grant must still authorize skill_read");
    }

    @Test
    void aGrantScopedToAnotherSkillDoesNotCoverThisSkill() throws Exception {
        UUID target = UUID.randomUUID();
        UUID other = UUID.randomUUID();

        // A resource-scoped read grant is the only narrowing the current grant model can express:
        // the call is denied because no grant covers skill:<target>.
        assertFalse(evaluator.allows(requestFor(target), List.of(grantFor(other))),
                "a grant for another skill must not authorize the target skill");

        // Positive control: the exact uuid grant does cover it, so the case above is a real scope
        // disagreement rather than a request that can never be authorized.
        assertTrue(evaluator.allows(requestFor(target), List.of(grantFor(target))),
                "the exact skill:<uuid> grant must cover its own skill");
    }

    private static PolicyRequest requestFor(UUID skillId) throws Exception {
        String body = "{\"params\":{\"name\":\"skill_read\",\"arguments\":{\"skill\":\""
                + skillId + "\"}}}";
        return new PolicyRequest("skill_read", List.of(ToolFaceRegistry.ACTION_READ),
                PolicyResourceExtractor.extract(body), ToolShape.STRUCTURED,
                "user-1", "workspace-1", "session-1");
    }

    private Set<GrantIntersectionEvaluator.PermissionAtom> grantFor(UUID skillId) throws Exception {
        return parse("[{\"actionClass\":\"read\",\"resource\":\""
                + ToolFaceRegistry.SKILL_RESOURCE_PREFIX + skillId + "\"}]");
    }

    private Set<GrantIntersectionEvaluator.PermissionAtom> parse(String json) throws Exception {
        return evaluator.parse(MAPPER.readTree(json));
    }
}
