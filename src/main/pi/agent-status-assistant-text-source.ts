/** The dashboard preview's assistant-text extractor, emitted into the generated extension. */
export function getAgentStatusAssistantTextSourceLines(): string[] {
  return [
    '// Why: pi assistant messages carry content as an array of parts',
    "// ({ type: 'text', text } / tool_use / tool_result / reasoning). We only",
    "// surface the concatenated text parts as the visible 'last assistant",
    "// message' for the dashboard preview — tool_use / reasoning would be",
    '// noise (the dashboard already shows the active tool name + input).',
    'function extractAssistantText(message: unknown): string {',
    "  if (!message || typeof message !== 'object') return ''",
    '  const content = (message as { content?: unknown }).content',
    "  if (typeof content === 'string') return content",
    "  if (!Array.isArray(content)) return ''",
    "  let out = ''",
    '  for (const part of content) {',
    "    if (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text') {",
    '      const text = (part as { text?: unknown }).text',
    "      if (typeof text === 'string') out += text",
    '    }',
    '  }',
    '  return out',
    '}',
    ''
  ]
}
