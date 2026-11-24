package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;

/**
 * task-993: the browser face is visible to the approval workflow and can never be auto-allowed.
 *
 * <p>The refutation for this card flips one of these: adding a {@code browser_*} name to
 * {@code AUTO_ALLOW_TOOLS} turns {@link #browserToolsAreNeverInTheAutoAllowSet()} red, and
 * removing the {@code isBrowserTool} floor in {@code PolicyEngine} turns
 * {@link #autoModeStillAsksWithoutAnAllowedByBypass()} red.</p>
 */
class BrowserToolPolicyTest {

    private static final Set<String> BROWSER_TOOLS = Set.of(
            "browser_navigate", "browser_snapshot", "browser_click", "browser_take_screenshot");

    private PolicyEngine engineOf(PolicyContext context) {
        PolicyContextProvider provider = (userId, workspaceId, sessionId) -> context;
        return new PolicyEngine(mock(AuditLogger.class), provider);
    }

    private PolicyEngine manualEngine() {
        return new PolicyEngine(mock(AuditLogger.class), new BuiltinPolicyContextProvider());
    }

    @Test
    void exactlyFourBrowserToolsAreClassified() {
        assertEquals(BROWSER_TOOLS, ToolFaceRegistry.browserTools());
        ToolFaceRegistry registry = new ToolFaceRegistry();
        for (String tool : BROWSER_TOOLS) {
            assertTrue(registry.known(tool), tool + " must be classified");
            assertEquals(ToolFaceRegistry.ACTION_NETWORK, registry.faceOf(tool).actionClass());
        }
        // Everything outside the four-tool slice stays off the surface entirely.
        for (String forbidden : List.of(
                "browser_evaluate", "browser_run_code_unsafe", "browser_cookie_set",
                "browser_tabs", "browser_route", "browser_upload")) {
            assertFalse(ToolFaceRegistry.isBrowserTool(forbidden), forbidden + " must not be browser-classified");
            assertEquals(PolicyLayer.UNCLASSIFIED_ACTION, registry.faceOf(forbidden).actionClass());
        }
    }

    @Test
    void browserToolsAreNeverInTheAutoAllowSet() {
        for (String tool : BROWSER_TOOLS) {
            assertFalse(PolicyEngine.autoAllowTools().contains(tool),
                    tool + " must never be auto-allowed");
        }
    }

    @Test
    void manualModeAsks() {
        PolicyEngine engine = manualEngine();
        for (String tool : BROWSER_TOOLS) {
            PolicyVerdict verdict = engine.evaluateVerdict(tool, "{}", "s1", null, null, null);
            assertEquals(PolicyEffect.ASK, verdict.effect(), tool);
            assertEquals(LayeredPolicyResolver.MODE_MANUAL, verdict.mode(), tool);
            assertNull(verdict.allowedBy(), tool);
        }
    }

    @Test
    void autoModeStillAsksWithoutAnAllowedByBypass() {
        PolicyEngine engine = manualEngine();
        for (String tool : BROWSER_TOOLS) {
            PolicyVerdict verdict = engine.evaluateVerdict(tool, "{}", "s1",
                    LayeredPolicyResolver.MODE_AUTO, null, null);
            assertEquals(PolicyEffect.ASK, verdict.effect(), tool);
            assertEquals(LayeredPolicyResolver.MODE_AUTO, verdict.mode(), tool);
            // The whole point of the floor: `auto` must not tag this call for a materialized rule.
            assertNull(verdict.allowedBy(), tool + " must not carry an auto bypass");
            assertTrue(verdict.reason().contains("browser control always requires approval"), tool);
        }
    }

    @Test
    void persistedAskListWithoutNetworkCannotRelaxTheBrowserFace() {
        // Simulates a workspace/session config that removes `network` from the ask list. A
        // plain network tool would then fall through to ALLOW; browser control must still ask.
        PolicyContext context = new PolicyContext(Map.of(), null, null, null,
                List.of("write", "exec", "delete"), PolicyLayer.WORKSPACE);
        PolicyEngine engine = engineOf(context);

        PolicyVerdict browser = engine.evaluateVerdict("browser_navigate", "{}", "s1", null, "u1", "ws1");
        assertEquals(PolicyEffect.ASK, browser.effect());

        PolicyVerdict webFetch = engine.evaluateVerdict("web_fetch", "{}", "s1", null, "u1", "ws1");
        assertEquals(PolicyEffect.ALLOW, webFetch.effect(),
                "control: a plain network tool is still mode-resolved by the ask list");
    }
}
