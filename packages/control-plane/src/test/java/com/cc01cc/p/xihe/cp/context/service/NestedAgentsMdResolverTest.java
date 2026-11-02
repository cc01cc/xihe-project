package com.cc01cc.p.xihe.cp.context.service;

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
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * PLAN-0627 M1: ancestor-chain resolution contract (D27-01/D27-21/D27-10).
 */
class NestedAgentsMdResolverTest {
    private static final String USER = UUID.randomUUID().toString();
    private static final String WORKSPACE = UUID.randomUUID().toString();
    private static final String SESSION_ID = UUID.randomUUID().toString();

    private final RuntimeContextSourceClient runtime = mock(RuntimeContextSourceClient.class);
    private final PolicyEngine policy = mock(PolicyEngine.class);
    private final NestedAgentsMdResolver resolver =
            new NestedAgentsMdResolver(runtime, policy, new ObjectMapper());

    @Test
    void resolvesSubDirectoryChainOnlyAndOrdersRootToNearest() throws Exception {
        allowPolicy();
        when(runtime.readFile(any(), anyString())).thenReturn(RuntimeContextSourceClient.SourceRead.absent());
        when(runtime.readFile(WORKSPACE, "src/AGENTS.md"))
                .thenReturn(RuntimeContextSourceClient.SourceRead.content("src rules"));
        when(runtime.readFile(WORKSPACE, "src/deep/AGENTS.md"))
                .thenReturn(RuntimeContextSourceClient.SourceRead.content("deep rules"));
        // The workspace-root file is stubbed to prove the resolver never reads it.
        when(runtime.readFile(WORKSPACE, "AGENTS.md"))
                .thenReturn(RuntimeContextSourceClient.SourceRead.content("root rules"));

        NestedAgentsMdResolver.Resolution result =
                resolver.resolve(SESSION_ID, USER, WORKSPACE, "read_file", "src/deep/module/a.ts");

        assertEquals("ready", result.status());
        assertEquals(List.of("src/AGENTS.md", "src/deep/AGENTS.md"),
                result.entries().stream().map(NestedAgentsMdResolver.Entry::path).toList());
        assertEquals(List.of("src rules", "deep rules"),
                result.entries().stream().map(NestedAgentsMdResolver.Entry::content).toList());
        // D27-21: the root file belongs to the eager L1 source and must never enter the chain.
        verify(runtime, never()).readFile(WORKSPACE, "AGENTS.md");
    }

    @Test
    void listDirectoryTouchUsesTheDirectoryItself() throws Exception {
        allowPolicy();
        when(runtime.readFile(any(), anyString())).thenReturn(RuntimeContextSourceClient.SourceRead.absent());
        when(runtime.readFile(WORKSPACE, "src/AGENTS.md"))
                .thenReturn(RuntimeContextSourceClient.SourceRead.content("src rules"));

        NestedAgentsMdResolver.Resolution result =
                resolver.resolve(SESSION_ID, USER, WORKSPACE, "list_directory", "src");

        assertEquals("ready", result.status());
        assertEquals(List.of("src/AGENTS.md"),
                result.entries().stream().map(NestedAgentsMdResolver.Entry::path).toList());
    }

    @Test
    void workspaceRootTouchProducesAnEmptyChainWithoutAnyCall() {
        NestedAgentsMdResolver.Resolution result =
                resolver.resolve(SESSION_ID, USER, WORKSPACE, "list_directory", ".");
        assertEquals("ready", result.status());
        assertTrue(result.entries().isEmpty());
        verifyNoInteractions(runtime);
        verifyNoInteractions(policy);
    }

    @Test
    void unsafePathsFailClosedWithoutRuntimeOrPolicy() {
        for (String unsafe : List.of("../secret/a.ts", "/etc/passwd", "C:\\secret\\a.ts", "a\0b.ts")) {
            NestedAgentsMdResolver.Resolution result =
                    resolver.resolve(SESSION_ID, USER, WORKSPACE, "read_file", unsafe);
            assertEquals("failed", result.status(), "path should be rejected: " + unsafe);
            assertTrue(result.entries().isEmpty());
            assertEquals(List.of("nested_agents_md_unsafe_path"), result.diagnostics());
        }
        verifyNoInteractions(runtime);
        verifyNoInteractions(policy);
    }

