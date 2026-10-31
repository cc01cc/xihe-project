package com.cc01cc.p.xihe.cp.auth;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/**
 * PLAN-0581 §6: the registration-policy parser is the one place that decides
 * {@code open|closed}, so its three states and the fail-fast path are pinned here
 * (the closed-mode behaviour over HTTP is covered by
 * {@code RegistrationPolicyIntegrationTest}, which needs its own Spring context).
 */
class RegistrationPolicyTest {

    @Test
    void unsetDefaultsToOpen() {
        RegistrationPolicy policy = new RegistrationPolicy(null);
        policy.validate();
        assertTrue(policy.isOpen(), "an absent value must behave like open (decision #15)");
        policy.requireOpen();
    }

    @Test
    void blankDefaultsToOpen() {
        RegistrationPolicy policy = new RegistrationPolicy("   ");
        policy.validate();
        assertTrue(policy.isOpen());
    }

    @Test
    void closedIsRecognisedCaseInsensitively() {
        RegistrationPolicy policy = new RegistrationPolicy(" Closed ");
        policy.validate();
        assertFalse(policy.isOpen());
        var thrown = assertThrows(com.cc01cc.p.xihe.cp.config.CpApiException.class, policy::requireOpen);
        assertEquals("REGISTRATION_CLOSED", thrown.getCode());
        assertEquals(403, thrown.getStatus().value());
    }

    @Test
    void invalidValueFailsFastWithTheKeyName() {
        RegistrationPolicy policy = new RegistrationPolicy("false");
        IllegalStateException thrown = assertThrows(IllegalStateException.class, policy::validate);
        assertTrue(thrown.getMessage().contains("XIHE_AUTH_REGISTRATION_POLICY"),
                "the startup error must name the offending key: " + thrown.getMessage());
    }
}
