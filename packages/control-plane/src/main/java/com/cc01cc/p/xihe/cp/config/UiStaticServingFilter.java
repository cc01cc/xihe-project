package com.cc01cc.p.xihe.cp.config;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.web.util.UriUtils;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.InvalidPathException;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * PLAN-0632 D32-06 / M2-3: serve the built UI from the CP so "double click the installed app"
 * reaches the SPA on the same origin the API lives on.
 *
 * <p><b>Default off.</b> The whole filter is a pass-through unless {@code cp.ui.static-root}
 * (env {@code XIHE_UI_STATIC_ROOT}) names a directory. The dev/host lanes and every existing
 * test keep using the Vite dev server proxy, so nothing about them changes.</p>
 *
 * <p><b>Never swallows the API.</b> Requests under the machine-facing prefixes (see
 * {@link #API_PREFIXES}) return to the original chain untouched — a 404 stays a 404, an
 * authenticated route stays authenticated. Only paths that no controller owns can reach the SPA
 * fallback, and even then only when the last segment carries no file extension: a missing
 * {@code /assets/app.js} is a 404, not an {@code index.html} served as JavaScript.</p>
 *
 * <p><b>Why a filter instead of a resource handler or a catch-all controller.</b> The SPA shell
 * has to be readable <i>before</i> login (the UI renders the login form), while
 * {@code SecurityConfig} ends with {@code anyRequest().authenticated()}. A catch-all
 * {@code @RequestMapping} would also outrank actuator's own handler mapping; a resource handler
 * would still be subject to the security chain. Sitting in front of the chain keeps those two
 * contracts unchanged and confines the change to the "static root is configured" case.</p>
 *
 * <p><b>Traversal.</b> The request path is percent-decoded once, backslashes and NUL are rejected
 * outright, every {@code ..} segment fails, and the final path must still be inside the canonical
 * static root (symlinks resolved) — a request can never read outside the install directory.</p>
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 100)
public class UiStaticServingFilter extends OncePerRequestFilter {

    private static final Logger log = LoggerFactory.getLogger(UiStaticServingFilter.class);

    /**
     * Paths owned by the API, actuator, springdoc or the error dispatch. These are handed back to
     * the original chain verbatim. `/swagger-ui.html` and `/v3/api-docs.yaml` are listed separately
     * because the segment boundary check below would otherwise not match the suffixed form
     * (task-194: same reason SecurityConfig needs the explicit `.yaml` permit).
     */
    private static final List<String> API_PREFIXES = List.of(
            "/api", "/internal", "/actuator", "/v3/api-docs", "/v3/api-docs.yaml", "/swagger-ui.html", "/swagger-ui", "/error");

    private static final Map<String, String> CONTENT_TYPES = Map.ofEntries(
            Map.entry("html", "text/html; charset=utf-8"),
            Map.entry("js", "text/javascript; charset=utf-8"),
            Map.entry("mjs", "text/javascript; charset=utf-8"),
            Map.entry("css", "text/css; charset=utf-8"),
            Map.entry("json", "application/json"),
            Map.entry("map", "application/json"),
            Map.entry("svg", "image/svg+xml"),
            Map.entry("png", "image/png"),
            Map.entry("jpg", "image/jpeg"),
            Map.entry("jpeg", "image/jpeg"),
            Map.entry("gif", "image/gif"),
            Map.entry("webp", "image/webp"),
            Map.entry("ico", "image/x-icon"),
            Map.entry("woff", "font/woff"),
            Map.entry("woff2", "font/woff2"),
            Map.entry("ttf", "font/ttf"),
            Map.entry("wasm", "application/wasm"),
            Map.entry("txt", "text/plain; charset=utf-8"));

    private static final String INDEX_FILE = "index.html";

    private final boolean enabled;

    /** Canonical static root, or {@code null} when disabled. */
    private final Path root;

    private final Path indexPath;

    public UiStaticServingFilter(@Value("${cp.ui.static-root:}") String staticRoot) {
        this.enabled = staticRoot != null && !staticRoot.isBlank();
        if (!this.enabled) {
            this.root = null;
            this.indexPath = null;
            log.info("ui-static: disabled (cp.ui.static-root is empty); the CP serves the API only");
            return;
        }
        Path configured = Paths.get(staticRoot.trim()).toAbsolutePath().normalize();
        Path canonical = canonicalize(configured);
        if (canonical == null || !Files.isDirectory(canonical)) {
            // Configured but unusable: stay inert rather than half-enabled. The launcher's `ui`
            // phase then fails with a hint instead of the CP answering 404 to every route.
            this.root = null;
            this.indexPath = null;
            log.warn("ui-static: static root is not a directory: {} — filter stays inert (API only)", configured);
            return;
        }
        this.root = canonical;
        this.indexPath = canonical.resolve(INDEX_FILE);
        if (!Files.isRegularFile(this.indexPath)) {
            log.warn("ui-static: static root {} has no {} — SPA requests will answer 404", this.root, INDEX_FILE);
        } else {
            log.info("ui-static: serving {} from {} (SPA fallback on, API prefixes bypass)", INDEX_FILE, this.root);
        }
    }

    /** Exposed for tests/tooling: is the filter doing anything at all? */
    public boolean isEnabled() {
        return enabled && root != null;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain filterChain) throws ServletException, IOException {
        // Not configured (the default) or not a read: behave exactly like before this filter existed.
        if (!isEnabled() || !isReadMethod(request.getMethod())) {
            filterChain.doFilter(request, response);
            return;
        }
        String path = requestPath(request);
        if (path == null || isApiPath(path)) {
            filterChain.doFilter(request, response);
            return;
        }
        Path target = resolveWithinRoot(path);
        if (target == null) {
            // Traversal (or an undecodable path): refuse without ever touching the file system
            // outside the root, and never answer with index.html.
            log.warn("ui-static: rejected path outside the static root: {}", path);
            response.sendError(HttpServletResponse.SC_BAD_REQUEST, "invalid path");
            return;
        }
        if (Files.isRegularFile(target) && isInsideRoot(target)) {
            serveFile(request, response, target);
            return;
        }
        if (hasExtension(path)) {
            // A missing asset must be a 404; answering index.html would surface as a MIME/parse
            // error in the browser and hide the real problem.
            response.setStatus(HttpServletResponse.SC_NOT_FOUND);
            return;
        }
        Path index = indexPath;
        if (index == null || !Files.isRegularFile(index)) {
            response.setStatus(HttpServletResponse.SC_NOT_FOUND);
            return;
        }
        serveFile(request, response, index);
    }

    private static boolean isReadMethod(String method) {
        return "GET".equals(method) || "HEAD".equals(method);
    }

    /** Request path with the context path removed; {@code null} means "do not touch this request". */
    private static String requestPath(HttpServletRequest request) {
        String uri = request.getRequestURI();
        if (uri == null) {
            return null;
        }
        String context = request.getContextPath();
        if (context != null && !context.isEmpty() && uri.startsWith(context)) {
            uri = uri.substring(context.length());
        }
        return uri.isEmpty() ? "/" : uri;
    }

    private static boolean isApiPath(String path) {
        for (String prefix : API_PREFIXES) {
            if (path.equals(prefix) || path.startsWith(prefix + "/")) {
                return true;
            }
        }
        return false;
    }

    /**
     * Resolve a decoded request path under the root. Returns {@code null} for anything that could
     * escape it: undecodable percent sequences, backslashes (Windows separators), NUL bytes, a
     * {@code ..} segment, or a resolution that no longer starts with the root.
     */
    private Path resolveWithinRoot(String path) {
        String decoded;
        try {
            decoded = UriUtils.decode(path, StandardCharsets.UTF_8);
        } catch (IllegalArgumentException notEncoded) {
            return null;
        }
        if (decoded.indexOf('\0') >= 0 || decoded.indexOf('\\') >= 0) {
            return null;
        }
        String relative = decoded.startsWith("/") ? decoded.substring(1) : decoded;
        if (relative.isEmpty()) {
            return root;
        }
        for (String segment : relative.split("/", -1)) {
            if ("..".equals(segment)) {
                return null;
            }
        }
        try {
            Path resolved = root.resolve(relative).normalize();
            return resolved.startsWith(root) ? resolved : null;
        } catch (InvalidPathException invalid) {
            return null;
        }
    }

    /** Second gate: a symlink (or a junction) inside the tree must not point outside it. */
    private boolean isInsideRoot(Path target) {
        try {
            return target.toRealPath().startsWith(root);
        } catch (IOException unreadable) {
            log.debug("ui-static: cannot canonicalize {}: {}", target, unreadable.getMessage());
            return false;
        }
    }

    private void serveFile(HttpServletRequest request, HttpServletResponse response, Path file)
            throws IOException {
        long length = Files.size(file);
        response.setStatus(HttpServletResponse.SC_OK);
        response.setContentType(contentType(file));
        response.setContentLengthLong(length);
        // Hashed bundles never change under the same URL; the shell must never be cached, or an
        // upgrade would keep serving the old asset names.
        boolean index = file.getFileName().toString().equals(INDEX_FILE);
        response.setHeader("Cache-Control", index ? "no-store" : "public, max-age=31536000, immutable");
        response.setHeader("X-Content-Type-Options", "nosniff");
        if ("HEAD".equals(request.getMethod())) {
            return;
        }
        try (InputStream in = Files.newInputStream(file)) {
            in.transferTo(response.getOutputStream());
        }
    }

    private static String contentType(Path file) {
        String name = file.getFileName().toString();
        int dot = name.lastIndexOf('.');
        if (dot >= 0) {
            String known = CONTENT_TYPES.get(name.substring(dot + 1).toLowerCase(Locale.ROOT));
            if (known != null) {
                return known;
            }
        }
        try {
            String probed = Files.probeContentType(file);
            if (probed != null && !probed.isBlank()) {
                return probed;
            }
        } catch (IOException ignoredProbeFailure) {
            log.debug("ui-static: content type probe failed for {}", file);
        }
        return "application/octet-stream";
    }

    private static boolean hasExtension(String path) {
        int slash = path.lastIndexOf('/');
        String last = slash >= 0 ? path.substring(slash + 1) : path;
        int dot = last.lastIndexOf('.');
        return dot > 0 && dot < last.length() - 1;
    }

    private static Path canonicalize(Path path) {
        try {
            return Files.exists(path) ? path.toRealPath() : path;
        } catch (IOException cannotResolve) {
            log.warn("ui-static: cannot canonicalize {}: {}", path, cannotResolve.getMessage());
            return null;
        }
    }
}
