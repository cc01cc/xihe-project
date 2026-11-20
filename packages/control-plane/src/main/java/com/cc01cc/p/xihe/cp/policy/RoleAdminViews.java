package com.cc01cc.p.xihe.cp.policy;

import tools.jackson.core.JsonParser;
import tools.jackson.core.JsonToken;
import tools.jackson.databind.DatabindException;
import tools.jackson.databind.DeserializationContext;
import tools.jackson.databind.ValueDeserializer;
import tools.jackson.databind.annotation.JsonDeserialize;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.UUID;

/**
 * PLAN-0610 W3-2a: the wire views of the access-role administration API.
 *
 * <p>They live next to the policy services (not in {@code auth/}) because the role model is owned by
 * this package; the controllers only translate HTTP. Every view is an explicit projection — the
 * entities {@code AccessRole}/{@code AccessRoleBinding} never reach the API, so an internal column
 * (for example {@code is_system}'s storage shape) cannot leak by accident.</p>
 */
public final class RoleAdminViews {

    private RoleAdminViews() {
    }

    /**
     * One permission atom as the catalog exposes it (SSOT: {@link PermissionAtomCatalog}).
     *
     * <p>{@code displayName} is resolved server-side from the explicit {@code ?locale} (D51-37): the
     * wire carries one string, never a {@code {zh, en}} pair, so the UI keeps no vocabulary.</p>
     *
     * <p>{@code resource} is the <b>pattern actually stored for this subject</b>: the catalog itself
     * reports {@link PermissionAtomCatalog.Atom#canonicalResource()} while a role row reports its
     * own {@code role_permissions.resource_pattern}. Since task-81 that column may hold a declaration
     * key ({@code fs:<workspaceId>/<rel>}), so a projection that always printed the canonical value
     * would hide the narrowing from the editor that has to display and diff it.</p>
     */
    public record AtomView(String name, String scopeClass, boolean capability, String resource,
                           String displayName, boolean agentPrincipalForbidden) {

        static AtomView of(PermissionAtomCatalog.Atom atom, String locale) {
            return of(atom, atom.canonicalResource(), locale);
        }

        static AtomView of(PermissionAtomCatalog.Atom atom, String resource, String locale) {
            return new AtomView(atom.name(), atom.scopeClass(), atom.capability(),
                    resource == null || resource.isBlank() ? atom.canonicalResource() : resource,
                    PermissionAtomLabels.label(atom.name(), locale),
                    // task-415 (RBAC P0-1): the catalog already computed this flag; the view used to
                    // drop it, so a binding UI could offer a role the CP would refuse. Projecting it
                    // lets the UI pre-disable instead of walking into AGENT_PRINCIPAL_FORBIDDEN.
                    atom.agentPrincipalForbidden());
        }
    }

    /**
     * {@code GET /api/v1/roles/catalog}: the atom vocabulary, the bindable scope types and the
     * built-in default grant sets (task-415 / RBAC P1-2).
     */
    public record CatalogView(List<AtomView> atoms, List<String> scopes,
                              List<DefaultGrantView> defaultGrants) {
    }

    /**
     * task-415 (RBAC P1-2): one built-in role's seeded default grant set, from
     * {@link SystemAccessRoleCatalog#roleSeeds()} — the code-level default, not the live DB rows
     * ({@code GET /roles} lists the rows). This is what answers "who gets a new atom by default"
     * without reading code, the default-grant half of the permission-face rule.
     */
    public record DefaultGrantView(String roleName, String displayName, String description,
                                   List<String> atoms) {
    }

    /** One role definition. {@code bindingCount} lets the UI disable a delete it cannot perform. */
    public record RoleView(UUID id, String name, String displayName, String description,
                           boolean system, List<AtomView> atoms, long bindingCount) {
    }

    /** One binding row as the API shows it (role name resolved, subject type pinned to user). */
    public record BindingView(UUID id, String subjectType, UUID subjectId, UUID roleId,
                              String roleName, UUID grantedBy, Instant grantedAt) {
    }

    /** {@code GET/PUT /api/v1/bindings}: the resolved scope and its complete binding set. */
    public record BindingSetView(String scopeType, UUID scopeId, List<BindingView> bindings) {
    }

