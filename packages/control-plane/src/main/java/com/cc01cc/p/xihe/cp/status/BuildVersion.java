package com.cc01cc.p.xihe.cp.status;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.InputStream;
import java.util.Properties;
import java.util.regex.Pattern;

/**
 * PLAN-0534: the Control Plane's own version, derived from the single manifest
 * ({@code pom.xml}) through Maven resource filtering.
 *
 * <p>The filtered {@code pom.properties} is the only runtime source. When it is
 * missing (for example an IDE that copies resources without filtering) the
 * version is {@code null} and a WARN is logged; a raw {@code ${project.version}}
 * placeholder is never reported as a version.
 */
@Component
public class BuildVersion {

    private static final Logger logger = LoggerFactory.getLogger(BuildVersion.class);
    private static final String RESOURCE =
        "/META-INF/maven/com.cc01cc.p.xihe/control-plane/pom.properties";
    private static final Pattern SEMVER = Pattern.compile(
        "^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$");

    private final String version;

    public BuildVersion() {
        this(RESOURCE);
    }

    BuildVersion(String resource) {
        this.version = load(resource);
    }

    public String version() {
        return version;
    }

    /** MCP clientInfo requires a string; an unknown version is still honest. */
    public String versionOrUnknown() {
        return version == null ? "unknown" : version;
    }

    private String load(String resource) {
        try (InputStream input = BuildVersion.class.getResourceAsStream(resource)) {
            if (input == null) {
                logger.warn("CP version resource {} is missing; reporting null version", resource);
                return null;
            }
            Properties properties = new Properties();
            properties.load(input);
            String value = properties.getProperty("version");
            if (value == null || !SEMVER.matcher(value.trim()).matches()) {
                logger.warn("CP version resource {} has no valid semver (value={})",
                    resource, value);
                return null;
            }
            return value.trim();
        } catch (IOException e) {
            logger.warn("Failed to read CP version resource {}: {}", resource, e.getMessage());
            return null;
        }
    }
}
