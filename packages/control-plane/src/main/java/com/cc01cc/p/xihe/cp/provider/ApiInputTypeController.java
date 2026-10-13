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

    @org.springframework.beans.factory.annotation.Autowired
    private ApiRequestValidator validator;

    private final ApiInputTypeService apiTypes;

    public ApiInputTypeController(ApiInputTypeService apiTypes) {
        this.apiTypes = apiTypes;
    }

    @GetMapping
    public Map<String, Object> list() {
        return Map.of("types", apiTypes.list());
    }

    @org.springframework.web.bind.annotation.PostMapping("/{apiTypeId}/versions/{version}/validate")
    public ApiRequestValidator.Result validate(@org.springframework.web.bind.annotation.PathVariable String apiTypeId,
                                               @org.springframework.web.bind.annotation.PathVariable int version,
                                               @org.springframework.web.bind.annotation.RequestBody Map<String, String> request) {
        if (request == null || request.get("bodySource") == null) {
            throw com.cc01cc.p.xihe.cp.service.ApiRequestTemplateService.invalid("bodySource is required");
        }
        return validator.validate(apiTypeId, version, request.get("bodySource"));
    }
}
