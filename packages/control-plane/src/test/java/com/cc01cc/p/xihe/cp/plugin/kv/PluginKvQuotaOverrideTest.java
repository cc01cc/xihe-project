package com.cc01cc.p.xihe.cp.plugin.kv;

import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.TestPropertySource;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * PLAN-0691 T1.5 (verify.md V5, the env-override clause): {@code XIHE_CP_PLUGIN_KV_MAX_KEYS=2} must
 * really lower the key budget.
 *
 * <p>Surefire cannot set an OS environment variable for the forked JVM, so the end-to-end half is
 * exercised through the property half of the same placeholder
 * ({@code ${cp.plugin.kv.max-keys:${XIHE_CP_PLUGIN_KV_MAX_KEYS:10000}}}): a Boot property source is
 * the exact place an env variable would land, and the constructor parameter below is the single value
 * both paths feed. {@link PluginKvLimitsEnvTest} covers the env spelling itself.
 *
 * <p>Own property set ⇒ own application context ⇒ the quota tests with the default 10000 are not
 * disturbed (they run against the context without this override).
 */
@TestPropertySource(properties = "cp.plugin.kv.max-keys=2")
class PluginKvQuotaOverrideTest extends AbstractPluginKvIntegrationTest {

    @Test
    void loweringMaxKeysToTwoRejectsTheThirdKey() {
        SeededBinding binding = seedEnabledBinding();

        assertEquals(HttpStatus.OK,
                put(kvPath(binding, "default/k1"), token(binding), putBody("{\"n\":1}")).getStatusCode());
        assertEquals(HttpStatus.OK,
                put(kvPath(binding, "default/k2"), token(binding), putBody("{\"n\":2}")).getStatusCode());

        ResponseEntity<String> rejected =
                put(kvPath(binding, "default/k3"), token(binding), putBody("{\"n\":3}"));

        assertEquals(HttpStatus.TOO_MANY_REQUESTS, rejected.getStatusCode(),
                "the configured budget is 2, not the 10000 default: " + rejected.getBody());
        assertEquals(PluginKvService.CODE_QUOTA_EXCEEDED, code(rejected));
        assertEquals(2, jdbcTemplate.queryForObject(
                "SELECT count(*) FROM plugin_kv WHERE binding_id = ?", Integer.class,
                binding.bindingId()));
    }
}
