package com.cc01cc.p.xihe.cp.context.service;

import com.cc01cc.p.xihe.cp.chat.MentionParser;
import com.cc01cc.p.xihe.cp.policy.PolicyContext;
import com.cc01cc.p.xihe.cp.policy.PolicyEffect;
import com.cc01cc.p.xihe.cp.policy.PolicyEngine;
import com.cc01cc.p.xihe.cp.policy.PolicyLayer;
import com.cc01cc.p.xihe.cp.policy.PolicyVerdict;
import com.cc01cc.p.xihe.cp.runtime.RuntimeContextSourceClient;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * PLAN-0635 M2: `@文件/目录` resolution.
 *
 * <p>The tests that matter most here are the "reuse" ones: path rejection must be
 * {@link NestedAgentsMdResolver#normalizeTouchedPath} (asserted directly, not just through the
 * resolver) and a token the roster already claims must never be treated as a path.</p>
 */
class MentionPathResolverTest {

    private static final String SESSION_ID = "session-1";
    private static final String USER = "user-1";
    private static final String WORKSPACE = "workspace-1";

    private final RuntimeContextSourceClient runtime = mock(RuntimeContextSourceClient.class);
    private final PolicyEngine policy = mock(PolicyEngine.class);
    private final MentionPathResolver resolver =
            new MentionPathResolver(runtime, policy, new ObjectMapper());

    private void allowPolicy() {
        when(policy.loadContext(USER, WORKSPACE, SESSION_ID)).thenReturn(PolicyContext.EMPTY);
        when(policy.allowsByGrant(any(), anyString(), anyString(), eq(SESSION_ID), eq(USER),
                eq(WORKSPACE), eq(false))).thenReturn(true);
        when(policy.evaluateVerdict(any(), anyString(), anyString(), eq(SESSION_ID), isNull(),
                eq(USER), eq(WORKSPACE))).thenReturn(
                PolicyVerdict.of(PolicyEffect.ALLOW, null, PolicyLayer.BUILTIN, "manual", "allowed"));
    }

    @Test
    void fileMentionIsInlinedWithPathAndContent() {
        allowPolicy();
        when(runtime.readFile(WORKSPACE, "docs/guide.md"))
                .thenReturn(RuntimeContextSourceClient.SourceRead.content("hello"));

        MentionPathResolver.Resolution result = resolver.resolve(SESSION_ID, USER, WORKSPACE,
                "please read @docs/guide.md thanks", token -> false);

        assertEquals(1, result.entries().size());
        MentionPathResolver.Entry entry = result.entries().get(0);
        assertEquals("docs/guide.md", entry.path());
        assertEquals("file", entry.kind());
        assertEquals("hello", entry.content());
        assertFalse(entry.truncated());
        assertTrue(result.diagnostics().isEmpty());
    }

    @Test
    void oversizedFileIsTruncatedToTheSharedByteBound() {
        allowPolicy();
        String huge = "x".repeat(NestedAgentsMdResolver.MAX_FILE_BYTES + 5000);
        when(runtime.readFile(WORKSPACE, "big.txt"))
                .thenReturn(RuntimeContextSourceClient.SourceRead.content(huge));

        MentionPathResolver.Resolution result =
                resolver.resolve(SESSION_ID, USER, WORKSPACE, "@big.txt", token -> false);

        MentionPathResolver.Entry entry = result.entries().get(0);
        assertTrue(entry.truncated());
        assertTrue(entry.content().getBytes(StandardCharsets.UTF_8).length
                <= NestedAgentsMdResolver.MAX_FILE_BYTES);
    }

    @Test
    void directoryMentionCarriesTheBoundedTopLevelListing() {
        allowPolicy();
        when(runtime.readFile(WORKSPACE, "src/chat")).thenReturn(RuntimeContextSourceClient.SourceRead.absent());
        when(runtime.listDirectory(WORKSPACE, "src/chat")).thenReturn(
                new RuntimeContextSourceClient.DirectoryRead(List.of(
                        new RuntimeContextSourceClient.DirectoryEntry("components", "src/chat/components", true, false),
                        new RuntimeContextSourceClient.DirectoryEntry("store.ts", "src/chat/store.ts", false, false)),
                        "ok", 200));

        MentionPathResolver.Resolution result =
                resolver.resolve(SESSION_ID, USER, WORKSPACE, "@src/chat", token -> false);

        MentionPathResolver.Entry entry = result.entries().get(0);
        assertEquals("directory", entry.kind());
        assertEquals("components/\nstore.ts", entry.content());
        assertFalse(entry.truncated());
    }

