package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.SessionParticipantRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * task-188 MVP⑤ S2: makes {@link DelegationChainWalker} an injectable bean.
 *
 * <p>The walker is a dependency-free final helper whose three collaborators are repositories; the
 * existing call sites build it inline ({@code new DelegationChainWalker(sessionRepo, runRepo,
 * participantRepo)}) because they are plain {@code @Service}s that already had the repositories.
 * {@link TeamTaskService} needs the SAME walker and no longer has a natural inline site, so one
 * bean of it is declared here — the walker itself stays stateless and unchanged, and the inline
 * constructions keep working (they simply build another equivalent instance).</p>
 */
@Configuration
public class DelegationChainConfig {

    @Bean
    public DelegationChainWalker delegationChainWalker(SessionRepository sessionRepository,
                                                       ChatRunRepository chatRunRepository,
                                                       SessionParticipantRepository participantRepository) {
        return new DelegationChainWalker(sessionRepository, chatRunRepository, participantRepository);
    }
}
