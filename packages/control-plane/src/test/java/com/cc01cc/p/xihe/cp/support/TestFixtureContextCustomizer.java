package com.cc01cc.p.xihe.cp.support;

import com.cc01cc.p.xihe.cp.CpApplication;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;

import java.util.Arrays;
import java.util.List;

import org.springframework.beans.factory.support.BeanDefinitionRegistry;
import org.springframework.beans.factory.support.RootBeanDefinition;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.test.context.ContextConfigurationAttributes;
import org.springframework.test.context.ContextCustomizer;
import org.springframework.test.context.ContextCustomizerFactory;
import org.springframework.test.context.MergedContextConfiguration;

/**
 * Registers the test-only {@link WorkspaceFixture} for every Spring test context built from
 * {@link CpApplication}, instead of leaving it to the component scan.
 *
 * <p>Why this exists (2026-11-03): {@code WorkspaceFixture} is the only {@code @Component} that
 * lives in test sources, so it is normally discovered by the ordinary classpath scan — and that
 * scan reads <b>files</b> under {@code target/test-classes}, not classes already loaded by the JVM.
 * While a Maven build recompiles this module, the compiler empties that directory before refilling
 * it (measured on this tree: 567 class files → 0 at t+2.4 s → 567 again at t+7.5 s). A context
 * created inside that window silently scans no test component at all, so the fixture is missing and
 * every test of that class fails with "No qualifying bean of type WorkspaceFixture" — the
 * order-dependent, "a different victim every run" symptom this customizer removes.
 *
 * <p>The definition is registered before configuration-class processing, under the name and bean
 * class the scanner itself would produce, so {@code ClassPathBeanDefinitionScanner} treats the
 * scanned candidate as compatible and skips it: no duplicate definitions, and after the class has
 * been loaded once the fixture no longer depends on a directory listing. Loading is lazy, so
 * contexts that never inject the fixture never instantiate it.
 *
 * <p>Registered in {@code META-INF/spring.factories} (test resources), which is the supported way to
 * contribute a {@link ContextCustomizer} to every Spring test context without annotating each test
 * class.
 */
public final class TestFixtureContextCustomizer implements ContextCustomizerFactory {

    /** The bean name the component scan would have produced for {@link WorkspaceFixture}. */
    static final String BEAN_NAME = "workspaceFixture";

    @Override
    public ContextCustomizer createContextCustomizer(
            Class<?> testClass, List<ContextConfigurationAttributes> configAttributes) {
        return new FixtureCustomizer();
    }

    /** Stateless: equal instances keep the Spring Test context cache sharing working. */
    static final class FixtureCustomizer implements ContextCustomizer {

        @Override
        public void customizeContext(ConfigurableApplicationContext context,
                                     MergedContextConfiguration mergedConfig) {
            TestClasspathGuard.reportIfClasspathChanged();
            if (!Arrays.asList(mergedConfig.getClasses()).contains(CpApplication.class)) {
                return; // sliced/probe contexts do not host the fixture
            }
            if (!(context.getBeanFactory() instanceof BeanDefinitionRegistry registry)) {
                return;
            }
            if (registry.containsBeanDefinition(BEAN_NAME)) {
                return;
            }
            RootBeanDefinition definition = new RootBeanDefinition(WorkspaceFixture.class);
            definition.setLazyInit(true);
            registry.registerBeanDefinition(BEAN_NAME, definition);
        }

        @Override
        public boolean equals(Object other) {
            return other != null && getClass() == other.getClass();
        }

        @Override
        public int hashCode() {
            return getClass().hashCode();
        }
    }
}
