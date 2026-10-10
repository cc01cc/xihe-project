package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.policy.PolicyContext;
import com.cc01cc.p.xihe.cp.policy.PolicyEffect;
import com.cc01cc.p.xihe.cp.policy.PolicyEngine;
import com.cc01cc.p.xihe.cp.policy.PolicyVerdict;
import com.cc01cc.p.xihe.cp.policy.PolicyLayer;
import com.cc01cc.p.xihe.cp.runtime.RuntimeContextSourceClient;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

class ContextTemplateSourceServiceTest {
    private static final String USER = UUID.randomUUID().toString();
    private static final String WORKSPACE = UUID.randomUUID().toString();
    private static final String SESSION_ID = UUID.randomUUID().toString();
    private static final String RUN_ID = UUID.randomUUID().toString();
    private final RuntimeContextSourceClient runtime = mock(RuntimeContextSourceClient.class);
    private final PolicyEngine policy = mock(PolicyEngine.class);
    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    void listsOnlySafeFilteredPathsAndNeverFollowsSymlinks() throws Exception {
        allowPolicy();
        when(runtime.listDirectory(WORKSPACE, ".")).thenReturn(ready(
                entry("src", "src", true, false), entry("link", "link", true, true),
                entry("README.md", "README.md", false, false), entry("secret", "secret", false, false)));
        when(runtime.listDirectory(WORKSPACE, "src")).thenReturn(ready(
                entry("AGENTS.md", "src/AGENTS.md", false, false), entry("nested", "src/nested", true, false)));
        when(runtime.listDirectory(WORKSPACE, "src/nested")).thenReturn(ready(
                entry("a.txt", "src/nested/a.txt", false, false)));

        Map<String, Object> result = resolve("workspace_tree", "{\"root\":\"session_workspace\","
                + "\"maxDepth\":2,\"includeFiles\":true,\"maxEntries\":10,"
                + "\"excludePatterns\":[\"SECRET\"]}");
        assertEquals("ready", result.get("status"));
        assertEquals(List.of("src/", "README.md", "src/AGENTS.md", "src/nested/", "src/nested/a.txt"), result.get("items"));
        verify(runtime, never()).listDirectory(WORKSPACE, "link");
    }

    @Test
    void agentsTreeReturnsOnlyConfiguredFilePathsAndBoundsDepthAndEntries() throws Exception {
        allowPolicy();
        when(runtime.listDirectory(WORKSPACE, ".")).thenReturn(ready(
                entry("AGENTS.md", "AGENTS.md", false, false), entry("deep", "deep", true, false),
                entry("other.md", "other.md", false, false)));
        when(runtime.listDirectory(WORKSPACE, "deep")).thenReturn(ready(
                entry("agents.md", "deep/agents.md", false, false), entry("child", "deep/child", true, false)));
        Map<String, Object> result = resolve("agents_md_tree", "{\"root\":\"session_workspace\","
                + "\"maxDepth\":1,\"maxEntries\":1,\"fileNames\":[\"AGENTS.md\"]}");
        assertEquals(List.of("AGENTS.md"), result.get("items"));
        assertTrue((Boolean) result.get("truncated"));
        verify(runtime, never()).listDirectory(WORKSPACE, "deep/child");
    }

    @Test
    void askDenyAndRuntimeErrorsAreExplicitAndDoNotBecomeEmptySuccess() throws Exception {
        when(policy.loadContext(USER, WORKSPACE, SESSION_ID)).thenReturn(PolicyContext.EMPTY);
        when(policy.allowsByGrant(any(), eq("list_directory"), anyString(), eq(SESSION_ID),
                eq(USER), eq(WORKSPACE), eq(false))).thenReturn(true);
        when(policy.evaluateVerdict(any(), eq("list_directory"), anyString(), eq(SESSION_ID),
                isNull(), eq(USER), eq(WORKSPACE))).thenReturn(
                PolicyVerdict.of(PolicyEffect.ASK, null, PolicyLayer.BUILTIN, "manual", "approval"));
        Map<String, Object> asked = resolve("workspace_tree", standardConfig());
        assertEquals("approval_required", asked.get("status"));
        verifyNoInteractions(runtime);

        when(policy.evaluateVerdict(any(), anyString(), anyString(), anyString(), any(), anyString(), anyString()))
                .thenReturn(PolicyVerdict.of(PolicyEffect.ALLOW, null, PolicyLayer.BUILTIN, "auto", "allowed"));
        when(runtime.listDirectory(WORKSPACE, "."))
                .thenReturn(new RuntimeContextSourceClient.DirectoryRead(List.of(), "failed", 403));
        Map<String, Object> failed = resolve("workspace_tree", standardConfig());
        assertEquals("failed", failed.get("status"));
        assertNotEquals("ready", failed.get("status"));
        assertEquals(List.of(), failed.get("items"));

        when(runtime.listDirectory(WORKSPACE, "."))
                .thenReturn(new RuntimeContextSourceClient.DirectoryRead(List.of(), "unavailable", null));
        Map<String, Object> unavailable = resolve("workspace_tree", standardConfig());
        assertEquals("unavailable", unavailable.get("status"));
        assertEquals(List.of(), unavailable.get("items"));

        when(policy.evaluateVerdict(any(), anyString(), anyString(), anyString(), any(), anyString(), anyString()))
                .thenReturn(PolicyVerdict.of(PolicyEffect.DENY, null, PolicyLayer.BUILTIN, "manual", "denied"));
        Map<String, Object> denied = resolve("workspace_tree", standardConfig());
        assertEquals("failed", denied.get("status"));
        assertEquals("policy_denied", ((List<?>) denied.get("diagnostics")).getFirst());
    }

