package com.cc01cc.p.xihe.cp.repository;

import java.util.Optional;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.UUID;

import com.cc01cc.p.xihe.cp.entity.OAuthCredential;

public interface OAuthCredentialRepository extends JpaRepository<OAuthCredential, UUID> {

    Optional<OAuthCredential> findByUserIdAndWorkspaceIdAndServerId(
            String userId, String workspaceId, String serverId);
}
