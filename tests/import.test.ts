import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagramSources } from '../src/import.ts';

test('raw Mermaid imports retain their source, including literal fence text', () => {
  const source = 'flowchart LR\n A["```mermaid"] --> B\n';
  assert.deepEqual(diagramSources(`\uFEFF${source}`, 'diagram.mmd'), [source]);
  assert.deepEqual(diagramSources(source, 'diagram.mermaid'), [source]);
  assert.deepEqual(diagramSources('flowchart TB\n A --> B', 'diagram.txt'), ['flowchart TB\n A --> B']);
});

test('Markdown imports extract every Mermaid diagram in document order without prose or other languages', () => {
  const document = [
    '# Design', '', 'Introductory prose.', '', '```javascript', 'const example = 1;', '```', '',
    '```mermaid', '---', 'title: First diagram', '---', 'flowchart LR', ' A --> B', '```', '',
    'More prose.', '', '~~~MERMAID title="Sequence"', 'sequenceDiagram', ' A->>B: Hello', '~~~', '',
  ].join('\r\n');
  assert.deepEqual(diagramSources(document, 'design.MD'), [
    '---\ntitle: First diagram\n---\nflowchart LR\n A --> B',
    'sequenceDiagram\n A->>B: Hello',
  ]);
  assert.deepEqual(diagramSources(document, 'design.txt'), diagramSources(document, 'design.MD'));
});

test('Markdown fences in lists and blockquotes are supported, but nested examples inside longer fences are not diagrams', () => {
  const document = [
    '````markdown', '```mermaid', 'flowchart LR', ' Fake --> Example', '```', '````', '',
    '> ```mermaid', '> flowchart TB', '>  A --> B', '> ```', '',
    '- A list item', '', '  ```mermaid', '  flowchart LR', '   C --> D', '  ```',
  ].join('\n');
  assert.deepEqual(diagramSources(document, 'design.markdown'), ['flowchart TB\n A --> B', 'flowchart LR\n C --> D']);
});

test('CommonMark end-of-file fences and repeated diagrams retain their content', () => {
  const source = 'flowchart LR\n A --> B';
  assert.deepEqual(diagramSources(`\`\`\`mermaid\n${source}`, 'design.mdown'), [source]);
  assert.deepEqual(diagramSources(`\`\`\`mermaid\n${source}\n\`\`\`\n\`\`\`mermaid\n${source}\n\`\`\``, 'design.md'), [source, source]);
});

test('Markdown without diagrams, empty blocks, and excessive block counts have actionable errors', () => {
  assert.throws(() => diagramSources('# No diagrams\n```js\n1 + 1\n```', 'design.md'), /no Mermaid code blocks/);
  assert.throws(() => diagramSources('```mermaid\n \n```', 'design.md'), /code block is empty/);
  assert.throws(() => diagramSources('```mermaid\nflowchart LR\nA\n```\n'.repeat(51), 'design.md'), /at most 50/);
});

test('pasted documents are bounded by UTF-8 bytes before Markdown tokenization', () => {
  assert.throws(() => diagramSources('x'.repeat(200_001)), /smaller than 200 KB/);
  assert.throws(() => diagramSources('\u4e2d'.repeat(70_000)), /smaller than 200 KB/);
  assert.deepEqual(diagramSources(`${'Documentation.\n'.repeat(4_000)}\n\`\`\`mermaid\nflowchart LR\n A --> B\n\`\`\``), ['flowchart LR\n A --> B']);
});
