package com.cc01cc.p.xihe.cp.skill;

import com.cc01cc.p.xihe.cp.config.ConfigDomainSchema;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0628 M1 (taskbook T7): the {@code skill_catalog} component as a <b>config-domain</b> shape.
 *
 * <p>Container-free on purpose: the same "the shape the writer accepts is the shape the reader
 * accepts" trap that PLAN-0625 Gap E/F/G hit (V98 seeded a document the read path rejected) applies
 * here, and a schema assertion is the cheapest way to catch it. Reserved values are refused
 * <b>explicitly</b> rather than silently falling back — a user who asks for a sort the product does
 * not implement must see 400, not a listing that quietly ignores the request.</p>
 */
class SkillCatalogComponentSchemaTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String INSTANCE = "11111111-1111-4111-8111-111111111111";
    private static final String INSTANCE_TWO = "22222222-2222-4222-8222-222222222222";

    private static ConfigDomainSchema schema;

    @BeforeAll
    static void loadSchema() throws Exception {
        schema = new ConfigDomainSchema(MAPPER);
        schema.init();
    }

    private static String document(String componentExtra) {
        return """
                {
                  "templates": [
                    {
                      "id": "33333333-3333-4333-8333-333333333333",
                      "version": 1,
                      "name": "skill catalog template",
                      "description": "schema fixture",
                      "document": "body",
                      "components": [
                        {
                          "instanceId": "%s",
                          "type": "skill_catalog",
                          "enabled": true,
                          "config": %s
                        }
                      ]
                    }
                  ]
                }
                """.formatted(INSTANCE, componentExtra);
    }

    private static List<String> validate(String json) throws Exception {
        JsonNode node = MAPPER.readTree(json);
        return schema.validate("context-templates", node);
    }

    @Test
    void aMinimalSkillCatalogComponentPasses() throws Exception {
        assertEquals(List.of(),
                validate(document("{\"maxSkills\":40,\"includeDescriptions\":true,\"sort\":\"binding\"}")));
    }

    @Test
    void optionalMaxTokensIsAcceptedAtOneAndRefusedAtZero() throws Exception {
        assertTrue(validate(document(
                "{\"maxSkills\":40,\"includeDescriptions\":true,\"sort\":\"binding\",\"maxTokens\":1}"))
                .isEmpty());
        assertFalse(validate(document(
                "{\"maxSkills\":40,\"includeDescriptions\":true,\"sort\":\"binding\",\"maxTokens\":0}"))
                .isEmpty());
    }

    /** The v1-reserved value must be a 400, not a silent fallback to `binding` order. */
    @Test
    void reservedUsageSortIsRefused() throws Exception {
        assertFalse(validate(document(
                "{\"maxSkills\":40,\"includeDescriptions\":true,\"sort\":\"usage\"}")).isEmpty());
        assertFalse(validate(document(
                "{\"maxSkills\":40,\"includeDescriptions\":true,\"sort\":\"name\"}")).isEmpty());
    }

    @Test
    void maxSkillsIsBoundedByTheDeclaredRange() throws Exception {
        assertFalse(validate(document(
                "{\"maxSkills\":0,\"includeDescriptions\":true,\"sort\":\"binding\"}")).isEmpty());
        assertFalse(validate(document(
                "{\"maxSkills\":201,\"includeDescriptions\":true,\"sort\":\"binding\"}")).isEmpty());
        assertTrue(validate(document(
                "{\"maxSkills\":200,\"includeDescriptions\":true,\"sort\":\"binding\"}")).isEmpty());
    }

    @Test
    void requiredKeysAndUnknownKeysAreEnforced() throws Exception {
        // Missing `sort`/`includeDescriptions`.
        assertFalse(validate(document("{\"maxSkills\":40}")).isEmpty());
        // A typo must not quietly become a no-op setting.
        assertFalse(validate(document(
                "{\"maxSkills\":40,\"includeDescriptions\":true,\"sort\":\"binding\",\"maxSkill\":9}"))
                .isEmpty());
    }

    @Test
    void twoSkillCatalogInstancesAreAllowed() throws Exception {
        String json = """
                {
                  "templates": [
                    {
                      "id": "33333333-3333-4333-8333-333333333333",
                      "version": 1,
                      "name": "two catalogs",
                      "description": "schema fixture",
                      "document": "body",
                      "components": [
                        {"instanceId": "%s", "type": "skill_catalog", "enabled": true,
                         "config": {"maxSkills":10,"includeDescriptions":true,"sort":"binding"}},
                        {"instanceId": "%s", "type": "skill_catalog", "enabled": false,
                         "config": {"maxSkills":40,"includeDescriptions":false,"sort":"binding"}}
                      ]
                    }
                  ]
                }
                """.formatted(INSTANCE, INSTANCE_TWO);

        assertEquals(List.of(), validate(json));
    }
}
