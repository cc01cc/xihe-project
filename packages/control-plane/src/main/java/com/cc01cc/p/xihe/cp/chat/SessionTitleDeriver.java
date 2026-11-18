package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.entity.Session;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

/**
 * D-1866 / task-24: writes the rule-derived title at the moment a user-facing message of a
 * Session lands. The durable fact is {@code sessions.title}; every surface (UI sidebar, OpenAPI
 * clients, MCP callers, spawned child Sessions that inherit the parent title) reads it from
 * there, so naming on the server is what keeps "one title" true across clients.
 *
 * <p>Two hard constraints, both enforced here:
 * <ol>
 *   <li><b>A manual rename always wins.</b> The write only happens while the row still carries a
 *       {@linkplain SessionTitleRule#isDefaultTitle default} title. The caller
 *       ({@code ChatSubmissionService.persist}) already holds the Session row lock
 *       ({@code SELECT … FOR UPDATE}), and the rename path
 *       ({@code SessionService.updateBinding → lockForDelete}) takes the same lock, so "renamed
 *       first ⇒ we see the new title and skip" and "we wrote first ⇒ the rename blocks and then
 *       wins" are the only two interleavings.</li>
 *   <li><b>Never a blank title.</b> A derivation that yields nothing (blank message, or pure
 *       markdown markers such as {@code ###}) leaves the default title untouched.</li>
 * </ol>
 *
 * <p>Zero model calls: this class must stay dependent on the rule only. Widgets such as a
 * provider client, an LLM call or an event stream would turn a cosmetic field into privacy
 * surface plus cost/latency (D-1866 rationale ②), so none is injected.
 */
@Service
public class SessionTitleDeriver {

    private static final Logger logger = LoggerFactory.getLogger(SessionTitleDeriver.class);

    /**
     * @param session the <b>managed</b> Session row; the caller must already hold its row lock
     * @param content the user-facing message text that just landed
     * @return {@code true} when the title was replaced
     */
    public boolean applyToFirstMessage(Session session, String content) {
        if (session == null || !SessionTitleRule.isDefaultTitle(session.getTitle())) {
            // Renamed by hand (or already derived from an earlier message): leave it alone.
            return false;
        }
        String derived = SessionTitleRule.derive(content);
        if (derived.isEmpty()) {
            // Nothing but markup / blank: the default title is the correct outcome.
            return false;
        }
        session.setTitle(derived);
        // Log the length, never the text: the title is untrusted message content (logging rules).
        logger.info("[LIFECYCLE] service=cp event=session_title_derived sessionId={} source=rule units={}",
                session.getId(), derived.codePointCount(0, derived.length()));
        return true;
    }
}
