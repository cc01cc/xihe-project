package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.Message;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.SessionParticipant;
import com.cc01cc.p.xihe.cp.logging.LogRedactor;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;
import com.cc01cc.p.xihe.cp.repository.SessionParticipantRepository;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;

/**
 * PLAN-0690 T1.2b (CP-2, spec §4): assembles what the judge reads — recent window, roster, duty
 * line and the prompt that asks for a §1 verdict. Replaces the inline
 * {@code inputWindow="trigger=… round=…"} and the bare one-line prompt that
 * {@code WakeDispatchService} used to hand to {@link JudgeDecisionService}.
 *
 * <p>Window: the newest {@value #WINDOW_MESSAGES} messages of the session, rendered oldest first;
 * blank rows are skipped; sender = {@code participant_id} → principal name, otherwise the message
 * role. Each message is {@link LogRedactor#redact}ed and cut to
 * {@value #MESSAGE_MAX_CHARS} code points; the whole window is then cut to
 * {@value #WINDOW_MAX_CHARS} code points by dropping the oldest lines and prepending
 * {@link #OLDER_OMITTED}. Empty history renders {@link #EMPTY_WINDOW} so
 * {@code judge_decisions.input_window} stays NOT NULL.</p>
 *
 * <p>Roster: at most {@value #ROSTER_MAX} entries of {@code <name>=<role>/<wakePolicy>} in
 * {@code orderIndex} order, plus {@code +N more}. Duty: one line ≤{@value #DUTY_MAX_CHARS} code
 * points that names {@code respondPolicy=JUDGE}. The prompt template is a class constant (spec §4:
 * no {@code resources/prompts/} loader exists) and the session title is deliberately not
 * included.</p>
 *
 * <p>Read-only by contract: no repository write, no audit row, no model call.</p>
 */
@Component
public class JudgeInputAssembler {

    /** spec §4: how many messages the window keeps. */
    static final int WINDOW_MESSAGES = 20;
    static final int MESSAGE_MAX_CHARS = 500;
    static final int WINDOW_MAX_CHARS = 4000;
    static final int ROSTER_MAX = 20;
    static final int DUTY_MAX_CHARS = 200;

    static final String EMPTY_WINDOW = "(no messages yet)";
    static final String OLDER_OMITTED = "(older messages omitted)";
    static final String EMPTY_ROSTER = "(no participants)";

    /**
     * Fixed template (spec §4): the judge contract lives in the prompt itself, so nothing is
     * loaded at runtime. {@code %s} slots: duty line, roster, window — in that order.
     */
    static final String PROMPT_TEMPLATE = """
            You are the judge for one wake round of a multi-participant session.
            Decide whether the addressed participant should speak in this round.
            Judge only from the duty line, the roster and the recent messages below; the session
            title is intentionally absent.

            Duty line:
            %s

            Roster (name=role/wakePolicy):
            %s

            Recent messages (oldest first):
            %s

            Answer with ONLY one JSON object: {"speak": true|false, "reason": "<short reason>"}.
            speak=true only when this participant should produce a turn now; otherwise speak=false.
            """;

    private final MessageRepository messageRepository;
    private final SessionParticipantRepository participantRepository;
    private final AgentPrincipalRepository agentPrincipalRepository;
    private final String modelProvider;
    private final String modelName;

    public JudgeInputAssembler(MessageRepository messageRepository,
                               SessionParticipantRepository participantRepository,
                               AgentPrincipalRepository agentPrincipalRepository,
                               @Value("${cp.judge.provider:bailian}") String modelProvider,
                               @Value("${cp.judge.model:decision-model-preview}") String modelName) {
        this.messageRepository = messageRepository;
        this.participantRepository = participantRepository;
        this.agentPrincipalRepository = agentPrincipalRepository;
        this.modelProvider = modelProvider;
        this.modelName = modelName;
    }

    /**
     * Builds the decision input for one (session, participant, wake round). The model identity is
     * the configured {@code cp.judge.*} value (spec §5) — it used to be two literals at the wake
     * call site, which made the JUDGE branch unable to follow a provider rebind.
     *
     * @return a judge input whose {@code inputWindow} is never empty and never carries the prompt
     */
    public JudgeDecisionService.JudgeInput assemble(Session session, SessionParticipant participant,
                                                    String triggerSource, String wakeRoundId) {
        Objects.requireNonNull(session, "session");
        Objects.requireNonNull(participant, "participant");
        List<SessionParticipant> roster =
                participantRepository.findBySessionIdOrderByOrderIndexAsc(session.getId());
        List<Message> newestFirst = messageRepository.findLatestPage(session.getId().toString(),
                PageRequest.of(0, WINDOW_MESSAGES));
        Map<UUID, String> principalNames = principalNames(roster, newestFirst);
        String window = window(newestFirst, principalNames);
        String rosterSummary = rosterSummary(roster, principalNames);
        String duty = duty(participant, principalNames);
        return new JudgeDecisionService.JudgeInput(session.getId(), null, participant.getId(),
                wakeRoundId, triggerSource, window, duty, modelProvider, modelName,
                prompt(triggerSource, wakeRoundId, session.getId(), duty, rosterSummary, window));
    }

