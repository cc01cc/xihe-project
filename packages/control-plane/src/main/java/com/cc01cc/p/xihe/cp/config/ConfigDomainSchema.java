package com.cc01cc.p.xihe.cp.config;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
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

    /** PLAN-0556: top-level property names per domain (lockable-key derivation). */
    private final Map<String, Set<String>> properties = new HashMap<>();

    /** PLAN-0556: properties whose declared type is array/object (not lockable scalars). */
    private final Map<String, Set<String>> nonScalarProperties = new HashMap<>();

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
            if (filename == null) {
                continue;
            }
            String domain = filename.replace(".json", "");
            try (InputStream is = resource.getInputStream()) {
                JsonNode schemaNode = objectMapper.readTree(is);
                Schema schema = registry.getSchema(schemaNode.toString(), InputFormat.JSON);
                schemas.put(domain, schema);
                Set<String> names = new java.util.LinkedHashSet<>();
                Set<String> nonScalar = new java.util.LinkedHashSet<>();
                JsonNode props = schemaNode.path("properties");
                props.fieldNames().forEachRemaining(names::add);
                props.fields().forEachRemaining(property -> {
                    JsonNode type = property.getValue().path("type");
                    boolean structured = "object".equals(type.asText()) || "array".equals(type.asText())
                            || (type.isArray() && (type.toString().contains("\"object\"")
                                    || type.toString().contains("\"array\"")));
                    if (structured) {
                        nonScalar.add(property.getKey());
                    }
                });
                properties.put(domain, Set.copyOf(names));
                nonScalarProperties.put(domain, Set.copyOf(nonScalar));
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

    /** PLAN-0556: top-level property names, used to derive the lockable key set. */
    public Set<String> propertyNames(String domain) {
        return properties.getOrDefault(domain, Set.of());
    }

    /** PLAN-0556: true when the key is a scalar (string/number/boolean), not array/object. */
    public boolean isScalarProperty(String domain, String key) {
        return properties.getOrDefault(domain, Set.of()).contains(key)
                && !nonScalarProperties.getOrDefault(domain, Set.of()).contains(key);
    }
}
