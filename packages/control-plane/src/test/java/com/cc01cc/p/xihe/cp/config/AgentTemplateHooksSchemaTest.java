package com.cc01cc.p.xihe.cp.config;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0625 Gap G (P0): a template document carrying {@code hooks} must pass the config-domain
 * schema, because {@code AgentTemplateService.parseLayer} validates every assembled layer document
 * on the READ path too — an undeclared property under the template def ({@code
 * additionalProperties:false}) turned {@code GET /api/v1/agent-templates?layer=instance} into a
 * blanket 409 {@code AGENT_TEMPLATE_CONFIG_INVALID} for the whole domain.
 *
 * <p>Why this test exists next to {@code GuardTemplateReadPathIntegrationTest}: V98 seeded
 * {@code hooks} straight through SQL, bypassing the config write gate, so only the read path could
 * notice the schema gap (Gap E/F/G are the same family: "the shape the seed writes is not the shape
 * the reader accepts"). The integration test pins the endpoint with the real migrations; this one
 * pins the schema contract itself — cheap, container-free, and it states the accepted shapes.</p>
 */
class AgentTemplateHooksSchemaTest {

    private static final String GUARD_ROLE_ID = "00000000-0000-4000-8000-0000000000a1";
    private static final String GUARD_TEMPLATE_ID = "00000000-0000-4000-8000-0000000000a2";

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static ConfigDomainSchema schema;

    @BeforeAll
    static void loadSchema() throws Exception {
        schema = new ConfigDomainSchema(MAPPER);
        schema.init();
    }

    /** The exact document V97+V98 assemble: guard role, guard template, hooks pre-subscription. */
    @Test
    void seededGuardTemplateWithHooksPassesSchemaValidation() throws Exception {
        String document = """
                {
                  "roles": [
                    { "id": "%s", "name": "guard",
                      "permissions": [ { "actionClass": "read", "resource": "*" } ] }
                  ],
                  "templates": [
                    { "id": "%s", "name": "守卫 Guard", "description": "Built-in guard preset",
                      "systemPrompt": "You are the built-in guard of this Xihe conversation.",
                      "toolMode": "none", "roleId": "%s",
                      "hooks": { "advisors": [ { "kind": "guard", "on": ["approval.ask"] } ] } }
                  ]
                }
                """.formatted(GUARD_ROLE_ID, GUARD_TEMPLATE_ID, GUARD_ROLE_ID);

        assertEquals(List.of(), schema.validate("agent-templates", MAPPER.readTree(document)),
                "Gap G regression guard: a template with hooks must be readable at the instance layer");
    }

    /** V98's documented rollback writes jsonb null; the read path must keep working then too. */
    @Test
    void templateWithNullHooksPassesSchemaValidation() throws Exception {
        JsonNode document = MAPPER.readTree("""
                {
                  "roles": [ { "id": "%s", "name": "guard",
                               "permissions": [ { "actionClass": "read", "resource": "*" } ] } ],
                  "templates": [ { "id": "%s", "name": "守卫 Guard", "description": "Built-in guard preset",
                                   "systemPrompt": "guard prompt", "toolMode": "none",
                                   "roleId": "%s", "hooks": null } ]
                }
                """.formatted(GUARD_ROLE_ID, GUARD_TEMPLATE_ID, GUARD_ROLE_ID));

        assertEquals(List.of(), schema.validate("agent-templates", document));
    }

    /**
     * PLAN-0633 D33-01 batch A2 (json-schema-validator 3.0.7 → 3.0.8) nullable probe.
     *
     * <p>The upgrade is a patch release, so the only real risk is <b>validation semantics</b> drifting:
     * {@code ConfigDomainSchema} runs all 14 config-domain schemas through this library, and
     * {@code hooks} is declared as the union {@code ["object", "null"]}. Two drifts would hurt and both
     * are invisible to a single happy-path test:</p>
     * <ul>
     *   <li>a validator that starts <b>rejecting {@code null}</b> bricks the V98 rollback shape and the
     *       instance-layer read path (409 for the whole domain);</li>
     *   <li>a validator that starts treating the union as <b>"any type goes"</b> silently weakens every
     *       domain schema in the repository.</li>
     * </ul>
     *
     * <p>{@code templateWithNullHooksPassesSchemaValidation} documents the rollback shape; this probe
     * pins the boundary around it — null and absent stay accepted, the object form stays accepted, and a
     * wrong non-null type is still rejected. If this ever fails after a dependency bump, report the
     * behaviour change and its blast radius instead of loosening the schema to match the library.</p>
     */
    @Test
    void nullableHooksProbeKeepsNullAcceptedWithoutLooseningTheTypeUnion() throws Exception {
        assertEquals(List.of(), schema.validate("agent-templates", guardDocument("null")),
                "hooks:null is the V98 rollback shape — [object,null] must still accept it");
        assertEquals(List.of(), schema.validate("agent-templates", guardDocument(null)),
                "an absent hooks document stays valid (no declaration)");
        assertEquals(List.of(), schema.validate("agent-templates",
                        guardDocument("{ \"advisors\": [ { \"kind\": \"guard\", \"on\": [\"approval.ask\"] } ] }")),
                "the declared object form stays valid");

        assertFalse(schema.validate("agent-templates", guardDocument("\"guard\"")).isEmpty(),
                "[object,null] must not degrade into 'any type accepted' after the validator upgrade");
        assertFalse(schema.validate("agent-templates", guardDocument("42")).isEmpty(),
                "a number is not in the [object,null] union either");
    }

    /** D25-10: advisor kind is an open string, and per-advisor parameters may grow later. */
    @Test
    void unknownAdvisorKindAndExtraAdvisorKeysStayAccepted() throws Exception {
        JsonNode document = guardDocument("""
                { "advisors": [ { "kind": "future-plugin", "on": ["approval.ask"], "threshold": 3 } ] }
                """);

        assertEquals(List.of(), schema.validate("agent-templates", document),
                "an added per-advisor key must never 409 the read path again");
    }

    /** The template def itself stays closed: an undeclared sibling of hooks is still rejected. */
    @Test
    void undeclaredTemplatePropertyIsStillRejected() throws Exception {
        JsonNode document = guardDocument(null).deepCopy();
        ((com.fasterxml.jackson.databind.node.ObjectNode) document.get("templates").get(0))
                .put("hookz", "typo");

        assertFalse(schema.validate("agent-templates", document).isEmpty(),
                "loosening hooks must not loosen the template def");
    }

    @Test
    void malformedHooksAreRejected() throws Exception {
        assertFalse(schema.validate("agent-templates",
                guardDocument("{ \"advisors\": [] }")).isEmpty(), "empty advisors array");
        assertFalse(schema.validate("agent-templates",
                guardDocument("{ \"advisors\": [ { \"kind\": \"guard\" } ] }")).isEmpty(), "missing on[]");
        assertFalse(schema.validate("agent-templates",
                guardDocument("{ \"advisors\": [ { \"kind\": \"\", \"on\": [\"approval.ask\"] } ] }")).isEmpty(),
                "blank kind");
        assertFalse(schema.validate("agent-templates",
                guardDocument("{ \"advisors\": [ { \"kind\": \"guard\", \"on\": [] } ] }")).isEmpty(),
                "empty on[]");
        assertFalse(schema.validate("agent-templates", guardDocument("\"guard\"")).isEmpty(),
                "hooks must be an object");
    }

    private JsonNode guardDocument(String hooksJson) throws Exception {
        String hooks = hooksJson == null ? "" : ", \"hooks\": " + hooksJson;
        String document = """
                {
                  "roles": [ { "id": "%s", "name": "guard",
                               "permissions": [ { "actionClass": "read", "resource": "*" } ] } ],
                  "templates": [ { "id": "%s", "name": "守卫 Guard", "description": "Built-in guard preset",
                                   "systemPrompt": "guard prompt", "toolMode": "none",
                                   "roleId": "%s"%s } ]
                }
                """.formatted(GUARD_ROLE_ID, GUARD_TEMPLATE_ID, GUARD_ROLE_ID, hooks);
        JsonNode node = MAPPER.readTree(document);
        assertTrue(node.has("templates"), "fixture must stay a template document");
        return node;
    }
}
