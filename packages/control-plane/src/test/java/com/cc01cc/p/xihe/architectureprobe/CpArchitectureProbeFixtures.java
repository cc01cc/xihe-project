package com.cc01cc.p.xihe.architectureprobe;

import jakarta.persistence.Entity;
import jakarta.persistence.Embeddable;
import jakarta.persistence.Id;
import org.springframework.data.repository.Repository;
import org.springframework.stereotype.Service;
import org.springframework.web.bind.annotation.RestController;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;
import java.lang.annotation.ElementType;
import com.cc01cc.p.xihe.cp.entity.MessageRole;

// Outside CpApplication's component/entity scan so negative probes cannot become runtime beans.
public final class CpArchitectureProbeFixtures {

    private CpArchitectureProbeFixtures() { }

    @Entity
    public static class ProbeEntity {
        @Id
        private String id;
    }

    public interface ProbeRepository extends Repository<ProbeEntity, String> { }

    /** PLAN-0470 #27 negative probe: a repository must not depend on an application service. */
    public interface BadServiceDependentRepository extends Repository<ProbeEntity, String> {
        GoodService findService();
    }

    @Service
    public static class GoodService {
        private final ProbeRepository repository;

        public GoodService(ProbeRepository repository) { this.repository = repository; }
    }

    @RestController
    public static class GoodController {
        private final GoodService service;

        public GoodController(GoodService service) { this.service = service; }
    }

    @RestController
    public static class BadController {
        private final GoodController controller;

        public BadController(GoodController controller) { this.controller = controller; }
    }

    @Service
    public static class BadService {
        private final GoodController controller;

        public BadService(GoodController controller) { this.controller = controller; }
    }

    @RestController
    public static class BadRepositoryController {
        private final ProbeRepository repository;

        public BadRepositoryController(ProbeRepository repository) { this.repository = repository; }
    }

    @Entity
    public static class BadEntity {
        @Id
        private String id;
        private final GoodController controller;

        public BadEntity(GoodController controller) { this.controller = controller; }
    }

    @Embeddable
    public static class BadEmbeddable {
        private final GoodController controller;

        public BadEmbeddable(GoodController controller) { this.controller = controller; }
    }

    @RestController
    @Retention(RetentionPolicy.RUNTIME)
    @Target(ElementType.TYPE)
    public @interface ProbeController { }

    @ProbeController
    public static class BadMetaController {
        private final GoodController controller;

        public BadMetaController(GoodController controller) { this.controller = controller; }
    }

    @Service
    @Retention(RetentionPolicy.RUNTIME)
    @Target(ElementType.TYPE)
    public @interface ProbeService { }

    @ProbeService
    public static class BadComposedApplication {
        private final GoodController controller;

        public BadComposedApplication(GoodController controller) { this.controller = controller; }
    }

    public static class ArrayOwnershipProbe {
        private MessageRole[][] roles;
    }

    public static class CycleA {
        private CycleB other;
    }

    public static class CycleB {
        private CycleA other;
    }

    public static class ChainA {
        private ChainB next;
    }

    public static class ChainB { }

    /**
     * task-123 bad probe: two constructors, no @Autowired and no public no-arg fallback - the exact
     * FirstRunAccountService shape of task-122 (D-1535) that stopped the context in every
     * @SpringBootTest file. The gate must catch this even while src/main has no such class left.
     */
    @Service
    public static class BadAmbiguousConstructorService {
        private final ProbeRepository repository;
        private final Object clock;

        public BadAmbiguousConstructorService(ProbeRepository repository) { this(repository, new Object()); }

        BadAmbiguousConstructorService(ProbeRepository repository, Object clock) {
            this.repository = repository;
            this.clock = clock;
        }
    }

    /**
     * task-123 good probe: two constructors with exactly one @Autowired, written as a fully qualified name
     * on purpose - that is how three production classes spell it (CheckpointRevertAudit,
     * SessionSnapshotAudit, SessionParticipantService). A gate matching the literal text "@Autowired" would
     * flag this class as a violation; a gate resolving the annotation by type does not. This fixture is the
     * regression guard for that distinction, so keep the dotted spelling - do not "tidy" it into an import,
     * which would also push the package comment below line 15 (pinned by AGENTS.md).
     */
    @Service
    public static class FqnAutowiredConstructorService {
        private final ProbeRepository repository;
        private final Object clock;

        @org.springframework.beans.factory.annotation.Autowired
        public FqnAutowiredConstructorService(ProbeRepository repository) { this(repository, new Object()); }

        FqnAutowiredConstructorService(ProbeRepository repository, Object clock) {
            this.repository = repository;
            this.clock = clock;
        }
    }

    /**
     * task-123 good probe: two constructors, no @Autowired, but a public no-arg one - the fourth safe form,
     * i.e. Spring's documented "no-arg or explicit annotation" fallback
     * ({@code EnvOverlayRegistry:47}, {@code ResourceGovernor:88}, {@code SessionPolicyState:67},
     * {@code ScheduledTaskContracts:87}, {@code BuildVersion:32}, {@code RequestQueue:34} in src/main).
     * Without this fixture the exemption could be deleted and the gate would stay green on production code,
     * because every production multi-constructor bean also happens to carry @Autowired.
     */
    @Service
    public static class NoArgFallbackConstructorService {
        private final Object clock;

        public NoArgFallbackConstructorService() { this(new Object()); }

        NoArgFallbackConstructorService(Object clock) { this.clock = clock; }
    }
}
