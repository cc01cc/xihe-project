package com.cc01cc.p.xihe.cp.config;

import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.UserResponse;
import com.cc01cc.p.xihe.cp.files.dto.AttachmentInfo;
import com.cc01cc.p.xihe.cp.files.dto.BatchUploadResult;
import com.cc01cc.p.xihe.cp.files.dto.UploadFailure;
import org.apache.coyote.AbstractProtocol;
import org.apache.coyote.http11.AbstractHttp11Protocol;
import org.flywaydb.core.internal.exception.sqlExceptions.FlywaySqlNoDriversForInteractiveAuthException;
import org.flywaydb.core.internal.exception.sqlExceptions.FlywaySqlNoIntegratedAuthException;
import org.flywaydb.core.internal.exception.sqlExceptions.FlywaySqlServerUntrustedCertificateSqlException;
import org.springframework.aot.hint.ExecutableMode;
import org.springframework.aot.hint.MemberCategory;
import org.springframework.aot.hint.RuntimeHints;
import org.springframework.aot.hint.RuntimeHintsRegistrar;
import org.springframework.aot.hint.TypeReference;
import org.springframework.core.io.ClassPathResource;
import org.springframework.lang.NonNull;

import java.sql.SQLException;

/**
 * Native Image runtime hints discovered by real host runs (PLAN-0584 T2.1).
 * Tomcat uses `IntrospectionUtils` to dynamically inspect and invoke protocol
 * accessors during web-server bind, Connector configuration, and context startup.
 * Register public methods only on the two protocol abstraction classes involved;
 * host runs identified `getProperty`, `setProperty`, `getName`, `getAddress`, and
 * `isSSLEnabled` across this path (no package-wide reflection is enabled).
 *
 * <p>Resource hints: host run {@code host-1793341726726-81d3} proved that
 * {@code ApiInputTypeService} cannot open {@code api-input-types/api-input-types.json}
 * inside the native image. {@code ProviderCatalogService} loads
 * {@code provider-catalog/providers.json} the same way in the same bean chain, and
 * {@code BuildVersion} reads the Maven {@code pom.properties}; the config-domain
 * JSON Schemas are scanned at startup via {@code classpath:config-schemas/*.json}.
 * Each exact resource (or one bounded directory pattern) is registered below.
 */
public class NativeAotRuntimeHints implements RuntimeHintsRegistrar {

    private static final String[] EXACT_RESOURCES = {
        "api-input-types/api-input-types.json",
        "provider-catalog/providers.json",
        "META-INF/maven/com.cc01cc.p.xihe/control-plane/pom.properties",
    };

    private static final String CONFIG_SCHEMA_PATTERN = "config-schemas/*.json";

    /**
     * Plain-class JSON response bodies the UI consumes (chat attachment upload/list and the
     * {@code attachments} array embedded in message views). Native Image strips getters that
     * only Jackson discovers reflectively — proven twice in this PLAN (`AuthResponse`,
     * `UserResponse` → {@code /auth/me} returned {@code {}}). The list comes from a read-only
     * controller-reachability scan that self-checks against those two proven gaps; only these
     * exact types are registered (no package-wide reflection).
     */
    private static final Class<?>[] JSON_RESPONSE_POJOS = {
        AttachmentInfo.class,
        BatchUploadResult.class,
        UploadFailure.class,
    };

