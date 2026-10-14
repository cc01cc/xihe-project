package com.cc01cc.p.xihe.cp.policy;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Set;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0496 M1 (T1.1/T1.3): the credential vocabulary — three atoms with the canonical
 * {@code credential:<uuid>} / {@code credential:*} resource namespace, and the fail-fast
 * request rule (evaluation requests must carry a concrete id, never the wildcard).
 */
class CredentialAtomVocabularyTest {

    private final GrantIntersectionEvaluator evaluator = new GrantIntersectionEvaluator();
    private final ObjectMapper objectMapper = new ObjectMapper();

    @Test
    void vocabularyContainsTheThreeCredentialAtomsAndRetiresTheLegacyWord() {
        Set<String> vocabulary = ToolFaceRegistry.builtinActionClasses();
        assertTrue(vocabulary.containsAll(
                Set.of("credential_use", "credential_reveal", "credential_manage")));
        assertFalse(vocabulary.contains("credential"),
                "the legacy single word is retired in the same cutover (0496 #5)");
    }

    @Test
    void canonicalCredentialResourcesAreAcceptedAtParseTime() throws Exception {
        String concrete = "credential:" + UUID.randomUUID();
        var atoms = evaluator.parse(objectMapper.readTree("""
                [
                  {"actionClass":"credential_use","resource":"credential:*"},
                  {"actionClass":"credential_reveal","resource":"%s"},
                  {"actionClass":"credential_manage","resource":"%s"}
                ]
                """.formatted(concrete, concrete)));
        assertEquals(3, atoms.size());
    }

    @Test
    void nonCanonicalCredentialResourcesAreRejectedAtParseTime() {
        assertAtomRejected("""
                [{"actionClass":"credential_use"}]
                """, "a missing resource means the bare '*' — not part of the credential namespace");
        assertAtomRejected("""
                [{"actionClass":"credential_use","resource":"*"}]
                """, "the bare wildcard is not the credential namespace");
        assertAtomRejected("""
                [{"actionClass":"credential_use","resource":"credential:not-a-uuid"}]
                """, "non-UUID ids are not canonical");
        assertAtomRejected("""
                [{"actionClass":"credential_use","resource":"credential:ab*"}]
                """, "partial globs are not part of the naming rule (0496 #2)");
        assertAtomRejected("""
                [{"actionClass":"credential_use","resource":"provider_connections/*"}]
                """, "credential atoms cannot borrow other resource namespaces");
        assertAtomRejected("""
                [{"actionClass":"credential_use","resource":"credential:"}]
                """, "an empty id is not canonical");
    }

    @Test
    void nonCredentialAtomsKeepTheLegacyRules() throws Exception {
        var atoms = evaluator.parse(objectMapper.readTree("""
                [{"actionClass":"read","resource":"src/**"},{"actionClass":"write"}]
                """));
        assertEquals(2, atoms.size());
    }

    @Test
    void credentialRequestsMustCarryAConcreteId() {
        String concrete = "credential:" + UUID.randomUUID();
        PolicyRequest ok = new PolicyRequest("probe", List.of("credential_use"), List.of(concrete),
                ToolShape.STRUCTURED, "u", "w", null);
        assertEquals(List.of(concrete), ok.resources());

        assertThrows(IllegalArgumentException.class, () -> new PolicyRequest(
                "probe", List.of("credential_use"), List.of("credential:*"),
                ToolShape.STRUCTURED, "u", "w", null),
                "the wildcard must be rejected on the request side (I2)");
        assertThrows(IllegalArgumentException.class, () -> new PolicyRequest(
                "probe", List.of("credential_manage"), List.of("*"),
                ToolShape.STRUCTURED, "u", "w", null),
                "a bare wildcard is never a concrete credential id");
        assertThrows(IllegalArgumentException.class, () -> new PolicyRequest(
                "probe", List.of("credential_use"), List.of("credential:not-a-uuid"),
                ToolShape.STRUCTURED, "u", "w", null));

        PolicyRequest legacy = new PolicyRequest("probe", List.of("read"), List.of("notes/today.md"),
                ToolShape.STRUCTURED, "u", "w", null);
        assertEquals(List.of("notes/today.md"), legacy.resources(),
                "non-credential requests keep the existing shape");
    }

    @Test
    void resourceFormHelpersMatchTheNamespaceContract() {
        String concrete = "credential:" + UUID.randomUUID();
        assertTrue(ToolFaceRegistry.isCanonicalCredentialResource("credential:*"));
        assertTrue(ToolFaceRegistry.isCanonicalCredentialResource(concrete));
        assertTrue(ToolFaceRegistry.isConcreteCredentialResource(concrete));
        assertFalse(ToolFaceRegistry.isConcreteCredentialResource("credential:*"));
        assertFalse(ToolFaceRegistry.isCanonicalCredentialResource("credential:1-1-1-1-1"),
                "loose UUID forms are not canonical");
        assertFalse(ToolFaceRegistry.isCanonicalCredentialResource(concrete.toUpperCase()),
                "round-4: uppercase spellings are rejected at write time — every downstream "
                        + "comparison is case-sensitive and would strand the atom");
        assertFalse(ToolFaceRegistry.isCanonicalCredentialResource(null));
    }

    @Test
    void resourceCoversIsKeyedByActionClassNotResourcePrefix() {
        // non-credential atom with a credential-prefixed resource keeps the legacy rule
        assertTrue(ToolFaceRegistry.resourceCovers("read", "*", "credential:whatever"));
        assertFalse(ToolFaceRegistry.resourceCovers("read", "credential:abc", "credential:whatever"));
        // the credential namespace applies to the credential atoms
        assertTrue(ToolFaceRegistry.resourceCovers("credential_use", "credential:*",
                "credential:" + UUID.randomUUID()));
        assertFalse(ToolFaceRegistry.resourceCovers("credential_use", "credential:abc",
                "credential:" + UUID.randomUUID()));
    }

    @Test
    void acquireCredentialToolFaceIsCredentialUseStructured() {
        ToolFaceRegistry registry = new ToolFaceRegistry();
        ToolFaceRegistry.Face face = registry.faceOf("acquire_credential");

        assertEquals("credential_use", face.actionClass(),
                "PLAN-0497 M0 freeze: acquire_credential runs the credential_use evaluation");
        assertEquals(ToolShape.STRUCTURED, face.shape());
        assertTrue(registry.known("acquire_credential"));
    }

    private void assertAtomRejected(String json, String message) {
        assertThrows(IllegalArgumentException.class,
                () -> evaluator.parse(objectMapper.readTree(json)), message);
    }
}
