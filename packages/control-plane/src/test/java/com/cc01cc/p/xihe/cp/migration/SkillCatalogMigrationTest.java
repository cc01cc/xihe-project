package com.cc01cc.p.xihe.cp.migration;

import com.cc01cc.p.xihe.cp.support.TestContainerLabels;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0628 M1 (V101): {@code skills} + {@code skill_bindings} — the DDL is the contract, so every
 * constraint is asserted against a real PostgreSQL instead of being trusted from review.
 *
 * <p>The two probes that matter most:</p>
 * <ul>
 *   <li><b>NULLS NOT DISTINCT</b> on both unique keys — the instance tier stores
 *       {@code definition_scope_id}/{@code scope_id} as NULL, and a plain UNIQUE would let two
 *       instance rows coexist (the V87 round-2 P0 trap);</li>
 *   <li><b>same name across definition scopes</b> — README frozen #4 requires "双存", so this test
 *       really <b>inserts</b> two rows named {@code writing} (instance + workspace, and two
 *       different workspaces) rather than only reading the DDL text.</li>
 * </ul>
 */
@Testcontainers
class SkillCatalogMigrationTest {

    @Container
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("pgvector/pgvector:pg17")
            .withDatabaseName("xihe_cp_v101")
            .withUsername("test")
            .withPassword("test")
            .withLabels(TestContainerLabels.runId());

    /** Skill author / binding author — kept separate from {@link #OWNER_ID} (see restrict test). */
    private static final UUID USER_ID = UUID.randomUUID();
    private static final UUID OWNER_ID = UUID.randomUUID();
    private static final UUID WORKSPACE_1 = UUID.randomUUID();
    private static final UUID WORKSPACE_2 = UUID.randomUUID();
    private static final UUID PRINCIPAL_ID = UUID.randomUUID();
    private static final String HASH = "c".repeat(64);

    private static Connection connection;

    @BeforeAll
    static void migrateAndSeedFixtures() throws SQLException {
        String url = postgres.getJdbcUrl();
        Flyway.configure().dataSource(url, postgres.getUsername(), postgres.getPassword()).load().migrate();
        connection = DriverManager.getConnection(url, postgres.getUsername(), postgres.getPassword());
        execute("INSERT INTO users (id, email, password_hash, username) VALUES ('" + USER_ID
                + "', 'plan0628-skill@test.local', 'x', 'plan0628skill')");
        execute("INSERT INTO users (id, email, password_hash, username) VALUES ('" + OWNER_ID
                + "', 'plan0628-owner@test.local', 'x', 'plan0628owner')");
        execute("INSERT INTO workspaces (id, name) VALUES ('" + WORKSPACE_1 + "', 'v101-skill-ws1')");
        execute("INSERT INTO workspaces (id, name) VALUES ('" + WORKSPACE_2 + "', 'v101-skill-ws2')");
        execute("INSERT INTO agent_principals (id, name, created_by_user_id) VALUES ('" + PRINCIPAL_ID
                + "', 'v101 skill principal', '" + USER_ID + "')");
    }

    @BeforeEach
    void clearTables() throws SQLException {
        execute("DELETE FROM skill_bindings");
        execute("DELETE FROM skills");
    }

    // ---------------------------------------------------------------- helpers

    /**
     * A fresh workspace per test that needs one: the cascade test deletes its own workspace, so
     * sharing a module-level id across tests would make them order-dependent.
     */
    private static UUID newWorkspace() throws SQLException {
        UUID id = UUID.randomUUID();
        execute("INSERT INTO workspaces (id, name) VALUES ('" + id + "', 'v101-ws-" + id + "')");
        return id;
    }

    private static SkillInsert skill(String name, String scopeType, UUID scopeId) {
        return new SkillInsert(name, scopeType, scopeId);
    }

    /** One insert spec; every field can be overridden by the negative tests (mutable on purpose). */
    private static final class SkillInsert {