    /**
     * Records the JVM host lane actually reflected on. Evidence: GraalVM tracing agent
     * metadata {@code plans/PLAN-0584-xh-cp-graalvm-native-image/evidence/agent-metadata-r5/reachability-metadata.json}
     * (host run {@code host-1793377720565-5422}), filtered by
     * {@code evidence/agent-metadata-r5/plan0584-analyze-agent-config-v2.mjs} — the rule is
     * "project-owned record reflected by the lane", so every entry below has a per-type agent
     * observation. Native Image refuses {@code Class.getRecordComponents()} unless every record
     * component accessor is registered, which surfaced as {@code UnsupportedFeatureError} for
     * {@code ProviderConnectionService$ProviderConnectionView}. Only these two member
     * categories are registered (accessors + canonical constructor); no package-wide and no
     * all-declared reflection. The request-side group is defensive: Spring AOT normally covers
     * {@code @RequestBody} records, so those entries may be trimmed once a host run proves them
     * redundant.
     */
    // BEGIN agent-captured records (2026-10-31 r5)
    private static final String[] JSON_RECORD_TYPES = {
        // response side (Jackson serialization)
        "com.cc01cc.p.xihe.cp.provider.ProviderConnectionService$ProviderConnectionView",
        "com.cc01cc.p.xihe.cp.provider.ProviderCredentialLeaseService$CredentialGrant",
        "com.cc01cc.p.xihe.cp.event.WorkspaceEvent",
        "com.cc01cc.p.xihe.cp.chat.RunTraceReadService$TraceResponse",
        "com.cc01cc.p.xihe.cp.chat.RunTraceReadService$TraceEvent",
        "com.cc01cc.p.xihe.cp.chat.RunTraceReadService$TraceProvenance",
        "com.cc01cc.p.xihe.cp.chat.RunTraceReadService$TraceSource",
        "com.cc01cc.p.xihe.cp.chat.RunTraceReadService$Usage",
        "com.cc01cc.p.xihe.cp.chat.FollowUpQueueSnapshot",
        "com.cc01cc.p.xihe.cp.chat.FollowUpItemView",
        "com.cc01cc.p.xihe.cp.checkpoint.AgentGraphCheckpointService$LineageView",
        "com.cc01cc.p.xihe.cp.service.RunCheckpointService$View",
        "com.cc01cc.p.xihe.cp.service.RunCheckpointService$RevertView",
        "com.cc01cc.p.xihe.cp.service.SessionBranchActionService$BranchList",
        "com.cc01cc.p.xihe.cp.service.SessionBranchActionService$BranchView",
        "com.cc01cc.p.xihe.cp.service.SessionDerivedStateService$Response",
        "com.cc01cc.p.xihe.cp.service.SessionDerivedStateService$ActiveChild",
        "com.cc01cc.p.xihe.cp.service.SessionDerivedStateService$TerminalNotice",
        "com.cc01cc.p.xihe.cp.controller.RuntimeExecutionSpecController$WorkspaceExecutionSpecResponse",
        "com.cc01cc.p.xihe.cp.runtime.RuntimeCheckpointClient$ChangedFile",
        // request side (Jackson deserialization; canonical constructor)
        "com.cc01cc.p.xihe.cp.chat.SessionController$CreateSessionRequest",
        "com.cc01cc.p.xihe.cp.chat.SessionController$UpdateSessionRequest",
        "com.cc01cc.p.xihe.cp.checkpoint.AgentGraphCheckpointService$LineageRequest",
        "com.cc01cc.p.xihe.cp.checkpoint.AgentGraphCheckpointService$PutCheckpointRequest",
        "com.cc01cc.p.xihe.cp.checkpoint.AgentGraphCheckpointService$PutWritesRequest",
        "com.cc01cc.p.xihe.cp.checkpoint.AgentGraphCheckpointService$WriteValue",
        "com.cc01cc.p.xihe.cp.controller.RuntimeHeartbeatState$RuntimeHeartbeatRequest",
        "com.cc01cc.p.xihe.cp.controller.RuntimeWorkspaceEventController$PublishWorkspaceEventRequest",
        "com.cc01cc.p.xihe.cp.provider.ProviderConnectionController$ConnectionRequest",
        "com.cc01cc.p.xihe.cp.provider.ProviderCredentialLeaseController$RedeemRequest",
    };
    // END agent-captured records (2026-10-31 r5)


    /**
     * jjwt 0.13 loads these classes by name through {@code Classes.newInstance}
     * ({@code Class.forName} + {@code Class.newInstance}). The four builder suppliers
     * are named from {@code Jwts.<clinit>} (host run host-1793347811924-a2c6).
     * {@code StandardSecureDigestAlgorithms} is named by {@code Jwts$SIG.<clinit>},
     * and {@code DefaultKeyOperationBuilder$Supplier} is named by
     * {@code Jwks$OP.<clinit>} (host run host-1793354022297-e71b, first cause at
     * {@code DefaultProtectedHeader.<clinit>} → {@code AbstractJwk.<clinit>} →
     * {@code KeyOperationConverter.<clinit>} → {@code Jwks$OP.<clinit>}). The same
     * initializer also names {@code StandardKeyOperations} and
     * {@code DefaultKeyOperationPolicyBuilder$Supplier}. All names and public no-arg
     * constructors were verified against jjwt 0.13.0 jars.
     */
    private static final String[] JWT_STRING_LOADED_TYPES = {
        "io.jsonwebtoken.impl.DefaultJwtBuilder$Supplier",
        "io.jsonwebtoken.impl.DefaultJwtParserBuilder$Supplier",
        "io.jsonwebtoken.impl.DefaultJwtHeaderBuilder$Supplier",
        "io.jsonwebtoken.impl.DefaultClaimsBuilder$Supplier",
        "io.jsonwebtoken.impl.security.StandardSecureDigestAlgorithms",
        "io.jsonwebtoken.impl.security.StandardKeyOperations",
        "io.jsonwebtoken.impl.security.DefaultKeyOperationBuilder$Supplier",
        "io.jsonwebtoken.impl.security.DefaultKeyOperationPolicyBuilder$Supplier",
    };

