import { describe, expect, it, vi } from 'vitest'

import { createHintCoalescer } from '../userChannelHintCoalescer'

/**
 * PLAN-0660 T5.6 — a burst of `user-events` hints costs exactly ONE roster reload.
 *
 * The badge itself is never touched here: it renders the CP-derived `readCursor.mentionCount`, so the
 * frontend must not count anything. What these cases pin down is the promise from the Lead: same hint
 * three times ⇒ no request storm, and hints for another session are ignored outright.
 */
describe('userChannelHintCoalescer', () => {
    const sessionA = 'session-a'

    it('collapses three hints of one session into a single flush', () => {
        vi.useFakeTimers()
        try {
            const onFlush = vi.fn()
            const coalescer = createHintCoalescer(() => sessionA, { delayMs: 300, onFlush })

            expect(coalescer.push(sessionA, 'participant-1')).toBe(true)
            expect(coalescer.push(sessionA, 'participant-1')).toBe(true)
            expect(coalescer.push(sessionA, 'participant-2')).toBe(true)
            expect(onFlush).not.toHaveBeenCalled()

            vi.advanceTimersByTime(300)
            expect(onFlush).toHaveBeenCalledTimes(1)
        } finally {
            vi.useRealTimers()
        }
    })

    it('ignores hints for a session that is not on screen', () => {
        const onFlush = vi.fn()
        const coalescer = createHintCoalescer(() => sessionA, { delayMs: 300, onFlush })

        expect(coalescer.push('session-b', 'participant-1')).toBe(false)
        expect(coalescer.push('', 'participant-1')).toBe(false)
        expect(coalescer.push(sessionA, '')).toBe(false)
        expect(onFlush).not.toHaveBeenCalled()
    })

    it('opens a fresh window after the previous flush', () => {
        vi.useFakeTimers()
        try {
            const onFlush = vi.fn()
            const coalescer = createHintCoalescer(() => sessionA, { delayMs: 300, onFlush })

            coalescer.push(sessionA, 'participant-1')
            vi.advanceTimersByTime(300)
            coalescer.push(sessionA, 'participant-1')
            vi.advanceTimersByTime(300)

            expect(onFlush).toHaveBeenCalledTimes(2)
        } finally {
            vi.useRealTimers()
        }
    })

    it('dispose drops a pending flush', () => {
        vi.useFakeTimers()
        try {
            const onFlush = vi.fn()
            const coalescer = createHintCoalescer(() => sessionA, { delayMs: 300, onFlush })
            coalescer.push(sessionA, 'participant-1')

            coalescer.dispose()
            vi.advanceTimersByTime(1_000)

            expect(onFlush).not.toHaveBeenCalled()
        } finally {
            vi.useRealTimers()
        }
    })
})
