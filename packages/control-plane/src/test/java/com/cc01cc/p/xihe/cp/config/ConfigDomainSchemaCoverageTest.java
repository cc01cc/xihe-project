package com.cc01cc.p.xihe.cp.config;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.core.io.Resource;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.ActiveProfiles;

import java.io.IOException;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * task-384 (B+): the authority for the legal {@code {domain}} set is {@link ConfigService#DOMAINS},
 * not the {@code config-schemas/*.json} file set. Thirteen domains carry a schema; the fourteenth
 * ({@code api-request-templates}) is carried whole by {@code ApiRequestTemplateService}, which
 * {@link ConfigService#putLayerInternal} forwards to before any schema validation could run.
 *
 * <p>This gate pins both halves of that statement so the exception stays explicit:
 * <ul>
 *   <li>the set difference is exactly the one service-carried domain — a new schema-less domain, or
 *       an orphan schema file for a domain that does not exist, turns this red;</li>
 *   <li>the exception cannot be written through the generic path with arbitrary keys — if the
 *       forward in {@code putLayerInternal} is ever removed, the generic path would accept any key
 *       (no schema, so {@code validateBySchema} passes) and this turns red.</li>
 * </ul>
 *
 * <p>History note: AGENTS.md used to claim a "yaml enum == schema file names" gate that never
 * existed; this is the real, executable replacement (task-381 reading, task-384 ruling B).
 */
@SpringBootTest
@ActiveProfiles("h2")
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class ConfigDomainSchemaCoverageTest {

    /** The single domain carried by a dedicated service instead of a schema file. */
    private static final String SERVICE_CARRIED_DOMAIN = "api-request-templates";

    @Autowired
    private ConfigService configService;

    @Test
    void theDomainSetIsExactlyTheSchemaFilesPlusTheSingleServiceCarriedException() throws IOException {
        Set<String> schemaDomains = schemaFileDomains();
        assertTrue(ConfigService.DOMAINS.containsAll(schemaDomains),
                "every schema file must belong to a registered domain; orphans: " + difference(schemaDomains,
                        ConfigService.DOMAINS));

        Set<String> withoutSchema = difference(ConfigService.DOMAINS, schemaDomains);
        assertEquals(Set.of(SERVICE_CARRIED_DOMAIN), withoutSchema,
                "the schema-less exception list must stay exactly {api-request-templates}; "
                        + "a new schema-less domain needs a dedicated-service forward and an update here");
    }

    @Test
    void theServiceCarriedDomainRejectsArbitraryKeysThroughTheGenericPath() {
        UUID user = UUID.randomUUID();
        TenantContext.setUserId(user.toString());
        try {
            CpApiException rejected = assertThrows(CpApiException.class,
                    () -> configService.putLayer("user", SERVICE_CARRIED_DOMAIN,
                            Map.of("not-a-template-key", "x"), "probe", user, null));
            assertEquals("INVALID_REQUEST", rejected.getCode(),
                    "the dedicated service's KEYS whitelist must answer, not the generic path");
            assertTrue(rejected.getMessage().contains("Unknown API Request Template config key"),
                    "the rejection must come from ApiRequestTemplateService.putLayer, got: "
                            + rejected.getMessage());
        } finally {
            TenantContext.clear();
        }
    }

    private static Set<String> difference(Set<String> left, Set<String> right) {
        Set<String> result = new TreeSet<>(left);
        result.removeAll(right);
        return result;
    }

    private static Set<String> schemaFileDomains() throws IOException {
        PathMatchingResourcePatternResolver resolver = new PathMatchingResourcePatternResolver();
        Set<String> domains = new TreeSet<>();
        for (Resource resource : resolver.getResources("classpath:config-schemas/*.json")) {
            String filename = resource.getFilename();
            assertNotNull(filename, "schema resource without a filename");
            domains.add(filename.replace(".json", ""));
        }
        return domains;
    }
}
