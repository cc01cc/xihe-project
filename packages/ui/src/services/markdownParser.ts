import { Marked, type Token, type TokensList } from 'marked'
import { katexExtension } from './markedKatexExtension'
import { thinkExtension } from './markedThinkExtension'
import { citationExtension } from './markedCitationExtension'
import { artifactExtension } from './markedArtifactExtension'

export type MarkdownToken = Token
export type MarkdownTokensList = TokensList

export interface MarkdownParser {
  parse(content: string): MarkdownTokensList
  parseStreaming(content: string): MarkdownTokensList
}

const BASE_MARKED_OPTIONS = {
  gfm: true,
  html: false,
  breaks: false,
} as const

const completeMarked = new Marked(BASE_MARKED_OPTIONS)
completeMarked.use(katexExtension())
completeMarked.use(citationExtension())
completeMarked.use(thinkExtension())
completeMarked.use(artifactExtension())

const streamingMarked = new Marked(BASE_MARKED_OPTIONS)
streamingMarked.use(citationExtension())
streamingMarked.use(thinkExtension())
streamingMarked.use(artifactExtension())

export class MarkedParser implements MarkdownParser {
  parse(content: string): MarkdownTokensList {
    return completeMarked.lexer(content)
  }

  parseStreaming(content: string): MarkdownTokensList {
    return streamingMarked.lexer(content)
  }
}

export function createMarkdownParser(): MarkdownParser {
  return new MarkedParser()
}
