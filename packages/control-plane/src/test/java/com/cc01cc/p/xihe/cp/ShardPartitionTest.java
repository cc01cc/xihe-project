package com.cc01cc.p.xihe.cp;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import javax.xml.parsers.DocumentBuilder;
import javax.xml.parsers.DocumentBuilderFactory;
import org.junit.jupiter.api.Test;
import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.w3c.dom.NodeList;

/**
 * task-611: the 2-shard surefire split must partition every test class exactly once.
 *
 * <p><b>The two lists mean different things</b> (this is the part people re-guess):</p>
 * <ul>
 *   <li>shard A ({@code -Pl2-shard-a}) <b>only has {@code <includes>}</b> — it enumerates the packages it
 *       owns. Anything not listed simply does not run there.</li>
 *   <li>shard B ({@code -Pl2-shard-b}) keeps surefire's default {@code <includes>} and expresses
 *       "everything else" with 12 {@code <excludes>} of the same packages.</li>
 * </ul>
 *
 * <p>That shape is safe <i>only</i> as long as (A ∪ B) == every {@code *Test} source and A ∩ B == ∅.
 * Nothing in the build enforces it: a package that A forgets and B excludes anyway runs in neither shard,
 * and the suite stays green while the count silently drops. This failure mode matches task-598
 * ({@code DoNotIncludeTests()} silently over-counting): no error, only numbers that do not add up.</p>
 *
 * <p>So this test recomputes the partition from {@code pom.xml} + the source tree, without surefire and
 * without reading surefire reports. {@code pom.xml} line ~367 used to claim "有专门的并集校验" (a dedicated
 * union check existed) — until this class there was none; it now is that check.</p>
 *
 * <p>Scope note: the enumeration is by <b>source file</b> ({@code *Test.java} etc.), which is the same
 * granularity as surefire's include/exclude patterns. A file that compiles to zero test cases is still
 * part of the partition — that is intended, the question here is "which shard owns which file".</p>
 */
class ShardPartitionTest {

    /** Surefire's documented default include set; kept independent of the pom on purpose. */
    private static final List<String> SUREFIRE_DEFAULT_INCLUDES = List.of(
            "**/Test*.java",
            "**/*Test.java",
            "**/*Tests.java",
            "**/*TestCase.java");

    private static final String SHARD_A = "l2-shard-a";
    private static final String SHARD_B = "l2-shard-b";
    private static final String SUREFIRE = "maven-surefire-plugin";
    private static final Path POM = Path.of("pom.xml");
    private static final Path TEST_SOURCE_ROOT = Path.of("src", "test", "java");

    @Test
    void shardPartitionCoversEveryTestSourceExactlyOnce() throws Exception {
        List<String> sources = testSources();
        Map<String, List<String>> a = surefireConfig(SHARD_A);
        Map<String, List<String>> b = surefireConfig(SHARD_B);

        Set<String> full = new TreeSet<>();
        Set<String> shardA = new TreeSet<>();
        Set<String> shardB = new TreeSet<>();
        for (String source : sources) {
            if (!matchesAny(SUREFIRE_DEFAULT_INCLUDES, source)) {
                continue;
            }
            full.add(source);
            if (selectedBy(source, a)) {
                shardA.add(source);
            }
            if (selectedBy(source, b)) {
                shardB.add(source);
            }
        }

        System.out.println("shard partition: all=" + full.size()
                + " shard-a=" + shardA.size() + " shard-b=" + shardB.size()
                + " (a+b=" + (shardA.size() + shardB.size()) + ")");

        Set<String> ownedByNoShard = new TreeSet<>(full);
        ownedByNoShard.removeAll(shardA);
        ownedByNoShard.removeAll(shardB);
        assertThat(ownedByNoShard).as(
                "test sources selected by NEITHER shard (they would silently not run): %s",
                ownedByNoShard.stream().limit(20).toList()).isEmpty();

        Set<String> ownedByBothShards = new TreeSet<>(shardA);
        ownedByBothShards.retainAll(shardB);
        assertThat(ownedByBothShards).as(
                "test sources selected by BOTH shards (they would run twice): %s",
                ownedByBothShards.stream().limit(20).toList()).isEmpty();

        Set<String> outsideDefaultIncludes = new TreeSet<>(shardA);
        outsideDefaultIncludes.addAll(shardB);
        outsideDefaultIncludes.removeAll(full);
        assertThat(outsideDefaultIncludes).as(
                "a shard selects sources outside surefire's default includes: %s",
                outsideDefaultIncludes.stream().limit(20).toList()).isEmpty();

        assertThat(full).as("the partition is computed over a non-empty set of test sources").isNotEmpty();
    }

    /** {@code <includes>} are a union (any match); {@code <excludes>} win over them. */
    private static boolean selectedBy(String source, Map<String, List<String>> config) {
        return matchesAny(config.getOrDefault("include", List.of()), source)
                && !matchesAny(config.getOrDefault("exclude", List.of()), source);
    }

