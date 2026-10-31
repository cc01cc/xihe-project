package com.cc01cc.p.xihe.cp.migration;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import jakarta.persistence.EntityManagerFactory;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0407 T2.9: DB schema conformance to spec §3
 * ({@code plans/PLAN-0407-XH-principal-scope-derivation/spec/authorization-and-derivation.md}
 * lines 37–61) on the Spring-managed Testcontainers schema — the same Flyway chain the
 * application boots with, inspected through {@code JdbcTemplate}.
 *
 * <p>{@code DomainSchemaMigrationTest} covers fresh and upgraded schema paths on a standalone
 * Flyway connection. This class asserts exact enumeration value sets (grants.source,
 * sessions.kind, chat_runs.origin), the partial default-index definition, the ChatRun waiting-link
 * carrier, and that Hibernate {@code ddl-auto=validate} runs against this schema.</p>
 */
class SpecFieldConformanceTest extends AbstractIntegrationTest {

    private static final Pattern QUOTED_VALUE = Pattern.compile("'([^']+)'");

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private EntityManagerFactory entityManagerFactory;

    @Value("${spring.jpa.hibernate.ddl-auto}")
    private String ddlAuto;

    /** spec §3.1: grants columns, the four-value source enum, the partial default index. */
    @Test
    void grantsColumnsSourceVocabularyAndDefaultIndexConformToSpec31() {
        for (String column : new String[]{"granter_type", "granter_id", "subject_type", "subject_id",
                "permissions", "source", "role_name", "template_name", "created_at", "read_state",
                "scope_type", "scope_id"}) {
            assertEquals(1, columnCount("grants", column),
                    "spec §3.1 grants must expose column: " + column);
        }
        assertEquals("jsonb", columnInfo("grants", "permissions", "data_type"),
                "spec §3.1: permissions is a JSONB atom array");
        assertEquals("timestamp with time zone", columnInfo("grants", "created_at", "data_type"),
                "spec §3.1: created_at is a timestamp column");
        // PLAN-0610 V87 (round-2 P0): the allow-list is the union of the legacy four values and
        // the three new ones, so the migration applies to a database that still holds
        // default/direct rows. V88 converts the rows and narrows the constraint.
        assertEquals(Set.of("default", "spawn", "direct", "template",
                        "role", "credential_binding", "agent_default"),
                checkAllowedValues("ck_grants_source"),
                "PLAN-0610 V87: legacy four values plus role/credential_binding/agent_default");

        // PLAN-0610 V87: the scoped materialization keys (one row per atom per scope), and the
        // per-source successors of the V38/V65 fences.
        assertNotNull(indexDefinition("uq_grants_role_atom"),
                "role materialization needs its scoped per-atom partial unique index");
        assertNotNull(indexDefinition("uq_grants_credential_binding_subject"),
                "PLAN-0610 keeps V65's one-row-per-subject fence under the new source name");
        assertNotNull(indexDefinition("uq_grants_agent_default_subject"),
                "the frozen agent snapshot keeps the V38-style single-row fence");

        String indexDef = indexDefinition("uq_grants_default_subject");
        assertNotNull(indexDef, "spec §3.1: partial unique index uq_grants_default_subject must "
                + "survive until V88 converts the legacy default rows");
        assertTrue(indexDef.contains("UNIQUE"),
                "one default permission set per subject: " + indexDef);
        assertTrue(indexDef.contains("(subject_type, subject_id)"),
                "spec §3.1: the default index keys are (subject_type, subject_id): " + indexDef);
        String partialPredicate = indexDef.contains("WHERE")
                ? indexDef.substring(indexDef.indexOf("WHERE"))
                        .replace("::text", "").replace("(", "").replace(")", "")
                : "";
        assertTrue(partialPredicate.contains("source = 'default'"),
                "spec §3.1: the index is partial over source='default': " + indexDef);
    }

    /** spec §3.2: sessions provenance columns, kind ∈ {spawn, fork}, agent_principal_id. */
    @Test
    void sessionsProvenanceKindAndPrincipalColumnsConformToSpec32() {
        for (String column : new String[]{"spawned_from_session_id", "spawned_from_run_id",
                "spawned_at", "kind", "agent_principal_id"}) {
            assertEquals(1, columnCount("sessions", column),
                    "spec §3.2 sessions must expose column: " + column);
        }
        for (String column : new String[]{"spawned_from_session_id", "spawned_from_run_id",
                "spawned_at", "kind"}) {
            assertEquals("YES", columnInfo("sessions", column, "is_nullable"),
                    "spec §3.2: root Sessions keep " + column + " NULL, so the column stays nullable");
        }
        assertEquals(Set.of("spawn", "fork"), checkAllowedValues("ck_sessions_kind"),
                "spec §3.2: kind ∈ {spawn, fork} — exactly two values, no extras");
    }

