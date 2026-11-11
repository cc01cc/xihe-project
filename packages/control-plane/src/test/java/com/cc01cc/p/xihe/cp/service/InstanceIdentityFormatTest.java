package com.cc01cc.p.xihe.cp.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.UUID;
import org.junit.jupiter.api.Test;

/** PLAN-0767 M1-3 C3: the deployment-identity normalization matrix. */
class InstanceIdentityFormatTest {

    private static final String CANONICAL = "9f1c1d3e-2b7a-4c55-9d2e-3f4a5b6c7d80";
    private static final String HEX = "9f1c1d3e2b7a4c559d2e3f4a5b6c7d80";

    @Test
    void parsesCanonicalUuid() {
        assertEquals(UUID.fromString(CANONICAL), InstanceIdentityFormat.parse(CANONICAL));
        assertEquals(CANONICAL, InstanceIdentityFormat.normalize(CANONICAL));
    }

    @Test
    void parses32HexDeploymentFileForm() {
        assertEquals(UUID.fromString(CANONICAL), InstanceIdentityFormat.parse(HEX));
        assertEquals(CANONICAL, InstanceIdentityFormat.normalize(HEX));
    }

    @Test
    void normalizationIsCaseInsensitiveAndTrimsWhitespace() {
        assertEquals(CANONICAL, InstanceIdentityFormat.normalize("  " + CANONICAL.toUpperCase() + "  "));
        assertEquals(CANONICAL, InstanceIdentityFormat.normalize(HEX.toUpperCase()));
    }

    @Test
    void invalidValuesAreRejected() {
        assertNull(InstanceIdentityFormat.normalize(null));
        assertNull(InstanceIdentityFormat.normalize(""));
        assertNull(InstanceIdentityFormat.normalize("   "));
        assertNull(InstanceIdentityFormat.normalize("not-a-uuid"));
        assertNull(InstanceIdentityFormat.normalize(HEX.substring(0, 31)));
        assertNull(InstanceIdentityFormat.normalize(HEX + "00"));
        assertNull(InstanceIdentityFormat.normalize("9f1c1d3e-2b7a-4c55-9d2e-3f4a5b6c7dz0"));
    }

    @Test
    void equalsIdentityIsDashAndCaseInsensitive() {
        assertTrue(InstanceIdentityFormat.equalsIdentity(CANONICAL, HEX));
        assertTrue(InstanceIdentityFormat.equalsIdentity(HEX.toUpperCase(), CANONICAL));
        assertFalse(InstanceIdentityFormat.equalsIdentity(CANONICAL,
                "9f1c1d3e-2b7a-4c55-9d2e-3f4a5b6c7d81"));
        assertFalse(InstanceIdentityFormat.equalsIdentity(null, CANONICAL));
        assertFalse(InstanceIdentityFormat.equalsIdentity("not-a-uuid", CANONICAL));
    }
}
