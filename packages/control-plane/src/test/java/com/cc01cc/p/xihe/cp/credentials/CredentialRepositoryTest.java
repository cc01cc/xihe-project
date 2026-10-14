package com.cc01cc.p.xihe.cp.credentials;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.Credential;
import com.cc01cc.p.xihe.cp.entity.CredentialEvent;
import com.cc01cc.p.xihe.cp.repository.CredentialEventRepository;
import com.cc01cc.p.xihe.cp.repository.CredentialRepository;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0495 T1.1：credentials / credential_events repository 基础行为——
 * UUID 转换、rev/状态默认、软删过滤、owner 列表、revision 单调、事件时间序。
 */
class CredentialRepositoryTest extends AbstractIntegrationTest {

    @Autowired
    private CredentialRepository credentialRepository;

    @Autowired
    private CredentialEventRepository credentialEventRepository;

    @Test
    void roundTripPreservesFieldsAndAppliesDefaults() {
        Credential saved = save(owner(), "repo-token");

        Credential loaded = credentialRepository.findByIdAndDeletedAtIsNull(saved.getId()).orElseThrow();
        assertEquals(saved.getId(), loaded.getId());
        assertEquals(Credential.OWNER_USER, loaded.getOwnerType());
        assertEquals(saved.getOwnerId(), loaded.getOwnerId());
        assertEquals("repo-token", loaded.getLabel());
        assertEquals(Credential.KIND_TOKEN, loaded.getKind());
        assertEquals(Credential.TIER_LEASE, loaded.getDeliveryTier());
        assertEquals(Credential.STATUS_ACTIVE, loaded.getStatus());
        assertEquals(1, loaded.getRevision());
        assertEquals("v1:nonce:cipher", loaded.getSecretCiphertext());
        assertEquals("fp-repo-token", loaded.getFingerprint());
        assertEquals("v1", loaded.getKeyVersion());
        assertNotNull(loaded.getCreatedAt());
        assertNotNull(loaded.getUpdatedAt());
        assertNull(loaded.getDeletedAt());
    }

    @Test
    void ownerListingExcludesSoftDeletedAndOtherOwners() {
        String ownerA = owner();
        String ownerB = owner();
        save(ownerA, "a-active");
        Credential deleted = save(ownerA, "a-deleted");
        deleted.setDeletedAt(Instant.now());
        credentialRepository.save(deleted);
        save(ownerB, "b-active");

        List<Credential> rows = credentialRepository
                .findByOwnerTypeAndOwnerIdAndDeletedAtIsNullOrderByCreatedAtDesc(
                        Credential.OWNER_USER, ownerA);

        assertEquals(1, rows.size());
        assertEquals("a-active", rows.get(0).getLabel());
    }

    @Test
    void softDeletedRowIsHiddenByActiveLookup() {
        Credential credential = save(owner(), "hidden-after-delete");
        credential.setDeletedAt(Instant.now());
        credentialRepository.save(credential);

        assertTrue(credentialRepository.findByIdAndDeletedAtIsNull(credential.getId()).isEmpty());
        assertTrue(credentialRepository.findById(credential.getId()).isPresent());
    }

    @Test
    void replaceBumpsRevisionAndKeepsId() {
        Credential credential = save(owner(), "rotating");
        credential.setRevision(2);
        credential.setSecretCiphertext("v1:nonce2:cipher2");
        credential.setReplacedAt(Instant.now());
        credentialRepository.save(credential);

        Credential reloaded = credentialRepository.findById(credential.getId()).orElseThrow();
        assertEquals(credential.getId(), reloaded.getId());
        assertEquals(2, reloaded.getRevision());
        assertEquals("v1:nonce2:cipher2", reloaded.getSecretCiphertext());
        assertNotNull(reloaded.getReplacedAt());
    }

    @Test
    void eventsRoundTripOrderedByCreatedAtDesc() {
        Credential credential = save(owner(), "with-events");

        CredentialEvent created = event(credential, CredentialEvent.TYPE_CREATED, "u-actor");
        created.setCreatedAt(Instant.now().minusSeconds(60));
        credentialEventRepository.save(created);
        CredentialEvent replaced = event(credential, CredentialEvent.TYPE_REPLACED, "u-actor");
        credentialEventRepository.save(replaced);

        List<CredentialEvent> events =
                credentialEventRepository.findByCredentialIdOrderByCreatedAtDesc(credential.getId().toString());

        assertEquals(List.of(CredentialEvent.TYPE_REPLACED, CredentialEvent.TYPE_CREATED),
                events.stream().map(CredentialEvent::getEventType).toList());
        assertEquals(credential.getOwnerId(), events.get(0).getOwnerId());
    }

    private static String owner() {
        return UUID.randomUUID().toString();
    }

    private Credential save(String ownerId, String label) {
        Credential credential = new Credential();
        credential.setId(UUID.randomUUID());
        credential.setOwnerType(Credential.OWNER_USER);
        credential.setOwnerId(ownerId);
        credential.setLabel(label);
        credential.setKind(Credential.KIND_TOKEN);
        credential.setDeliveryTier(Credential.TIER_LEASE);
        credential.setSecretCiphertext("v1:nonce:cipher");
        credential.setFingerprint("fp-" + label);
        credential.setKeyVersion("v1");
        return credentialRepository.save(credential);
    }

    private static CredentialEvent event(Credential credential, String type, String actor) {
        CredentialEvent event = new CredentialEvent();
        event.setId(UUID.randomUUID());
        event.setCredentialId(credential.getId().toString());
        event.setEventType(type);
        event.setActor(actor);
        event.setOwnerType(credential.getOwnerType());
        event.setOwnerId(credential.getOwnerId());
        return event;
    }
}