    @Test
    void grantDeniedStopsBeforePolicyVerdictAndRuntime() throws Exception {
        when(policy.loadContext(USER, WORKSPACE, SESSION_ID)).thenReturn(PolicyContext.EMPTY);
        when(policy.allowsByGrant(any(), anyString(), anyString(), anyString(), anyString(), anyString(), anyBoolean()))
                .thenReturn(false);
        Map<String, Object> result = resolve("workspace_tree", standardConfig());
        assertEquals("failed", result.get("status"));
        verify(policy, never()).evaluateVerdict(any(), anyString(), anyString(), anyString(), any(), anyString(), anyString());
        verifyNoInteractions(runtime);
    }

    @Test
    void allTreeComponentsShareOnePerRunRuntimeRequestBudget() throws Exception {
        allowPolicy();
        RuntimeContextSourceClient.DirectoryEntry[] rootEntries = new RuntimeContextSourceClient.DirectoryEntry[600];
        for (int index = 0; index < rootEntries.length; index++) {
            String name = "dir-" + index;
            rootEntries[index] = entry(name, name, true, false);
        }
        when(runtime.listDirectory(WORKSPACE, ".")).thenReturn(ready(rootEntries));
        when(runtime.listDirectory(eq(WORKSPACE), argThat(path -> path != null && path.startsWith("dir-"))))
                .thenReturn(ready());

        String firstId = "11111111-1111-4111-8111-111111111111";
        String secondId = "22222222-2222-4222-8222-222222222222";
        String snapshot = "{\"template\":{\"components\":["
                + "{\"instanceId\":\"" + firstId + "\",\"type\":\"workspace_tree\",\"enabled\":true,"
                + "\"config\":{\"root\":\"session_workspace\",\"maxDepth\":2,\"includeFiles\":true,\"maxEntries\":2000}},"
                + "{\"instanceId\":\"" + secondId + "\",\"type\":\"workspace_tree\",\"enabled\":true,"
                + "\"config\":{\"root\":\"session_workspace\",\"maxDepth\":2,\"includeFiles\":true,\"maxEntries\":2000}}]}}";
        ContextTemplateSourceService.RunContext run = new ContextTemplateSourceService.RunContext(
                SESSION_ID, WORKSPACE, USER, mapper.readTree(snapshot));
        Session session = new Session(WORKSPACE, USER, "bounded tree");
        session.setId(UUID.fromString(SESSION_ID));

        Map<String, Object> sources = new ContextTemplateSourceService(runtime, policy, mapper).resolve(run, session);

        assertEquals(2, sources.size());
        assertEquals("truncated", ((Map<?, ?>) sources.get(firstId)).get("status"));
        assertEquals("truncated", ((Map<?, ?>) sources.get(secondId)).get("status"));
        verify(runtime, times(512)).listDirectory(eq(WORKSPACE), anyString());
    }

    private Map<String, Object> resolve(String type, String config) throws Exception {
        String snapshot = "{\"template\":{\"components\":[{\"instanceId\":\"component-1\","
                + "\"type\":\"" + type + "\",\"enabled\":true,\"config\":" + config + "}]}}";
        ContextTemplateSourceService.RunContext run = new ContextTemplateSourceService.RunContext(
                SESSION_ID, WORKSPACE, USER, mapper.readTree(snapshot));
        Session session = new Session(WORKSPACE, USER, "tree test");
        session.setId(UUID.fromString(SESSION_ID));
        return (Map<String, Object>) new ContextTemplateSourceService(runtime, policy, mapper)
                .resolve(run, session).get("component-1");
    }

    private void allowPolicy() {
        when(policy.loadContext(USER, WORKSPACE, SESSION_ID)).thenReturn(PolicyContext.EMPTY);
        when(policy.allowsByGrant(any(), eq("list_directory"), anyString(), eq(SESSION_ID),
                eq(USER), eq(WORKSPACE), eq(false))).thenReturn(true);
        when(policy.evaluateVerdict(any(), eq("list_directory"), anyString(), eq(SESSION_ID),
                isNull(), eq(USER), eq(WORKSPACE))).thenReturn(
                PolicyVerdict.of(PolicyEffect.ALLOW, null, PolicyLayer.BUILTIN, "auto", "allowed"));
    }

    private static RuntimeContextSourceClient.DirectoryRead ready(RuntimeContextSourceClient.DirectoryEntry... entries) {
        return new RuntimeContextSourceClient.DirectoryRead(List.of(entries), "ready", 200);
    }

    private static RuntimeContextSourceClient.DirectoryEntry entry(String name, String path, boolean dir, boolean symlink) {
        return new RuntimeContextSourceClient.DirectoryEntry(name, path, dir, symlink);
    }

    private static String standardConfig() {
        return "{\"root\":\"session_workspace\",\"maxDepth\":2,\"includeFiles\":true,\"maxEntries\":10}";
    }
}
