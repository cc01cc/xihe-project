package com.cc01cc.p.xihe.cp.plugin;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.policy.AuthzContext;
import com.cc01cc.p.xihe.cp.policy.GrantSources;
import com.cc01cc.p.xihe.cp.policy.PluginBindingAuthorization;
import com.cc01cc.p.xihe.cp.policy.PluginBindingAuthorization.GrantRow;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

/**
 * PLAN-0691 T1.2 (spec/openapi-delta.md §1 routes 8–16): binding CRUD, authorization summary and the
 * session attach/detach skeleton.
 *
 * <p>Scope of this task, stated so the skeleton is not mistaken for the finished feature:</p>
 * <ul>
 *   <li>The <b>atom machinery is T1.3</b>. {@code plugin_binding_grants}, the grant intersection and
 *       the {@code plugin:*} catalog entries do not exist yet, so the granted set is stored on the
 *       binding and {@code effectiveAtoms} is reported as {@code granted ∩ requested}. T1.3 replaces
 *       that line, not the contract around it.</li>
 *   <li>The <b>catalogVersion sequence is T1.6</b>. Attach reports the per-session revision counter,
 *       which is monotonic, instead of inventing a sequence T1.6 would have to renumber.</li>
 *   <li>Authorization is <b>not</b> authentication-only any more (T1.3): every write path calls
 *       {@link #requireBindAtom(UUID, String)} as its first statement, so a missing
 *       {@code PLUGIN_BIND} answers {@code 403 PLUGIN_GRANT_DENIED} before a single row or audit
 *       entry exists. The read paths stay authentication-only — read visibility is the same
 *       workspace-scoped disclosure rule as the rest of the surface, not an atom.</li>
 * </ul>
 *
 * <p>Error order is deliberate and mirrors {@code SkillBindingService}: authorization → existence →
 * workspace ownership (403 before disclosure) → shape. A foreign binding answers {@code 403
 * PLUGIN_GRANT_DENIED}, a missing one {@code 404 PLUGIN_NOT_FOUND}. Authorization comes first on
 * purpose: an actor that does not hold {@code PLUGIN_BIND} must not be able to use the endpoint's
 * error vocabulary (409/422/404) as an oracle, and — the reason this is testable — a denial must
 * leave the transaction with nothing to roll back
 * ({@code PluginBindingAuthorizationGateTest}).</p>
 */
@Service
public class PluginBindingService {

    private static final Logger log = LoggerFactory.getLogger(PluginBindingService.class);

    private static final String ACTION_CREATE = "plugin.binding.create";
    private static final String ACTION_UPDATE = "plugin.binding.update";
    private static final String ACTION_DELETE = "plugin.binding.delete";
    private static final String ACTION_ATTACH = "plugin.binding.attach";
    private static final String ACTION_DETACH = "plugin.binding.detach";

    /** B-4: the only atom a builtin binding gets by default (spec/authz-plugin-atoms.md §1). */
    private static final String ATOM_INVOKE = "plugin:invoke";

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private final PluginBindingRepository bindings;
    private final SessionPluginBindingRepository attachments;
    private final PluginRepository plugins;
    private final SessionRepository sessions;
    private final AuditLogger auditLogger;
    private final AuthorizationGrantRepository grants;

    public PluginBindingService(PluginBindingRepository bindings,
            SessionPluginBindingRepository attachments, PluginRepository plugins,
            SessionRepository sessions, AuditLogger auditLogger,
            AuthorizationGrantRepository grants) {
        this.bindings = bindings;
        this.attachments = attachments;
        this.plugins = plugins;
        this.sessions = sessions;
        this.auditLogger = auditLogger;
        this.grants = grants;
    }

    // ------------------------------------------------------------------ authorization gate

