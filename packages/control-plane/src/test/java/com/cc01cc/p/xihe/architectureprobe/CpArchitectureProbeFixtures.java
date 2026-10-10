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
}
