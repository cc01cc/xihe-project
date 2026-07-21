import { inject, provide, type InjectionKey } from 'vue'

export interface MarkdownRenderContext {
  isStreaming: boolean
}

export const markdownContextKey: InjectionKey<MarkdownRenderContext> = Symbol('markdownContext')

export function provideMarkdownContext(context: MarkdownRenderContext): void {
  provide(markdownContextKey, context)
}

export function useMarkdownContext(): { isStreaming: boolean } {
  return inject(markdownContextKey, { isStreaming: false })
}
