package com.cc01cc.p.xihe.cp.skill;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.util.Arrays;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * PLAN-0628 M1 (D28-17): the import writer.
 *
 * <p>Two rules are pinned here because they are the ones a "helpful" refactor breaks: the
 * bookkeeping fields are <b>server-computed</b> (the request cannot even carry them), and
 * re-importing identical content is a no-op instead of a version bump.</p>
 */
class SkillImportServiceTest {

    private static final UUID CALLER = UUID.randomUUID();

    private final SkillRepository repository = mock(SkillRepository.class);
    private final SkillImportService service = new SkillImportService(repository, new ObjectMapper());

    private static SkillImportItem item(String name, String body) {
        return new SkillImportItem(name, "desc of " + name, body,
                ".agents/skills/" + name + "/SKILL.md", List.of(), false);
    }

    private Skill stored(String name, String body, int version) {
        Skill skill = new Skill();
        skill.setId(UUID.randomUUID());
        skill.setName(name);
        skill.setDefinitionScopeType(Skill.DEFINITION_SCOPE_INSTANCE);
        skill.setVersion(version);
        skill.setBodyTokensEst(SkillTokenEstimator.estimate(body));
        skill.setContentHash(service.contentHash(item(name, body)));
        return skill;
    }

    @Test
    void theRequestCannotCarryServerComputedFields() {
        // `content_hash`/`body_tokens_est`/`oversize`/`version` are not on the DTO at all, so a
        // forged value is a deserialisation error rather than a silent override.
        List<String> components = Arrays.stream(SkillImportItem.class.getRecordComponents())
                .map(component -> component.getName())
                .toList();
        assertEquals(List.of("name", "description", "body", "sourcePath", "attachments", "trusted"),
                components);
        assertFalse(components.contains("contentHash"));
        assertFalse(components.contains("bodyTokensEst"));
        assertFalse(components.contains("oversize"));
        assertFalse(components.contains("version"));
    }

    @Test
    void aNewSkillIsCreatedAndTheHashIsComputedByTheService() {
        when(repository.findQualified(anyString(), anyString(), any())).thenReturn(Optional.empty());
        when(repository.save(any(Skill.class))).thenAnswer(invocation -> invocation.getArgument(0));

        SkillImportService.ImportResult result = service.importSkills(
                List.of(item("writing", "do the thing")),
                SkillImportService.DefinitionScope.instance(), CALLER, true, true);

        assertEquals(1, result.results().size());
        assertEquals(SkillImportService.ACTION_CREATED, result.results().get(0).action());
        assertEquals(1, result.results().get(0).version());
        assertEquals(1, result.summary().created());

        // Assert on the entity that was actually handed to the repository — not on a recalculated
        // value — so "the client's hash is ignored" is really pinned.
        ArgumentCaptor<Skill> saved = ArgumentCaptor.forClass(Skill.class);
        verify(repository).save(saved.capture());
        String hash = saved.getValue().getContentHash();
        assertTrue(hash.matches("^[0-9a-f]{64}$"), hash);
        assertEquals(service.contentHash(item("writing", "do the thing")), hash);
        assertNotEquals(hash, service.contentHash(item("writing", "do the thing changed")));
    }

    @Test
    void reimportingIdenticalContentIsUnchangedAndDoesNotBumpTheVersion() {
        when(repository.findQualified("writing", Skill.DEFINITION_SCOPE_INSTANCE, null))
                .thenReturn(Optional.of(stored("writing", "do the thing", 3)));

        SkillImportService.ImportResult result = service.importSkills(
                List.of(item("writing", "do the thing")),
                SkillImportService.DefinitionScope.instance(), CALLER, true, true);

        assertEquals(SkillImportService.ACTION_UNCHANGED, result.results().get(0).action());
        assertEquals(3, result.results().get(0).version());
        assertEquals(1, result.summary().unchanged());
    }

