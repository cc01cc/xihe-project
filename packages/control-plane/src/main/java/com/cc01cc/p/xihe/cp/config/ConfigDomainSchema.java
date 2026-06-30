package com.cc01cc.p.xihe.cp.config;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.networknt.schema.JsonSchema;
import com.networknt.schema.JsonSchemaFactory;
import com.networknt.schema.SpecVersion;
import com.networknt.schema.ValidationMessage;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.io.Resource;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

@Component
public class ConfigDomainSchema {

    private static final Logger log = LoggerFactory.getLogger(ConfigDomainSchema.class);

    private final Map<String, JsonSchema> schemas = new HashMap<>();

    private final ObjectMapper objectMapper;

    public ConfigDomainSchema(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    @PostConstruct
    public void init() throws IOException {
        PathMatchingResourcePatternResolver resolver = new PathMatchingResourcePatternResolver();
        Resource[] resources = resolver.getResources("classpath:config-schemas/*.json");
        JsonSchemaFactory factory = JsonSchemaFactory.getInstance(SpecVersion.VersionFlag.V202012);

        for (Resource resource : resources) {
            String filename = resource.getFilename();
            if (filename == null) continue;
            String domain = filename.replace(".json", "");
            try (InputStream is = resource.getInputStream()) {
                JsonNode schemaNode = objectMapper.readTree(is);
                JsonSchema schema = factory.getSchema(schemaNode);
                schemas.put(domain, schema);
                log.debug("Loaded JSON Schema for domain: {}", domain);
            }
        }
        log.info("Loaded {} config domain schemas", schemas.size());
    }

    public Set<String> getSupportedDomains() {
        return schemas.keySet();
    }

    public List<String> validate(String domain, JsonNode body) {
        JsonSchema schema = schemas.get(domain);
        if (schema == null) {
            return List.of("Unsupported domain: " + domain);
        }
        Set<ValidationMessage> errors = schema.validate(body);
        return errors.stream()
            .map(ValidationMessage::getMessage)
            .collect(Collectors.toList());
    }

    public boolean hasSchema(String domain) {
        return schemas.containsKey(domain);
    }
}
