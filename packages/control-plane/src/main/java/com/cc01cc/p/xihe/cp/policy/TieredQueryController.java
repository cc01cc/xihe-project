package com.cc01cc.p.xihe.cp.policy;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Tiered query internal API (PLAN-0407 T3.1, spec §5). Service Bearer only
 * ({@code /internal/v1/**} → role INTERNAL_SERVICE); errors surface through the global
 * RFC 9457 handler as problem+json.
 */
@RestController
@RequestMapping("/internal/v1/queries")
public class TieredQueryController {

    private final TieredQueryService tieredQueryService;

    public TieredQueryController(TieredQueryService tieredQueryService) {
        this.tieredQueryService = tieredQueryService;
    }

    /** Tier-1: downward provenance status metadata, no grant, no content fields. */
    @GetMapping("/tier1/status")
    public TieredQueryService.Tier1Status tier1Status(
            @RequestParam String requesterSessionId,
            @RequestParam String targetSessionId) {
        return tieredQueryService.tier1Status(requesterSessionId, targetSessionId);
    }

    /** Tier-2: content access decision through the single grant kernel. */
    @GetMapping("/tier2/access")
    public TieredQueryService.Tier2Access tier2Access(
            @RequestParam String requesterSessionId,
            @RequestParam String targetSessionId) {
        return tieredQueryService.tier2Access(requesterSessionId, targetSessionId);
    }
}
