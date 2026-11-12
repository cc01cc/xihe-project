package com.cc01cc.p.xihe.cp.skill;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * PLAN-0628 M1 (D28-17): manual import — the only writer of {@code skills}.
 *
 * <p>Everything the caller could get wrong about bookkeeping is computed <b>here</b>, never read
 * from the request: {@code content_hash} (sha256 over name/description/body/canonical attachments),
 * {@code body_tokens_est} ({@link SkillTokenEstimator}, the Python-mirrored formula),
 * {@code oversize} (D28-15: marked, never rejected) and {@code version} (a content change bumps it;
 * identical content does not). The DTO {@link SkillImportItem} therefore has no such components — a
 * forged field is a deserialisation error rather than a silent override, and
 * {@code SkillImportServiceTest} pins that by reflection.</p>
 *
 * <p>Idempotency is by the qualified identity {@code (name, definitionScopeType, scope id)}: re-importing
 * identical content is {@code unchanged} (no write, no version bump), which is what makes "import the
 * whole skills directory again" cheap instead of a churn of versions. The scope id is the workspace
 * id for a workspace library and the owner's user id for the personal layer (V156) — one record, two
 * distinct columns, so a personal row never occupies a workspace id.</p>
 *
 * <p>Item-level problems land in {@code rejected[]} and the batch continues — one bad SKILL.md must
 * not block the other 110. Only "batch too large" and "you may not write this library" throw.</p>
 */
@Service
public class SkillImportService {

    public static final String ACTION_CREATED = "created";
    public static final String ACTION_UPDATED = "updated";
    public static final String ACTION_UNCHANGED = "unchanged";

    private final SkillRepository skillRepository;
    private final ObjectMapper objectMapper;

    public SkillImportService(SkillRepository skillRepository, ObjectMapper objectMapper) {
        this.skillRepository = skillRepository;
        this.objectMapper = objectMapper;
    }

    /**
     * Which library a definition is imported into. {@code id} is the workspace id for a workspace
     * scope and the <b>owner's user id</b> for the personal scope (V156); the two id columns are
     * distinct on purpose, see {@link Skill#getDefinitionScopeUserId()}.
     */
    public record DefinitionScope(String type, UUID id) {

        public static DefinitionScope instance() {
            return new DefinitionScope(Skill.DEFINITION_SCOPE_INSTANCE, null);
        }

        public static DefinitionScope workspace(UUID workspaceId) {
            return new DefinitionScope(Skill.DEFINITION_SCOPE_WORKSPACE, workspaceId);
        }

        /** The personal layer: {@code userId} is always the authenticated caller, never a body. */
        public static DefinitionScope user(UUID userId) {
            return new DefinitionScope(Skill.DEFINITION_SCOPE_USER, userId);
        }

        public boolean isPersonal() {
            return Skill.DEFINITION_SCOPE_USER.equals(type);
        }
    }

    public record Outcome(UUID skillId, String name, String action, int version, int bodyTokensEst,
                          boolean oversize) {}

    /** One refused item; mirrors the wire {@code rejected[]} entry. */
    public record Rejection(String sourcePath, String code, String detail) {}

    public record Summary(int created, int updated, int unchanged, int rejected, int oversize) {}

    public record ImportResult(List<Outcome> results, List<Rejection> rejected, Summary summary) {}

    /** What {@link #upsert} decided, so the summary never has to be re-derived from the entity. */
    private record Upsert(Skill skill, String action) {}

