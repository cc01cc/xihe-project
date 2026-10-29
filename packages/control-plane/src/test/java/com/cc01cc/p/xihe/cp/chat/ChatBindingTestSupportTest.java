package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.ProviderConnection;
import com.cc01cc.p.xihe.cp.repository.CredentialRepository;
import com.cc01cc.p.xihe.cp.repository.ProviderConnectionRepository;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * PLAN-0577: the chat binding fixture must stay idempotent for the same
 * business key without collapsing different keys onto one label.
 */
class ChatBindingTestSupportTest extends AbstractIntegrationTest {

    @Autowired
    private ProviderConnectionRepository connections;

    @Autowired
    private CredentialRepository credentials;

    @Test
    void sameBusinessKeyReusesConnectionAndCredential() {
        String ownerId = UUID.randomUUID().toString();
        ProviderConnection first = ChatBindingTestSupport.ensureChatConnection(
                connections, "USER", ownerId, "chat-key-reuse");
        long credentialsAfterFirst = credentials.count();

        ProviderConnection second = ChatBindingTestSupport.ensureChatConnection(
                connections, "USER", ownerId, "chat-key-reuse");

        assertThat(second.getId()).isEqualTo(first.getId());
        assertThat(second.getCredentialId()).isEqualTo(first.getCredentialId());
        assertThat(credentials.count()).isEqualTo(credentialsAfterFirst);
        assertThat(connections.findByOwnerTypeAndOwnerId("USER", ownerId)).hasSize(1);
    }

    @Test
    void keysDifferingOnlyByCaseOrPaddingStayDistinct() {
        String ownerId = UUID.randomUUID().toString();
        ProviderConnection lower = ChatBindingTestSupport.ensureChatConnection(
                connections, "USER", ownerId, "chat-abc");
        ProviderConnection upper = ChatBindingTestSupport.ensureChatConnection(
                connections, "USER", ownerId, "CHAT-ABC");
        ProviderConnection padded = ChatBindingTestSupport.ensureChatConnection(
                connections, "USER", ownerId, "chat-abc ");

        assertThat(lower.getId()).isNotEqualTo(upper.getId());
        assertThat(lower.getId()).isNotEqualTo(padded.getId());
        assertThat(upper.getLabel()).isNotEqualToIgnoringCase(lower.getLabel());
        assertThat(connections.findByOwnerTypeAndOwnerId("USER", ownerId)).hasSize(3);
    }

    @Test
    void reusedKeyWithDifferentShapeFailsLoudly() {
        String ownerId = UUID.randomUUID().toString();
        ProviderConnection created = ChatBindingTestSupport.ensureChatConnection(
                connections, "USER", ownerId, "chat-key-shape");
        created.setApiTypeId("embedding-openai");
        connections.saveAndFlush(created);

        assertThatThrownBy(() -> ChatBindingTestSupport.ensureChatConnection(
                connections, "USER", ownerId, "chat-key-shape"))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("different shape");
        assertThat(connections.findByOwnerTypeAndOwnerId("USER", ownerId)).hasSize(1);
    }
}
