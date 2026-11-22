package com.cc01cc.p.xihe.cp.policy;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.Test;

/**
 * task-830 / DEV-037 §2: one namespace registry decides the matcher and whether a namespace may be
 * written to a grant. Each case pins a face that used to be a scattered string literal, so a future
 * namespace is a registry row rather than a parser change.
 */
class ResourceNamespaceRegistryTest {

    private static final String WS = "11111111-1111-4111-8111-111111111111";
    private static final String OTHER = "22222222-2222-4222-8222-222222222222";

    @Test
    void everyKnownNamespaceDeclaresItsMatcherAndGrantability() {
        assertEquals(ResourceNamespaces.Matcher.PREFIX,
                ResourceNamespaces.matcherOf("fs:" + WS + "/src"));
        assertEquals(ResourceNamespaces.Matcher.PREFIX,
                ResourceNamespaces.matcherOf("phys:/h/ws/src"));
        assertEquals(ResourceNamespaces.Matcher.EXACT,
                ResourceNamespaces.matcherOf("credential:" + WS));
        assertEquals(ResourceNamespaces.Matcher.PREFIX,
                ResourceNamespaces.matcherOf("skill:" + WS));
        assertNull(ResourceNamespaces.matcherOf("notes/today.md"),
                "a bare path has no namespace");
        assertNull(ResourceNamespaces.matcherOf("*"));

        assertEquals(ResourceNamespaces.Grantability.GRANTABLE,
                ResourceNamespaces.grantabilityOf("fs:" + WS + "/src"));
        assertEquals(ResourceNamespaces.Grantability.GRANTABLE,
                ResourceNamespaces.grantabilityOf("skill:" + WS));
        assertEquals(ResourceNamespaces.Grantability.GRANTABLE,
                ResourceNamespaces.grantabilityOf("credential:*"));
        assertEquals(ResourceNamespaces.Grantability.EVALUATION_ONLY,
                ResourceNamespaces.grantabilityOf("phys:/h/ws/src"));
    }

    @Test
    void unknownNamespaceFailsClosedAndIsNotADefault() {
        assertEquals(ResourceNamespaces.Grantability.UNKNOWN,
                ResourceNamespaces.grantabilityOf("mystery:" + WS));
        assertTrue(ResourceNamespaces.isUnknownNamespace("mystery:value"));
        assertFalse(ResourceNamespaces.isUnknownNamespace("fs:" + WS),
                "a registered namespace is never 'unknown'");
    }

    @Test
    void workspaceAndSessionAreContextNotResources() {
        assertEquals(ResourceNamespaces.Grantability.CONTEXT_RESERVED,
                ResourceNamespaces.grantabilityOf("workspace:" + WS));
        assertEquals(ResourceNamespaces.Grantability.CONTEXT_RESERVED,
                ResourceNamespaces.grantabilityOf("session:" + WS));

        // Same spelling, different meaning: `workspace:admin` is a capability atom, never a resource
        // pattern. This is the collision the docs must call out.
        assertTrue(PermissionAtomCatalog.atom("cap:workspace:admin").capability(),
                "cap:workspace:admin is a capability atom");
        assertEquals(ResourceNamespaces.Grantability.CONTEXT_RESERVED,
                ResourceNamespaces.grantabilityOf("workspace:admin"),
                "the same spelling is context-reserved on the resource axis");
    }

    @Test
    void legacyShapesStayLegal() {
        assertEquals(ResourceNamespaces.Grantability.GRANTABLE, ResourceNamespaces.grantabilityOf("*"));
        assertEquals(ResourceNamespaces.Grantability.GRANTABLE,
                ResourceNamespaces.grantabilityOf("notes/today.md"));
        assertEquals(ResourceNamespaces.Grantability.GRANTABLE,
                ResourceNamespaces.grantabilityOf("credential:*"));
    }

    @Test
    void exactMatcherCoversOnlyTheSameValueOrItsWildcard() {
        assertTrue(ResourceNamespaces.matches(ResourceNamespaces.Matcher.EXACT,
                "credential:" + WS, "credential:" + WS));
        assertTrue(ResourceNamespaces.matches(ResourceNamespaces.Matcher.EXACT,
                "credential:*", "credential:" + WS));
        assertFalse(ResourceNamespaces.matches(ResourceNamespaces.Matcher.EXACT,
                "credential:" + WS, "credential:" + OTHER));
        assertFalse(ResourceNamespaces.matches(ResourceNamespaces.Matcher.EXACT,
                "credential:" + WS, "credential:" + WS + "/extra"),
                "EXACT never prefix-matches");
    }

