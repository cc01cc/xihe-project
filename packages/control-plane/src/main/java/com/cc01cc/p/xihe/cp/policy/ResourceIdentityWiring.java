package com.cc01cc.p.xihe.cp.policy;

import org.springframework.stereotype.Component;

/**
 * task-533：把声明键生产者接成求交器的<b>生产侧</b>解析器。
 *
 * <p>没有这一步，{@code fs:} 声明键在求交时解析不出 {@code phys} 键，会按 521 的 fail-closed
 * 一律拒绝 —— 「构件存在但不在产品路径上」正是 484 死组件的形态，所以接线必须是一等公民而不是
 * 测试里的注入 seam。</p>
 */
@Component
public class ResourceIdentityWiring {

    public ResourceIdentityWiring(GrantIntersectionEvaluator evaluator, FsResourceKeys keys) {
        evaluator.useScopeResolver(keys::scopeFor);
    }
}
