package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.ProviderConnectionModelLimit;
import com.cc01cc.p.xihe.cp.entity.ProviderConnectionModelLimitId;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.UUID;

/** PLAN-0622 M1.5: read-only access to the per-model limit overrides. */
public interface ProviderConnectionModelLimitRepository
        extends JpaRepository<ProviderConnectionModelLimit, ProviderConnectionModelLimitId> {

    List<ProviderConnectionModelLimit> findByConnectionId(UUID connectionId);
}
