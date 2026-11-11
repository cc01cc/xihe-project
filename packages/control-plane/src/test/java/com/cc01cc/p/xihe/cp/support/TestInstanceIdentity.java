package com.cc01cc.p.xihe.cp.support;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.when;

import com.cc01cc.p.xihe.cp.service.InstanceIdentityFormat;
import com.cc01cc.p.xihe.cp.service.InstanceIdentityService;
import java.util.UUID;

/**
 * PLAN-0767 M1-3: the single fixture identity for tests that used to compare against the removed
 * {@code ProviderConnection.INSTANCE_OWNER_ID} sentinel. The id is a fixed UUID so instance-scope
 * fixtures keep a stable owner; the mock reproduces the real dash-insensitive comparison.
 */
public final class TestInstanceIdentity {

    public static final String OWNER_ID = "9f1c1d3e-2b7a-4c55-9d2e-3f4a5b6c7d80";
    public static final UUID INSTANCE_ID = UUID.fromString(OWNER_ID);

    private TestInstanceIdentity() {
    }

    /** A service stub that behaves like a seeded identity with {@link #INSTANCE_ID}. */
    public static InstanceIdentityService mock() {
        InstanceIdentityService identity = org.mockito.Mockito.mock(InstanceIdentityService.class);
        when(identity.instanceId()).thenReturn(INSTANCE_ID);
        when(identity.ownerId()).thenReturn(OWNER_ID);
        when(identity.isInstanceOwnerId(any())).thenAnswer(invocation ->
                InstanceIdentityFormat.equalsIdentity(invocation.getArgument(0), OWNER_ID));
        return identity;
    }
}
