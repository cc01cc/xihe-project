package com.cc01cc.p.xihe.cp.status;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;

class BuildVersionTest {

    @Test
    void filteredPomPropertiesIsReadable() {
        BuildVersion buildVersion = new BuildVersion();

        assertNotNull(buildVersion.version());
        assertEquals(buildVersion.version(), buildVersion.versionOrUnknown());
    }

    @Test
    void validFixtureIsParsed() {
        assertEquals("1.2.3", new BuildVersion("/version-fixtures/valid.properties").version());
    }

    @Test
    void unfilteredPlaceholderIsNotARelease() {
        BuildVersion buildVersion = new BuildVersion("/version-fixtures/placeholder.properties");

        assertNull(buildVersion.version());
        assertEquals("unknown", buildVersion.versionOrUnknown());
    }

    @Test
    void missingResourceIsNull() {
        assertNull(new BuildVersion("/version-fixtures/missing.properties").version());
    }
}