    @Test
    void askSkipsTheFileWithoutRaisingAnApproval() throws Exception {
        allowPolicy();
        when(policy.evaluateVerdict(any(), eq("read_file"), anyString(), eq(SESSION_ID), isNull(),
                eq(USER), eq(WORKSPACE))).thenReturn(
                PolicyVerdict.of(PolicyEffect.ASK, null, PolicyLayer.BUILTIN, "manual", "approval"));
        NestedAgentsMdResolver.Resolution result =
                resolver.resolve(SESSION_ID, USER, WORKSPACE, "read_file", "src/a.ts");
        assertEquals("ready", result.status());
        assertTrue(result.entries().isEmpty());
        assertEquals(List.of("nested_agents_md_policy_ask_skipped"), result.diagnostics());
        // Injection is system-initiated: it must never read the file it is not allowed to read.
        verifyNoInteractions(runtime);
    }

    @Test
    void denyAndGrantDenialSkipTheFileAndKeepGoing() throws Exception {
        when(policy.loadContext(USER, WORKSPACE, SESSION_ID)).thenReturn(PolicyContext.EMPTY);
        when(policy.allowsByGrant(any(), eq("read_file"), anyString(), eq(SESSION_ID), eq(USER),
                eq(WORKSPACE), eq(false))).thenReturn(true);
        when(policy.evaluateVerdict(any(), eq("read_file"), anyString(), eq(SESSION_ID), isNull(),
                eq(USER), eq(WORKSPACE))).thenReturn(
                        PolicyVerdict.of(PolicyEffect.DENY, null, PolicyLayer.BUILTIN, "manual", "denied"))
                .thenReturn(PolicyVerdict.of(PolicyEffect.ALLOW, null, PolicyLayer.BUILTIN, "manual", "allowed"));
        when(runtime.readFile(WORKSPACE, "src/deep/AGENTS.md"))
                .thenReturn(RuntimeContextSourceClient.SourceRead.content("deep rules"));

        NestedAgentsMdResolver.Resolution result =
                resolver.resolve(SESSION_ID, USER, WORKSPACE, "read_file", "src/deep/a.ts");

        assertEquals("ready", result.status());
        assertEquals(List.of("src/deep/AGENTS.md"),
                result.entries().stream().map(NestedAgentsMdResolver.Entry::path).toList());
        assertEquals(List.of("nested_agents_md_policy_denied"), result.diagnostics());
    }

    @Test
    void missingFilesAreSkippedSilently() throws Exception {
        allowPolicy();
        when(runtime.readFile(any(), anyString())).thenReturn(RuntimeContextSourceClient.SourceRead.absent());
        NestedAgentsMdResolver.Resolution result =
                resolver.resolve(SESSION_ID, USER, WORKSPACE, "read_file", "src/deep/a.ts");
        assertEquals("ready", result.status());
        assertTrue(result.entries().isEmpty());
        assertTrue(result.diagnostics().isEmpty());
    }

    @Test
    void runtimeFailureFailsTheWholeResolutionClosed() throws Exception {
        allowPolicy();
        when(runtime.readFile(WORKSPACE, "src/AGENTS.md"))
                .thenReturn(RuntimeContextSourceClient.SourceRead.content("src rules"));
        when(runtime.readFile(WORKSPACE, "src/deep/AGENTS.md"))
                .thenReturn(RuntimeContextSourceClient.SourceRead.error(503));

        NestedAgentsMdResolver.Resolution result =
                resolver.resolve(SESSION_ID, USER, WORKSPACE, "read_file", "src/deep/a.ts");

        assertEquals("unavailable", result.status());
        assertTrue(result.entries().isEmpty(), "a partial chain must not be injected on transport failure");
        assertEquals(List.of("nested_agents_md_runtime_unavailable"), result.diagnostics());
    }

