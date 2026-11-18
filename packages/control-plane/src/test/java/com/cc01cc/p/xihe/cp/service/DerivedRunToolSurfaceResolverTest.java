package com.cc01cc.p.xihe.cp.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * task-86 (decision = (a)): the three branches of the derived run's tool surface are each observable,
 * and the no-key branch is a refusal — never the entity default. Granted / not-granted / unwired map
 * one-to-one onto the audit states the card requires, so a reviewer can read the grant decision off
 * the log line instead of inferring it from a run that quietly got no tools.
 */
class DerivedRunToolSurfaceResolverTest {

    private static final UUID PRINCIPAL_ID = UUID.randomUUID();

    private final ObjectMapper mapper = new ObjectMapper();
    private AgentPrincipalRepository repository;
    private DerivedRunToolSurfaceResolver resolver;

    @BeforeEach
    void setUp() {
        repository = mock(AgentPrincipalRepository.class);
        resolver = new DerivedRunToolSurfaceResolver(repository);
    }

    private void policy(String json) {
        AgentPrincipal principal = new AgentPrincipal();
        principal.setId(PRINCIPAL_ID);
        try {
            principal.setContextPolicy(json == null ? null : mapper.readTree(json));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
        when(repository.findById(PRINCIPAL_ID)).thenReturn(Optional.of(principal));
    }

    @Test
    void grantedWorkspaceIsHandedOverVerbatim() {
        policy("{\"derivedRunToolMode\":\"workspace\"}");

        DerivedRunToolSurfaceResolver.Resolution result = resolver.resolve(PRINCIPAL_ID);

        assertThat(result.granted()).isTrue();
        assertThat(result.toolMode()).isEqualTo("workspace");
        assertThat(result.reason()).isEqualTo("granted");
    }

    @Test
    void grantedNoneIsADeliberateValueNotAMissingOne() {
        policy("{\"derivedRunToolMode\":\"none\"}");

        DerivedRunToolSurfaceResolver.Resolution result = resolver.resolve(PRINCIPAL_ID);

        assertThat(result.granted()).isTrue();
        assertThat(result.toolMode()).isEqualTo("none");
    }

    @Test
    void absentKeyRefusesWithNoKey() {
        policy("{\"other\":1}");

        DerivedRunToolSurfaceResolver.Resolution result = resolver.resolve(PRINCIPAL_ID);

        assertThat(result.granted()).isFalse();
        assertThat(result.toolMode()).isNull();
        assertThat(result.reason()).isEqualTo("no_key");
    }

    @Test
    void nullPolicyRefusesWithNoKey() {
        policy(null);

        assertThat(resolver.resolve(PRINCIPAL_ID).reason()).isEqualTo("no_key");
    }

    @Test
    void valueOutsideTheEnumerationIsAWiringFaultNotACoercion() {
        policy("{\"derivedRunToolMode\":\"full\"}");

        DerivedRunToolSurfaceResolver.Resolution result = resolver.resolve(PRINCIPAL_ID);

        assertThat(result.granted()).isFalse();
        assertThat(result.reason()).isEqualTo("invalid_value");
    }

    @Test
    void nonTextualValueIsAWiringFault() {
        policy("{\"derivedRunToolMode\":true}");

        assertThat(resolver.resolve(PRINCIPAL_ID).reason()).isEqualTo("invalid_value_type");
    }

    @Test
    void missingPrincipalRowIsAWiringFault() {
        when(repository.findById(PRINCIPAL_ID)).thenReturn(Optional.empty());

        assertThat(resolver.resolve(PRINCIPAL_ID).reason()).isEqualTo("principal_absent");
    }

    @Test
    void nullPrincipalIdIsAWiringFault() {
        assertThat(resolver.resolve(null).reason()).isEqualTo("null_principal");
    }
}
