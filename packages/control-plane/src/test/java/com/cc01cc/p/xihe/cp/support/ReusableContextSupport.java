package com.cc01cc.p.xihe.cp.support;

/**
 * task-251（A 方案试点）：上下文复用时的"当前测试库"键持有者。
 *
 * <p>解析顺序：HTTP 头 {@code X-XH-Test-DB}（test-only 过滤器写入 request scope）→ 本类 ThreadLocal
 * （测试线程）→ {@link #activeKey()}（volatile，串行试点下"当前类"的键）→ 默认库。
 *
 * <p>为什么需要 {@code activeKey}：被测代码的 HTTP 调用跑在 Tomcat 线程上，ThreadLocal 不跨线程；
 * 试点串行（{@code -DforkCount=1}，一次只有一个测试类），因此"当前类"的静态键足以把请求路由到该类
 * 自己的库 —— 既有测试体因此**一行不用改**。并行/异步场景才必须靠请求头（见设计文档 §2/§4）。
 */
public final class ReusableContextSupport {

    private static final ThreadLocal<String> THREAD_KEY = new ThreadLocal<>();

    private static final String REQUEST_ATTRIBUTE = "xh.test.database.key";

    private static volatile String activeKey;

    private ReusableContextSupport() {
    }

    /** 测试线程与"当前类"都绑定到同一个键（{@code @BeforeAll} 调用）。 */
    public static void bind(String key) {
        if (key == null || key.isBlank()) {
            throw new IllegalArgumentException("test database key must not be blank");
        }
        activeKey = key;
        THREAD_KEY.set(key);
    }

    /** 类结束后清空，避免把键泄漏给别的类（{@code @AfterAll} 调用）。 */
    public static void unbind() {
        THREAD_KEY.remove();
        activeKey = null;
    }

    public static String activeKey() {
        return activeKey;
    }

    /** 解析当前应用异常要用的库键；返回 {@code null} 表示落默认库。 */
    public static String resolveKey() {
        String threadKey = THREAD_KEY.get();
        if (threadKey != null && !threadKey.isBlank()) {
            return threadKey;
        }
        String current = activeKey;
        return current != null && !current.isBlank() ? current : null;
    }

    /** test-only 请求头名：供异步/并行场景显式指定库（普通客户端不会带）。 */
    public static String requestAttributeName() {
        return REQUEST_ATTRIBUTE;
    }
}