    @Test
    void chainLengthIsBoundedKeepingTheNearestLayers() throws Exception {
        allowPolicy();
        when(runtime.readFile(any(), anyString()))
                .thenReturn(RuntimeContextSourceClient.SourceRead.content("rules"));
        StringBuilder deep = new StringBuilder();
        for (int level = 1; level <= 40; level++) {
            deep.append("d").append(level).append('/');
        }
        String path = deep + "a.ts";

        NestedAgentsMdResolver.Resolution result =
                resolver.resolve(SESSION_ID, USER, WORKSPACE, "read_file", path);

        assertEquals(NestedAgentsMdResolver.MAX_ANCESTORS, result.entries().size());
        // Nearest layers survive: the deepest directory is present, the far ones are dropped.
        String first = result.entries().getFirst().path();
        String last = result.entries().getLast().path();
        assertFalse(first.startsWith("d1/AGENTS.md"), "the farthest layer must be evicted first");
        assertTrue(last.startsWith(deep.substring(0, deep.length() - 1) + "/AGENTS.md"));
    }

    @Test
    void oversizedFileIsCutOnTheUtf8BoundaryAndFlagged() throws Exception {
        allowPolicy();
        String huge = "汉".repeat(NestedAgentsMdResolver.MAX_FILE_BYTES); // 3 bytes per char
        when(runtime.readFile(WORKSPACE, "src/AGENTS.md"))
                .thenReturn(RuntimeContextSourceClient.SourceRead.content(huge));

        NestedAgentsMdResolver.Resolution result =
                resolver.resolve(SESSION_ID, USER, WORKSPACE, "read_file", "src/a.ts");

        assertEquals("truncated", result.status());
        NestedAgentsMdResolver.Entry entry = result.entries().getFirst();
        assertTrue(entry.truncated());
        assertTrue(entry.content().getBytes(StandardCharsets.UTF_8).length
                <= NestedAgentsMdResolver.MAX_FILE_BYTES);
        assertFalse(entry.content().endsWith("\uFFFD"), "cut must not split a code point");
    }

    @Test
    void pathNormalizationAcceptsWindowsSeparatorsAndRelativeDots() {
        assertEquals("src/deep/a.ts", NestedAgentsMdResolver.normalizeTouchedPath("src\\deep\\.\\a.ts"));
        assertEquals("src/a.ts", NestedAgentsMdResolver.normalizeTouchedPath("./src/a.ts"));
        assertEquals("", NestedAgentsMdResolver.normalizeTouchedPath(""));
        assertNull(NestedAgentsMdResolver.normalizeTouchedPath("src/../../a.ts"));
        assertEquals(List.of("src/deep", "src"),
                NestedAgentsMdResolver.ancestorDirectories("src/deep/a.ts", false));
        // A directory touch resolves the directory itself plus its ancestors (root excluded).
        assertEquals(List.of("src/deep", "src"),
                NestedAgentsMdResolver.ancestorDirectories("src/deep", true));
        assertEquals(List.of(), NestedAgentsMdResolver.ancestorDirectories("a.ts", false));
    }

    private void allowPolicy() {
        when(policy.loadContext(USER, WORKSPACE, SESSION_ID)).thenReturn(PolicyContext.EMPTY);
        when(policy.allowsByGrant(any(), eq("read_file"), anyString(), eq(SESSION_ID), eq(USER),
                eq(WORKSPACE), anyBoolean())).thenReturn(true);
        when(policy.evaluateVerdict(any(), eq("read_file"), anyString(), eq(SESSION_ID), isNull(),
                eq(USER), eq(WORKSPACE))).thenReturn(
                PolicyVerdict.of(PolicyEffect.ALLOW, null, PolicyLayer.BUILTIN, "manual", "allowed"));
    }
}
