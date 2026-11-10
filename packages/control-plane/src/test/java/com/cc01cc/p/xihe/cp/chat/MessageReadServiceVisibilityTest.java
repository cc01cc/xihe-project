package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.entity.Message;
import com.cc01cc.p.xihe.cp.entity.MessageRole;
import com.cc01cc.p.xihe.cp.mcp.McpInvocationService;
import com.cc01cc.p.xihe.cp.operation.JobStateService;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;
import com.cc01cc.p.xihe.cp.service.BranchPathService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.when;

/**
 * PLAN-0630 M5b / D3: a wake instruction is persisted as the Run's user Message so the model sees
 * it, but it is not a user turn. {@link Message#VISIBILITY_INTERNAL} keeps it out of the single
 * public read entry ({@code listVisibleMessages}) while dispatch still reads its content.
 */
class MessageReadServiceVisibilityTest {

    private static final String SESSION_ID = "11111111-1111-1111-1111-111111111111";
    private static final String WORKSPACE_ID = "22222222-2222-2222-2222-222222222222";
    private static final String BRANCH_ID = "33333333-3333-3333-3333-333333333333";
    private static final String RUN_ID = "44444444-4444-4444-4444-444444444444";

    private MessageRepository messageRepository;
    private MessageReadService service;

    @BeforeEach
    void setUp() {
        messageRepository = Mockito.mock(MessageRepository.class);
        service = new MessageReadService(
                messageRepository,
                Mockito.mock(ChatRunRepository.class),
                Mockito.mock(McpInvocationService.class),
                Mockito.mock(JobStateService.class),
                Mockito.mock(BranchPathService.class),
                new ObjectMapper(),
                com.cc01cc.p.xihe.cp.chat.SessionReadMemoryGuard.disabled());
    }

    private static Message message(MessageRole role, String content, String visibility) {
        Message message = new Message(SESSION_ID, role, content);
        message.setId(UUID.randomUUID());
        message.setRunId(RUN_ID);
        message.setBranchId(BRANCH_ID);
        message.setVisibility(visibility);
        return message;
    }

    @Test
    void internal_wake_instruction_is_hidden_from_the_conversation_list() {
        Message userTurn = message(MessageRole.USER, "please answer", Message.VISIBILITY_USER);
        Message wake = message(MessageRole.USER,
                "[mention wake wake:mention:44444444-4444-4444-4444-444444444444] respond to the conversation.",
                Message.VISIBILITY_INTERNAL);
        when(messageRepository.findBySessionIdOrderByCreatedAtAsc(SESSION_ID))
                .thenReturn(List.of(userTurn, wake));

        BranchPathService.BranchVisibility visibility =
                new BranchPathService.BranchVisibility(BRANCH_ID, Map.of());

        List<Map<String, Object>> listed =
                service.listVisibleMessages(SESSION_ID, WORKSPACE_ID, BRANCH_ID, visibility);

        assertEquals(1, listed.size());
        assertEquals("please answer", listed.get(0).get("content"));
        assertTrue(listed.stream().noneMatch(row -> String.valueOf(row.get("content")).contains("mention wake")));
    }

    /**
     * PLAN-0761 (BL-555): the reasoning field projects onto the public message view and is
     * omitted (not null) for Messages written before V150 — the same "absent ⇒ no thinking
     * block" contract the UI already has for toolCalls.
     */
    @Test
    void reasoning_projects_only_when_present() {
        Message withReasoning = message(MessageRole.ASSISTANT, "answer", Message.VISIBILITY_USER);
        withReasoning.setReasoning("thinking about the answer");
        Message withoutReasoning = message(MessageRole.ASSISTANT, "older answer", Message.VISIBILITY_USER);
        when(messageRepository.findBySessionIdOrderByCreatedAtAsc(SESSION_ID))
                .thenReturn(List.of(withReasoning, withoutReasoning));

        BranchPathService.BranchVisibility visibility =
                new BranchPathService.BranchVisibility(BRANCH_ID, Map.of());

        List<Map<String, Object>> listed =
                service.listVisibleMessages(SESSION_ID, WORKSPACE_ID, BRANCH_ID, visibility);

        assertEquals(2, listed.size());
        assertEquals("thinking about the answer", listed.get(0).get("reasoning"));
        assertTrue(!listed.get(1).containsKey("reasoning"),
                "pre-V150 rows must omit reasoning instead of sending null");
    }
}
