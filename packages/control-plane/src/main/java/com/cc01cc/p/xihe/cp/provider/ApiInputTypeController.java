package com.cc01cc.p.xihe.cp.provider;

import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@RestController
@RequestMapping("/api/v1/api-input-types")
@PreAuthorize("hasAnyRole('USER', 'ADMIN')")
public class ApiInputTypeController {

    private final ApiInputTypeService apiTypes;

    public ApiInputTypeController(ApiInputTypeService apiTypes) {
        this.apiTypes = apiTypes;
    }

    @GetMapping
    public Map<String, Object> list() {
        return Map.of("types", apiTypes.list());
    }
}