        private final String name;
        private final String scopeType;
        private final UUID scopeId;
        private String description = "a test skill";
        private String body = "do the thing";
        private int bodyTokensEst = 3;
        private boolean oversize = false;
        private String attachments = "'[]'::jsonb";
        private boolean trusted = false;
        private final String sourcePath;
        private final String contentHash = HASH;
        private UUID createdBy = OWNER_ID;

        private SkillInsert(String name, String scopeType, UUID scopeId) {
            this.name = name;
            this.scopeType = scopeType;
            this.scopeId = scopeId;
            this.sourcePath = ".agents/skills/" + name + "/SKILL.md";
        }

        SkillInsert description(String value) {
            this.description = value;
            return this;
        }

        SkillInsert body(String value) {
            this.body = value;
            return this;
        }

        SkillInsert tokens(int value) {
            this.bodyTokensEst = value;
            return this;
        }

        SkillInsert oversize(boolean value) {
            this.oversize = value;
            return this;
        }

        SkillInsert attachments(String jsonLiteral) {
            this.attachments = jsonLiteral;
            return this;
        }

        SkillInsert createdBy(UUID value) {
            this.createdBy = value;
            return this;
        }

        UUID insert() throws SQLException {
            UUID id = UUID.randomUUID();
            execute("INSERT INTO skills (id, name, definition_scope_type, definition_scope_id,"
                    + " description, body, body_tokens_est, oversize, attachments, trusted,"
                    + " source_path, content_hash, created_by_user_id) VALUES ('" + id + "', '"
                    + name + "', '" + scopeType + "', "
                    + (scopeId == null ? "NULL" : "'" + scopeId + "'") + ", '"
                    + description.replace("'", "''") + "', '" + body.replace("'", "''") + "', "
                    + bodyTokensEst + ", " + oversize + ", " + attachments + ", " + trusted
                    + ", '" + sourcePath + "', '" + contentHash + "', '" + createdBy + "')");
            return id;
        }
    }

    private static UUID bind(UUID skillId, String subjectType, UUID subjectId,
                             String scopeType, UUID scopeId) throws SQLException {
        UUID id = UUID.randomUUID();
        execute("INSERT INTO skill_bindings (id, skill_id, subject_type, subject_id, scope_type,"
                + " scope_id, created_by_user_id) VALUES ('" + id + "', '" + skillId + "', '"
                + subjectType + "', '" + subjectId + "', '" + scopeType + "', "
                + (scopeId == null ? "NULL" : "'" + scopeId + "'") + ", '" + USER_ID + "')");
        return id;
    }

    // ---------------------------------------------------------------- T1 cases

    @Test
    void tablesHaveTheFrozenColumnsAndIndexes() throws SQLException {
        List<String> skillColumns = queryStrings("SELECT column_name FROM information_schema.columns "
                + "WHERE table_name = 'skills' ORDER BY column_name");
        assertTrue(skillColumns.containsAll(List.of("id", "name", "definition_scope_type",
                "definition_scope_id", "description", "body", "body_tokens_est", "oversize",
                "attachments", "trusted", "source_path", "content_hash", "version",
                "created_by_user_id", "created_at", "updated_at")), skillColumns.toString());
        // Zero-consumer columns that were deliberately not created (YAGNI, taskbook §4.3).
        assertTrue(!skillColumns.contains("disabled_at") && !skillColumns.contains("origin")
                && !skillColumns.contains("trusted_source"), skillColumns.toString());

        List<String> bindingColumns = queryStrings(
                "SELECT column_name FROM information_schema.columns "
                        + "WHERE table_name = 'skill_bindings' ORDER BY column_name");
        assertTrue(bindingColumns.containsAll(List.of("id", "skill_id", "subject_type",
                "subject_id", "scope_type", "scope_id", "created_by_user_id", "created_at")),
                bindingColumns.toString());

        for (String index : List.of("idx_skills_definition_scope", "idx_skill_bindings_subject",
                "idx_skill_bindings_scope", "idx_skill_bindings_skill")) {
            assertEquals(1, scalarInt("SELECT count(*) FROM pg_indexes WHERE indexname = '" + index + "'"),
                    "missing index " + index);
        }
        for (String constraint : List.of("uq_skills_qualified_name", "uq_skill_bindings")) {
            assertEquals(1, scalarInt("SELECT count(*) FROM pg_constraint WHERE conname = '"
                    + constraint + "'"), "missing constraint " + constraint);
        }
    }