    @Test
    void prefixMatcherCoversSlashDescendantsAndTheLegacySingleSegmentFsKey() {
        assertTrue(ResourceNamespaces.matches(ResourceNamespaces.Matcher.PREFIX,
                "fs:" + WS, "fs:" + WS + "/src/app.ts"),
                "legacy single-segment fs: key covers the whole workspace");
        assertTrue(ResourceNamespaces.matches(ResourceNamespaces.Matcher.PREFIX,
                "fs:" + WS + "/src", "fs:" + WS + "/src/app.ts"));
        assertFalse(ResourceNamespaces.matches(ResourceNamespaces.Matcher.PREFIX,
                "fs:" + WS + "/src", "fs:" + WS + "/srcs/app.ts"),
                "prefix is a segment boundary, not a string prefix");
        assertFalse(ResourceNamespaces.matches(ResourceNamespaces.Matcher.PREFIX,
                "fs:" + WS, "fs:" + OTHER + "/src"),
                "different namespace values never cover each other");
    }

    @Test
    void treeMatcherTypeIsReservedWithoutAnOrgNamespace() {
        assertTrue(ResourceNamespaces.matches(ResourceNamespaces.Matcher.TREE,
                "org:root/team", "org:root/team/member"));
        assertFalse(ResourceNamespaces.matches(ResourceNamespaces.Matcher.TREE,
                "org:root/team", "org:root/teamwork"));
        assertEquals(Optional.empty(), ResourceNamespaces.find(ResourceNamespaces.ORG_TREE),
                "the tree matcher is a declared type, but no org: namespace is registered");
        assertEquals(ResourceNamespaces.Grantability.UNKNOWN,
                ResourceNamespaces.grantabilityOf("org:root/team"),
                "an unregistered tree namespace still fails closed");
    }

    @Test
    void normalizationKeepsNamespaceAndCanonicalizesTheValue() {
        assertEquals("credential:" + WS,
                ResourceNamespaces.normalize("CREDENTIAL:" + WS.toUpperCase()));
        assertEquals("fs:" + WS + "/src/app",
                ResourceNamespaces.normalize("FS:" + WS + "/src/app/"));
        assertEquals("*", ResourceNamespaces.normalize(" * "));
        assertEquals("src/app", ResourceNamespaces.normalize("src/app/"));
    }

    @Test
    void canonicalResourcesAreDerivedOnce() {
        assertEquals("*", ResourceNamespaces.canonicalResourceFor("read"));
        assertEquals("credential:*", ResourceNamespaces.canonicalResourceFor("credential_use"));
        assertEquals(ResourceNamespaces.CREDENTIAL_WILDCARD,
                ToolFaceRegistry.CREDENTIAL_RESOURCE_WILDCARD);
        assertEquals(ResourceNamespaces.SKILL_PREFIX, ToolFaceRegistry.SKILL_RESOURCE_PREFIX);
        assertEquals(ResourceNamespaces.FS_PREFIX, ResourceIdentity.DECLARATION_PREFIX);
        assertEquals(ResourceNamespaces.PHYS_PREFIX, ResourceIdentity.PHYSICAL_PREFIX);
    }

    @Test
    void credentialWildcardIsManagementOnlyNeverAUseRequest() {
        // Management face: the catalog canonical resource is the wide ceiling, and a permission atom
        // may carry it (that is how a preset stores `credential_manage@credential:*`).
        assertEquals("credential:*", PermissionAtomCatalog.atom("credential_manage").canonicalResource());
        assertNotNull(new GrantIntersectionEvaluator.PermissionAtom("credential_manage", "credential:*"));

        // Use face: an evaluation request must carry a concrete credential:<uuid>; the wildcard is
        // refused before evaluation. Pinned so a refactor cannot quietly widen credential_use.
        IllegalArgumentException refusal = assertThrows(IllegalArgumentException.class,
                () -> new PolicyRequest("acquire_credential", List.of("credential_use"),
                        List.of("credential:*"), ToolShape.STRUCTURED, "user", null, null));
        assertTrue(refusal.getMessage().contains("concrete credential:<uuid>"), refusal.getMessage());
        assertNotNull(new PolicyRequest("acquire_credential", List.of("credential_use"),
                List.of("credential:" + WS), ToolShape.STRUCTURED, "user", null, null));
    }
}