    private static boolean matchesAny(List<String> patterns, String source) {
        for (String pattern : patterns) {
            if (toRegex(pattern).matcher(source).matches()) {
                return true;
            }
        }
        return false;
    }

    /** Ant path syntax as surefire applies it: {@code **}{@code /} matches zero or more directories. */
    private static Pattern toRegex(String antPattern) {
        StringBuilder regex = new StringBuilder();
        for (int i = 0; i < antPattern.length(); i++) {
            char c = antPattern.charAt(i);
            if (c == '*' && i + 1 < antPattern.length() && antPattern.charAt(i + 1) == '*') {
                i++;
                if (i + 1 < antPattern.length() && antPattern.charAt(i + 1) == '/') {
                    i++;
                    regex.append("(?:.*/)?");
                } else {
                    regex.append(".*");
                }
            } else if (c == '*') {
                regex.append("[^/]*");
            } else if (c == '?') {
                regex.append("[^/]");
            } else if ("\\.[]{}()+^$|".indexOf(c) >= 0) {
                regex.append('\\').append(c);
            } else {
                regex.append(c);
            }
        }
        return Pattern.compile(regex.toString());
    }

    /** Source paths relative to {@code src/test/java}, always with {@code /} separators. */
    private static List<String> testSources() throws IOException {
        assertThat(Files.isDirectory(TEST_SOURCE_ROOT)).as("run from the control-plane module dir").isTrue();
        List<String> sources = new ArrayList<>();
        try (Stream<Path> walk = Files.walk(TEST_SOURCE_ROOT)) {
            for (Path path : walk.filter(Files::isRegularFile).filter(p -> p.toString().endsWith(".java")).toList()) {
                sources.add(TEST_SOURCE_ROOT.relativize(path).toString().replace('\\', '/'));
            }
        }
        sources.sort(String::compareTo);
        return sources;
    }

    private static Map<String, List<String>> surefireConfig(String profileId) throws Exception {
        Element profile = profile(pomDocument(), profileId);
        Element surefire = surefirePlugin(profile);
        assertThat(surefire).as("profile %s configures %s", profileId, SUREFIRE).isNotNull();
        Element configuration = firstDescendant(surefire, "configuration");
        assertThat(configuration).as("profile %s has a surefire configuration", profileId).isNotNull();
        Map<String, List<String>> config = new LinkedHashMap<>();
        config.put("include", children(configuration, "includes", "include"));
        config.put("exclude", children(configuration, "excludes", "exclude"));
        return config;
    }

    /** The {@code <plugin>} whose {@code <artifactId>} is maven-surefire-plugin. */
    private static Element surefirePlugin(Element profile) {
        NodeList plugins = profile.getElementsByTagName("plugin");
        for (int i = 0; i < plugins.getLength(); i++) {
            Element plugin = (Element) plugins.item(i);
            for (String artifactId : children(plugin, null, "artifactId")) {
                if (SUREFIRE.equals(artifactId)) {
                    return plugin;
                }
            }
        }
        return null;
    }

    private static Element profile(org.w3c.dom.Document document, String profileId) {
        NodeList profiles = document.getElementsByTagName("profile");
        for (int i = 0; i < profiles.getLength(); i++) {
            Element candidate = (Element) profiles.item(i);
            List<String> ids = children(candidate, null, "id");
            if (!ids.isEmpty() && profileId.equals(ids.get(0))) {
                return candidate;
            }
        }
        throw new AssertionError("pom.xml has no profile with id " + profileId);
    }

    private static org.w3c.dom.Document pomDocument() throws Exception {
        assertThat(Files.isRegularFile(POM)).as("run from the control-plane module dir").isTrue();
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
        factory.setNamespaceAware(false);
        DocumentBuilder builder = factory.newDocumentBuilder();
        return builder.parse(POM.toFile());
    }

    private static Element firstDescendant(Element root, String name) {
        NodeList nodes = root.getElementsByTagName(name);
        return nodes.getLength() == 0 ? null : (Element) nodes.item(0);
    }

    /** Text of {@code <child><item>…} or of a plain {@code <item>} when {@code child} is null. */
    private static List<String> children(Element root, String child, String item) {
        List<String> values = new ArrayList<>();
        NodeList items;
        if (child == null) {
            items = root.getElementsByTagName(item);
        } else {
            NodeList groups = root.getElementsByTagName(child);
            if (groups.getLength() == 0) {
                return List.of(); // shard A has no <excludes>, shard B no extra <includes>
            }
            items = ((Element) groups.item(0)).getElementsByTagName(item);
        }
        for (int i = 0; i < items.getLength(); i++) {
            Node node = items.item(i);
            if (node.getParentNode() == null || (child == null && node.getParentNode() != root)) {
                continue;
            }
            values.add(node.getTextContent().trim());
        }
        return values.isEmpty() ? List.of() : List.copyOf(new LinkedHashSet<>(values));
    }
}
