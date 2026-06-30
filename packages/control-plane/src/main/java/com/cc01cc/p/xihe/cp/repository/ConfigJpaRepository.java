package com.cc01cc.p.xihe.cp.repository;

import org.springframework.data.jpa.repository.JpaRepository;
import com.cc01cc.p.xihe.cp.entity.ConfigEntity;

import java.util.List;
import java.util.Optional;

public interface ConfigJpaRepository extends JpaRepository<ConfigEntity, Long> {

    List<ConfigEntity> findByEnvironmentAndLayerAndDomain(
        String environment, String layer, String domain);

    Optional<ConfigEntity> findByEnvironmentAndLayerAndDomainAndConfigKey(
        String environment, String layer, String domain, String configKey);

    void deleteByEnvironmentAndLayerAndDomainAndConfigKey(
        String environment, String layer, String domain, String configKey);

    long countByEnvironmentAndLayer(String environment, String layer);

    List<ConfigEntity> findByEnvironmentAndLayer(
        String environment, String layer);
}
