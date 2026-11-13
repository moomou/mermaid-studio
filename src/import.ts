import { lexer, walkTokens } from 'marked';

export const MAX_DOCUMENT_BYTES = 200_000;
const MAX_DIAGRAMS = 50;

export function diagramSources(contents: string, name = ''): string[] {
  if (contents.length > MAX_DOCUMENT_BYTES || new TextEncoder().encode(contents).byteLength > MAX_DOCUMENT_BYTES) {
    throw new Error('Use a Mermaid or Markdown document smaller than 200 KB.');
  }
  const source = contents.replace(/^\uFEFF/, '');
  if (/\.(?:mmd|mermaid)$/i.test(name)) return [source];
  const diagrams: string[] = [];
  walkTokens(lexer(source), token => {
    if (token.type === 'code' && /^mermaid(?:\s|$)/i.test(token.lang ?? '')) {
      diagrams.push(token.text);
    }
  });
  if (diagrams.length > MAX_DIAGRAMS) {
    throw new Error('Use at most 50 Mermaid blocks in one Markdown document.');
  }
  if (diagrams.some(value => !value.trim())) throw new Error('A Mermaid code block is empty. Add a diagram or remove that block.');
  if (diagrams.length) return diagrams;
  if (/\.(?:md|markdown|mdown)$/i.test(name)) {
    throw new Error('This Markdown file has no Mermaid code blocks. Start a fenced code block with ```mermaid.');
  }
  return [source];
}
