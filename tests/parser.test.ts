import './setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSource, plainText, readPaint, safeLink } from '../src/parser.ts';
import { examples } from '../src/examples.ts';

test('the reference transcription retains all nodes, edges, boundaries, labels, and title', async () => {
  const graph = await parseSource(examples[0].source);
  assert.equal(graph.kind, 'flowchart');
  if (graph.kind !== 'flowchart') return;
  assert.equal(graph.title, 'KidsMealToys deployment flow');
  assert.equal(graph.background, '#f7f2e6');
  assert.equal(graph.nodes.length, 24);
  assert.equal(graph.edges.length, 26);
  assert.equal(graph.groups.length, 5);
  assert.equal(graph.nodes.find(node => node.id === 'service')?.parent, 'bot');
  assert.match(graph.nodes.find(node => node.id === 'service')!.label, /read-only rootfs\n0 capabilities/);
  assert.equal(graph.edges.filter(edge => edge.stroke === 'dotted').length, 3);
  assert.equal(graph.nodes.find(node => node.id === 'rollback')?.paint.fill, '#fff0ee');
});

test('official Mermaid grammar handles nested groups, chained edges, aliases, classes, and metadata', async () => {
  const graph = await parseSource(`---
title: "Nested: example"
---
flowchart RL
  subgraph outer["Outer"]
    subgraph inner["Inner"]
      direction TB
      A["Alpha<br/>Detail"] --> B@{ shape: cyl, label: "Store" }
    end
    C{Ready?}
  end
  B -->|yes| C & D
  style A fill:#112233,color:#ffffff
  linkStyle 1 stroke:#e04040,stroke-width:3px
  click A "https://example.com" "Docs"
`);
  assert.equal(graph.kind, 'flowchart');
  if (graph.kind !== 'flowchart') return;
  assert.equal(graph.title, 'Nested: example');
  assert.equal(graph.direction, 'RL');
  assert.equal(graph.groups.find(group => group.id === 'inner')?.parent, 'outer');
  assert.equal(graph.groups.find(group => group.id === 'inner')?.direction, 'TB');
  assert.equal(graph.nodes.find(node => node.id === 'B')?.shape, 'cylinder');
  assert.equal(graph.nodes.find(node => node.id === 'A')?.label, 'Alpha\nDetail');
  assert.equal(graph.edges.length, 3);
  assert.equal(graph.edges[1].paint.strokeWidth, 3);
});

test('arrow kinds, invisible constraints, and parallel edge identities survive', async () => {
  const graph = await parseSource(`graph LR
    A <--> B
    B o--o C
    C x--x D
    D --- E
    E ~~~ A
    A ==>|heavy| B
  `);
  assert.equal(graph.kind, 'flowchart');
  if (graph.kind !== 'flowchart') return;
  assert.deepEqual(graph.edges.slice(0, 4).map(edge => [edge.startMarker, edge.endMarker]), [
    ['arrow', 'arrow'], ['circle', 'circle'], ['cross', 'cross'], ['none', 'none'],
  ]);
  assert.equal(graph.edges[4].stroke, 'invisible');
  assert.equal(graph.edges[5].stroke, 'thick');
  assert.equal(new Set(graph.edges.map(edge => edge.id)).size, 6);
});

test('non-flowchart diagrams and unsupported shapes have explicit native rendering', async () => {
  const sequence = await parseSource(examples.find(example => example.id === 'sequence')!.source);
  assert.equal(sequence.kind, 'native');
  const shape = await parseSource('flowchart LR\nA@{ shape: cloud, label: "Cloud" } --> B');
  assert.equal(shape.kind, 'native');
  const animation = await parseSource('flowchart LR\n A e1@--> B\n e1@{ animate: true }');
  assert.equal(animation.kind, 'native');
});

test('failed parses do not poison or race later edits', async () => {
  const results = await Promise.allSettled([
    parseSource('flowchart TB\nA["broken'),
    parseSource('flowchart TB\nA[First] --> B'),
    parseSource('flowchart TB\nX[Second] --> Y'),
  ]);
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[1].status, 'fulfilled');
  assert.equal(results[2].status, 'fulfilled');
  if (results[1].status === 'fulfilled' && results[1].value.kind === 'flowchart') {
    assert.deepEqual(results[1].value.nodes.map(node => node.id), ['A', 'B']);
  }
  if (results[2].status === 'fulfilled' && results[2].value.kind === 'flowchart') {
    assert.deepEqual(results[2].value.nodes.map(node => node.id), ['X', 'Y']);
  }
});

test('plain labels, styles, and links cannot inject markup or external paint resources', () => {
  assert.equal(plainText('<b>A &amp; B</b><br/>#9829;'), 'A & B\n\u2665');
  assert.equal(plainText('**Bold** and `code`', true), 'Bold and code');
  assert.deepEqual(readPaint(['fill:url(https://example.com/a)', 'stroke:expression(alert(1))']), {});
  assert.equal(safeLink('javascript:alert(1)'), undefined);
  assert.equal(safeLink('data:text/html,hello'), undefined);
  assert.equal(safeLink('/relative'), undefined);
  assert.equal(safeLink('https://example.com'), 'https://example.com/');
});

test('background metadata is limited to static colors', async () => {
  const graph = await parseSource('---\nconfig:\n  themeVariables:\n    background: "url(https://example.com/a)"\n---\nflowchart TB\nA');
  assert.equal(graph.background, '#fff');
});

test('source and graph size limits fail explicitly', async () => {
  await assert.rejects(parseSource(''), /Add a Mermaid diagram/);
  await assert.rejects(parseSource('x'.repeat(50_001)), /50,000/);
  await assert.rejects(parseSource(`flowchart TB\n${Array.from({ length: 201 }, (_, i) => `n${i}`).join('\n')}`), /200 nodes/);
  const atLimit = await parseSource(`flowchart TB\nsubgraph g[Boundary]\n${Array.from({ length: 199 }, (_, i) => `n${i}`).join('\n')}\nend\nstyle g fill:none,stroke:blue`);
  assert.equal(atLimit.kind, 'flowchart', 'A styled subgraph is counted once, not again as a vertex');
});
