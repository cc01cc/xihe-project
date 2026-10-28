package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.entity.ProviderConnection;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.repository.ProviderConnectionRepository;
import com.cc01cc.p.xihe.cp.service.ApiRequestTemplateService;
import com.fasterxml.jackson.databind.JsonNode;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.UUID;

/**
 * PLAN-0439 test support: chat admission requires an explicit Session binding —
 * a visible chat connection at the pinned revision plus a complete template pin
 * triple (NULL pins or a missing connection return
 * {@code API_TYPE_REBIND_REQUIRED}). Fixtures that predate the API-native
 * runtime create raw Sessions without one, so they bind through this helper.
 */
public final class ChatBindingTestSupport {

    private static final String FIXTURE_API_TYPE_ID = "openai-chat-completions";
    private static final int FIXTURE_API_TYPE_VERSION = 1;
    private static final String FIXTURE_MODEL_DISCOVERY = "remote-models";

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
        // PLAN-0577: idempotent for the same business key (owner + provider +
        // connectionKey). The unique index only covers the normalized label, so
        // every distinct key needs a distinct label; a digest keeps the label
        // bounded and free of case/whitespace normalization collisions.
        var existing = connections.findByOwnerTypeAndOwnerIdAndProviderIdAndConnectionKey(
                ownerType, ownerId, providerId, connectionKey);
        if (existing.isPresent()) {
            ProviderConnection reused = existing.get();
            requireFixtureShape(reused);
            return reused;
        }
        ProviderConnection connection = new ProviderConnection();
        connection.setId(UUID.randomUUID());
        connection.setOwnerType(ownerType);
        connection.setOwnerId(ownerId);
        connection.setProviderId(providerId);
        connection.setConnectionKey(connectionKey);
        connection.setApiTypeId(FIXTURE_API_TYPE_ID);
        connection.setApiTypeVersion(FIXTURE_API_TYPE_VERSION);
        connection.setLabel(fixtureLabel(connectionKey));
        connection.setModelDiscovery(FIXTURE_MODEL_DISCOVERY);
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
     * Deterministic, bounded and normalization-safe fixture label. The V79
     * unique index compares {@code lower(btrim(label))}, so the raw key cannot
     * be embedded: keys that differ only by case or padding would still clash.
     */
    private static String fixtureLabel(String connectionKey) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(connectionKey.getBytes(StandardCharsets.UTF_8));
            return "chat binding fixture " + HexFormat.of().formatHex(digest, 0, 16);
        } catch (NoSuchAlgorithmException cause) {
            throw new IllegalStateException("SHA-256 unavailable for fixture label", cause);
        }
    }

    /**
     * Reuse only when the stored row is the same shape this helper would create;
     * a key collision with different semantics must fail loudly instead of
     * silently handing a different connection to the caller.
     */
    private static void requireFixtureShape(ProviderConnection connection) {
        boolean sameShape = FIXTURE_API_TYPE_ID.equals(connection.getApiTypeId())
                && connection.getApiTypeVersion() == FIXTURE_API_TYPE_VERSION
                && FIXTURE_MODEL_DISCOVERY.equals(connection.getModelDiscovery())
                && connection.isEnabled()
                && ProviderConnection.STATUS_READY.equals(connection.getStatus());
        if (!sameShape) {
            throw new IllegalStateException(
                    "chat binding fixture key was reused with a different shape: " + connection.getId());
        }
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
        // Full id: a truncated prefix could collide across sessions, and with
        // same-key idempotency that would silently share one connection.
        String key = "chat-" + session.getId();
        bind(session, ensureChatConnection(connections, "USER", userId, key), templates);
    }
}
