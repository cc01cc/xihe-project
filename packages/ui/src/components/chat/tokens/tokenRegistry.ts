import type { Component } from 'vue'
import HeadingToken from './HeadingToken.vue'
import ParagraphToken from './ParagraphToken.vue'
import CodeBlockToken from './CodeBlockToken.vue'
import ListToken from './ListToken.vue'
import BlockquoteToken from './BlockquoteToken.vue'
import TableToken from './TableToken.vue'
import InlineTokens from './InlineTokens.vue'
import KatexToken from './KatexToken.vue'
import ThinkToken from './ThinkToken.vue'
import CitationToken from './CitationToken.vue'
import ArtifactToken from './ArtifactToken.vue'
import HrToken from './HrToken.vue'
import SpaceToken from './SpaceToken.vue'
import UnknownToken from './UnknownToken.vue'
import HtmlToken from './HtmlToken.vue'

const registry: Record<string, Component> = {
  heading: HeadingToken,
  paragraph: ParagraphToken,
  code: CodeBlockToken,
  list: ListToken,
  blockquote: BlockquoteToken,
  table: TableToken,
  hr: HrToken,
  space: SpaceToken,
  html: HtmlToken,
  inlineKatex: KatexToken,
  blockKatex: KatexToken,
  think: ThinkToken,
  citation: CitationToken,
  artifact: ArtifactToken,

  // Inline tokens are normally rendered through InlineTokens.vue, but we
  // register a fallback mapping so that a flat token list can still render.
  text: InlineTokens,
  strong: InlineTokens,
  em: InlineTokens,
  codespan: InlineTokens,
  link: InlineTokens,
  image: InlineTokens,
  del: InlineTokens,
  br: InlineTokens,
  escape: InlineTokens,
}

export function resolveTokenComponent(type: string): Component {
  return registry[type] ?? UnknownToken
}

export function registerTokenComponent(type: string, component: Component): void {
  registry[type] = component
}