    /**
     * PLAN-0691 T1.3: the atom gate. <b>Called as the first statement of every write path</b>
     * (create / update / delete / attach / detach) so the decision belongs to the pre-effect phase.
     *
     * <p>Two different things are observable, and only one of them is about ordering. The <b>row
     * counts</b> ({@code plugin_bindings}, {@code session_plugin_bindings}, the session revision
     * high-water, {@code audit_logs}) are the outcome the card asks for — rejection ⇒ zero rows
     * written — but the transaction would produce that outcome even from a late gate. The <b>error
     * the client gets</b> is the ordering proof: a denied {@code create} of an already-bound plugin
     * must answer 403, not 409, and a denied create of an unknown plugin must answer 403, not 404, so
     * a gate that ran after the conflict/existence checks is detectable from the wire.
     * {@code PluginBindingAuthorizationGateTest} asserts both, and it was mutation-checked: moving
     * this call below the conflict check turns the class red.</p>
     *
     * <p>The atom is {@code PLUGIN_BIND} for all five verbs: spec/authz-plugin-atoms.md line 10 puts
     * "binding CRUD、enable/disable、session attach/detach" under {@code plugin:bind}, and M1 narrows
     * <i>who holds it</i> (SUPER_ADMIN + ADMIN, not {@code WS_OWNER}) without re-mapping the verbs —
     * see V137's header. An agent principal cannot reach this path with the atom at all
     * ({@code AGENT_FORBIDDEN_ATOMS}).</p>
     *
     * @param workspaceId the {@code X-Workspace-Id} scope, parsed first (no I/O) so the scoped grant
     *                    read can happen before anything else
     * @param actorUserId the authenticated subject
     * @return the workspace id, for the caller to reuse instead of re-parsing
     */
    private UUID requireBindAtom(String workspaceId, String actorUserId) {
        UUID workspace = requireWorkspace(workspaceId);
        String required = PluginBindingAuthorization
                .requiredAtom(PluginBindingAuthorization.Op.BIND_TO_WORKSPACE);
        List<GrantRow> held = grantRows(subject(actorUserId), workspace);
        PluginBindingAuthorization.Decision decision;
        try {
            decision = PluginBindingAuthorization.require(held, required);
        } catch (CpApiException denied) {
            log.warn("plugin binding write denied actor={} workspace={} atom={} holds={}",
                    actorUserId, workspace, required, held.size());
            throw denied;
        }
        log.debug("plugin binding atom granted actor={} workspace={} atom={} matchedSource={}",
                actorUserId, workspace, required, decision.matchedSource());
        return workspace;
    }

    /**
     * The actor's grant holds, projected into the policy kernel's {@link GrantRow} shape.
     *
     * <p>Read through the same scoped query the evaluation kernel uses
     * ({@link AuthorizationGrantRepository#findScopedGrants}: instance rows always, workspace rows
     * only for this workspace) and filtered to {@link GrantSources#EVALUATION_SOURCES} by the kernel,
     * so a retired {@code default}/{@code direct} row stays inert. {@code bindingId} is null: a row
     * materialized from a role or a frozen default snapshot is not attributable to one binding, and
     * the decision's {@code matchedSource} is the answer the spec asks for.</p>
     */
    private List<GrantRow> grantRows(UUID subjectId, UUID workspace) {
        List<GrantRow> held = new ArrayList<>();
        for (AuthorizationGrant grant : grants.findScopedGrants(AuthzContext.SUBJECT_USER,
                subjectId, GrantSources.EVALUATION_SOURCES, workspace)) {
            JsonNode permissions = grant.getPermissions();
            if (permissions == null || !permissions.isArray()) {
                continue;
            }
            for (JsonNode permission : permissions) {
                String actionClass = permission.path("actionClass").asText(null);
                if (actionClass != null && !actionClass.isBlank()) {
                    held.add(new GrantRow(actionClass, grant.getSource(), null));
                }
            }
        }
        return held;
    }

    /** The request subject, or a denial — an anonymous actor holds no atoms by definition. */
    private static UUID subject(String actorUserId) {
        if (actorUserId == null || actorUserId.isBlank()) {
            throw new CpApiException(HttpStatus.FORBIDDEN,
                    PluginBindingAuthorization.CODE_PLUGIN_GRANT_DENIED,
                    "no authenticated principal in the request context");
        }
        try {
            return UUID.fromString(actorUserId.trim());
        } catch (IllegalArgumentException e) {
            throw new CpApiException(HttpStatus.FORBIDDEN,
                    PluginBindingAuthorization.CODE_PLUGIN_GRANT_DENIED,
                    "the request subject is not a user id: " + actorUserId);
        }
    }

    // ------------------------------------------------------------------ binding CRUD

