import { runtimeError, type ProviderCitationContent, type ProviderContent } from '@praxis/core-sdk'

/**
 * Converts structured history into a text-capable Provider input without silently
 * discarding semantic blocks. Binary references require a future artifact resolver.
 */
export function providerContentText(content: ProviderContent): string {
  if (typeof content === 'string') return content
  const unsupported = new Set<string>()
  let output = ''
  for (const block of content) {
    switch (block.type) {
      case 'text':
        output += block.text
        break
      case 'reasoning':
        output = appendSemanticBlock(output, `[reasoning]\n${block.text}\n[/reasoning]`)
        break
      case 'citation':
        output = appendSemanticBlock(
          output,
          `[citation]${JSON.stringify(citationValue(block))}[/citation]`,
        )
        break
      case 'image_ref':
      case 'audio_ref':
        unsupported.add(block.type)
        break
      case 'tool_call':
        // Tool calls are carried through each Provider's native tool-call field.
        break
    }
  }
  if (unsupported.size > 0) {
    const unsupportedBlocks = [...unsupported].sort()
    throw runtimeError(
      'PROVIDER_CAPABILITY_UNSUPPORTED',
      'provider',
      `The selected provider adapter cannot resolve these content blocks: ${unsupportedBlocks.join(', ')}.`,
      { unsupportedBlocks },
    )
  }
  return output
}

function appendSemanticBlock(output: string, block: string): string {
  return `${output}${output && !output.endsWith('\n') ? '\n' : ''}${block}\n`
}

function citationValue(block: ProviderCitationContent): Record<string, string | number> {
  return {
    ...(block.title === undefined ? {} : { title: block.title }),
    ...(block.url === undefined ? {} : { url: block.url }),
    ...(block.artifactId === undefined ? {} : { artifactId: block.artifactId }),
    ...(block.startIndex === undefined ? {} : { startIndex: block.startIndex }),
    ...(block.endIndex === undefined ? {} : { endIndex: block.endIndex }),
  }
}
