import { inject, provide, type InjectionKey, type ComputedRef } from 'vue'

export interface MarkdownRenderContext {
  isStreaming: ComputedRef<boolean> | boolean
}

export const markdownContextKey: InjectionKey<MarkdownRenderContext> = Symbol('markdownContext')

export function provideMarkdownContext(context: MarkdownRenderContext): void {
  provide(markdownContextKey, context)
}

export function useMarkdownContext(): { isStreaming: boolean } {
  const injected = inject(markdownContextKey, { isStreaming: false })
  const isStreaming = typeof injected.isStreaming === 'boolean'
    ? injected.isStreaming
    : injected.isStreaming.value
  return { isStreaming }
}