    @Test
    void qualifiedNameKeyAllowsOnlyOneDefinitionPerScope() throws SQLException {
        skill("writing", "instance", null).insert();
        // Same (name, 'instance', NULL): the NULL scope id must collide, not slip through.
        assertThrows(SQLException.class, () -> skill("writing", "instance", null).insert());
    }

    /**
     * README frozen #4 ("双存"): the same name exists once per definition scope — really inserted,
     * not inferred from the DDL text.
     */
    @Test
    void sameNameCoexistsAcrossDefinitionScopes() throws SQLException {
        UUID instanceSkill = skill("writing", "instance", null).insert();
        UUID workspaceOneSkill = skill("writing", "workspace", WORKSPACE_1).insert();
        UUID workspaceTwoSkill = skill("writing", "workspace", WORKSPACE_2).insert();

        assertEquals(3, scalarInt("SELECT count(*) FROM skills WHERE name = 'writing'"));

        // …and within one workspace the same name is still unique.
        assertThrows(SQLException.class, () -> skill("writing", "workspace", WORKSPACE_1).insert());

        // The three rows are genuinely distinct identities (this is what the qualifier needs).
        assertEquals(3, List.of(instanceSkill, workspaceOneSkill, workspaceTwoSkill).stream().distinct().count());
    }

    @Test
    void descriptionAndBodyBounds() throws SQLException {
        // DDL truth: description is bounded by char_length 1..1024.
        assertThrows(SQLException.class, () -> skill("too-long", "instance", null)
                .description("d".repeat(1025)).insert());
        assertThrows(SQLException.class, () -> skill("empty-desc", "instance", null)
                .description("").insert());
        // Body: trimmed non-empty and <= 262144 octets. The tab/newline case is the one a plain
        // `btrim(body)` would let through (one-arg btrim removes spaces only).
        assertThrows(SQLException.class, () -> skill("blank-body", "instance", null)
                .body("   ").insert());
        assertThrows(SQLException.class, () -> skill("blank-body-2", "instance", null)
                .body("\n\t\r ").insert());
        assertThrows(SQLException.class, () -> skill("huge-body", "instance", null)
                .body("x".repeat(262_145)).insert());
        // Boundary is inclusive.
        skill("max-body", "instance", null).body("x".repeat(262_144)).insert();
    }

    /**
     * D28-29 (user ruling 2026-11-02): the DDL itself rejects a <b>whitespace-only</b> description.
     * A "stored by the DDL, refused by the validator" split would let any direct insert or future
     * import path bypass the seam. {@code SkillImportValidator} refuses it too — see
     * {@code SkillImportValidatorTest} (dual protection, not either/or).
     */
    @Test
    void blankDescriptionIsRejectedByTheDdl() throws SQLException {
        assertThrows(SQLException.class, () -> skill("blank-ish", "instance", null)
                .description("   ").insert());
        assertThrows(SQLException.class, () -> skill("blank-ish-2", "instance", null)
                .description("\n\t ").insert());
        assertEquals(0, scalarInt("SELECT count(*) FROM skills"));
    }

    @Test
    void oversizeIsBiconditional() throws SQLException {
        // (est > 5000) must equal the flag: the two contradictory states are refused.
        assertThrows(SQLException.class, () -> skill("over-false", "instance", null)
                .tokens(5001).oversize(false).insert());
        assertThrows(SQLException.class, () -> skill("under-true", "instance", null)
                .tokens(5000).oversize(true).insert());
        // The two consistent states are accepted (D28-15: marked, never rejected).
        skill("over-true", "instance", null).tokens(5001).oversize(true).insert();
        skill("under-false", "instance", null).tokens(5000).oversize(false).insert();
    }

