package com.cc01cc.p.xihe.cp.timeout;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class ToolTimeoutPolicyTest {

    private final ToolTimeoutPolicy policy = new ToolTimeoutPolicy();

    @Test
    void perCallBeatsConfig() {
        ToolTimeoutPolicy.ToolWaits waits = policy.resolve(120, 90);
        assertThat(waits.runtimeSeconds()).isEqualTo(120);
        assertThat(waits.cpSeconds()).isEqualTo(122);
        assertThat(waits.agentSeconds()).isEqualTo(124);
        assertThat(waits.origin()).isEqualTo("per-call");
    }

    @Test
    void configBeatsDefault() {
        ToolTimeoutPolicy.ToolWaits waits = policy.resolve(null, 90);
        assertThat(waits.runtimeSeconds()).isEqualTo(90);
        assertThat(waits.cpSeconds()).isEqualTo(92);
        assertThat(waits.agentSeconds()).isEqualTo(94);
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
        assertThat(policy.resolve(0, 90).runtimeSeconds()).isEqualTo(90);
        assertThat(policy.resolve(-5, 90).origin()).isEqualTo("config");
        assertThat(policy.resolve(null, 0).runtimeSeconds())
                .isEqualTo(ToolTimeoutPolicy.DEFAULT_BUDGET_SECONDS);
    }

    @Test
    void perCallValidationEnforcesPositiveAndCap() {
        assertThat(policy.parsePerCall("600")).isEqualTo(600L);
        assertThat(policy.parsePerCall("1")).isEqualTo(1L);
        assertThat(policy.parsePerCall("601")).isNull();
        assertThat(policy.parsePerCall("0")).isNull();
        assertThat(policy.parsePerCall("-3")).isNull();
        assertThat(policy.parsePerCall("abc")).isNull();
        assertThat(policy.parsePerCall("  ")).isNull();
        assertThat(policy.parsePerCall(null)).isNull();
    }

    @Test
    void configSecondsParsingIsFailClosed() {
        assertThat(policy.parseConfigSeconds("90")).isEqualTo(90);
        assertThat(policy.parseConfigSeconds("0")).isNull();
        assertThat(policy.parseConfigSeconds("-1")).isNull();
        assertThat(policy.parseConfigSeconds("x")).isNull();
        assertThat(policy.parseConfigSeconds("")).isNull();
    }

    @Test
    void marginsAreFixedConstants() {
        assertThat(policy.waits(600, "config").cpSeconds()).isEqualTo(602);
        assertThat(policy.waits(600, "config").agentSeconds()).isEqualTo(604);
    }

    // PLAN-0308 T1.9：run 请求携带的 per-call 映射校验（非法/超限 → 400，不静默截断）。

    @Test
    void perCallMapAcceptsIntegersAndNumericStrings() {
        ToolTimeoutPolicy.PerCallMap result = policy.validatePerCallMap(
                java.util.Map.of("execute_command", 120, "read_file", "90"));
        assertThat(result.valid()).isTrue();
        assertThat(result.values()).containsEntry("execute_command", 120).containsEntry("read_file", 90);
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
        for (Object bad : new Object[] {"86400", 601, 0, -3, "abc", 12.5, true}) {
            ToolTimeoutPolicy.PerCallMap result =
                    policy.validatePerCallMap(java.util.Map.of("execute_command", bad));
            assertThat(result.valid()).as("value %s", bad).isFalse();
            assertThat(result.error()).contains("toolTimeouts.execute_command").contains("600");
        }
        ToolTimeoutPolicy.PerCallMap nullValue = policy.validatePerCallMap(withNull);
        assertThat(nullValue.valid()).isFalse();
        assertThat(nullValue.error()).contains("toolTimeouts.execute_command");
    }

    @Test
    void perCallMapRejectsNonObjectAndBlankToolName() {
        assertThat(policy.validatePerCallMap(java.util.List.of(120)).error())
                .contains("toolTimeouts must be an object");
        assertThat(policy.validatePerCallMap(java.util.Map.of("  ", 120)).error())
                .contains("blank tool name");
    }
}
