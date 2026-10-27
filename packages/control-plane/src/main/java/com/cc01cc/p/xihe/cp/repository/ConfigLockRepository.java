package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.ConfigLockEntity;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

/** PLAN-0556: one lock row per (domain, config_key); global scope only. */
public interface ConfigLockRepository extends JpaRepository<ConfigLockEntity, UUID> {

    List<ConfigLockEntity> findByDomainOrderByConfigKeyAsc(String domain);

    List<ConfigLockEntity> findAllByOrderByDomainAscConfigKeyAsc();

    Optional<ConfigLockEntity> findByDomainAndConfigKey(String domain, String configKey);
}