    @Test
    void attachmentsMustBeAJsonArray() throws SQLException {
        assertThrows(SQLException.class, () -> skill("obj-attachments", "instance", null)
                .attachments("'{}'::jsonb").insert());
        skill("arr-attachments", "instance", null)
                .attachments("'[{\"path\":\"references/a.md\",\"sizeBytes\":12,"
                        + "\"sha256\":\"" + HASH + "\",\"kind\":\"reference\"}]'::jsonb")
                .insert();
    }

    @Test
    void bindingKeyIsTwoAxisAndNullSafe() throws SQLException {
        UUID skillId = skill("bound", "instance", null).insert();

        bind(skillId, "user", USER_ID, "instance", null);
        // Same (skill, subject, instance scope): the NULL scope id must collide.
        assertThrows(SQLException.class, () -> bind(skillId, "user", USER_ID, "instance", null));

        // A workspace binding without a scope id is refused, and so is the out-of-vocabulary tier.
        assertThrows(SQLException.class, () -> bind(skillId, "user", USER_ID, "workspace", null));
        assertThrows(SQLException.class, () -> bind(skillId, "instance", USER_ID, "instance", null));

        // The two axes are independent: the same subject may hold one binding per scope.
        bind(skillId, "user", USER_ID, "workspace", WORKSPACE_1);
        assertEquals(2, scalarInt("SELECT count(*) FROM skill_bindings WHERE skill_id = '" + skillId + "'"));
    }

    @Test
    void cascadeAndRestrict() throws SQLException {
        UUID workspace = newWorkspace();
        UUID workspaceSkill = skill("scoped", "workspace", workspace).insert();
        UUID bound = bind(workspaceSkill, "user", USER_ID, "workspace", workspace);

        // Deleting the workspace removes its definition and its bindings (ON DELETE CASCADE).
        execute("DELETE FROM workspaces WHERE id = '" + workspace + "'");
        assertEquals(0, scalarInt("SELECT count(*) FROM skills WHERE id = '" + workspaceSkill + "'"));
        assertEquals(0, scalarInt("SELECT count(*) FROM skill_bindings WHERE id = '" + bound + "'"));

        // The author is RESTRICTed: users are soft-deleted in this product, so the FK never blocks
        // a real deactivation, but a hard delete must fail loudly instead of orphaning provenance.
        UUID ownedSkill = skill("owned", "instance", null).insert();
        assertThrows(SQLException.class, () -> execute("DELETE FROM users WHERE id = '" + OWNER_ID + "'"));
        assertEquals(1, scalarInt("SELECT count(*) FROM skills WHERE id = '" + ownedSkill + "'"));

        // Deleting a skill cascades to its bindings.
        UUID kept = bind(ownedSkill, "user", USER_ID, "instance", null);
        execute("DELETE FROM skills WHERE id = '" + ownedSkill + "'");
        assertEquals(0, scalarInt("SELECT count(*) FROM skill_bindings WHERE id = '" + kept + "'"));
    }

    @Test
    void invalidDefinitionScopeCombination() throws SQLException {
        assertThrows(SQLException.class, () -> skill("bad-1", "instance", WORKSPACE_2).insert());
        assertThrows(SQLException.class, () -> skill("bad-2", "workspace", null).insert());
    }

    // ---------------------------------------------------------------- jdbc helpers

    private static void execute(String sql) throws SQLException {
        try (Statement statement = connection.createStatement()) {
            statement.execute(sql);
        }
    }

    private static int scalarInt(String sql) throws SQLException {
        try (Statement statement = connection.createStatement();
             ResultSet rows = statement.executeQuery(sql)) {
            rows.next();
            return rows.getInt(1);
        }
    }

    private static List<String> queryStrings(String sql) throws SQLException {
        List<String> values = new ArrayList<>();
        try (Statement statement = connection.createStatement();
             ResultSet rows = statement.executeQuery(sql)) {
            while (rows.next()) {
                values.add(rows.getString(1));
            }
        }
        return values;
    }
}
