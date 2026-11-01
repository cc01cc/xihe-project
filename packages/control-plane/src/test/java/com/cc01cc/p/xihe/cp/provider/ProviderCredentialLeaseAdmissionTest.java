package com.cc01cc.p.xihe.cp.provider;

import com.cc01cc.p.xihe.cp.config.ResourceExhaustedException;
import com.cc01cc.p.xihe.cp.entity.ProviderConnection;
import com.cc01cc.p.xihe.cp.entity.ProviderConnectionModelLimit;
import com.cc01cc.p.xihe.cp.policy.ResourceGovernor;
import com.cc01cc.p.xihe.cp.policy.ResourceKey;
import com.cc01cc.p.xihe.cp.repository.ProviderConnectionModelLimitRepository;
import com.cc01cc.p.xihe.cp.repository.ProviderConnectionRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;

import java.time.Duration;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.when;

/**
 * PLAN-0622 D28: the admission borrow is a <b>pair</b> (connection slot + model slot).
 *
 * <p>The model slot is acquired second, so a refusal there must also give back the connection slot
 * it was paired with — otherwise every model-level refusal permanently leaks one connection slot,
 * and the connection eventually refuses perfectly admissible work. That leak is the single easiest
 * mistake in this change, so it gets its own test with an unlimited connection ceiling and a
 * one-slot model ceiling.</p>
 */
class ProviderCredentialLeaseAdmissionTest {

    private static final UUID CONNECTION_ID = UUID.fromString("11111111-1111-4111-8111-111111111111");
    private static final String PROVIDER = "openai";
    private static final String MODEL = "gpt-4o";

    private final ProviderConnectionRepository connections = Mockito.mock(ProviderConnectionRepository.class);
    private final ProviderConnectionModelLimitRepository modelLimits =
            Mockito.mock(ProviderConnectionModelLimitRepository.class);
    private final ResourceGovernor governor = new ResourceGovernor();

    private ProviderCredentialLeaseService service() {
        return new ProviderCredentialLeaseService(
                Mockito.mock(com.cc01cc.p.xihe.cp.repository.ProviderCredentialLeaseRepository.class),
                connections,
                Mockito.mock(ProviderConnectionService.class),
                Mockito.mock(ProviderCatalogService.class),
                Mockito.mock(ApiInputTypeService.class),
                new ObjectMapper(),
                Mockito.mock(ProviderCredentialAccess.class),
                modelLimits,
                governor);
    }

    private ProviderConnection connection(Integer maxInflight) {
        ProviderConnection connection = new ProviderConnection();
        connection.setId(CONNECTION_ID);
        connection.setProviderId(PROVIDER);
        connection.setMaxInflight(maxInflight);
        when(connections.findById(CONNECTION_ID)).thenReturn(Optional.of(connection));
        return connection;
    }

    @Test
    void aModelRefusalGivesBackTheConnectionSlotItWasPairedWith() {
        connection(null);   // connection ceiling unlimited
        ProviderConnectionModelLimit onlyOneModel = new ProviderConnectionModelLimit();
        onlyOneModel.setProvider(PROVIDER);
        onlyOneModel.setModel(MODEL);
        onlyOneModel.setMaxInflight(1);
        when(modelLimits.findByConnectionId(CONNECTION_ID)).thenReturn(List.of(onlyOneModel));

        ProviderCredentialLeaseService service = service();
        ProviderCredentialLeaseService.Admission first =
                service.admit(CONNECTION_ID.toString(), PROVIDER, MODEL, Duration.ofMinutes(10));
        assertEquals(2, first.leases().size(), "connection slot + model slot");

        assertThrows(ResourceExhaustedException.class,
                () -> service.admit(CONNECTION_ID.toString(), PROVIDER, MODEL, Duration.ofMinutes(10)));

        // The refused attempt must leave exactly the first admission's borrows behind.
        assertEquals(1, governor.inflight(ResourceKey.connection(CONNECTION_ID.toString())),
                "the connection slot of the refused pair must be released (leak guard)");
        assertEquals(1, governor.inflight(ResourceKey.model(CONNECTION_ID.toString(), PROVIDER, MODEL)));

        governor.releaseRun("run-first");
        governor.bindToRun("run-first", first.leases());
        governor.releaseRun("run-first");
        assertEquals(0, governor.inflight(ResourceKey.connection(CONNECTION_ID.toString())));
        assertEquals(0, governor.inflight(ResourceKey.model(CONNECTION_ID.toString(), PROVIDER, MODEL)));
    }

    @Test
    void anUnboundOrForeignConnectionAdmitsNothingAndKeepsTheAsyncPathUnchanged() {
        ProviderCredentialLeaseService service = service();
        assertTrue(service.admit(null, PROVIDER, MODEL, null).isEmpty(), "unbound session borrows nothing");
        assertTrue(service.admit("not-a-uuid", PROVIDER, MODEL, null).isEmpty());

        connection(null);
        assertTrue(service.admit(CONNECTION_ID.toString(), "other-provider", MODEL, null).isEmpty(),
                "a provider mismatch keeps today's asynchronous behaviour");
        assertTrue(service.admit(CONNECTION_ID.toString(), PROVIDER, null, null).isEmpty());
        assertEquals(0, governor.inflight(ResourceKey.connection(CONNECTION_ID.toString())));
    }
}
