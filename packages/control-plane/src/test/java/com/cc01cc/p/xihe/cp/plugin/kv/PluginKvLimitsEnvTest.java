package com.cc01cc.p.xihe.cp.plugin.kv;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.env.MapPropertySource;
import org.springframework.core.env.StandardEnvironment;
import org.springframework.core.env.SystemEnvironmentPropertySource;

import java.lang.reflect.Constructor;
import java.lang.reflect.Parameter;
import java.util.LinkedHashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0691 T1.5 (spec/data-plane.md §2.1): the property shape the quota values are declared with.
 *
 * <p>{@code spec §2.1} fixes the form
 * {@code cp.plugin.<组>.<key> = ${XIHE_CP_PLUGIN_<组>_<KEY>:<默认>}} and V5 requires that
 * {@code XIHE_CP_PLUGIN_KV_MAX_KEYS=2} really lowers the budget. That cannot be proven by an
 * integration test: Surefire inherits the surefire JVM's environment and there is no supported way to
 * set a process environment variable for a forked test JVM (and mutating {@code System.getenv} would
 * be a test-only hack, not the real binding path).
 *
 * <p>So the two halves are tested where each one actually lives:
 * <ul>
 *   <li>here — the declared placeholder <b>text</b> is resolved against a real
 *       {@link SystemEnvironmentPropertySource}, which is the exact mechanism Spring uses for OS
 *       environment variables (including its {@code .}/{@code -} to {@code _} mapping — the reason
 *       the env variable has to be spelled out as a placeholder default rather than relying on relaxed
 *       binding);</li>
 *   <li>in {@link PluginKvQuotaTest} — {@code cp.plugin.kv.max-keys=2} through a real Boot property
 *       source lowers the budget end-to-end (env and property land in the same constructor
 *       parameter).</li>
 * </ul>
 */
class PluginKvLimitsEnvTest {

    private static final Map<String, String> EXPECTED = new LinkedHashMap<>();

    static {
        EXPECTED.put("cp.plugin.kv.max-keys", "XIHE_CP_PLUGIN_KV_MAX_KEYS");
        EXPECTED.put("cp.plugin.kv.max-value-bytes", "XIHE_CP_PLUGIN_KV_MAX_VALUE_BYTES");
        EXPECTED.put("cp.plugin.kv.ttl-seconds-max", "XIHE_CP_PLUGIN_KV_TTL_SECONDS_MAX");
        EXPECTED.put("cp.plugin.rate.per-min", "XIHE_CP_PLUGIN_RATE_PER_MIN");
        EXPECTED.put("cp.plugin.rate.burst", "XIHE_CP_PLUGIN_RATE_BURST");
        EXPECTED.put("cp.plugin.rate.concurrency", "XIHE_CP_PLUGIN_RATE_CONCURRENCY");
    }

    @Test
    void everyQuotaPropertyIsDeclaredAsPropertyThenEnvThenDefault() {
        Map<String, String> declared = declaredExpressions();
        assertEquals(6, declared.size(), "PluginKvLimits takes exactly the six QUOTA values");
        assertEquals(EXPECTED.keySet(), declared.keySet());

        for (Map.Entry<String, String> entry : EXPECTED.entrySet()) {
            String expression = declared.get(entry.getKey());
            String expectedStart = "${" + entry.getKey() + ":${" + entry.getValue() + ":";
            assertTrue(expression.startsWith(expectedStart),
                    "spec §2.1 form is property > env > default, got " + expression);
            assertTrue(expression.endsWith("}}"), "placeholder must be closed: " + expression);
            String defaultValue = expression.substring(expectedStart.length(), expression.length() - 2);
            // The default is the spec's low value; the number itself is asserted in the tests below.
            assertTrue(defaultValue.matches("\\d+"),
                    "default must be a plain integer, got " + defaultValue);
        }
    }

    @Test
    void theEnvironmentVariableLowersTheValue() {
        String expression = declaredExpressions().get("cp.plugin.kv.max-keys");

        // The env variable that verify.md V5 names, resolved through Spring's own env lookup.
        assertEquals("2", environment(Map.of("XIHE_CP_PLUGIN_KV_MAX_KEYS", "2"), Map.of())
                .resolvePlaceholders(expression));
    }

    @Test
    void anExplicitPropertyWinsOverTheEnvironment() {
        String expression = declaredExpressions().get("cp.plugin.kv.max-keys");

        // Same precedence Boot applies: `cp.plugin.kv.max-keys` beats XIHE_CP_PLUGIN_KV_MAX_KEYS.
        assertEquals("7", environment(Map.of("XIHE_CP_PLUGIN_KV_MAX_KEYS", "2"),
                Map.of("cp.plugin.kv.max-keys", "7")).resolvePlaceholders(expression));
    }

    @Test
    void withNothingSetTheSpecDefaultIsUsed() {
        assertEquals("10000", environment(Map.of(), Map.of()).resolvePlaceholders(
                declaredExpressions().get("cp.plugin.kv.max-keys")));
        assertEquals("120", environment(Map.of(), Map.of()).resolvePlaceholders(
                declaredExpressions().get("cp.plugin.rate.per-min")));
        assertEquals("8", environment(Map.of(), Map.of()).resolvePlaceholders(
                declaredExpressions().get("cp.plugin.rate.concurrency")));
    }

    @Test
    void theRelaxedBindingShortcutWouldNotFindTheEnvVariable() {
        // Why the placeholder is spelled out: `cp.plugin.kv.max-keys` maps to
        // XIHE_CP_PLUGIN_KV_MAXKEYS only after `.`->`_`; the `-` before `keys` is not mapped, so
        // relying on relaxed binding alone would silently ignore the documented env variable.
        StandardEnvironment environment = environment(Map.of("XIHE_CP_PLUGIN_KV_MAX_KEYS", "2"),
                Map.of());
        assertEquals("2", environment.getProperty("XIHE_CP_PLUGIN_KV_MAX_KEYS"));
        assertNull(environment.getProperty("cp.plugin.kv.max-keys"),
                "no property-backed value exists for the dotted key; only the env variable does");
    }

    // ------------------------------------------------------------------ helpers

    /** {@code @Value} expressions of {@link PluginKvLimits}'s constructor, in parameter order. */
    private static Map<String, String> declaredExpressions() {
        Constructor<?> constructor = PluginKvLimits.class.getDeclaredConstructors()[0];
        Map<String, String> expressions = new LinkedHashMap<>();
        for (Parameter parameter : constructor.getParameters()) {
            String expression = parameter.getAnnotation(Value.class).value();
            String key = expression.substring(2, expression.indexOf(':', 2));
            expressions.put(key, expression);
        }
        return expressions;
    }

    private static StandardEnvironment environment(Map<String, Object> envVars,
            Map<String, Object> properties) {
        StandardEnvironment environment = new StandardEnvironment();
        // The host machine's real environment/system properties must not leak into the assertions.
        environment.getPropertySources()
                .remove(StandardEnvironment.SYSTEM_ENVIRONMENT_PROPERTY_SOURCE_NAME);
        environment.getPropertySources()
                .remove(StandardEnvironment.SYSTEM_PROPERTIES_PROPERTY_SOURCE_NAME);
        environment.getPropertySources()
                .addLast(new SystemEnvironmentPropertySource("test-env", envVars));
        if (!properties.isEmpty()) {
            environment.getPropertySources().addFirst(new MapPropertySource("test-props", properties));
        }
        return environment;
    }
}
