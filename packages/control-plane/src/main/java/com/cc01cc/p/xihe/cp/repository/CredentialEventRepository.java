package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.CredentialEvent;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.UUID;

public interface CredentialEventRepository extends JpaRepository<CredentialEvent, UUID> {

    List<CredentialEvent> findByCredentialIdOrderByCreatedAtDesc(String credentialId);

    /** Bounded variant for the read face (PLAN-0497 T3.2 wave review). */
    List<CredentialEvent> findByCredentialIdOrderByCreatedAtDesc(String credentialId, Pageable pageable);
}
