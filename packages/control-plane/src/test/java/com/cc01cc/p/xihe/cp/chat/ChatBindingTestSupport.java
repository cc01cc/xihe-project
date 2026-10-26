package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.entity.ProviderConnection;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.repository.ProviderConnectionRepository;
import com.cc01cc.p.xihe.cp.service.ApiRequestTemplateService;
import com.fasterxml.jackson.databind.JsonNode;

import java.util.UUID;

/**
 * PLAN-0439 test support: chat admission requires an explicit Session binding —
 * a visible chat connection at the pinned revision plus a complete template pin
 * triple (NULL pins or a missing connection return
 * {@code API_TYPE_REBIND_REQUIRED}). Fixtures that predate the API-native
 * runtime create raw Sessions without one, so they bind through this helper.
 */
public final class ChatBindingTestSupport {

    private ChatBindingTestSupport() {
    }

    private static com.cc01cc.p.xihe.cp.credentials.CredentialService credentialService;

    public static void setCredentialService(
            com.cc01cc.p.xihe.cp.credentials.CredentialService service) {
        credentialService = service;
    }

    /**
     * A READY chat connection whose non-manual discovery accepts any model, so
     * fixtures do not have to register every model name they assert on.
     */
    public static ProviderConnection ensureChatConnection(ProviderConnectionRepository connections,
                                                          String ownerType, String ownerId, String connectionKey) {
        return ensureChatConnection(connections, ownerType, ownerId, connectionKey, "custom-openai-compatible");
    }

    public static ProviderConnection ensureChatConnection(ProviderConnectionRepository connections,
                                                          String ownerType, String ownerId, String connectionKey,
                                                          String providerId) {
        ProviderConnection connection = new ProviderConnection();
        connection.setId(UUID.randomUUID());
        connection.setOwnerType(ownerType);
        connection.setOwnerId(ownerId);
        connection.setProviderId(providerId);
        connection.setConnectionKey(connectionKey);
        connection.setApiTypeId("openai-chat-completions");
        connection.setApiTypeVersion(1);
        connection.setLabel("chat binding fixture");
        connection.setModelDiscovery("remote-models");
        connection.setEnabled(true);
        connection.setStatus(ProviderConnection.STATUS_READY);
        connection.setRevision(1L);
        if (credentialService != null) {
            connection.setCredentialId(credentialService.create(
                    new com.cc01cc.p.xihe.cp.credentials.CredentialService.CreateRequest(
                            ownerType, ownerId, "chat fixture " + connectionKey,
                            com.cc01cc.p.xihe.cp.entity.Credential.KIND_TOKEN,
                            com.cc01cc.p.xihe.cp.entity.Credential.TIER_LEASE,
                            com.cc01cc.p.xihe.cp.credentials.CredentialService.SecretPayload
                                    .ofToken("fixture-token")),
                    ownerId).getId());
        }
        return connections.saveAndFlush(connection);
    }

    /**
     * Pins the built-in template of the connection's API Type, mirroring what
     * Session creation resolves when the caller makes no explicit choice. A
     * fixture that left provider/model unset gets the chat defaults, since the
     * admission path requires a model for the credential lease.
     */
    public static void bind(Session session, ProviderConnection connection,
                            ApiRequestTemplateService templates) {
        if (session.getModelProvider() == null) {
            session.setModelProvider("custom-openai-compatible");
        }
        if (session.getModelName() == null) {
            session.setModelName("wire-model");
        }
        session.setProviderConnectionId(connection.getId().toString());
        session.setConnectionRevision(connection.getRevision());
        JsonNode ref = templates.builtinRef(connection.getApiTypeId(), connection.getApiTypeVersion());
        session.setContextTemplateLayer(ref.path("layer").asText());
        session.setContextTemplateId(UUID.fromString(ref.path("templateId").asText()));
        session.setContextTemplateVersion(ref.path("version").asInt());
    }

    /**
     * Convenience for per-test fixtures: creates a fresh USER-owned connection
     * (key derived from the session id so owners can be reused across tests)
     * and binds it.
     */
    public static void bindNewChatConnection(Session session, ProviderConnectionRepository connections,
                                             ApiRequestTemplateService templates, String userId) {
        String key = "chat-" + session.getId().toString().substring(0, 8);
        bind(session, ensureChatConnection(connections, "USER", userId, key), templates);
    }
}
