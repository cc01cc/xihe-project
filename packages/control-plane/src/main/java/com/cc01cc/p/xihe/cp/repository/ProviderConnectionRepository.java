package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.ProviderConnection;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.UUID;

import java.util.List;
import java.util.Optional;

public interface ProviderConnectionRepository extends JpaRepository<ProviderConnection, UUID> {

    @org.springframework.data.jpa.repository.Lock(jakarta.persistence.LockModeType.PESSIMISTIC_WRITE)
    @org.springframework.data.jpa.repository.Query("select c from ProviderConnection c where c.id = :id")
    Optional<ProviderConnection> findByIdForUpdate(@org.springframework.data.repository.query.Param("id") UUID id);

    List<ProviderConnection> findByOwnerTypeAndOwnerId(String ownerType, String ownerId);

    List<ProviderConnection> findByOwnerTypeAndOwnerIdAndProviderId(
            String ownerType, String ownerId, String providerId);

    Optional<ProviderConnection> findByOwnerTypeAndOwnerIdAndProviderIdAndConnectionKey(
            String ownerType, String ownerId, String providerId, String connectionKey);

    List<ProviderConnection> findByCredentialId(UUID credentialId);

    long countByCredentialId(UUID credentialId);
}
