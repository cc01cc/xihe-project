package com.cc01cc.p.xihe.cp.credentials;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * PLAN-0576 T1.3: AAD format contract — v1 stays byte-identical to PLAN-0495;
 * v2 has the frozen field order and rejects ambiguous/blank input.
 */
class CredentialAadTest {

    @Test
    void v1FormatIsUnchanged() {
        assertEquals("c-1|USER|u-1", CredentialAad.formatV1("c-1", "USER", "u-1"));
    }

    @Test
    void v2FormatHasTheFrozenFieldOrder() {
        assertEquals("v2|c-1|USER|u-1|token|3|v1",
                CredentialAad.formatV2("c-1", "USER", "u-1", "token", 3, "v1"));
    }

    @Test
    void v1AndV2NeverCollide() {
        assertNotEquals(CredentialAad.formatV1("c-1", "USER", "u-1"),
                CredentialAad.formatV2("c-1", "USER", "u-1", "token", 1, "v1"));
    }

    @Test
    void v2IsCaseSensitive() {
        assertNotEquals(CredentialAad.formatV2("c-1", "USER", "u-1", "token", 1, "v1"),
                CredentialAad.formatV2("c-1", "USER", "u-1", "TOKEN", 1, "v1"));
        assertNotEquals(CredentialAad.formatV2("c-1", "USER", "u-1", "token", 1, "v1"),
                CredentialAad.formatV2("c-1", "USER", "u-1", "token", 1, "V1"));
    }

    @Test
    void v2RejectsBlankFieldsAndSeparatorInjection() {
        assertThrows(IllegalArgumentException.class,
                () -> CredentialAad.formatV2("c-1", "USER", "u-1", null, 1, "v1"));
        assertThrows(IllegalArgumentException.class,
                () -> CredentialAad.formatV2("c-1", "USER", "u-1", " ", 1, "v1"));
        assertThrows(IllegalArgumentException.class,
                () -> CredentialAad.formatV2("c|1", "USER", "u-1", "token", 1, "v1"));
        assertThrows(IllegalArgumentException.class,
                () -> CredentialAad.formatV2("c-1", "USER", "u-1", "token", 1, "v|1"));
    }

    @Test
    void v2RejectsNonMonotonicRevision() {
        assertThrows(IllegalArgumentException.class,
                () -> CredentialAad.formatV2("c-1", "USER", "u-1", "token", 0, "v1"));
    }
}