    @Test
    void changedContentUpdatesInPlaceAndBumpsTheVersion() {
        when(repository.findQualified("writing", Skill.DEFINITION_SCOPE_INSTANCE, null))
                .thenReturn(Optional.of(stored("writing", "old body", 2)));
        when(repository.save(any(Skill.class))).thenAnswer(invocation -> invocation.getArgument(0));

        SkillImportService.ImportResult result = service.importSkills(
                List.of(item("writing", "new body")),
                SkillImportService.DefinitionScope.instance(), CALLER, true, true);

        assertEquals(SkillImportService.ACTION_UPDATED, result.results().get(0).action());
        assertEquals(3, result.results().get(0).version());
    }

    @Test
    void anOversizeBodyIsStoredAndCountedNotRejected() {
        when(repository.findQualified(anyString(), anyString(), any())).thenReturn(Optional.empty());
        when(repository.save(any(Skill.class))).thenAnswer(invocation -> invocation.getArgument(0));

        // 10 001 code points ⇒ ~5000 estimated tokens (boundary) — push past it.
        String big = "x".repeat(12_000);
        SkillImportService.ImportResult result = service.importSkills(
                List.of(item("big", big)),
                SkillImportService.DefinitionScope.instance(), CALLER, true, true);

        assertTrue(result.results().get(0).oversize());
        assertEquals(1, result.summary().oversize());
        assertEquals(1, result.summary().created());
    }

    @Test
    void aBadItemIsRejectedWithoutBlockingTheRest() {
        when(repository.findQualified(anyString(), anyString(), any())).thenReturn(Optional.empty());
        when(repository.save(any(Skill.class))).thenAnswer(invocation -> invocation.getArgument(0));

        // The second item's directory name does not match its `name`.
        SkillImportItem mismatch = new SkillImportItem("good-one", "d", "b",
                ".agents/skills/other-name/SKILL.md", List.of(), false);
        SkillImportService.ImportResult result = service.importSkills(
                List.of(item("good-one", "body"), mismatch),
                SkillImportService.DefinitionScope.instance(), CALLER, true, true);

        assertEquals(1, result.results().size());
        assertEquals(1, result.rejected().size());
        assertEquals(SkillImportValidator.SKILL_NAME_INVALID, result.rejected().get(0).code());
        assertEquals(1, result.summary().created());
        assertEquals(1, result.summary().rejected());
    }

    @Test
    void trustedRequiresAnInstanceAdmin() {
        when(repository.findQualified(anyString(), anyString(), any())).thenReturn(Optional.empty());
        when(repository.save(any(Skill.class))).thenAnswer(invocation -> invocation.getArgument(0));
        SkillImportItem trusted = new SkillImportItem("trusted-one", "d", "b",
                ".agents/skills/trusted-one/SKILL.md", List.of(), true);

        SkillImportService.ImportResult rejected = service.importSkills(
                List.of(trusted), SkillImportService.DefinitionScope.instance(), CALLER, true, false);
        assertEquals(1, rejected.rejected().size());
        assertEquals(SkillImportValidator.SKILL_TRUSTED_FORBIDDEN, rejected.rejected().get(0).code());

        SkillImportService.ImportResult accepted = service.importSkills(
                List.of(trusted), SkillImportService.DefinitionScope.instance(), CALLER, true, true);
        assertEquals(1, accepted.results().size());
    }

    @Test
    void anUnauthorizedCallerIsRefusedBeforeAnythingIsRead() {
        CpApiException refused = assertThrows(CpApiException.class, () -> service.importSkills(
                List.of(item("writing", "b")), SkillImportService.DefinitionScope.instance(),
                CALLER, false, false));

        assertEquals("SKILL_IMPORT_FORBIDDEN", refused.getCode());
        assertEquals(403, refused.getStatus().value());
    }

    @Test
    void anEmptyBatchIsANoOp() {
        SkillImportService.ImportResult result = service.importSkills(
                List.of(), SkillImportService.DefinitionScope.instance(), CALLER, true, true);

        assertTrue(result.results().isEmpty());
        assertEquals(new SkillImportService.Summary(0, 0, 0, 0, 0), result.summary());
    }
}
