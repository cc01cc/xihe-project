package com.cc01cc.p.xihe.cp.policy;

import org.junit.jupiter.api.Test;

import java.util.LinkedHashSet;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0651 D51-37: every atom of the vocabulary must carry a non-empty display label in both
 * supported locales, so a newly added atom can never reach the role editor as a bare wire name.
 *
 * <p>The labels live in the CP (not the UI) because the role editor deliberately keeps no
 * vocabulary of its own; {@code GET /roles/catalog?locale=…} resolves one string server-side.</p>
 */
class PermissionAtomLabelsTest {

    private static Set<String> allAtoms() {
        Set<String> atoms = new LinkedHashSet<>(PermissionAtomCatalog.actionAtoms());
        atoms.addAll(PermissionAtomCatalog.capabilityAtoms());
        return atoms;
    }

    @Test
    void everyAtomHasANonEmptyLabelInBothLocales() {
        for (String atom : allAtoms()) {
            for (String locale : new String[]{PermissionAtomLabels.DEFAULT_LOCALE,
                    PermissionAtomLabels.EN_LOCALE}) {
                String label = PermissionAtomLabels.label(atom, locale);
                assertFalse(label == null || label.isBlank(),
                        "atom " + atom + " has no label for " + locale);
                assertNotEquals(atom, label,
                        "atom " + atom + " must not fall back to its wire name in " + locale);
            }
        }
    }

    @Test
    void labelsAreBilingual() {
        for (String atom : allAtoms()) {
            assertNotEquals(
                    PermissionAtomLabels.label(atom, PermissionAtomLabels.DEFAULT_LOCALE),
                    PermissionAtomLabels.label(atom, PermissionAtomLabels.EN_LOCALE),
                    "atom " + atom + " needs a distinct zh-CN and en-US label");
        }
    }

    @Test
    void unknownLocaleFallsBackToZhCnAndUnknownAtomFallsBackToItsName() {
        assertEquals(PermissionAtomLabels.label(ToolFaceRegistry.ACTION_READ,
                        PermissionAtomLabels.DEFAULT_LOCALE),
                PermissionAtomLabels.label(ToolFaceRegistry.ACTION_READ, "fr-FR"));
        assertEquals("SOME_FUTURE_ATOM", PermissionAtomLabels.label("SOME_FUTURE_ATOM", "en-US"));
        assertEquals(PermissionAtomLabels.EN_LOCALE, PermissionAtomLabels.normalize("en"));
        assertEquals(PermissionAtomLabels.DEFAULT_LOCALE, PermissionAtomLabels.normalize(null));
    }

    @Test
    void theTwoManagementAtomsHaveLabels() {
        // The atoms this plan adds must never render as MANAGE_AGENT_PRINCIPALS / MANAGE_WORKSPACE_MEMBERS.
        assertTrue(PermissionAtomLabels.label(ToolFaceRegistry.ACTION_MANAGE_AGENT_PRINCIPALS,
                PermissionAtomLabels.DEFAULT_LOCALE).contains("智能体主体"));
        assertTrue(PermissionAtomLabels.label(ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_MEMBERS,
                PermissionAtomLabels.DEFAULT_LOCALE).contains("成员"));
        assertEquals("Manage workspace members", PermissionAtomLabels.label(
                ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_MEMBERS, PermissionAtomLabels.EN_LOCALE));
    }
}
