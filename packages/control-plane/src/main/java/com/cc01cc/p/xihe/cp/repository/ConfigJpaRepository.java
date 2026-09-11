package com.cc01cc.p.xihe.cp.repository;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.UUID;
import com.cc01cc.p.xihe.cp.entity.ConfigEntity;

import java.util.List;
import java.util.Optional;

/**
 * PLAN-0307 decision #37: scope-bound lookups replace the old
 * environment+layer queries (environment column is gone).
 */
public interface ConfigJpaRepository extends JpaRepository<ConfigEntity, UUID> {

    List<ConfigEntity> findByLayerAndDomain(String layer, String domain);

    List<ConfigEntity> findByUserIdAndDomain(UUID userId, String domain);

    List<ConfigEntity> findByWorkspaceIdAndDomain(UUID workspaceId, String domain);

    Optional<ConfigEntity> findByLayerAndDomainAndConfigKey(
        String layer, String domain, String configKey);

    Optional<ConfigEntity> findByUserIdAndDomainAndConfigKey(
        UUID userId, String domain, String configKey);

    Optional<ConfigEntity> findByWorkspaceIdAndDomainAndConfigKey(
        UUID workspaceId, String domain, String configKey);

    long countByLayer(String layer);
}
