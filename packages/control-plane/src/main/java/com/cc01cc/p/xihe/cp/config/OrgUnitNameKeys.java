package com.cc01cc.p.xihe.cp.config;

import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/**
 * DSD-1520 D3(c) / task-148: the i18n keys the first-run org-tree seed writes into
 * {@code org_units.name_key} (V181), and their translations.
 *
 * <p><b>Why the translation lives in the CP and not in the UI</b>: exactly the argument
 * {@code policy/PermissionAtomLabels.java} gives for permission atoms — the seeded tree is
 * server-side data, so a client that translated it would need its own copy of the seed vocabulary,
 * and the two copies would drift the first time a key is added. One table here means adding a
 * language is a one-file change.</p>
 *
 * <p><b>Why the response stays one string</b>: {@code controller/OrgUnitWireView.Node} carries
 * {@code name}, never a {@code {zh, en}} pair, so the wire contract cannot grow a second source of
 * truth and the UI cannot pick a different language than the request asked for (same rule as
 * {@code PermissionAtomLabels}: "the payload carries a single string").</p>
 *
 * <p><b>What is NOT translated</b>: any unit whose {@code name_key} is NULL — that is every unit a
 * user created, and every unit a user renamed (the rename writes {@code name_key = NULL} in the same
 * statement, DSD-1520 Q2). Those units render their stored {@code name} verbatim, in every locale;
 * that is the point of keeping {@code name} as a column rather than replacing it with a key.</p>
 */
public final class OrgUnitNameKeys {

    public static final String DEFAULT_LOCALE = "zh-CN";
    public static final String EN_LOCALE = "en-US";

    /** The three keys V181 writes; also the closed set the migration is the only writer of. */
    public static final String SEED_ROOT = "orgUnit.seedRoot";
    public static final String SEED_LEADERS = "orgUnit.seedLeaders";
    public static final String SEED_EXECUTION = "orgUnit.seedExecution";

    private static final Map<String, Map<String, String>> LABELS = build();

    private OrgUnitNameKeys() {
    }

    /**
     * The name to render for one unit: the translation of {@code nameKey} when the locale has one,
     * otherwise {@code name} unchanged.
     *
     * <p>The fallback chain is deliberately three-deep — unknown/absent key ⇒ stored name, because a
     * user-created unit has no key; known key without a translation for the resolved locale ⇒ the
     * default locale's translation ⇒ stored name. It never returns null or an empty string: an
     * untranslatable unit must still show something it was actually called.</p>
     */
    public static String label(String nameKey, String name, String locale) {
        if (nameKey == null || nameKey.isBlank()) {
            return name;
        }
        Map<String, String> byLocale = LABELS.get(nameKey);
        if (byLocale == null) {
            return name;
        }
        String resolved = normalize(locale);
        String translated = byLocale.getOrDefault(resolved, byLocale.get(DEFAULT_LOCALE));
        return translated == null ? name : translated;
    }

    /** Supported locale tag for an arbitrary request value ({@code en*} ⇒ en-US, else zh-CN). */
    public static String normalize(String locale) {
        if (locale == null || locale.isBlank()) {
            return DEFAULT_LOCALE;
        }
        return locale.trim().toLowerCase(Locale.ROOT).startsWith("en") ? EN_LOCALE : DEFAULT_LOCALE;
    }

    private static Map<String, Map<String, String>> build() {
        Map<String, Map<String, String>> labels = new LinkedHashMap<>();
        put(labels, SEED_ROOT, "默认组织", "Default organization");
        put(labels, SEED_LEADERS, "负责人组", "Leads");
        put(labels, SEED_EXECUTION, "执行组", "Execution");
        return labels;
    }

    private static void put(Map<String, Map<String, String>> labels, String key,
                            String zh, String en) {
        labels.put(key, Map.of(DEFAULT_LOCALE, zh, EN_LOCALE, en));
    }
}
