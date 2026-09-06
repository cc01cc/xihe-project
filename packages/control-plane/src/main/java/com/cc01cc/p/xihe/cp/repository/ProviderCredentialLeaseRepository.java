package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.ProviderCredentialLease;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;

import jakarta.persistence.LockModeType;
import java.util.List;
import java.util.Optional;

public interface ProviderCredentialLeaseRepository extends JpaRepository<ProviderCredentialLease, String> {

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    Optional<ProviderCredentialLease> findByLeaseHash(String leaseHash);

    List<ProviderCredentialLease> findByProviderConnectionIdAndRedeemedAtIsNullAndRevokedAtIsNull(
            String providerConnectionId);
}