    /** Provider classes named by jjwt's own {@code META-INF/services} entries (read from the jars). */
    private static final String[] JWT_SERVICE_PROVIDERS = {
        "io.jsonwebtoken.jackson.io.JacksonSerializer",
        "io.jsonwebtoken.jackson.io.JacksonDeserializer",
        "io.jsonwebtoken.impl.compression.DeflateCompressionAlgorithm",
        "io.jsonwebtoken.impl.compression.GzipCompressionAlgorithm",
    };

    /** Exact jjwt service descriptor files, in case the providers are resolved by direct resource reads. */
    private static final String[] JWT_SERVICE_FILES = {
        "META-INF/services/io.jsonwebtoken.io.Serializer",
        "META-INF/services/io.jsonwebtoken.io.Deserializer",
        "META-INF/services/io.jsonwebtoken.CompressionCodec",
    };

    @Override
    public void registerHints(@NonNull RuntimeHints hints, ClassLoader classLoader) {
        hints.reflection().registerType(AbstractProtocol.class, MemberCategory.INVOKE_PUBLIC_METHODS);
        hints.reflection().registerType(AbstractHttp11Protocol.class, MemberCategory.INVOKE_PUBLIC_METHODS);
        // AuthResponse is returned by /api/v1/auth/login; the native probe proved a
        // direct Jackson mapper otherwise sees no bean properties in the image.
        hints.reflection().registerType(AuthResponse.class, MemberCategory.INVOKE_PUBLIC_METHODS);
        // UserResponse is the `/api/v1/auth/me` body and the `user` field of the
        // register/login AuthResponse. Isolated native probe (run 55e1dd17/fd6b0452,
        // PLAN-0584 T2.1) returned HTTP 200 with `{}` for /auth/me and `"user":{}`
        // for register — the POJO's getters are reflectively discovered only, so
        // they were stripped. Same bounded pattern as AuthResponse above.
        hints.reflection().registerType(UserResponse.class, MemberCategory.INVOKE_PUBLIC_METHODS);
        // Chat attachment JSON bodies (see JSON_RESPONSE_POJOS): getters for serialization,
        // setters for the attachments JSON round-trip in SessionForkService/FollowUpQueueService.
        for (Class<?> type : JSON_RESPONSE_POJOS) {
            hints.reflection().registerType(type, MemberCategory.INVOKE_PUBLIC_METHODS);
        }
        // Records: accessors are required for Class.getRecordComponents(), the canonical
        // constructor for the deserialization side (see JSON_RECORD_TYPES).
        for (String name : JSON_RECORD_TYPES) {
            hints.reflection()
                    .registerType(
                            TypeReference.of(name),
                            MemberCategory.INVOKE_PUBLIC_METHODS,
                            MemberCategory.INVOKE_PUBLIC_CONSTRUCTORS);
        }
        for (String path : EXACT_RESOURCES) {
            hints.resources().registerResource(new ClassPathResource(path));
        }
        hints.resources().registerPattern(CONFIG_SCHEMA_PATTERN);
        // FlywaySqlException.throwFlywayExceptionIfPossible reflectively resolves
        // "isFlywaySpecificVersionOf(SQLException)" on these three classes when
        // classifying any connection SQLException; host run host-1793343151893-c646
        // proved the stripped methods surface as NoSuchMethodException, masking the
        // original database error.
        hints.reflection()
                .registerMethod(
                        methodOf(FlywaySqlServerUntrustedCertificateSqlException.class), ExecutableMode.INVOKE)
                .registerMethod(methodOf(FlywaySqlNoIntegratedAuthException.class), ExecutableMode.INVOKE)
                .registerMethod(methodOf(FlywaySqlNoDriversForInteractiveAuthException.class), ExecutableMode.INVOKE);
        // jjwt classes named in Classes.newInstance calls (public no-arg construction).
        for (String name : JWT_STRING_LOADED_TYPES) {
            hints.reflection().registerType(TypeReference.of(name), MemberCategory.INVOKE_PUBLIC_CONSTRUCTORS);
        }
        for (String name : JWT_SERVICE_PROVIDERS) {
            hints.reflection().registerType(TypeReference.of(name), MemberCategory.INVOKE_PUBLIC_CONSTRUCTORS);
        }
        for (String path : JWT_SERVICE_FILES) {
            hints.resources().registerResource(new ClassPathResource(path));
        }
    }

    private static java.lang.reflect.Method methodOf(Class<?> owner) {
        try {
            return owner.getMethod("isFlywaySpecificVersionOf", SQLException.class);
        } catch (NoSuchMethodException exception) {
            throw new IllegalStateException(
                    "Required Flyway reflection target is missing: " + owner.getName() + ".isFlywaySpecificVersionOf",
                    exception);
        }
    }
}
