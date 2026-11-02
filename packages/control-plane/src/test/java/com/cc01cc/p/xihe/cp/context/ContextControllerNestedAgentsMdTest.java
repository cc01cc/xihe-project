package com.cc01cc.p.xihe.cp.context;

import com.cc01cc.p.xihe.cp.context.service.ContextAccessService;
import com.cc01cc.p.xihe.cp.context.service.ContextService;
import com.cc01cc.p.xihe.cp.context.service.ContextSourceRefreshService;
import com.cc01cc.p.xihe.cp.context.service.NestedAgentsMdResolver;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * PLAN-0627 M1: the internal-only nested AGENTS.md route (D27-06).
 *
 * <p>Only the thin controller contract is asserted here: access gate, body validation and
 * the response shape. Resolution semantics live in {@link NestedAgentsMdResolverTest}.
 */
class ContextControllerNestedAgentsMdTest {
    private static final String SESSION_ID = "11111111-1111-4111-8111-111111111111";
    private static final String USER = "22222222-2222-4222-8222-222222222222";
    private static final String WORKSPACE = "33333333-3333-4333-8333-333333333333";

    private final ContextService contextService = mock(ContextService.class);
    private final ContextSourceRefreshService refreshService = mock(ContextSourceRefreshService.class);
    private final ContextAccessService accessService = mock(ContextAccessService.class);
    private final ContextEventResponseMapper responseMapper = mock(ContextEventResponseMapper.class);
    private final NestedAgentsMdResolver resolver = mock(NestedAgentsMdResolver.class);
    private final ContextController controller = new ContextController(
            contextService, refreshService, accessService, responseMapper, resolver);

    @Test
    void forbiddenWhenSessionAccessIsNotVerified() {
        when(accessService.verifyAccess(SESSION_ID)).thenReturn(false);
        ResponseEntity<?> response = controller.resolveNestedAgentsMd(SESSION_ID, Map.of("path", "src/a.ts"));
        assertEquals(HttpStatus.FORBIDDEN, response.getStatusCode());
        verify(resolver, never()).resolve(any(), any(), any(), any(), any());
    }

    @Test
    void rejectsANonStringPath() {
        when(accessService.verifyAccess(SESSION_ID)).thenReturn(true);
        ResponseEntity<?> response = controller.resolveNestedAgentsMd(SESSION_ID, Map.of("path", 42));
        assertEquals(HttpStatus.BAD_REQUEST, response.getStatusCode());
        verify(resolver, never()).resolve(any(), any(), any(), any(), any());
    }

    @Test
    void returnsPathContentOnlyForTheResolvedChain() {
        when(accessService.verifyAccess(SESSION_ID)).thenReturn(true);
        when(accessService.resolveUserId(SESSION_ID)).thenReturn(USER);
        when(accessService.resolveWorkspaceId(SESSION_ID)).thenReturn(WORKSPACE);
        when(resolver.resolve(SESSION_ID, USER, WORKSPACE, "read_file", "src/a.ts")).thenReturn(
                new NestedAgentsMdResolver.Resolution("ready",
                        List.of(new NestedAgentsMdResolver.Entry("src/AGENTS.md", "rules", false)),
                        List.of()));

        ResponseEntity<?> response = controller.resolveNestedAgentsMd(
                SESSION_ID, Map.of("path", "src/a.ts", "tool", "read_file"));

        assertEquals(HttpStatus.OK, response.getStatusCode());
        Map<?, ?> body = (Map<?, ?>) response.getBody();
        assertEquals("ready", body.get("status"));
        List<?> entries = (List<?>) body.get("entries");
        assertEquals(1, entries.size());
        Map<?, ?> entry = (Map<?, ?>) entries.getFirst();
        assertEquals("src/AGENTS.md", entry.get("path"));
        assertEquals("rules", entry.get("content"));
        assertEquals(false, entry.get("truncated"));
        assertTrue(((List<?>) body.get("diagnostics")).isEmpty());
    }

    @Test
    void defaultsToAnEmptyToolAndPathWhenBodyIsEmpty() {
        when(accessService.verifyAccess(SESSION_ID)).thenReturn(true);
        when(accessService.resolveUserId(SESSION_ID)).thenReturn(USER);
        when(accessService.resolveWorkspaceId(SESSION_ID)).thenReturn(WORKSPACE);
        when(resolver.resolve(anyString(), anyString(), anyString(), anyString(), anyString()))
                .thenReturn(new NestedAgentsMdResolver.Resolution("ready", List.of(), List.of()));
        ResponseEntity<?> response = controller.resolveNestedAgentsMd(SESSION_ID, Map.of());
        assertEquals(HttpStatus.OK, response.getStatusCode());
        verify(resolver).resolve(SESSION_ID, USER, WORKSPACE, "", "");
    }
}