    /**
     * Imports a batch into one definition scope.
     *
     * @param authorized the caller's write right for {@code scope}, resolved by the controller
     *     (instance ⇒ instance admin; workspace ⇒ workspace manager or instance admin)
     * @param callerIsInstanceAdmin separate from {@code authorized} on purpose: D28-09 rule 1 lets
     *     <b>only</b> an instance administrator import {@code trusted: true}, and a workspace
     *     manager is authorized to import without being one
     */
    @Transactional
    public ImportResult importSkills(List<SkillImportItem> items, DefinitionScope scope,
                                     UUID callerUserId, boolean authorized,
                                     boolean callerIsInstanceAdmin) {
        if (!authorized) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "SKILL_IMPORT_FORBIDDEN",
                    "you may not import into this skill library");
        }
        if (items == null || items.isEmpty()) {
            return new ImportResult(List.of(), List.of(), new Summary(0, 0, 0, 0, 0));
        }
        SkillImportValidator.requireBatchSize(items.size());

        List<Outcome> results = new ArrayList<>();
        List<Rejection> rejected = new ArrayList<>();
        int created = 0;
        int updated = 0;
        int unchanged = 0;
        int oversize = 0;

        for (SkillImportItem item : items) {
            Optional<SkillImportValidator.Rejection> violation =
                    SkillImportValidator.validate(item, callerIsInstanceAdmin);
            if (violation.isPresent()) {
                SkillImportValidator.Rejection refusal = violation.get();
                rejected.add(new Rejection(refusal.sourcePath(), refusal.code(), refusal.detail()));
                continue;
            }
            Upsert upsert = upsert(item, scope, callerUserId);
            Skill skill = upsert.skill();
            switch (upsert.action()) {
                case ACTION_CREATED -> created++;
                case ACTION_UPDATED -> updated++;
                default -> unchanged++;
            }
            if (skill.isOversize()) {
                oversize++;
            }
            results.add(new Outcome(skill.getId(), skill.getName(), upsert.action(),
                    skill.getVersion(), skill.getBodyTokensEst(), skill.isOversize()));
        }
        return new ImportResult(List.copyOf(results), List.copyOf(rejected),
                new Summary(created, updated, unchanged, rejected.size(), oversize));
    }

    private Upsert upsert(SkillImportItem item, DefinitionScope scope, UUID callerUserId) {
        String hash = contentHash(item);
        Optional<Skill> existing = scope.isPersonal()
                ? skillRepository.findQualifiedPersonal(item.name(), scope.id())
                : skillRepository.findQualified(item.name(), scope.type(), scope.id());
        if (existing.isEmpty()) {
            Skill skill = new Skill();
            skill.setName(item.name());
            skill.setDefinitionScopeType(scope.type());
            if (scope.isPersonal()) {
                skill.setDefinitionScopeUserId(scope.id());
            } else {
                skill.setDefinitionScopeId(scope.id());
            }
            skill.setCreatedByUserId(callerUserId);
            skill.setVersion(1);
            applyContent(skill, item, hash, scope.isPersonal());
            return new Upsert(skillRepository.save(skill), ACTION_CREATED);
        }
        Skill skill = existing.get();
        if (hash.equals(skill.getContentHash())) {
            return new Upsert(skill, ACTION_UNCHANGED);
        }
        applyContent(skill, item, hash, scope.isPersonal());
        skill.setVersion(skill.getVersion() + 1);
        return new Upsert(skillRepository.save(skill), ACTION_UPDATED);
    }

    private void applyContent(Skill skill, SkillImportItem item, String hash, boolean personal) {
        skill.setDescription(item.description());
        skill.setBody(item.body());
        int tokens = SkillTokenEstimator.estimate(item.body());
        skill.setBodyTokensEst(tokens);
        skill.setOversize(SkillTokenEstimator.isOversize(tokens));
        skill.setAttachments(attachmentsNode(item));
        // D-1019 / V156: a personal definition is always untrusted; the controller already refuses
        // any request that carries the member, so this line also holds for a direct service call.
        skill.setTrusted(!personal && Boolean.TRUE.equals(item.trusted()));
        skill.setSourcePath(item.sourcePath());
        skill.setContentHash(hash);
    }

    private JsonNode attachmentsNode(SkillImportItem item) {
        return objectMapper.valueToTree(item.attachments());
    }

    /**
     * sha256 over {@code name \0 description \0 body \0 canonical attachments}.
     *
     * <p>Server-side only: the request cannot carry a hash, so "trust the client's hash" is not even
     * expressible — asserted in {@code SkillImportServiceTest}.</p>
     */
    String contentHash(SkillImportItem item) {
        StringBuilder material = new StringBuilder()
                .append(item.name()).append('\0')
                .append(item.description()).append('\0')
                .append(item.body()).append('\0');
        for (SkillAttachmentView attachment : item.attachments()) {
            material.append(attachment.path()).append('\0')
                    .append(attachment.sizeBytes()).append('\0')
                    .append(attachment.sha256()).append('\0')
                    .append(attachment.kind()).append('\n');
        }
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(material.toString().getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(hash);
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is required by the JVM spec", impossible);
        }
    }
}
