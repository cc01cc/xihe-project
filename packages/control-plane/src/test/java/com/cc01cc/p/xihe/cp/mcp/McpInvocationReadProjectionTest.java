package com.cc01cc.p.xihe.cp.mcp;

import com.cc01cc.p.xihe.cp.entity.McpInvocation;
import com.cc01cc.p.xihe.cp.config.DbLockTimeout;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.McpAttemptRepository;
import com.cc01cc.p.xihe.cp.repository.McpDispatchHistoryRepository;
import com.cc01cc.p.xihe.cp.repository.McpInvocationRepository;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class McpInvocationReadProjectionTest {

    @Test
    void toolNamesByCallForRunReturnsFirstNameByCaseInsensitiveCallId() {
        String runId = "run-1";
        McpInvocation first = invocation("CALL-A", "shell");
        McpInvocation duplicate = invocation("call-a", "different");
        McpInvocation withoutName = invocation("call-b", null);
        McpInvocation withoutCallId = invocation(null, "ignored");
        McpInvocationRepository repository = mock(McpInvocationRepository.class);
        when(repository.findByRunIdOrderByCreatedAtAsc(runId))
                .thenReturn(List.of(first, duplicate, withoutName, withoutCallId));
        McpInvocationService service = new McpInvocationService(
                repository, mock(McpAttemptRepository.class),
                mock(McpDispatchHistoryRepository.class),
                mock(ChatRunRepository.class),
                mock(DbLockTimeout.class));

        assertEquals(Map.of("call-a", "shell"), service.toolNamesByCallForRun(runId));
    }

    private static McpInvocation invocation(String toolCallId, String toolName) {
        McpInvocation invocation = new McpInvocation();
        invocation.setToolCallId(toolCallId);
        invocation.setToolName(toolName);
        return invocation;
    }
}
