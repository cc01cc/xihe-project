package com.cc01cc.p.xihe.cp.crypto;

import com.cc01cc.p.xihe.cp.service.WorkspaceService;

/**
 * PLAN-0470 #27 negative probe: a class inside the technical-facility
 * {@code crypto} package that depends on a CP business service. Deliberately
 * unannotated so Spring never instantiates it; it exists only for the
 * {@code TECHNICAL_FACILITY_STAYS_LOWER} rule's negative bytecode probe.
 */
public final class BadCryptoFacilityProbe {

    private final WorkspaceService workspaceService;

    public BadCryptoFacilityProbe(WorkspaceService workspaceService) {
        this.workspaceService = workspaceService;
    }
}
