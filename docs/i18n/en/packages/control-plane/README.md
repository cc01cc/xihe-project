---
title: "xihe-control-plane"
category: api
sidebar_group: "@xihe/control-plane"
sidebar_order: 2
lang: en
---

# xihe-control-plane

Xihe Control Plane — Spring Boot-based management service responsible for configuration management, user authentication, and Agent orchestration.

## Tech Stack

- **Java 25** + **Spring Boot 4.0.6**
- **PostgreSQL** — Data storage
- **Maven** — Build tool

## Development

```bash
./mvnw spring-boot:run    # Start dev server in the default JVM mode
./mvnw test               # Run tests
```

## Experimental Native Image (Windows x64)

The opt-in native build currently targets Windows x64 with GraalVM Community Edition 25.4.4.1.1 (JDK 25.0.4.1.1). The `native-compat` host lane now passes on an isolated stack (`journey-a` + `plan0584-native-config-schema`, 2 passed / 1 skipped / 0 failed), but the executable is still experimental and not a supported release artifact. Keep the default `dev:cp` / `spring-boot:run` path on the regular JVM.

In a PowerShell process scoped to the portable GraalVM JDK, set `JAVA_HOME` and prepend its `bin` directory to `PATH`. The AOT step starts the CP context, so use a run-specific throwaway PostgreSQL database and enable the Runtime channel for the native host compatibility lane; never use the daily development database.

The Maven `native-aot` profile activates the matching Spring `native-aot` profile. `application-native-aot.properties` disables `.env` loading and only permits the explicit run-scoped `XIHE_CP_DATASOURCE_URL` or the run-scoped PG port. The profile-only `NativeAotDataSourceConfiguration` creates a primary Hikari DataSource from the explicit URL, or the isolated bootstrap database `xihe` on that run's port; it fails if both are absent, preventing embedded H2 and daily-port fallback. It also enables `spring.aot.jpa.repositories.use-entitymanager=true` so Spring Data JPA uses the real `EntityManagerFactory`. Database passwords stay in the process environment. The native host runner activates the same Spring profile; ordinary JVM and H2 test configuration remains unchanged.

Boot `process-aot` is bound to `prepare-package`; Native Build Tools `native:compile` forks the package lifecycle. Use `prepare-package` followed by `native:compile-no-fork` in the same Maven session so the AOT datasource configuration is preserved. From `packages/control-plane`:

```powershell
$env:JAVA_HOME = '<portable GraalVM root>'
$env:PATH = "$env:JAVA_HOME\bin;$env:PATH"
$env:XIHE_CP_DATASOURCE_URL = 'jdbc:postgresql://127.0.0.1:<port>/<throwaway-database>'
$env:XIHE_CP_DATASOURCE_USERNAME = 'xihe'
$env:XIHE_CP_DATASOURCE_PASSWORD = '<ephemeral password>'
$env:XIHE_CHANNEL_ENABLED = 'true'
$env:XIHE_LOAD_DOTENV = '0'
mvn -Pnative,native-build,native-aot -DskipTests prepare-package native:compile-no-fork
```

The Windows output is `target/control-plane.exe`. Building also requires supported Visual Studio C/C++ build tools and Windows SDK components. The validated build envelope is an 8 GiB Native Image builder heap, one worker, 512 MiB Maven heap, a 2700-second deadline, and at least 20 GiB free on H:. The supervisor enforces the deadline and disk reserve.

### Selected Native Test probe

With the portable GraalVM JDK active, run the bounded component probe from `packages/control-plane`:

```powershell
mvn -PnativeTest,native-build,native-test-probe -Dtest=NativeImageCompatibilityProbeTest test
```

The `native-test-probe` profile compiles only this class and shares its test output directory with Spring Test AOT and Native Build Tools. The verified probe covers JWT access-token round-trip, `AuthResponse` access-token JSON serialization, ConfigDomainSchema discovery/validation, and PDFBox splitting/FileProxy output; four tests passed in the Windows native test image. This component probe does not replace the `native-compat` host lane, which remains under validation.

Native runtime limitation: `TomcatMetricsAutoConfiguration` is excluded from the `native-aot` profile because its platform MBean path is unsupported in the tested GraalVM native executable. JVM metrics configuration remains unchanged. The native executable is still experimental and is not a supported release artifact.

### Verified platform matrix (PLAN-0584)

| Surface | Verified status |
| --- | --- |
| OS and architecture | Windows 11 Pro x64 (10.0.26300), the selected and locally tested builder platform only. Linux and macOS are unverified. |
| GraalVM | Community Edition 25.4.4.1.1 / JDK 25.0.4.1.1, portable process-scoped install. |
| Native compiler prerequisites | Visual Studio 18 Community, MSVC 14.51.36231, Windows SDK 10.0.26100.0; `cl.exe`, `link.exe`, Windows headers and UCRT libraries were present and a full CP executable was generated on an earlier code revision. |
| Native test probe | The selected four-test Native Image probe passed: JWT round-trip, AuthResponse JSON, ConfigDomainSchema and PDFBox. |
| Full CP host lane | **Accepted 2026-10-31**: `--jar-mode=native --batch=native-compat` on an isolated stack passed 2 / skipped 1 / failed 0 (`journey-a` + `plan0584-native-config-schema`). It covers provider connections, CP→Agent chat, `write_file` approval, SSE terminal events, message read-back, checkpoint capture, Runtime MCP and the channel handshake (`channel_connected` + `heartbeat: suppressed`); the teardown reverse check found 0 containers/volumes/networks/Sandboxes. |
| Native metadata provenance | Record hints in `NativeAotRuntimeHints` come from a GraalVM tracing-agent capture on the JVM host lane (`evidence/agent-metadata-r5`) and register only `INVOKE_PUBLIC_METHODS` + `INVOKE_PUBLIC_CONSTRUCTORS`, with no package-wide reflection; the request-side records are defensive and may be trimmed once a host run proves them redundant. |
| Native-only limitation | Tomcat platform-MBean metrics are disabled in `native-aot`; ordinary JVM behavior is unchanged. `/ready` requires authentication (anonymous access returns 401); Linux and macOS remain unverified. |
| Build envelope | 8 GiB builder heap, one worker, 512 MiB Maven heap, 2700-second deadline, H: free-space reserve >=20 GiB; the supervisor enforces the disk reserve. |

This matrix describes measured local compatibility, not a release-support commitment.
