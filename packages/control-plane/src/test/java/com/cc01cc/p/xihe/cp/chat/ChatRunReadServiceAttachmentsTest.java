package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Message;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunTransportAttemptRepository;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;
import org.junit.jupiter.api.Test;

import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * PLAN-0605: dispatch reads the run's admitted attachment JSON from the user message, so
 * `images[]` no longer depends on `files.message_id` being linked first.
 */
class ChatRunReadServiceAttachmentsTest {

    private static final String RUN_ID = "11111111-1111-4111-8111-111111111111";
    private static final String MESSAGE_ID = "22222222-2222-4222-8222-222222222222";

    private final ChatRunRepository chatRuns = mock(ChatRunRepository.class);
    private final MessageRepository messages = mock(MessageRepository.class);
    private final ChatRunReadService service = new ChatRunReadService(
            chatRuns,
            mock(ChatRunTransportAttemptRepository.class),
            mock(ApprovalService.class),
            messages);

    private ChatRun run(String userMessageId) {
        ChatRun run = new ChatRun();
        run.setId(UUID.fromString(RUN_ID));
        run.setUserMessageId(userMessageId);
        return run;
    }

    private Message message(String attachments) {
        Message message = new Message();
        message.setId(UUID.fromString(MESSAGE_ID));
        message.setAttachments(attachments);
        return message;
    }

    @Test
    void returnsAdmittedAttachmentJson() {
        String json = "[{\"fileId\":\"aaa\",\"name\":\"x\",\"type\":\"image/png\",\"size\":346}]";
        when(chatRuns.findById(any())).thenReturn(Optional.of(run(MESSAGE_ID)));
        when(messages.findById(any())).thenReturn(Optional.of(message(json)));

        assertEquals(Optional.of(json), service.findUserMessageAttachmentsJson(RUN_ID));
    }

    @Test
    void missingRunYieldsEmpty() {
        when(chatRuns.findById(any())).thenReturn(Optional.empty());
        assertTrue(service.findUserMessageAttachmentsJson(RUN_ID).isEmpty());
    }

    @Test
    void runWithoutUserMessageYieldsEmpty() {
        when(chatRuns.findById(any())).thenReturn(Optional.of(run(null)));
        assertTrue(service.findUserMessageAttachmentsJson(RUN_ID).isEmpty());
        when(chatRuns.findById(any())).thenReturn(Optional.of(run("  ")));
        assertTrue(service.findUserMessageAttachmentsJson(RUN_ID).isEmpty());
    }

    @Test
    void blankAttachmentsJsonYieldsEmpty() {
        when(chatRuns.findById(any())).thenReturn(Optional.of(run(MESSAGE_ID)));
        when(messages.findById(any())).thenReturn(Optional.of(message(null)));
        assertTrue(service.findUserMessageAttachmentsJson(RUN_ID).isEmpty());
        when(messages.findById(any())).thenReturn(Optional.of(message(" ")));
        assertTrue(service.findUserMessageAttachmentsJson(RUN_ID).isEmpty());
    }

    @Test
    void missingMessageYieldsEmpty() {
        when(chatRuns.findById(any())).thenReturn(Optional.of(run(MESSAGE_ID)));
        when(messages.findById(any())).thenReturn(Optional.empty());
        assertTrue(service.findUserMessageAttachmentsJson(RUN_ID).isEmpty());
    }
}