    /**
     * {@code POST /api/v1/roles} body (controller-side record keeps the parsing trivial).
     *
     * <p>task-81 / DSD-1485: {@code atoms} accepts two forms per entry — the historical
     * {@code "read"} and {@code {"actionClass":"read","resource":"fs:<workspaceId>/src"}}. The
     * string form is exactly the old contract (resource omitted ⇒ the atom's canonical pattern), so
     * no existing client changes behaviour; see {@link GrantResourcePattern} for what the object
     * form may carry.</p>
     */
    public record RoleCreate(String name, String displayName, String description,
                             List<AtomInput> atoms) {

        /**
         * Text-only convenience constructor: the atom-name list shape of every caller written before
         * task-81 (and of the tests that exercise the gates). Kept so a narrow-resource change does
         * not force unrelated call sites to learn a new type.
         */
        public RoleCreate(String name, String displayName, String description,
                          Collection<? extends CharSequence> atoms) {
            this(name, displayName, description, AtomInput.textOnly(atoms));
        }
    }

    /**
     * {@code PATCH /api/v1/roles/{roleId}} body; every field is optional (null = unchanged).
     *
     * <p>{@code atoms} follows {@link RoleCreate} — the whole set is replaced, and a resource pattern
     * travels with its atom.</p>
     */
    public record RoleUpdate(String name, String displayName, String description,
                             List<AtomInput> atoms) {

        /** Text-only convenience constructor (same reason as {@link RoleCreate}). */
        public RoleUpdate(String name, String displayName, String description,
                          Collection<? extends CharSequence> atoms) {
            this(name, displayName, description, AtomInput.textOnly(atoms));
        }
    }

    /** One requested binding in a {@code PUT /api/v1/bindings} full replacement. */
    public record BindingInput(String subjectType, UUID subjectId, UUID roleId) {
    }

    /**
     * One requested atom in a role body: its name plus an optional resource pattern.
     *
     * <p>Deserialised from either a bare string ({@code "read"}) or an object
     * ({@code {"actionClass":"read","resource":"fs:.../src"}}). Unknown object fields are rejected on
     * purpose: a typo such as {@code "resourcePath"} would otherwise deserialise to "no resource" and
     * silently widen the atom to {@code *} — the failure mode this class exists to prevent.</p>
     */
    @JsonDeserialize(using = AtomInput.Deserializer.class)
    public record AtomInput(String actionClass, String resource) {

        static List<AtomInput> textOnly(Collection<? extends CharSequence> atoms) {
            if (atoms == null) {
                return null;
            }
            return atoms.stream()
                    .map(atom -> atom == null ? null : new AtomInput(atom.toString(), null))
                    .toList();
        }

        /** Accepts the bare-string and the object form; everything else is a 400 via Jackson. */
        public static final class Deserializer extends ValueDeserializer<AtomInput> {

            @Override
            public AtomInput deserialize(JsonParser parser, DeserializationContext context) {
                JsonToken token = parser.currentToken();
                if (token == JsonToken.VALUE_STRING) {
                    return new AtomInput(parser.getString(), null);
                }
                if (token == JsonToken.VALUE_NULL) {
                    return null;
                }
                if (token != JsonToken.START_OBJECT) {
                    throw DatabindException.from(parser,
                            "An atom must be a string or an object with actionClass/name and resource");
                }
                String actionClass = null;
                String resource = null;
                JsonToken next = parser.nextToken();
                while (next != null && next != JsonToken.END_OBJECT) {
                    String field = parser.currentName();
                    JsonToken valueToken = parser.nextToken();
                    String value = valueToken == JsonToken.VALUE_STRING ? parser.getString() : null;
                    switch (field) {
                        case "actionClass", "name" -> actionClass = value;
                        case "resource" -> resource = value;
                        default -> throw DatabindException.from(parser,
                                "Unknown atom field: " + field
                                        + " (expected actionClass/name and resource)");
                    }
                    next = parser.nextToken();
                }
                if (actionClass == null) {
                    throw DatabindException.from(parser,
                            "An atom object requires actionClass (or name)");
                }
                return new AtomInput(actionClass, resource);
            }
        }
    }
}
