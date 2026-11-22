package com.cc01cc.p.xihe.cp.config;

import java.lang.annotation.Documented;
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * task-859 (837a): marks an HTTP handler whose access decision is the <b>atom</b> named here.
 *
 * <p>This is a declaration, not an interceptor: it exists so the route-coverage gate (task-837)
 * can enumerate every {@code RequestMappingHandlerMapping} entry and demand that each one is either
 * annotated with the atom it enforces or listed in the public-route whitelist. Without it a new
 * endpoint can be added with no policy decision and nothing notices; a comment cannot be asserted.</p>
 *
 * <p>{@link #atom()} is the canonical atom string ({@code action:...} / {@code cap:...}) the handler
 * evaluates. {@link #resource()} documents the resource axis when the decision is resource-scoped
 * (empty = the atom's canonical resource). Both are runtime-retained so the gate can read them off
 * the handler method rather than a parallel list that would drift.</p>
 */
@Documented
@Retention(RetentionPolicy.RUNTIME)
@Target({ElementType.METHOD, ElementType.TYPE})
public @interface PolicyChecked {

    /** The canonical atom this endpoint's access decision is built on. */
    String atom();

    /** Optional resource description; empty means the atom's own canonical resource. */
    String resource() default "";
}
