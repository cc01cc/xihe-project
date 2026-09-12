package com.cc01cc.p.xihe.cp;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class DotenvLoaderTest {

    private static final String[] PROPERTY_KEYS = {
        "XIHE_ENV",
        "XIHE_LOAD_DOTENV",
        "XIHE_ENV_FILE",
        "XIHE_TEST_ALPHA",
        "XIHE_TEST_BETA",
        "XIHE_TEST_GAMMA",
        "XIHE_TEST_CHAIN",
        "XIHE_TEST_DEFAULTED",
        "XIHE_TEST_CLI"
    };

    @AfterEach
    void restorePropertiesAndCwd() {
        for (String key : PROPERTY_KEYS) {
            System.clearProperty(key);
        }
    }

    @Test
    void parseCliOverridesVariants() {
        Map<String, String> overrides = DotenvLoader.parseCliOverrides(
                new String[] {"--set", "A=1", "--set=B=x=y", "ignored"});
        assertEquals("1", overrides.get("A"));
        assertEquals("x=y", overrides.get("B"));
        assertEquals(2, overrides.size());
        assertTrue(DotenvLoader.parseCliOverrides(new String[] {}).isEmpty());
        assertThrows(IllegalArgumentException.class,
                () -> DotenvLoader.parseCliOverrides(new String[] {"--set", "NOEQUALS"}));
    }

    @Test
    void interpolateForms() {
        Map<String, String> lookup = new HashMap<>();
        lookup.put("A", "1");
        assertEquals("1", DotenvLoader.interpolate("${A}", lookup));
        assertEquals("fallback", DotenvLoader.interpolate("${MISSING:-fallback}", lookup));
        assertEquals("", DotenvLoader.interpolate("${MISSING}", lookup));
        assertEquals("plain", DotenvLoader.interpolate("plain", lookup));
    }

    @Test
    void loadChainLaterFileWinsAndExistingPropertyWins(@TempDir Path root) throws IOException {
        write(root, ".env", "XIHE_TEST_ALPHA=base\nXIHE_TEST_BETA=from_env\n");
        write(root, ".env.dev", "XIHE_TEST_ALPHA=dev\n");
        write(root, ".env.local", "XIHE_TEST_ALPHA=local\n");

        System.setProperty("XIHE_TEST_BETA", "existing");
        withUserDir(root, () -> DotenvLoader.load(new String[] {"--set", "XIHE_ENV=dev"}));

        assertEquals("local", System.getProperty("XIHE_TEST_ALPHA"));
        assertEquals("existing", System.getProperty("XIHE_TEST_BETA"));
    }

    @Test
    void loadInterpolationAcrossFiles(@TempDir Path root) throws IOException {
        write(root, ".env", "XIHE_TEST_GAMMA=127.0.0.1\n");
        write(root, ".env.dev",
                "XIHE_TEST_CHAIN=http://${XIHE_TEST_GAMMA}:12631\n"
                        + "XIHE_TEST_DEFAULTED=${XIHE_TEST_MISSING:-fallback}\n");

        withUserDir(root, () -> DotenvLoader.load(new String[] {"--set", "XIHE_ENV=dev"}));

        assertEquals("http://127.0.0.1:12631", System.getProperty("XIHE_TEST_CHAIN"));
        assertEquals("fallback", System.getProperty("XIHE_TEST_DEFAULTED"));
    }

    @Test
    void loadSelectsProfileByXiheEnv(@TempDir Path root) throws IOException {
        write(root, ".env.dev", "XIHE_TEST_ALPHA=dev\n");
        write(root, ".env.test", "XIHE_TEST_ALPHA=test\n");

        withUserDir(root, () -> DotenvLoader.load(new String[] {"--set", "XIHE_ENV=test"}));

        assertEquals("test", System.getProperty("XIHE_TEST_ALPHA"));
    }

    @Test
    void loadCliOverrideWinsOverFiles(@TempDir Path root) throws IOException {
        write(root, ".env.test", "XIHE_TEST_CLI=from_file\n");

        withUserDir(root, () -> DotenvLoader.load(
                new String[] {"--set", "XIHE_ENV=test", "--set", "XIHE_TEST_CLI=from_cli"}));

        assertEquals("from_cli", System.getProperty("XIHE_TEST_CLI"));
    }

    @Test
    void loadSkipWhenDisabled(@TempDir Path root) throws IOException {
        write(root, ".env.dev", "XIHE_TEST_ALPHA=from_file\n");
        System.setProperty("XIHE_LOAD_DOTENV", "0");

        withUserDir(root, () -> DotenvLoader.load(new String[] {"--set", "XIHE_TEST_CLI=cli_only"}));

        assertNull(System.getProperty("XIHE_TEST_ALPHA"));
        assertEquals("cli_only", System.getProperty("XIHE_TEST_CLI"));
    }

    @Test
    void loadEnvFileOverride(@TempDir Path root) throws IOException {
        write(root, ".env.dev", "XIHE_TEST_ALPHA=default_chain\n");
        write(root, "custom.env", "XIHE_TEST_ALPHA=custom\n");

        withUserDir(root, () -> DotenvLoader.load(
                new String[] {"--set", "XIHE_ENV_FILE=custom.env"}));

        assertEquals("custom", System.getProperty("XIHE_TEST_ALPHA"));
    }

    private static void write(Path root, String name, String content) throws IOException {
        Files.writeString(root.resolve(name), content);
    }

    private static void withUserDir(Path root, Runnable action) {
        String original = System.getProperty("user.dir");
        System.setProperty("user.dir", root.toString());
        try {
            action.run();
        } finally {
            System.setProperty("user.dir", original);
        }
    }
}
