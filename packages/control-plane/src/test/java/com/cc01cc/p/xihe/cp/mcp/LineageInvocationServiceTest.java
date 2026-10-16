package com.cc01cc.p.xihe.cp.mcp;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class LineageInvocationServiceTest {

    @Test
    void canonicalArgumentsHashIgnoresObjectKeyOrderAndEquivalentNumberFormatting() {
        String left = "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"params\":{\"name\":\"write_file\",\"arguments\":{\"z\":1.0,\"a\":{\"b\":true,\"a\":\"x\"}}}}";
        String right = "{\"params\":{\"arguments\":{\"a\":{\"a\":\"x\",\"b\":true},\"z\":1},\"name\":\"write_file\"},\"method\":\"tools/call\",\"jsonrpc\":\"2.0\"}";

        String leftHash = LineageInvocationService.canonicalArgumentsHash(left, "write_file");
        String rightHash = LineageInvocationService.canonicalArgumentsHash(right, "write_file");

        assertEquals(leftHash, rightHash);
        assertTrue(leftHash.matches("[0-9a-f]{64}"));
    }

    @Test
    void canonicalArgumentsHashChangesWhenMutationArgumentsChange() {
        String left = "{\"method\":\"tools/call\",\"params\":{\"name\":\"write_file\",\"arguments\":{\"path\":\"a\"}}}";
        String right = "{\"method\":\"tools/call\",\"params\":{\"name\":\"write_file\",\"arguments\":{\"path\":\"b\"}}}";

        assertNotEquals(LineageInvocationService.canonicalArgumentsHash(left, "write_file"),
                LineageInvocationService.canonicalArgumentsHash(right, "write_file"));
    }

    @Test
    void canonicalArgumentsHashRejectsMalformedShapeAndDuplicateKeysAsBadRequest() {
        String wrongMethod = "{\"method\":\"tools/list\",\"params\":{}}";
        String wrongArguments = "{\"method\":\"tools/call\",\"params\":{\"name\":\"write_file\",\"arguments\":[]}}";
        String duplicateKey = "{\"method\":\"tools/call\",\"params\":{\"name\":\"write_file\",\"arguments\":{\"x\":1,\"x\":2}}}";

        assertInvalidArguments(wrongMethod);
        assertInvalidArguments(wrongArguments);
        assertInvalidArguments(duplicateKey);
    }

    @Test
    void originatingToolCallIdIsBoundedAndRejectsControlCharacters() {
        String valid = "tool-call:" + "a".repeat(118);
        assertEquals(valid, LineageInvocationService.validateOriginatingToolCallId(valid));

        CpApiException tooLong = assertThrows(CpApiException.class,
                () -> LineageInvocationService.validateOriginatingToolCallId("a".repeat(129)));
        CpApiException nul = assertThrows(CpApiException.class,
                () -> LineageInvocationService.validateOriginatingToolCallId("tool\u0000call"));
        assertEquals("RECONCILIATION_REQUIRED", tooLong.getCode());
        assertEquals("RECONCILIATION_REQUIRED", nul.getCode());
    }

    @Test
    void continuationRunOwnerBindingRejectsMissingOrMismatchedOwnership() {
        java.util.UUID session = java.util.UUID.randomUUID();
        java.util.UUID user = java.util.UUID.randomUUID();
        java.util.UUID workspace = java.util.UUID.randomUUID();
        java.util.UUID branch = java.util.UUID.randomUUID();
        var matching = new LineageInvocationService.ContinuationRunBinding(
                java.util.UUID.randomUUID(), session, user, workspace, branch,
                session, user, workspace, branch);
        var missingUser = new LineageInvocationService.ContinuationRunBinding(
                java.util.UUID.randomUUID(), session, null, workspace, branch,
                session, user, workspace, branch);
        var wrongBranch = new LineageInvocationService.ContinuationRunBinding(
                java.util.UUID.randomUUID(), session, user, workspace, java.util.UUID.randomUUID(),
                session, user, workspace, branch);

        assertTrue(LineageInvocationService.ownerTupleMatches(matching));
        assertFalse(LineageInvocationService.ownerTupleMatches(missingUser));
        assertFalse(LineageInvocationService.ownerTupleMatches(wrongBranch));
    }

    private static void assertInvalidArguments(String body) {
        CpApiException exception = assertThrows(CpApiException.class,
                () -> LineageInvocationService.canonicalArgumentsHash(body, "write_file"));
        assertEquals("INVALID_REQUEST", exception.getCode());
        assertEquals(400, exception.getStatus().value());
    }
}
