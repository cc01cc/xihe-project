package com.cc01cc.p.xihe.cp.chat;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The register for {@link SessionTitleRule#DEFAULT_TITLES} (D-1866 / task-24).
 *
 * <p>Why this test exists: the UI sends its <b>localised</b> {@code workspace.sessionDefaultTitle}
 * as the title when it creates a Session
 * ({@code packages/ui/src/stores/session.ts#createSession}), so "still the default" is a
 * UI-defined marker, not a CP one. Hard-coding those strings in CP is unavoidable (CP cannot read
 * TypeScript at runtime), but hard-coding them <i>without a guard</i> fails silently: adding a
 * locale would leave every session in that language permanently unnamed, with no error anywhere.
 *
 * <p>So this test reads the UI locale file and fails when a locale value is not registered on the
 * CP side. {@link #addingANewLocaleDefaultTitleTurnsThisTestRed()} feeds a synthetic new locale
 * through the same check, so a broken extractor cannot make the guard vacuous.
 */
class SessionTitleDefaultTitleConsistencyTest {

    private static final Pattern UI_DEFAULT_TITLE_PATTERN =
            Pattern.compile("sessionDefaultTitle:\\s*\"([^\"]*)\"");

    private static final Path UI_I18N = locateUiI18n();

    @Test
    void everyUiLocaleDefaultTitleIsRegisteredAsCpDefault() {
        List<String> uiValues = extractSessionDefaultTitles(readUiI18n());
        assertTrue(uiValues.size() >= 2,
                "expected at least the zh-Hans and en workspace.sessionDefaultTitle values, got " + uiValues);
        List<String> missing = notRegisteredOnCp(uiValues);
        assertTrue(missing.isEmpty(), () -> "UI locale defaults absent from SessionTitleRule.DEFAULT_TITLES "
                + missing + " — add them on the CP side, otherwise sessions in those languages are"
                + " never auto-named. (UI values read: " + uiValues + ")");
    }

    @Test
    void addingANewLocaleDefaultTitleTurnsThisTestRed() {
        String hypotheticalNewLocale = readUiI18n()
                + "\n                sessionDefaultTitle: \"Sitzung ohne Titel\",\n";
        List<String> uiValues = extractSessionDefaultTitles(hypotheticalNewLocale);
        List<String> missing = notRegisteredOnCp(uiValues);
        assertTrue(missing.contains("Sitzung ohne Titel"),
                "the guard must report a newly added locale value as unregistered, got " + missing);
    }

    @Test
    void cpFallbackTitleIsRegistered() {
        // SessionService.normalizeTitle stores this when the caller sends no title at all.
        assertTrue(SessionTitleRule.DEFAULT_TITLES.contains("Untitled"));
    }

    private static List<String> notRegisteredOnCp(List<String> uiValues) {
        List<String> missing = new ArrayList<>();
        for (String value : uiValues) {
            if (!SessionTitleRule.DEFAULT_TITLES.contains(value)) {
                missing.add(value);
            }
        }
        return missing;
    }

    private static List<String> extractSessionDefaultTitles(String source) {
        List<String> values = new ArrayList<>();
        Matcher matcher = UI_DEFAULT_TITLE_PATTERN.matcher(source);
        while (matcher.find()) {
            values.add(matcher.group(1));
        }
        return values;
    }

    private static String readUiI18n() {
        try {
            return Files.readString(UI_I18N, StandardCharsets.UTF_8);
        } catch (IOException cause) {
            throw new UncheckedIOException("cannot read " + UI_I18N, cause);
        }
    }

    /**
     * Resolves {@code packages/ui/src/i18n/index.ts} from the module directory. Fails loudly when
     * absent: a guard that skips itself is worse than no guard.
     */
    private static Path locateUiI18n() {
        Path cursor = Path.of("").toAbsolutePath();
        for (int depth = 0; depth < 6 && cursor != null; depth++, cursor = cursor.getParent()) {
            Path candidate = cursor.resolve("packages/ui/src/i18n/index.ts");
            if (Files.isRegularFile(candidate)) {
                return candidate;
            }
        }
        throw new IllegalStateException(
                "packages/ui/src/i18n/index.ts not found above " + Path.of("").toAbsolutePath());
    }
}