    /**
     * Five rejection classes — and every one of them is asserted against the **shared** rule, so a
     * future edit that re-implements normalization here fails this test.
     */
    @Test
    void pathRejectionReusesTheNestedResolverRules() {
        List<String> unsafe = List.of(
                "/etc/passwd",                        // absolute
                "../other-workspace/src/app.ts",      // parent traversal (cross-workspace escape)
                "C:/Windows/system32/cmd.exe",        // drive letter
                "src/" + (char) 0 + "nul.ts",         // NUL
                "..\\win\\style.ts");                 // backslash traversal

        for (String token : unsafe) {
            assertNull(NestedAgentsMdResolver.normalizeTouchedPath(token),
                    "shared normalizer must reject: " + token);
        }

        allowPolicy();
        assertTrue(resolver.resolve(SESSION_ID, USER, WORKSPACE,
                "@/etc/passwd @../other-workspace/src/app.ts @C:/Windows/system32/cmd.exe",
                token -> false).entries().isEmpty());
        // Unsafe tokens never reach Runtime: rejection happens before any read.
        verifyNoInteractions(runtime);
    }

    /**
     * Participant-first: the roster match is delegated to the real {@link MentionParser}, exactly
     * as {@code ChatController} wires it. A member whose name looks like a path keeps M1 semantics.
     */
    @Test
    void aTokenTheRosterClaimsIsNeverTreatedAsAPath() {
        allowPolicy();
        List<MentionParser.RosterEntry> roster = List.of(new MentionParser.RosterEntry(
                java.util.UUID.randomUUID(), "AGENT", "src/app.ts", "MEMBER", "WHEN_MENTIONED", null));

        MentionPathResolver.Resolution result = resolver.resolve(SESSION_ID, USER, WORKSPACE,
                "@src/app.ts", token -> !MentionParser.parse("@" + token, roster).mentions().isEmpty());

        assertTrue(result.entries().isEmpty());
        assertTrue(result.diagnostics().isEmpty());
        verifyNoInteractions(runtime);
    }

    @Test
    void atAllIsShortCircuitedAndNeverReadsAFile() {
        allowPolicy();

        MentionPathResolver.Resolution result =
                resolver.resolve(SESSION_ID, USER, WORKSPACE, "@all", token -> false);

        assertTrue(result.entries().isEmpty());
        assertTrue(result.diagnostics().isEmpty());
        verify(runtime, never()).readFile(anyString(), anyString());
    }

    @Test
    void anAskVerdictSkipsThePathWithoutReadingIt() {
        allowPolicy();
        when(policy.evaluateVerdict(any(), eq("read_file"), anyString(), eq(SESSION_ID), isNull(),
                eq(USER), eq(WORKSPACE))).thenReturn(
                PolicyVerdict.of(PolicyEffect.ASK, null, PolicyLayer.BUILTIN, "manual", "approval"));

        MentionPathResolver.Resolution result =
                resolver.resolve(SESSION_ID, USER, WORKSPACE, "@docs/guide.md", token -> false);

        assertTrue(result.entries().isEmpty());
        assertEquals(List.of(MentionPathResolver.DIAG_POLICY_ASK), result.diagnostics());
        verify(runtime, never()).readFile(anyString(), anyString());
    }

    @Test
    void duplicateMentionsOfOnePathAreResolvedOnce() {
        allowPolicy();
        when(runtime.readFile(WORKSPACE, "docs/guide.md"))
                .thenReturn(RuntimeContextSourceClient.SourceRead.content("hello"));

        MentionPathResolver.Resolution result = resolver.resolve(SESSION_ID, USER, WORKSPACE,
                "@docs/guide.md and again @docs/guide.md", token -> false);

        assertEquals(1, result.entries().size());
    }
}
