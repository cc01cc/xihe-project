package com.cc01cc.p.xihe.cp.timeout;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class ToolTimeoutPolicyTest {

    private final ToolTimeoutPolicy policy = new ToolTimeoutPolicy();

    @Test
    void perCallBeatsConfig() {
        ToolTimeoutPolicy.ToolWaits waits = policy.resolve(20, 15);
        assertThat(waits.runtimeSeconds()).isEqualTo(20);
        assertThat(waits.cpSeconds()).isEqualTo(22);
        assertThat(waits.agentSeconds()).isEqualTo(24);
        assertThat(waits.origin()).isEqualTo("per-call");
    }

    @Test
    void configBeatsDefault() {
        ToolTimeoutPolicy.ToolWaits waits = policy.resolve(null, 20);
        assertThat(waits.runtimeSeconds()).isEqualTo(20);
        assertThat(waits.cpSeconds()).isEqualTo(22);
        assertThat(waits.agentSeconds()).isEqualTo(24);
        assertThat(waits.origin()).isEqualTo("config");
    }

    @Test
    void defaultIsUsedWhenNothingConfigured() {
        ToolTimeoutPolicy.ToolWaits waits = policy.resolve(null, null);
        assertThat(waits.runtimeSeconds()).isEqualTo(ToolTimeoutPolicy.DEFAULT_BUDGET_SECONDS);
        assertThat(waits.origin()).isEqualTo("config");
    }

    @Test
    void invalidPerCallAndConfigAreIgnored() {
        assertThat(policy.resolve(0, 20).runtimeSeconds()).isEqualTo(20);
        assertThat(policy.resolve(-5, 20).origin()).isEqualTo("config");
        assertThat(policy.resolve(null, 0).runtimeSeconds())
                .isEqualTo(ToolTimeoutPolicy.DEFAULT_BUDGET_SECONDS);
    }

    @Test
    void perCallValidationEnforcesPositiveAndCap() {
        // PLAN-0308 T3.1：per-call 与数据库配置同顶 30s。
        assertThat(ToolTimeoutPolicy.MAX_BUDGET_SECONDS).isEqualTo(30L);
        assertThat(policy.parsePerCall("30")).isEqualTo(30L);
        assertThat(policy.parsePerCall("1")).isEqualTo(1L);
        assertThat(policy.parsePerCall("31")).isNull();
        assertThat(policy.parsePerCall("601")).isNull();
        assertThat(policy.parsePerCall("0")).isNull();
        assertThat(policy.parsePerCall("-3")).isNull();
        assertThat(policy.parsePerCall("abc")).isNull();
        assertThat(policy.parsePerCall("  ")).isNull();
        assertThat(policy.parsePerCall(null)).isNull();
    }

    @Test
    void configSecondsParsingIsFailClosed() {
        assertThat(policy.parseConfigSeconds("30")).isEqualTo(30);
        assertThat(policy.parseConfigSeconds("1")).isEqualTo(1);
        assertThat(policy.parseConfigSeconds("31")).isNull();
        // 遗留大值（旧上限 600 时代的配置）不再生效，回落默认。
        assertThat(policy.parseConfigSeconds("90")).isNull();
        assertThat(policy.parseConfigSeconds("600")).isNull();
        assertThat(policy.parseConfigSeconds("0")).isNull();
        assertThat(policy.parseConfigSeconds("-1")).isNull();
        assertThat(policy.parseConfigSeconds("x")).isNull();
        assertThat(policy.parseConfigSeconds("")).isNull();
    }

    @Test
    void schemaCeilingMatchesPolicyConstant() throws Exception {
        // T3.1 评审修复：三方同步的 schema `maximum`/`pattern` 必须与 CP 常量一致，
        // 改常量漏改 schema（或反之）会让 CI 直接失败，而不是线上静默漂移。
        try (java.io.InputStream in = getClass().getResourceAsStream("/config-schemas/agent-runtime.json")) {
            assertThat(in).as("agent-runtime schema on classpath").isNotNull();
            com.fasterxml.jackson.databind.JsonNode field =
                    new com.fasterxml.jackson.databind.ObjectMapper().readTree(in)
                            .path("properties").path("systemToolTimeoutS");
            assertThat(field.path("maximum").asLong()).isEqualTo(ToolTimeoutPolicy.MAX_BUDGET_SECONDS);
            String pattern = field.path("pattern").asText();
            // 配置以字符串提交（UI/API/import）：pattern 是写入侧真正生效的那道界。
            assertThat(java.util.regex.Pattern.matches(pattern, "30")).isTrue();
            assertThat(java.util.regex.Pattern.matches(pattern, "1")).isTrue();
            assertThat(java.util.regex.Pattern.matches(pattern, "31")).isFalse();
            assertThat(java.util.regex.Pattern.matches(pattern, "90")).isFalse();
        }
    }

    @Test
    void marginsAreFixedConstants() {
        assertThat(policy.waits(30, "config").cpSeconds()).isEqualTo(32);
        assertThat(policy.waits(30, "config").agentSeconds()).isEqualTo(34);
    }

    // PLAN-0308 T1.9：run 请求携带的 per-call 映射校验（非法/超限 → 400，不静默截断）。

    @Test
    void perCallMapAcceptsIntegersAndNumericStrings() {
        ToolTimeoutPolicy.PerCallMap result = policy.validatePerCallMap(
                java.util.Map.of("execute_command", 20, "read_file", "25"));
        assertThat(result.valid()).isTrue();
        assertThat(result.values()).containsEntry("execute_command", 20).containsEntry("read_file", 25);
    }

    @Test
    void perCallMapAbsentOrEmptyIsValid() {
        assertThat(policy.validatePerCallMap(null).valid()).isTrue();
        assertThat(policy.validatePerCallMap(java.util.Map.of()).valid()).isTrue();
        assertThat(policy.validatePerCallMap(java.util.Map.of()).values()).isEmpty();
    }

    @Test
    void perCallMapRejectsInvalidAndOversizedValuesWithNamedError() {
        java.util.Map<String, Object> withNull = new java.util.HashMap<>();
        withNull.put("execute_command", null);
        for (Object bad : new Object[] {"86400", 31, 601, 0, -3, "abc", 12.5, true}) {
            ToolTimeoutPolicy.PerCallMap result =
                    policy.validatePerCallMap(java.util.Map.of("execute_command", bad));
            assertThat(result.valid()).as("value %s", bad).isFalse();
            assertThat(result.error()).contains("toolTimeouts.execute_command").contains("30");
        }
        ToolTimeoutPolicy.PerCallMap nullValue = policy.validatePerCallMap(withNull);
        assertThat(nullValue.valid()).isFalse();
        assertThat(nullValue.error()).contains("toolTimeouts.execute_command");
    }

    @Test
    void perCallMapRejectsNonObjectAndBlankToolName() {
        assertThat(policy.validatePerCallMap(java.util.List.of(20)).error())
                .contains("toolTimeouts must be an object");
        assertThat(policy.validatePerCallMap(java.util.Map.of("  ", 20)).error())
                .contains("blank tool name");
    }
}
