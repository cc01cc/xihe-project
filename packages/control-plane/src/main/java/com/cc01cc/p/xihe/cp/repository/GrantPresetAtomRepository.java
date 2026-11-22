package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.GrantPresetAtom;
import com.cc01cc.p.xihe.cp.entity.GrantPresetAtomId;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Collection;
import java.util.List;
import java.util.UUID;

public interface GrantPresetAtomRepository extends JpaRepository<GrantPresetAtom, GrantPresetAtomId> {

    List<GrantPresetAtom> findByIdRoleId(UUID roleId);

    List<GrantPresetAtom> findByIdRoleIdIn(Collection<UUID> roleIds);

    void deleteByIdRoleId(UUID roleId);
}
