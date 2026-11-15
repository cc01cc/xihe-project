package com.cc01cc.p.xihe.cp.chat;

import org.springframework.web.servlet.mvc.method.annotation.ResponseBodyEmitter;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * task-269: captures what an {@link SseEmitter} actually hands to the transport, so a fan-out test
 * can assert <b>delivered content</b> instead of "two emitter objects exist".
 *
 * <p>Why reflection: {@code ResponseBodyEmitter.initialize(Handler)} and {@code Handler} are
 * package-private in Spring (spring-webmvc 7.0.10, verified with javap), so a test in this package
 * cannot implement the interface directly. A dynamic proxy for that interface plus one reflective
 * {@code initialize} call is the smallest seam that does not touch production code.
 *
 * <p>What is captured: the objects passed to {@code Handler.send} — for an SSE event that is the
 * event-name/data fragment set, i.e. the payload <b>before</b> HTTP serialization (a Map here, JSON
 * bytes on the wire). The real wire bytes are asserted separately by
 * {@code SseMultiTabIntegrationTest} over an actual socket.
 */
final class SseEmitterCapture {

    private final List<String> frames = new CopyOnWriteArrayList<>();

    private SseEmitterCapture() {
    }

    /** Wires a capturing transport into the emitter; every later send lands in {@link #frames()}. */
    static SseEmitterCapture attach(SseEmitter emitter, IOException failWith) throws Exception {
        SseEmitterCapture capture = new SseEmitterCapture();
        Class<?> handlerType = Class.forName(
                "org.springframework.web.servlet.mvc.method.annotation.ResponseBodyEmitter$Handler");
        Object proxy = Proxy.newProxyInstance(handlerType.getClassLoader(), new Class<?>[] {handlerType},
                (instance, method, args) -> {
                    if ("send".equals(method.getName())) {
                        if (failWith != null) {
                            throw failWith;
                        }
                        capture.record(args);
                    }
                    return null;
                });
        Method initialize = ResponseBodyEmitter.class.getDeclaredMethod("initialize", handlerType);
        initialize.setAccessible(true);
        initialize.invoke(emitter, proxy);
        return capture;
    }

    private void record(Object[] args) {
        if (args == null || args.length == 0) {
            return;
        }
        if (args[0] instanceof Set<?> items) {
            for (Object item : items) {
                if (item instanceof ResponseBodyEmitter.DataWithMediaType data) {
                    frames.add(String.valueOf(data.getData()));
                } else {
                    frames.add(String.valueOf(item));
                }
            }
            return;
        }
        frames.add(String.valueOf(args[0]));
    }

    List<String> frames() {
        return frames;
    }

    /** True when some delivered frame carries the given text (content, not object identity). */
    boolean delivered(String needle) {
        return frames.stream().anyMatch(frame -> frame.contains(needle));
    }
}