    private String window(List<Message> newestFirst, Map<UUID, String> principalNames) {
        if (newestFirst == null || newestFirst.isEmpty()) {
            return EMPTY_WINDOW;
        }
        List<String> lines = new ArrayList<>();
        for (int i = newestFirst.size() - 1; i >= 0; i--) {
            Message message = newestFirst.get(i);
            if (message == null) {
                continue;
            }
            String body = truncate(sanitise(message.getContent()), MESSAGE_MAX_CHARS);
            if (body.isEmpty()) {
                continue;
            }
            lines.add(sender(message, principalNames) + ": " + body);
        }
        if (lines.isEmpty()) {
            return EMPTY_WINDOW;
        }
        int budget = WINDOW_MAX_CHARS - OLDER_OMITTED.length() - 1;
        List<String> kept = new ArrayList<>();
        int used = 0;
        boolean omitted = false;
        for (int i = lines.size() - 1; i >= 0; i--) {
            String line = lines.get(i);
            int cost = codePointCount(line) + (kept.isEmpty() ? 0 : 1);
            if (used + cost > budget) {
                omitted = true;
                break;
            }
            kept.add(0, line);
            used += cost;
        }
        if (kept.isEmpty()) {
            // Defensive: a single line cannot exceed the budget (500 < 4000 - prefix), but never
            // return nothing when history exists.
            kept.add(truncate(lines.get(lines.size() - 1), budget));
            omitted = true;
        }
        String joined = String.join("\n", kept);
        return omitted ? OLDER_OMITTED + "\n" + joined : joined;
    }

    private String rosterSummary(List<SessionParticipant> roster, Map<UUID, String> principalNames) {
        if (roster == null || roster.isEmpty()) {
            return EMPTY_ROSTER;
        }
        List<String> lines = new ArrayList<>();
        for (int i = 0; i < roster.size() && i < ROSTER_MAX; i++) {
            SessionParticipant row = roster.get(i);
            lines.add(participantName(row, principalNames) + "=" + orDash(row.getRole()) + "/"
                    + orDash(row.getWakePolicy()));
        }
        if (roster.size() > ROSTER_MAX) {
            lines.add("+" + (roster.size() - ROSTER_MAX) + " more");
        }
        return String.join(", ", lines);
    }

    private String duty(SessionParticipant participant, Map<UUID, String> principalNames) {
        String line = "name=" + participantName(participant, principalNames)
                + " role=" + orDash(participant.getRole())
                + " wakePolicy=" + orDash(participant.getWakePolicy())
                + " respondPolicy=" + orDash(participant.getRespondPolicy());
        return truncate(line, DUTY_MAX_CHARS);
    }

    private String prompt(String triggerSource, String wakeRoundId, UUID sessionId, String duty,
                          String rosterSummary, String window) {
        String header = "[judge wake " + wakeRoundId + "] trigger=" + triggerSource
                + " session=" + sessionId;
        return header + "\n" + PROMPT_TEMPLATE.formatted(duty, rosterSummary, window);
    }

    private Map<UUID, String> principalNames(List<SessionParticipant> roster,
                                             List<Message> messages) {
        Set<UUID> ids = new LinkedHashSet<>();
        if (roster != null) {
            for (SessionParticipant row : roster) {
                if (row != null && row.getPrincipalId() != null) {
                    ids.add(row.getPrincipalId());
                }
            }
        }
        if (messages != null) {
            for (Message message : messages) {
                if (message != null && message.getParticipantId() != null) {
                    ids.add(message.getParticipantId());
                }
            }
        }
        if (ids.isEmpty()) {
            return Map.of();
        }
        Map<UUID, String> names = new HashMap<>();
        for (AgentPrincipal principal : agentPrincipalRepository.findAllById(ids)) {
            if (principal != null && principal.getId() != null) {
                names.put(principal.getId(), principal.getName());
            }
        }
        return names;
    }

    private static String sender(Message message, Map<UUID, String> principalNames) {
        String name = message.getParticipantId() == null
                ? null : principalNames.get(message.getParticipantId());
        if (name != null && !name.isBlank()) {
            return name;
        }
        return message.getRole() == null ? "unknown" : message.getRole().name().toLowerCase(Locale.ROOT);
    }

    private static String participantName(SessionParticipant participant,
                                          Map<UUID, String> principalNames) {
        String name = participant.getPrincipalId() == null
                ? null : principalNames.get(participant.getPrincipalId());
        return name == null || name.isBlank() ? orDash(participant.getRole()) : name;
    }

    private static String sanitise(String content) {
        if (content == null) {
            return "";
        }
        return LogRedactor.redact(content).strip();
    }

    private static String orDash(String value) {
        return value == null || value.isBlank() ? "-" : value;
    }

    /** Code-point safe cut — never splits a surrogate pair (spec §4). */
    static String truncate(String text, int maxCodePoints) {
        if (text == null || text.isEmpty() || maxCodePoints <= 0) {
            return "";
        }
        if (codePointCount(text) <= maxCodePoints) {
            return text;
        }
        return text.substring(0, text.offsetByCodePoints(0, maxCodePoints));
    }

    private static int codePointCount(String text) {
        return text.codePointCount(0, text.length());
    }
}
