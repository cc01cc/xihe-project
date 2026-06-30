import type { MarkedExtension, TokenizerExtension } from 'marked'

const ARTIFACT_REGEX = /^<artifact\b[^>]*>[\s\S]*?<\/artifact>/

export interface ArtifactToken {
  type: 'artifact'
  raw: string
  identifier: string
  artifactType: string
  title: string
  content: string
}

export function artifactExtension(): MarkedExtension {
  const artifact: TokenizerExtension = {
    name: 'artifact',
    level: 'block',
    start(src: string) {
      return src.indexOf('<artifact')
    },
    tokenizer(src: string) {
      const match = ARTIFACT_REGEX.exec(src)
      if (!match) return undefined
      const raw = match[0]
      const openMatch = raw.match(/^<artifact\b([^>]*)>/)
      const attrs = openMatch?.[1] ?? ''
      const identifierMatch = attrs.match(/identifier=["']([^"']+)["']/)
      const typeMatch = attrs.match(/type=["']([^"']+)["']/)
      const titleMatch = attrs.match(/title=["']([^"']+)["']/)
      const closeIndex = raw.lastIndexOf('</artifact>')
      const content = closeIndex > 0 ? raw.slice(openMatch?.[0].length ?? 0, closeIndex) : ''
      return {
        type: 'artifact',
        raw,
        identifier: identifierMatch?.[1] ?? '',
        artifactType: typeMatch?.[1] ?? '',
        title: titleMatch?.[1] ?? '',
        content,
      } as ArtifactToken as unknown as ReturnType<TokenizerExtension['tokenizer']>
    },
  }

  return { extensions: [artifact] }
}
