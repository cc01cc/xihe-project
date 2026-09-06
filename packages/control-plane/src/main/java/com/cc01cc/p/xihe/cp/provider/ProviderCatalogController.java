package com.cc01cc.p.xihe.cp.provider;

import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@RestController
@RequestMapping("/api/v1/provider-catalog")
@PreAuthorize("hasAnyRole('USER', 'ADMIN')")
public class ProviderCatalogController {

    private final ProviderCatalogService catalog;

    public ProviderCatalogController(ProviderCatalogService catalog) {
        this.catalog = catalog;
    }

    @GetMapping
    public ResponseEntity<?> list() {
        return ResponseEntity.ok(Map.of(
                "catalogRevision", "v1",
                "providers", catalog.list()));
    }
}
