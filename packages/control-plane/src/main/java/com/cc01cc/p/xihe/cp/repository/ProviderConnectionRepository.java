package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.ProviderConnection;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.UUID;

import java.util.List;
import java.util.Optional;

public interface ProviderConnectionRepository extends JpaRepository<ProviderConnection, UUID> {

    List<ProviderConnection> findByOwnerTypeAndOwnerId(String ownerType, String ownerId);

    Optional<ProviderConnection> findByOwnerTypeAndOwnerIdAndProviderId(
            String ownerType, String ownerId, String providerId);
}
