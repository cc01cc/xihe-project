package com.cc01cc.p.xihe.cp.support;

import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;

import java.io.IOException;
import java.net.URISyntaxException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.CodeSource;
import java.util.stream.Stream;

/**
 * Detects that {@code target/test-classes} was rewritten while this JVM is testing, and says so
 * once, in the place where the damage shows up.
 *
 * <p>Background (2026-11-03): a Maven build that recompiles this module deletes the whole test
 * output tree before refilling it (measured on this tree: 567 class files → 0 at t+2.4 s → 567 at
 * t+7.5 s). A test JVM that is already running keeps reading that directory lazily, so inside the
 * window a Spring component scan finds no test-source component and any not-yet-loaded class throws
 * {@code NoClassDefFoundError}. The visible result is a handful of integration classes failing with
 * unrelated-looking errors — a different set on every run — while each of them passes when rerun
 * alone. That looks like Spring Test context-cache pollution but is not: the cache only keeps the
 * one damaged scan for the one class that built it.
 *
 * <p>The check runs from {@link TestFixtureContextCustomizer}, i.e. at the beginning of every
 * context creation — the exact moment a damaged scan would be captured — and prints one
 * unmistakable banner. It never fails a test on its own: the failures caused by the rewrite are
 * already there, this only names their cause.
 */
public final class TestClasspathGuard {

    private static final Object LOCK = new Object();

    private static Fingerprint baseline;
    private static boolean reported;

    private TestClasspathGuard() {
    }

    /**
     * Compares the current test output tree with the one seen at the first context creation of this
     * JVM and prints a diagnostic banner when it changed. Cheap enough to call per context.
     */
    public static void reportIfClasspathChanged() {
        synchronized (LOCK) {
            Fingerprint current = fingerprint();
            if (baseline == null) {
                baseline = current;
                return;
            }
            if (reported || current.equals(baseline) || baseline.equals(UNSTABLE)) {
                return;
            }
            reported = true;
            System.err.println(banner(baseline, current));
            System.out.println(banner(baseline, current));
        }
    }

    private static String banner(Fingerprint expected, Fingerprint current) {
        return """

                ================================================================================
                [cp-classpath-guard] target/test-classes was REWRITTEN while this JVM was running
                  at first context : %d files, %d bytes, newest %d
                  now              : %d files, %d bytes, newest %d
                ================================================================================
                A Maven build compiled this module into the same target/ directory while the suite
                was running (`mvn test` / `test-compile` deletes target/test-classes and refills it,
                which takes seconds). Because the JVM loads classes and scans components from that
                directory lazily, the damage looks like a test bug and moves around:

                  * component scan finds no test-source @Component  ->  "No qualifying bean of
                    type WorkspaceFixture" (every test of that class errors)
                  * not-yet-loaded class / inner class              ->  NoClassDefFoundError

                Failures from this point are measurement artifacts, not regressions. Rerun with one
                Maven build per target directory (separate worktree, or -Dxihe.build.suffix=-b for a
                second concurrent build). See packages/control-plane/AGENTS.md, L2 section.
                ================================================================================
                """.formatted(expected.files(), expected.bytes(), expected.newestMillis(),
                current.files(), current.bytes(), current.newestMillis());
    }

    private static Fingerprint fingerprint() {
        Path root = testClassesRoot();
        if (root == null || !Files.isDirectory(root)) {
            return UNSTABLE;
        }
        int files = 0;
        long bytes = 0L;
        long newest = 0L;
        try (Stream<Path> walk = Files.walk(root)) {
            for (Path path : walk.toList()) {
                if (!Files.isRegularFile(path)) {
                    continue;
                }
                files++;
                bytes += Files.size(path);
                newest = Math.max(newest, Files.getLastModifiedTime(path).toMillis());
            }
        } catch (IOException failure) {
            // A file vanished between the walk and the stat: the tree is being rewritten right now.
            return UNSTABLE;
        }
        return new Fingerprint(files, bytes, newest);
    }

    private static Path testClassesRoot() {
        CodeSource source = WorkspaceFixture.class.getProtectionDomain().getCodeSource();
        if (source == null) {
            return null;
        }
        try {
            return Path.of(source.getLocation().toURI());
        } catch (URISyntaxException failure) {
            return null; // not a directory URL: nothing to watch
        }
    }

    /** Sentinel for "the tree could not be walked", which is itself a rewrite in progress. */
    private static final Fingerprint UNSTABLE = new Fingerprint(-1, -1L, -1L);

    /** Cheap change detector for the test output tree. */
    private record Fingerprint(int files, long bytes, long newestMillis) {
    }
}
