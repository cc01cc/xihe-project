package com.cc01cc.p.xihe.cp.context;

import com.cc01cc.p.xihe.cp.AbstractH2Test;
import com.cc01cc.p.xihe.cp.context.service.ContextProjectionService;
import com.cc01cc.p.xihe.cp.context.service.ContextService;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * PLAN-0382 T3.1: projection-side status/fact contract.
 *
 * <ul>
 *   <li>legacy source events derive the frozen {@code l1_status} (created/updated→ok);</li>
 *   <li>clear statuses drop the legacy {@code sources} array too (BL-48 — no
 *       unmarked fallback survives in any reader);</li>
 *   <li>legacy env events leave {@code env_status} key-absent (spec §5 → unknown)
 *       while new events populate the five fact/state keys.</li>
 * </ul>
 */
class ContextProjectionStatusTest extends AbstractH2Test {

    private final String session = java.util.UUID.randomUUID().toString();
    private static final String WS = "bbbbbbb2-0000-0000-0000-000000000000";
    private static final String USER = "bbbbbbb3-0000-0000-0000-000000000000";

    @Autowired
    private ContextService contextService;

    @Autowired
    private ContextProjectionService projectionService;

    private ObjectNode epoch() {
        ObjectNode ctx = projectionService.project(session, 0L);
        return (ObjectNode) ctx.get("epoch");
    }

    @Test
    void legacyCreatedEventDerivesL1StatusOk() {
        contextService.appendEvent(session, WS, USER, "context.source_changed", Map.of(
                "status", "created",
                "source_hash", "h1",
                "rendered_text", "RULES",
                "sources", Map.of("key", "AGENTS.md", "content", "RULES", "content_hash", "h1")));

        assertThat(epoch().get("l1_status").asText()).isEqualTo("ok");
        assertThat(epoch().get("l1_rendered").asText()).isEqualTo("RULES");
    }

    @Test
    void missingStatusClearsSlotAndDropsLegacySources() {
        contextService.appendEvent(session, WS, USER, "context.source_changed", Map.of(
                "status", "created",
                "source_hash", "h1",
                "rendered_text", "RULES",
                "sources", Map.of("key", "AGENTS.md", "content", "RULES", "content_hash", "h1")));
        contextService.appendEvent(session, WS, USER, "context.source_changed", Map.of(
                "status", "missing",
                "l1_status", "missing",
                "source_hash", "",
                "rendered_text", "",
                "sources", Map.of()));

        ObjectNode epoch = epoch();
        assertThat(epoch.get("l1_status").asText()).isEqualTo("missing");
        assertThat(epoch.get("source_hash").asText()).isEmpty();
        assertThat(epoch.get("l1_rendered").asText()).isEmpty();
        // BL-48: the legacy `sources` array must be gone, not merely unrendered.
        assertThat(epoch.get("sources")).isEmpty();
    }

    @Test
    void unavailableClearsSlotExplicitly() {
        contextService.appendEvent(session, WS, USER, "context.source_changed", Map.of(
                "status", "created",
                "source_hash", "h1",
                "rendered_text", "RULES",
                "sources", Map.of("key", "AGENTS.md", "content", "RULES", "content_hash", "h1")));
        contextService.appendEvent(session, WS, USER, "context.source_changed", Map.of(
                "status", "unavailable",
                "l1_status", "unavailable",
                "source_hash", "",
                "rendered_text", ""));

        ObjectNode epoch = epoch();
        assertThat(epoch.get("l1_status").asText()).isEqualTo("unavailable");
        assertThat(epoch.get("l1_rendered").asText()).isEmpty();
        assertThat(epoch.get("sources")).isEmpty();
    }

    @Test
    void legacyEnvEventLeavesEnvStatusKeyAbsent() {
        contextService.appendEvent(session, WS, USER, "context.env_updated", Map.of(
                "branch", "main",
                "head", "abc1234",
                "is_repository", true));

        ObjectNode epoch = epoch();
        assertThat(epoch.get("env_branch").asText()).isEqualTo("main");
        // spec §5: absence, not a fabricated value → readers infer unknown.
        assertThat(epoch.has("env_status")).isFalse();
        assertThat(epoch.has("env_cwd")).isFalse();
    }

    @Test
    void newEnvEventCarriesAllFiveKeys() {
        contextService.appendEvent(session, WS, USER, "context.env_updated", Map.of(
                "branch", "main",
                "head", "abc1234",
                "is_repository", true,
                "env_status", "ok",
                "env_observed_at", "2026-10-01T00:00:00Z",
                "env_cwd", "/workspace",
                "env_platform", "linux",
                "env_shell", "xihe-shell"));

        ObjectNode epoch = epoch();
        assertThat(epoch.get("env_status").asText()).isEqualTo("ok");
        assertThat(epoch.get("env_observed_at").asText()).isEqualTo("2026-10-01T00:00:00Z");
        assertThat(epoch.get("env_cwd").asText()).isEqualTo("/workspace");
        assertThat(epoch.get("env_platform").asText()).isEqualTo("linux");
        assertThat(epoch.get("env_shell").asText()).isEqualTo("xihe-shell");
    }

    @Test
    void nullEnvValueStaysNullNotFabricated() {
        // host/mxc mode: Runtime reports cwd=null (unknown, never a host path).
        Map<String, Object> payload = new java.util.HashMap<>();
        payload.put("branch", "");
        payload.put("head", "");
        payload.put("is_repository", false);
        payload.put("env_status", "unknown");
        payload.put("env_cwd", null);
        payload.put("env_platform", "windows");
        payload.put("env_shell", null);
        payload.put("env_observed_at", "2026-10-01T00:00:00Z");
        contextService.appendEvent(session, WS, USER, "context.env_updated", payload);

        ObjectNode epoch = epoch();
        assertThat(epoch.get("env_status").asText()).isEqualTo("unknown");
        assertThat(epoch.get("env_cwd").isNull()).isTrue();
        assertThat(epoch.get("env_shell").isNull()).isTrue();
        assertThat(epoch.get("env_platform").asText()).isEqualTo("windows");
    }
}
