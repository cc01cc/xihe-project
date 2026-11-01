package com.cc01cc.p.xihe.cp.policy;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;

import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0622 M1.4 (K2): the pure agent-principal credential decision.
 *
 * <p>Coverage follows the credential namespace: {@code credential:*} covers any id, an exact id
 * covers only itself, and anything else (missing atom, other action class, malformed cap) answers
 * false so the caller fails closed.</p>
 */
class CredentialUseCapTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Test
    void exactCredentialUseAtomCoversOnlyItsOwnId() {
        UUID granted = UUID.randomUUID();
        UUID other = UUID.randomUUID();
        ArrayNode cap = cap();
        cap.add(atom("credential_use", "credential:" + granted));

        assertTrue(CredentialUseCap.grants(cap, granted.toString()));
        assertFalse(CredentialUseCap.grants(cap, other.toString()));
    }

    @Test
    void wildcardCredentialUseAtomCoversAnyId() {
        ArrayNode cap = cap();
        cap.add(atom("credential_use", "credential:*"));

        assertTrue(CredentialUseCap.grants(cap, UUID.randomUUID().toString()));
    }

    @Test
    void aBareWildcardResourceIsNotTheCredentialNamespaceAndFailsClosed() {
        // The credential namespace is bound to the credential atoms: only `credential:*` is the
        // wide ceiling, a bare `*` is not a credential resource (ToolFaceRegistry#resourceCovers).
        ArrayNode cap = cap();
        cap.add(atom("credential_use", PermissionAtomCatalog.WILDCARD));

        assertFalse(CredentialUseCap.grants(cap, UUID.randomUUID().toString()));
    }

    @Test
    void aCredentialAtomWithoutAResourceFailsClosed() {
        ObjectNode atom = MAPPER.createObjectNode();
        atom.put("actionClass", "credential_use");
        ArrayNode cap = cap();
        cap.add(atom);

        assertFalse(CredentialUseCap.grants(cap, UUID.randomUUID().toString()),
                "the schema requires a resource on credential atoms; a malformed atom grants nothing");
    }

    @Test
    void otherActionClassesAndMalformedCapsFailClosed() {
        UUID credential = UUID.randomUUID();
        ArrayNode cap = cap();
        cap.add(atom("credential_reveal", "credential:" + credential));
        cap.add(atom("read", "*"));

        assertFalse(CredentialUseCap.grants(cap, credential.toString()), "only credential_use authorizes use");
        assertFalse(CredentialUseCap.grants(null, credential.toString()), "a null cap grants nothing");
        assertFalse(CredentialUseCap.grants(MAPPER.createObjectNode(), credential.toString()),
                "a non-array cap grants nothing");
        assertFalse(CredentialUseCap.grants(cap, null));
        assertFalse(CredentialUseCap.grants(cap, " "));
    }

    private static ArrayNode cap() {
        return MAPPER.createArrayNode();
    }

    private static ObjectNode atom(String actionClass, String resource) {
        ObjectNode atom = MAPPER.createObjectNode();
        atom.put("actionClass", actionClass);
        atom.put("resource", resource);
        return atom;
    }
}
