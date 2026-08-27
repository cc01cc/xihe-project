package com.cc01cc.p.xihe.cp.config;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.networknt.schema.Error;
import com.networknt.schema.InputFormat;
import com.networknt.schema.Schema;
import com.networknt.schema.SchemaRegistry;
import com.networknt.schema.SpecificationVersion;
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

    private final Map<String, Schema> schemas = new HashMap<>();

    private final ObjectMapper objectMapper;

    public ConfigDomainSchema(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    @PostConstruct
    public void init() throws IOException {
        PathMatchingResourcePatternResolver resolver = new PathMatchingResourcePatternResolver();
        Resource[] resources = resolver.getResources("classpath:config-schemas/*.json");
        SchemaRegistry registry = SchemaRegistry.withDefaultDialect(SpecificationVersion.DRAFT_2020_12);

        for (Resource resource : resources) {
            String filename = resource.getFilename();
            if (filename == null) continue;
            String domain = filename.replace(".json", "");
            try (InputStream is = resource.getInputStream()) {
                JsonNode schemaNode = objectMapper.readTree(is);
                Schema schema = registry.getSchema(schemaNode.toString(), InputFormat.JSON);
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
        Schema schema = schemas.get(domain);
        if (schema == null) {
            return List.of("Unsupported domain: " + domain);
        }
        List<Error> errors = schema.validate(body.toString(), InputFormat.JSON);
        return errors.stream()
            .map(Error::getMessage)
            .collect(Collectors.toList());
    }

    public boolean hasSchema(String domain) {
        return schemas.containsKey(domain);
    }
}
