package com.cc01cc.p.xihe.cp.skill;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgentId;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * PLAN-0628 M1 (D28-14): the two-axis binding writer.
 *
 * <p><b>The axes are independent, and that is the whole point.</b> {@code (subject_type ×
 * scope_type)} gives four reachable tiers; the "instance-wide shared" fifth tier is out of v1
 * because {@code subject_id} is NOT NULL (same shape as {@code role_bindings}, V87:44). See
 * {@link SkillBinding} for the 2×2 semantics table.</p>
 *
 * <p>Validation order matters for the error the caller sees, so it is fixed here: existence → shape →
 * definition visibility → authorization → subject validity → duplicate. Authorization sits before
 * subject validity on purpose: a caller who may not bind must not be able to probe whether a user or
 * principal exists (or is disabled) by reading the error code.</p>
 */
@Service
public class SkillBindingService {

    public static final String ERR_SKILL_NOT_FOUND = "SKILL_NOT_FOUND";
    public static final String ERR_BINDING_EXISTS = "SKILL_BINDING_EXISTS";
    public static final String ERR_SUBJECT_INVALID = "SKILL_BINDING_SUBJECT_INVALID";
    public static final String ERR_DEFINITION_OUT_OF_SCOPE = "SKILL_DEFINITION_OUT_OF_SCOPE";
    public static final String ERR_FORBIDDEN = "SKILL_BINDING_FORBIDDEN";
    public static final String ERR_INVALID_SCOPE = "SKILL_BINDING_SCOPE_INVALID";
    public static final String ERR_BINDING_NOT_FOUND = "SKILL_BINDING_NOT_FOUND";

    private final SkillRepository skillRepository;
    private final SkillBindingRepository bindingRepository;
    private final UserRepository userRepository;
    private final AgentPrincipalRepository principalRepository;
    private final WorkspaceAgentRepository workspaceAgentRepository;

    public SkillBindingService(SkillRepository skillRepository,
                               SkillBindingRepository bindingRepository,
                               UserRepository userRepository,
                               AgentPrincipalRepository principalRepository,
                               WorkspaceAgentRepository workspaceAgentRepository) {
        this.skillRepository = skillRepository;
        this.bindingRepository = bindingRepository;
        this.userRepository = userRepository;
        this.principalRepository = principalRepository;
        this.workspaceAgentRepository = workspaceAgentRepository;
    }

    /** The requested binding; {@code scopeId} is null exactly for the instance tier. */
    public record BindCommand(UUID skillId, String subjectType, UUID subjectId, String scopeType,
                              UUID scopeId) {}

    /** Who is asking, as resolved by the controller from the authenticated context. */
    public record Caller(UUID userId, boolean instanceAdmin, boolean workspaceManager) {}