    @Transactional(readOnly = true)
    public List<PluginBinding> list(String workspaceId, String state) {
        UUID workspace = requireWorkspace(workspaceId);
        if (state == null || state.isBlank()) {
            return bindings.findByWorkspaceIdOrderByCreatedAtAsc(workspace);
        }
        return bindings.findByWorkspaceIdAndStateOrderByCreatedAtAsc(workspace,
                normalizeState(state));
    }

    @Transactional(readOnly = true)
    public PluginBinding get(String workspaceId, String bindingId) {
        return require(workspaceId, bindingId);
    }

    @Transactional
    public PluginBinding create(String workspaceId, String pluginId, List<String> grantedAtoms,
            String actorUserId) {
        UUID workspace = requireBindAtom(workspaceId, actorUserId);
        if (pluginId == null || pluginId.isBlank()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "pluginId is required");
        }
        Plugin plugin = plugins.findCurrentById(pluginId.trim())
                .orElseThrow(() -> notFound("plugin " + pluginId + " is not installed"));
        if (bindings.findByWorkspaceIdAndPluginId(workspace, plugin.getId()).isPresent()) {
            throw new CpApiException(HttpStatus.CONFLICT, "PLUGIN_CONFLICT",
                    "workspace already binds plugin " + plugin.getId());
        }
        List<String> requested = declaredAtoms(plugin);
        Grant grant = resolveGrant(Plugin.SOURCE_BUILTIN.equals(plugin.getSource()), requested,
                grantedAtoms);
        // A binding of a plugin that is not itself enabled cannot be usable yet; it starts pending
        // and the PATCH that enables it re-checks the plugin (see update()).
        PluginBindingState initial = Plugin.STATE_ENABLED.equals(plugin.getState())
                ? PluginBindingState.ENABLED
                : PluginBindingState.PENDING;
        PluginBinding binding = new PluginBinding(workspace, plugin, initial,
                atomsNode(grant.atoms()), grant.source());
        bindings.save(binding);
        audit(ACTION_CREATE, actorUserId, workspace, binding,
                "plugin=" + plugin.getId() + " version=" + plugin.getVersion()
                        + " state=" + initial.wire() + " atoms=" + grant.atoms());
        log.info("plugin binding created id={} plugin={} workspace={} state={}", binding.getId(),
                plugin.getId(), workspace, initial.wire());
        return binding;
    }

    @Transactional
    public PluginBinding update(String workspaceId, String bindingId, String state,
            List<String> grantedAtoms, String actorUserId) {
        UUID workspace = requireBindAtom(workspaceId, actorUserId);
        PluginBinding binding = require(workspace, bindingId);
        boolean changed = false;

        if (grantedAtoms != null) {
            Plugin version = plugins.findVersion(binding.getPluginId(), binding.getDigest())
                    .orElseThrow(() -> notFound("plugin " + binding.getPluginId()
                            + " has no version row " + binding.getDigest()));
            Grant grant = resolveGrant(Plugin.SOURCE_BUILTIN.equals(version.getSource()),
                    declaredAtoms(version), grantedAtoms);
            binding.replaceGrantedAtoms(atomsNode(grant.atoms()),
                    PluginBinding.GRANT_SOURCE_BINDING);
            changed = true;
        }
        if (state != null) {
            PluginBindingState next = PluginBindingState.parseOperatorState(state);
            if (next == PluginBindingState.ENABLED) {
                requirePluginEnabled(binding);
            }
            binding.setState(next);
            changed = true;
        }
        if (!changed) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "provide state and/or grantedAtoms");
        }
        bindings.save(binding);
        audit(ACTION_UPDATE, actorUserId, binding.getWorkspaceId(), binding,
                "state=" + binding.state().wire() + " atoms=" + binding.grantedAtomList());
        return binding;
    }

    @Transactional
    public void delete(String workspaceId, String bindingId, String actorUserId) {
        UUID workspace = requireBindAtom(workspaceId, actorUserId);
        PluginBinding binding = require(workspace, bindingId);
        long attached = attachments.countByBindingId(binding.getId());
        bindings.delete(binding);
        audit(ACTION_DELETE, actorUserId, binding.getWorkspaceId(), binding,
                "plugin=" + binding.getPluginId() + " sessions_detached=" + attached);
        log.info("plugin binding deleted id={} plugin={} attached_sessions={}", binding.getId(),
                binding.getPluginId(), attached);
    }

    @Transactional(readOnly = true)
    public AuthorizationSummary authorization(String workspaceId, String bindingId) {
        PluginBinding binding = require(workspaceId, bindingId);
        List<String> requested = requestedAtoms(binding);
        List<String> granted = binding.grantedAtomList();
        List<String> effective = new ArrayList<>();
        List<AtomSource> sources = new ArrayList<>();
        for (String atom : requested) {
            boolean isGranted = granted.contains(atom);
            // T1.3 replaces this with the real intersection (GrantIntersectionEvaluator); today the
            // granted set is the authority, so an effective atom simply echoes its grant source.
            if (isGranted) {
                effective.add(atom);
                sources.add(new AtomSource(atom, binding.grantSource()));
            }
        }
        return new AuthorizationSummary(binding.getId(), requested, granted, effective, sources);
    }

    /**
     * The registry-side projection the wire view needs: the plugin's {@code builtin|third-party}
     * label plus the requested/effective atom sets. Kept in the service so the controller never
     * touches {@link PluginRepository} (CP architecture gate).
     */
    @Transactional(readOnly = true)
    public Detail detail(PluginBinding binding) {
        List<String> requested = requestedAtoms(binding);
        List<String> granted = binding.grantedAtomList();
        List<String> effective = requested.stream().filter(granted::contains).toList();
        String source = plugins.findVersion(binding.getPluginId(), binding.getDigest())
                .map(Plugin::getSource)
                .orElse(null);
        return new Detail(source, requested, effective);
    }

    // ------------------------------------------------------------------ session attach/detach

    @Transactional(readOnly = true)
    public List<SessionPluginBinding> listSession(String workspaceId, String sessionId) {
        Session session = requireSession(workspaceId, sessionId);
        return attachments.findBySessionIdAndDetachedAtIsNullOrderByAttachedAtAsc(session.getId());
    }

    /**
     * Route 14 ({@code GET /api/v1/sessions/{sessionId}/plugins}): the attached set projected as
     * scalars. The snapshot node never leaves the service — a Jackson-2 node on the wire would be
     * serialised as a bean by Jackson 3 (PLAN-0633 C1).
     */
    @Transactional(readOnly = true)
    public List<SessionView> listSessionViews(String workspaceId, String sessionId) {
        List<SessionView> views = new ArrayList<>();
        for (SessionPluginBinding attachment : listSession(workspaceId, sessionId)) {
            JsonNode snapshot = attachment.getSnapshot();
            views.add(new SessionView(attachment.getBindingId(),
                    snapshot.path("pluginId").asText(null),
                    snapshot.path("version").asText(null),
                    snapshot.path("digest").asText(null),
                    snapshot.path("state").asText(null),
                    attachment.getRevision(), attachment.getAttachedAt()));
        }
        return views;
    }

    @Transactional
    public AttachResult attach(String workspaceId, String sessionId, String bindingId,
            String actorUserId) {
        UUID workspace = requireBindAtom(workspaceId, actorUserId);
        Session session = requireSession(workspace, sessionId);
        PluginBinding binding = require(workspace, bindingId);
        PluginBindingState state = binding.state();
        if (state == PluginBindingState.DISABLED || state == PluginBindingState.PENDING) {
            throw new CpApiException(HttpStatus.CONFLICT, "PLUGIN_CONFLICT",
                    "binding " + binding.getId() + " is " + state.wire()
                            + "; enable it before attaching it to a session");
        }

        Optional<SessionPluginBinding> existing =
                attachments.findBySessionIdAndBindingId(session.getId(), binding.getId());
        SessionPluginBinding attachment;
        boolean created = false;
        if (existing.isPresent() && existing.get().isActive()) {
            // Idempotent re-attach: the frozen snapshot of the running turn does not move, so no
            // revision bump is spent on a repeated call.
            attachment = existing.get();
        } else if (existing.isPresent()) {
            attachment = existing.get();
            attachment.reattach(snapshot(binding));
            attachments.save(attachment);
        } else {
            attachment = new SessionPluginBinding(session.getId(), binding.getId(),
                    snapshot(binding));
            attachments.save(attachment);
            created = true;
        }
        audit(ACTION_ATTACH, actorUserId, binding.getWorkspaceId(), binding,
                "session=" + session.getId() + " revision=" + attachment.getRevision()
                        + " created=" + created);
        int catalogVersion = attachments.maxRevision(session.getId());
        log.info("plugin binding attached binding={} session={} revision={} catalogVersion={}",
                binding.getId(), session.getId(), attachment.getRevision(), catalogVersion);
        return new AttachResult(binding.getId(), attachment.getRevision(), catalogVersion, true);
    }

    @Transactional
    public void detach(String workspaceId, String sessionId, String bindingId,
            String actorUserId) {
        UUID workspace = requireBindAtom(workspaceId, actorUserId);
        Session session = requireSession(workspace, sessionId);
        PluginBinding binding = require(workspace, bindingId);
        Optional<SessionPluginBinding> existing =
                attachments.findBySessionIdAndBindingId(session.getId(), binding.getId());
        if (existing.isEmpty() || !existing.get().isActive()) {
            // Idempotent: detaching something already detached is a no-op, not a 404 — the caller's
            // intent ("this binding is not attached") already holds.
            return;
        }
        SessionPluginBinding attachment = existing.get();
        attachment.detach();
        attachments.save(attachment);
        audit(ACTION_DETACH, actorUserId, binding.getWorkspaceId(), binding,
                "session=" + session.getId() + " revision=" + attachment.getRevision());
        log.info("plugin binding detached binding={} session={}", binding.getId(), session.getId());
    }

    // ------------------------------------------------------------------ grant resolution

    /**
     * B-4 / spec/authz-plugin-atoms.md §1: a builtin plugin's binding defaults to the workspace
     * default set ({@code plugin:invoke}); a third-party binding must be granted explicitly. Either
     * way the granted set is bounded by the manifest's {@code requestedAtoms} — a plugin can never be
     * granted an atom it did not ask for.
     */
    private static Grant resolveGrant(boolean builtin, List<String> requested,
            List<String> requestedGrant) {
        List<String> atoms;
        String source;
        if (requestedGrant == null || requestedGrant.isEmpty()) {
            if (!builtin) {
                throw new CpApiException(HttpStatus.FORBIDDEN, "PLUGIN_GRANT_DENIED",
                        "third-party plugins must be granted atoms explicitly");
            }
            atoms = requested.contains(ATOM_INVOKE) ? List.of(ATOM_INVOKE) : List.of();
            source = PluginBinding.GRANT_SOURCE_DEFAULT;
        } else {
            Set<String> unique = new LinkedHashSet<>(
                    requestedGrant.stream().map(atom -> atom.trim()).toList());
            if (unique.isEmpty() || unique.contains("")) {
                throw invalid("grantedAtoms must not contain blank atoms");
            }
            List<String> undeclared = unique.stream().filter(atom -> !requested.contains(atom))
                    .toList();
            if (!undeclared.isEmpty()) {
                throw invalid("grantedAtoms not requested by the manifest: " + undeclared);
            }
            atoms = List.copyOf(unique);
            source = PluginBinding.GRANT_SOURCE_BINDING;
        }
        return new Grant(atoms, source);
    }

    private static List<String> declaredAtoms(Plugin plugin) {
        return atoms(plugin.getManifest());
    }

    private List<String> requestedAtoms(PluginBinding binding) {
        return plugins.findVersion(binding.getPluginId(), binding.getDigest())
                .map(PluginBindingService::declaredAtoms)
                .orElseGet(binding::grantedAtomList);
    }

    private static List<String> atoms(JsonNode manifest) {
        List<String> atoms = new ArrayList<>();
        JsonNode declared = manifest == null ? null : manifest.path("requestedAtoms");
        if (declared != null && declared.isArray()) {
            declared.forEach(atom -> atoms.add(atom.asText()));
        }
        return List.copyOf(atoms);
    }

    private static JsonNode atomsNode(List<String> atoms) {
        ArrayNode node = MAPPER.createArrayNode();
        atoms.forEach(node::add);
        return node;
    }

    private JsonNode snapshot(PluginBinding binding) {
        ObjectNode node = MAPPER.createObjectNode();
        node.put("bindingId", binding.getId().toString());
        node.put("pluginId", binding.getPluginId());
        node.put("version", binding.getVersion());
        node.put("digest", binding.getDigest());
        node.put("state", binding.state().wire());
        return node;
    }

    private void requirePluginEnabled(PluginBinding binding) {
        Plugin plugin = plugins.findVersion(binding.getPluginId(), binding.getDigest())
                .orElseThrow(() -> notFound("plugin " + binding.getPluginId()
                        + " has no version row " + binding.getDigest()));
        if (!Plugin.STATE_ENABLED.equals(plugin.getState())) {
            throw new CpApiException(HttpStatus.CONFLICT, "PLUGIN_CONFLICT",
                    "plugin " + plugin.getId() + " is " + plugin.getState()
                            + "; enable the plugin before enabling its binding");
        }
    }

    // ------------------------------------------------------------------ lookups and errors

    private PluginBinding require(String workspaceId, String bindingId) {
        return require(requireWorkspace(workspaceId), bindingId);
    }

    private PluginBinding require(UUID workspace, String bindingId) {
        UUID id = parseUuid(bindingId, "binding");
        Optional<PluginBinding> found = bindings.findById(id);
        if (found.isEmpty()) {
            throw notFound("binding " + bindingId + " does not exist");
        }
        PluginBinding binding = found.get();
        if (!binding.getWorkspaceId().equals(workspace)) {
            // Cross-workspace answers 403 before existence is disclosed (§4 PLUGIN_GRANT_DENIED).
            throw new CpApiException(HttpStatus.FORBIDDEN, "PLUGIN_GRANT_DENIED",
                    "binding " + bindingId + " belongs to another workspace");
        }
        return binding;
    }

    private Session requireSession(String workspaceId, String sessionId) {
        return requireSession(requireWorkspace(workspaceId), sessionId);
    }

    private Session requireSession(UUID workspace, String sessionId) {
        UUID id = parseUuid(sessionId, "session");
        Session session = sessions.findById(id)
                .orElseThrow(() -> notFound("session " + sessionId + " does not exist"));
        if (session.getWorkspaceId() == null
                || !session.getWorkspaceId().equalsIgnoreCase(workspace.toString())) {
            // Same rule as the binding: a session in another workspace must not be an oracle.
            throw notFound("session " + sessionId + " does not exist");
        }
        return session;
    }

    private static UUID requireWorkspace(String workspaceId) {
        if (workspaceId == null || workspaceId.isBlank()) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "PLUGIN_GRANT_DENIED",
                    "plugin bindings are workspace-scoped; send X-Workspace-Id");
        }
        return parseUuid(workspaceId, "workspace");
    }

    private static UUID parseUuid(String value, String kind) {
        try {
            return UUID.fromString(value.trim());
        } catch (IllegalArgumentException | NullPointerException e) {
            throw notFound(kind + " " + value + " does not exist");
        }
    }

    private static String normalizeState(String state) {
        return state.trim().toLowerCase(Locale.ROOT);
    }

    private void audit(String action, String actorUserId, UUID workspaceId, PluginBinding binding,
            String detail) {
        auditLogger.recordDurableChange(actorUserId,
                workspaceId == null ? null : workspaceId.toString(), action, "plugin_binding",
                binding.getId().toString(), detail);
    }

    private static CpApiException notFound(String detail) {
        return new CpApiException(HttpStatus.NOT_FOUND, "PLUGIN_NOT_FOUND", detail);
    }

    private static CpApiException invalid(String detail) {
        return new CpApiException(HttpStatus.UNPROCESSABLE_ENTITY,
                PluginManifestValidator.ERROR_CODE, detail);
    }

    private record Grant(List<String> atoms, String source) {}

    /** spec/openapi-delta.md §2 {@code PluginAuthorizationSummary}. */
    public record AuthorizationSummary(UUID bindingId, List<String> requestedAtoms,
            List<String> grantedAtoms, List<String> effectiveAtoms, List<AtomSource> sources) {}

    /** Registry projection for the binding view ({@code PluginBindingView}). */
    public record Detail(String source, List<String> requestedAtoms, List<String> effectiveAtoms) {}

    /** One {@code {atom, source}} entry; {@code source} uses the S5 vocabulary. */
    public record AtomSource(String atom, String source) {}

    /** spec/openapi-delta.md §2 {@code PluginAttachResult}. */
    public record AttachResult(UUID bindingId, int revision, int catalogVersion,
            boolean effectiveNextTurn) {}

    /** spec/openapi-delta.md §2 {@code SessionPluginView}, projected from the frozen snapshot. */
    public record SessionView(UUID bindingId, String pluginId, String version, String digest,
            String state, int revision, Instant attachedAt) {}
}
