package com.cc01cc.p.xihe.cp.context.service;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class ContextInjectionRenderTest {

    @Test
    void rendersSingleRootPath() {
        String html = ContextInjectionRender.renderAgentsChain(List.of(
                new ContextInjectionRender.SourceEntry("AGENTS.md", "be kind")));
        assertThat(html).contains("----- AGENTS.md -----");
        assertThat(html).contains("be kind");
        assertThat(html).contains("<system-reminder>");
    }

    @Test
    void sortsPathsStably() {
        var sorted = ContextInjectionRender.sortStable(List.of(
                new ContextInjectionRender.SourceEntry("b/AGENTS.md", "b"),
                new ContextInjectionRender.SourceEntry("AGENTS.md", "a")));
        assertThat(sorted).extracting(ContextInjectionRender.SourceEntry::path)
                .containsExactly("AGENTS.md", "b/AGENTS.md");
    }
}