    @Transactional
    public SkillBinding bind(BindCommand command, Caller caller) {
        Skill skill = skillRepository.findById(command.skillId())
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, ERR_SKILL_NOT_FOUND,
                        "skill not found"));
        requireVocabulary(command);
        requireDefinitionVisibility(skill, command);
        // Authorization BEFORE subject validity: otherwise a caller who may not bind still learns
        // whether a given user/principal exists (and whether it is disabled) from the error code.
        requireAuthorized(command, caller);
        requireValidSubject(command);
        if (bindingRepository.countExact(command.skillId(), command.subjectType(),
                command.subjectId(), command.scopeType(), command.scopeId()) > 0) {
            // Pre-checked so the unique key surfaces as 409 instead of a 500 constraint violation.
            throw new CpApiException(HttpStatus.CONFLICT, ERR_BINDING_EXISTS,
                    "this subject already has that binding");
        }
        SkillBinding binding = new SkillBinding();
        binding.setSkillId(command.skillId());
        binding.setSubjectType(command.subjectType());
        binding.setSubjectId(command.subjectId());
        binding.setScopeType(command.scopeType());
        binding.setScopeId(command.scopeId());
        binding.setCreatedByUserId(caller.userId());
        return bindingRepository.save(binding);
    }

    @Transactional
    public void unbind(UUID bindingId, Caller caller) {
        SkillBinding binding = bindingRepository.findById(bindingId)
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, ERR_BINDING_NOT_FOUND,
                        "binding not found"));
        requireAuthorized(new BindCommand(binding.getSkillId(), binding.getSubjectType(),
                binding.getSubjectId(), binding.getScopeType(), binding.getScopeId()), caller);
        bindingRepository.delete(binding);
    }

    /**
     * Unbind, resolving the caller's workspace right <b>from the row's own scope</b>.
     *
     * <p>This overload exists so a controller cannot supply a blanket "manages every workspace"
     * flag: the row is loaded first and the guard is asked about that row's workspace. (The first
     * controller draft did exactly that — it would have let any authenticated caller delete any
     * workspace-scoped binding.)</p>
     */
    @Transactional
    public void unbind(UUID bindingId, SkillAccessGuard guard) {
        SkillBinding binding = bindingRepository.findById(bindingId)
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, ERR_BINDING_NOT_FOUND,
                        "binding not found"));
        boolean managesThatWorkspace = SkillBinding.SCOPE_WORKSPACE.equals(binding.getScopeType())
                && guard.canManageWorkspace(binding.getScopeId());
        Caller caller = new Caller(UUID.fromString(guard.requireActor()), guard.canManageInstanceLibrary(),
                managesThatWorkspace);
        requireAuthorized(new BindCommand(binding.getSkillId(), binding.getSubjectType(),
                binding.getSubjectId(), binding.getScopeType(), binding.getScopeId()), caller);
        bindingRepository.delete(binding);
    }

    public List<SkillBinding> listForSkill(UUID skillId) {
        return bindingRepository.findBySkillIdOrderByCreatedAtAsc(skillId);
    }

    private static void requireVocabulary(BindCommand command) {
        boolean subjectOk = SkillBinding.SUBJECT_TYPES.contains(command.subjectType());
        boolean scopeOk = SkillBinding.SCOPE_TYPES.contains(command.scopeType());
        boolean shapeOk = (SkillBinding.SCOPE_INSTANCE.equals(command.scopeType())
                && command.scopeId() == null)
                || (SkillBinding.SCOPE_WORKSPACE.equals(command.scopeType())
                && command.scopeId() != null);
        if (!subjectOk || !scopeOk || !shapeOk) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, ERR_INVALID_SCOPE,
                    "binding must be (user|agent_principal) × (instance|workspace), "
                            + "with scopeId present only for a workspace");
        }
    }

    /**
     * A workspace-private definition may only be bound inside its own workspace — otherwise a
     * workspace's private skill would become visible elsewhere through a binding (the leak this
     * whole feature has to avoid).
     *
     * <p><b>Personal definitions are never bindable</b> (V156 / openapi.yaml:726-728): a
     * {@code type=user} definition answers {@code 404 SKILL_NOT_FOUND}, the same code and message a
     * random UUID gets. Not {@code 400}: the caller reached none of their own definitions, so this
     * is invisibility rather than a mis-scoped request — and a 400 with a "definition" wording would
     * tell the caller that the id <i>is</i> a definition.</p>
     */
    private static void requireDefinitionVisibility(Skill skill, BindCommand command) {
        if (Skill.DEFINITION_SCOPE_USER.equals(skill.getDefinitionScopeType())) {
            throw new CpApiException(HttpStatus.NOT_FOUND, ERR_SKILL_NOT_FOUND, "skill not found");
        }
        UUID definitionWorkspace = skill.getDefinitionScopeId();
        if (definitionWorkspace == null) {
            return;
        }
        if (!definitionWorkspace.equals(command.scopeId())) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, ERR_DEFINITION_OUT_OF_SCOPE,
                    "a workspace-private definition can only be bound inside its own workspace");
        }
    }

    private void requireValidSubject(BindCommand command) {
        if (SkillBinding.SUBJECT_USER.equals(command.subjectType())) {
            Optional<User> user = userRepository.findById(command.subjectId());
            if (user.isEmpty() || user.get().getDeletedAt() != null) {
                throw new CpApiException(HttpStatus.BAD_REQUEST, ERR_SUBJECT_INVALID,
                        "user subject does not exist or is deleted");
            }
            return;
        }
        Optional<AgentPrincipal> principal = principalRepository.findById(command.subjectId());
        if (principal.isEmpty() || principal.get().getDisabledAt() != null) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, ERR_SUBJECT_INVALID,
                    "agent principal subject does not exist or is disabled");
        }
        if (SkillBinding.SCOPE_WORKSPACE.equals(command.scopeType())
                && workspaceAgentRepository.findById(
                new WorkspaceAgentId(command.subjectId(), command.scopeId())).isEmpty()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, ERR_SUBJECT_INVALID,
                    "agent principal is not a member of that workspace");
        }
    }

    /**
     * Instance tier ⇒ instance administrator. Workspace tier ⇒ instance administrator or a manager
     * of that workspace. Binding a <b>different</b> user at any tier ⇒ instance administrator (you
     * may always bind yourself).
     */
    private static void requireAuthorized(BindCommand command, Caller caller) {
        boolean scopeAllowed = SkillBinding.SCOPE_INSTANCE.equals(command.scopeType())
                ? caller.instanceAdmin()
                : caller.instanceAdmin() || caller.workspaceManager();
        boolean subjectAllowed = !SkillBinding.SUBJECT_USER.equals(command.subjectType())
                || caller.instanceAdmin()
                || command.subjectId().equals(caller.userId());
        if (!scopeAllowed || !subjectAllowed) {
            throw new CpApiException(HttpStatus.FORBIDDEN, ERR_FORBIDDEN,
                    "you may not bind skills at this scope");
        }
    }
}
