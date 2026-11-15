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

    /**
     * task-159（D-1529）：布局键的判据必须在**真实写路径**上成立，不只是 schema 文件自洽。
     *
     * <p>这是卡面第 5 点要求的反向保证：`validateBySchema`（`ConfigService:1949-1973`）会把
     * `{`/`[` 开头的值文本预解析成 `JsonNode` 再校验 ⇒
     * ① 合法布局（JSON 文本）能写进去；② 畸形 JSON 文本被拒（`… is not valid JSON`）；
     * ③ 非对象（数组）被拒（`object expected`）。
     * 若哪天为了别的域改了预解析规则，这三条会红 —— 那时 `user-preference` 的 wire 契约就变了。</p>
     */
    @Test
    void layoutKeysFollowTheParsedShapeOnTheRealWritePath() {
        UUID user = UUID.randomUUID();
        TenantContext.setUserId(user.toString());
        try {
            String workspace = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
            configService.putLayer("user", "user-preference",
                    Map.of("theme", "dark",
                            "layout.global", "{\"navOpen\":true,\"navWidth\":280}",
                            "layout.ws." + workspace,
                            "{\"dockWidth\":360,\"dockTabs\":[\"files\"]}"),
                    "probe", user, null);

            IllegalArgumentException malformed = assertThrows(IllegalArgumentException.class,
                    () -> configService.putLayer("user", "user-preference",
                            Map.of("layout.global", "{not json"), "probe", user, null));
            assertTrue(malformed.getMessage().contains("is not valid JSON"),
                    "malformed JSON text must be rejected before schema validation, got: "
                            + malformed.getMessage());

            IllegalArgumentException notAnObject = assertThrows(IllegalArgumentException.class,
                    () -> configService.putLayer("user", "user-preference",
                            Map.of("layout.ws." + workspace, "[1,2,3]"), "probe", user, null));
            assertTrue(notAnObject.getMessage().contains("object"),
                    "an array payload must be rejected as a non-object shape, got: "
                            + notAnObject.getMessage());
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
