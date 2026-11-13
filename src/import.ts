import { lexer, walkTokens } from 'marked';

export const MAX_IMPORT_BYTES = 200_000;
const MAX_DIAGRAMS = 50;

export function diagramSources(contents: string, name: string): string[] {
  const source = contents.replace(/^\uFEFF/, '');
  if (/\.(?:mmd|mermaid)$/i.test(name)) return [source];
  const diagrams: string[] = [];
  walkTokens(lexer(source), token => {
    if (token.type === 'code' && /^mermaid(?:\s|$)/i.test(token.lang ?? '')) {
      diagrams.push(token.text);
    }
  });
  if (diagrams.length > MAX_DIAGRAMS) {
    throw new Error('Open a Markdown file with at most 50 Mermaid diagrams at a time.');
  }
  if (diagrams.some(value => !value.trim())) throw new Error('A Mermaid code block is empty. Add a diagram or remove that block.');
  if (diagrams.length) return diagrams;
  if (/\.(?:md|markdown|mdown)$/i.test(name)) {
    throw new Error('This Markdown file has no Mermaid code blocks. Start a fenced code block with ```mermaid.');
  }
  return [source];
}
