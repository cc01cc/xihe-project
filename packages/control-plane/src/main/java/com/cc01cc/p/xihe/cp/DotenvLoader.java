package com.cc01cc.p.xihe.cp;

import io.github.cdimascio.dotenv.Dotenv;
import io.github.cdimascio.dotenv.DotenvEntry;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Module-local env chain loader (PLAN-0307 T3.1/T3.5; spec/config-env-target §1.2/§1.5).
 *
 * <p>Single-authority loader for the Control Plane: CLI {@code --set} &gt; process env snapshot &gt;
 * file chain ({@code .env} → {@code .env.$XIHE_ENV} → {@code .env.local}) &gt; code default.
 * {@code scripts/run-with-log.sh} no longer sources env files.
 *
 * <p>Values land in {@link System#setProperty(String, String)} so Spring's Environment resolves
 * them (same channel the previous two-level loader used). Already-set OS env and system properties
 * win over file values; CLI overrides win over everything and are logged masked.
 */
public final class DotenvLoader {

    private static final Logger logger = LoggerFactory.getLogger(DotenvLoader.class);
    private static final int MAX_DEPTH = 5;
    private static final String BOOTSTRAP_ENV_KEY = "XIHE_ENV";
    private static final String LOAD_DOTENV_KEY = "XIHE_LOAD_DOTENV";
    private static final String ENV_FILE_KEY = "XIHE_ENV_FILE";
    private static final List<String> ROOT_MARKERS =
            List.of(".env", ".env.dev", ".env.test", ".env.prod", ".env.example");
    private static final Pattern INTERPOLATION =
            Pattern.compile("\\$\\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\\}");
    /** §1.5: undefined interpolation escalates from WARN to ERROR for fail-fast keys. */
    private static final Set<String> CRITICAL_KEYS = Set.of(
            "XIHE_CP_JWT_SECRET",
            "XIHE_CP_API_TOKEN",
            "XIHE_AGENT_API_TOKEN",
            "XIHE_CP_OAUTH_ENCRYPTION_KEY",
            "XIHE_CP_PROVIDER_CREDENTIALS_KEY");

    private DotenvLoader() {}

    public static void load(String[] args) {
        Map<String, String> overrides = parseCliOverrides(args);
        if ("0".equals(bootstrapValue(LOAD_DOTENV_KEY))) {
            applyCliOverrides(overrides);
            return;
        }
        Path root = findProjectRoot();
        if (root == null) {
            applyCliOverrides(overrides);
            return;
        }

        String envName = overrides.getOrDefault(
                BOOTSTRAP_ENV_KEY,
                bootstrapValue(BOOTSTRAP_ENV_KEY) == null ? "dev" : bootstrapValue(BOOTSTRAP_ENV_KEY));
        Map<String, String> snapshot = new LinkedHashMap<>(System.getenv());
        Set<String> propertySnapshot = Set.copyOf(System.getProperties().stringPropertyNames());
        String envFile = overrides.getOrDefault(ENV_FILE_KEY, bootstrapValue(ENV_FILE_KEY));
        List<Path> files = envFile != null
                ? List.of(resolveEnvFile(root, envFile))
                : List.of(
                        root.resolve(".env"),
                        root.resolve(".env." + envName),
                        root.resolve(".env.local"));

        Map<String, String> lookup = new HashMap<>(snapshot);
        boolean loadedAny = false;
        for (Path file : files) {
            if (!file.toFile().exists()) {
                continue;
            }
            loadedAny = true;
            Map<String, String> entries = parseFile(file, lookup);
            for (Map.Entry<String, String> entry : entries.entrySet()) {
                String key = entry.getKey();
                // §1.2 step 4: later file wins inside the chain, but never over the snapshot.
                if (snapshot.get(key) == null && !propertySnapshot.contains(key)) {
                    System.setProperty(key, entry.getValue());
                    logger.debug("Env loaded: {}=*** (source={})", key, file.getFileName());
                }
                lookup.put(key, entry.getValue());
            }
        }
        if (loadedAny) {
            logger.debug("Env chain loaded: {}", files.stream().filter(p -> p.toFile().exists()).toList());
        }
        applyCliOverrides(overrides);
    }

    /** Parse {@code --set KEY=VALUE} / {@code --set=KEY=VALUE} pairs (values may contain '='). */
    static Map<String, String> parseCliOverrides(String[] args) {
        Map<String, String> overrides = new LinkedHashMap<>();
        int index = 0;
        while (index < args.length) {
            String token = args[index];
            String pair = null;
            if ("--set".equals(token) && index + 1 < args.length) {
                pair = args[index + 1];
                index += 2;
            } else if (token.startsWith("--set=")) {
                pair = token.substring("--set=".length());
                index += 1;
            } else {
                index += 1;
            }
            if (pair == null) {
                continue;
            }
            int separator = pair.indexOf('=');
            if (separator < 0) {
                throw new IllegalArgumentException("--set expects KEY=VALUE, got: " + pair);
            }
            overrides.put(pair.substring(0, separator).trim(), pair.substring(separator + 1));
        }
        return overrides;
    }

    /** Resolve {@code ${VAR}} / {@code ${VAR:-default}}; undefined without default → WARN + empty. */
    static String interpolate(String value, Map<String, String> lookup) {
        Matcher matcher = INTERPOLATION.matcher(value);
        StringBuilder builder = new StringBuilder();
        while (matcher.find()) {
            String name = matcher.group(1);
            String fallback = matcher.group(2);
            String resolved = lookup.get(name);
            if (resolved != null) {
                matcher.appendReplacement(builder, Matcher.quoteReplacement(resolved));
            } else if (fallback != null) {
                matcher.appendReplacement(builder, Matcher.quoteReplacement(fallback));
            } else {
                if (CRITICAL_KEYS.contains(name)) {
                    logger.error("Undefined variable in env interpolation: {} (resolved to empty string)", name);
                } else {
                    logger.warn("Undefined variable in env interpolation: {} (resolved to empty string)", name);
                }
                matcher.appendReplacement(builder, "");
            }
        }
        matcher.appendTail(builder);
        return builder.toString();
    }

    static Path findProjectRoot() {
        Path cwd = Paths.get(System.getProperty("user.dir")).toAbsolutePath().normalize();
        for (int i = 0; i < MAX_DEPTH; i++) {
            Path current = cwd;
            if (ROOT_MARKERS.stream().anyMatch(marker -> current.resolve(marker).toFile().exists())) {
                return current;
            }
            if (current.resolve(".git").toFile().exists()) {
                return null;
            }
            cwd = cwd.getParent();
            if (cwd == null) {
                return null;
            }
        }
        return null;
    }

    private static Map<String, String> parseFile(Path file, Map<String, String> lookup) {
        Dotenv dotenv = Dotenv.configure()
                .directory(file.getParent().toString())
                .filename(file.getFileName().toString())
                .load();
        Map<String, String> entries = new LinkedHashMap<>();
        for (DotenvEntry entry : dotenv.entries()) {
            entries.put(entry.getKey(), interpolate(entry.getValue(), lookup));
        }
        return entries;
    }

    private static void applyCliOverrides(Map<String, String> overrides) {
        for (String key : overrides.keySet()) {
            logger.info("CLI override: {}=***", key);
        }
        for (Map.Entry<String, String> entry : overrides.entrySet()) {
            System.setProperty(entry.getKey(), entry.getValue());
        }
    }

    private static Path resolveEnvFile(Path root, String value) {
        Path candidate = Paths.get(value);
        return candidate.isAbsolute() ? candidate : root.resolve(candidate);
    }

    /** Bootstrap variables read from CLI/system env, with a system-property fallback for tests. */
    private static String bootstrapValue(String key) {
        String envValue = System.getenv(key);
        return envValue != null ? envValue : System.getProperty(key);
    }
}
