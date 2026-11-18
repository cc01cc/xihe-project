/**
 * 浅拷贝一个普通对象（新对象、同一批嵌套引用）。
 *
 * <p><b>为什么它是个具名函数，而不是各处直接写 <code>{ ...x }</code>：</b>
 * oxlint 的两条现行规则在「map 里浅拷贝元素」这一形态上互斥 ——
 * <code>oxc(no-map-spread)</code> 报「map 回调里 spread 以改属性」，让你改成
 * <code>Object.assign({}, x)</code>；而 <code>eslint(prefer-object-spread)</code> 立刻把
 * <code>Object.assign</code> + 对象字面量报回来（task-37 实测同一行两族互撞）。
 * 把 spread 放进**具名函数**（不在任何 map 回调体内）则两族同时静音，
 * 语义不动（仍是浅拷贝），而且调用点读起来是「拷贝」而不是「展开」。
 * </p>
 *
 * <p><b>不要替换成 <code>structuredClone</code>：</b>那是**深拷贝**，
 * 会让嵌套引用不再共享 ⇒ 快照比较、脏值检测的语义都会变。</p>
 */
export function shallowClone<T extends object>(source: T): T {
    return { ...source };
}