    /** spec §3.3: origin value set, the single waiting-link carrier, the V44 terminal column. */
    @Test
    void chatRunsOriginWaitingLinkAndTerminalConformToSpec33() {
        assertEquals(1, columnCount("chat_runs", "origin"),
                "spec §3.3: chat_runs.origin must exist");
        assertEquals("NO", columnInfo("chat_runs", "origin", "is_nullable"),
                "spec §3.3: every run carries its origin once the V39 backfill has run");
        // PLAN-0489 决策 #7（V59）: scheduled wakeup carriers join the origin set.
        assertEquals(Set.of("user_submission", "spawn", "scheduled"), checkAllowedValues("ck_chat_runs_origin"),
                "spec §3.3 + PLAN-0489 #7: origin ∈ {user_submission, spawn, scheduled} — exactly three values, no extras");

        assertEquals("uuid", columnInfo("chat_runs", "waiting_on_run_id", "data_type"),
                "spec §3.3: the waiting link is chat_runs.waiting_on_run_id");
        assertEquals("YES", columnInfo("chat_runs", "waiting_on_run_id", "is_nullable"),
                "spec §3.3: the waiting link is nullable (cleared inside the terminal transaction)");
        assertEquals("uuid", columnInfo("chat_runs", "waiting_tool_call_id", "data_type"),
                "spec §3.3: the waiting tool-call link is UUID-valued");
        assertEquals("YES", columnInfo("chat_runs", "waiting_tool_call_id", "is_nullable"));
        assertEquals(2, waitingKeyColumnCount("chat_runs"),
                "spec §3.3: ChatRun carries the parent-run and tool-call waiting keys");

        assertEquals("timestamp with time zone", columnInfo("chat_runs", "terminal_at", "data_type"),
                "V44 delta: chat_runs.terminal_at exists");
        assertEquals("YES", columnInfo("chat_runs", "terminal_at", "is_nullable"),
                "V44 delta: runs stay NULL there until the unified terminal transaction writes it");
    }

    /** Hibernate validates the Flyway-managed schema at context startup (ddl-auto=validate). */
    @Test
    void hibernateValidateModeIsExercisedAgainstTheFlywayMigratedSchema() {
        assertEquals("validate", ddlAuto,
                "the suite boots Hibernate with ddl-auto=validate, so schema drift fails context startup");
        assertNotNull(entityManagerFactory,
                "the JPA bootstrap ran against the Testcontainers database — that boot is when "
                        + "Hibernate performs schema validation");
        assertEquals(1, jdbcTemplate.queryForObject(
                        "SELECT count(*) FROM flyway_schema_history WHERE version = '55' AND success = true",
                        Integer.class),
                "the validated schema is the Flyway-managed one with the V44 delta applied");
    }

    private int columnCount(String table, String column) {
        Integer count = jdbcTemplate.queryForObject(
                "SELECT count(*) FROM information_schema.columns "
                        + "WHERE table_schema = 'public' AND table_name = ? AND column_name = ?",
                Integer.class, table, column);
        return count == null ? 0 : count;
    }

    private String columnInfo(String table, String column, String property) {
        List<String> values = jdbcTemplate.queryForList(
                "SELECT " + property + " FROM information_schema.columns "
                        + "WHERE table_schema = 'public' AND table_name = ? AND column_name = ?",
                String.class, table, column);
        return values.isEmpty() ? null : values.get(0);
    }

    private String indexDefinition(String indexName) {
        List<String> definitions = jdbcTemplate.queryForList(
                "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = ?",
                String.class, indexName);
        return definitions.isEmpty() ? null : definitions.get(0);
    }

    /** The exact value set of a CHECK constraint, parsed from pg_get_constraintdef. */
    private Set<String> checkAllowedValues(String constraintName) {
        List<String> definitions = jdbcTemplate.queryForList(
                "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = ?",
                String.class, constraintName);
        if (definitions.isEmpty()) {
            throw new AssertionError("missing CHECK constraint: " + constraintName);
        }
        Set<String> values = new LinkedHashSet<>();
        Matcher matcher = QUOTED_VALUE.matcher(definitions.get(0));
        while (matcher.find()) {
            values.add(matcher.group(1));
        }
        return values;
    }

    private int waitingKeyColumnCount(String table) {
        Integer count = jdbcTemplate.queryForObject(
                "SELECT count(*) FROM information_schema.columns "
                        + "WHERE table_schema = 'public' AND table_name = ? AND column_name LIKE '%waiting%'",
                Integer.class, table);
        return count == null ? 0 : count;
    }
}
