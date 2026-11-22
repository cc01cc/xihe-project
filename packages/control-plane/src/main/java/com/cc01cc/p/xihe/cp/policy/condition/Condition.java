package com.cc01cc.p.xihe.cp.policy.condition;

/**
 * task-863: the <b>MVP baseline shape</b> of a condition — a registered key naming the
 * request-context field it reads.
 *
 * <p>Operators ({@code eq} / {@code neq} / {@code in} / {@code exists} / time window) are
 * deliberately <b>not</b> modelled yet: this card implements only the two fail-closed rules
 * (unregistered key ⇒ deny, missing field ⇒ not satisfied). Adding an operator field before the
 * operator semantics exist would let a condition look evaluated while nothing compares values.
 * Value comparison arrives with the operator implementation (MVP 之后).</p>
 *
 * <p>A null or blank key is accepted by the record on purpose: the baseline reports it as
 * unregistered (deny) instead of throwing, so a malformed condition cannot crash a decision into
 * a 500 or, worse, be skipped.</p>
 */
public record Condition(String key) {
}
