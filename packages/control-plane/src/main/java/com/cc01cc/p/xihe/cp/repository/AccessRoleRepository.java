package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.AccessRole;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface AccessRoleRepository extends JpaRepository<AccessRole, UUID> {

    Optional<AccessRole> findByName(String name);

    List<AccessRole> findByNameIn(Collection<String> names);

    boolean existsByName(String name);
}
