import './setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ELK from 'elkjs/lib/elk.bundled.js';
import { parseSource } from '../src/parser.ts';
import { examples } from '../src/examples.ts';
import { buildStructure } from '../src/structure.ts';
import { layoutGraph } from '../src/layout.ts';
import { BOUNDARY_ROUTE_GAP, CROSS_ROUTE_GAP } from '../src/routing.ts';
import { renderDiagram } from '../src/render.ts';
import { wrapText, approximateMeasure } from '../src/text.ts';
import type { Box, DiagramLayout, FlowGraph, Point } from '../src/model.ts';

const engine = new ELK();

async function graph(source: string): Promise<FlowGraph> {
  const result = await parseSource(source);
  assert.equal(result.kind, 'flowchart');
  if (result.kind !== 'flowchart') throw new Error('Expected a flowchart');
  return result;
}

function overlaps(a: Box, b: Box): boolean {
  return a.x + 0.1 < b.x + b.width && b.x + 0.1 < a.x + a.width
    && a.y + 0.1 < b.y + b.height && b.y + 0.1 < a.y + a.height;
}

function longSegments(paths: Point[][]): { axis: 'x' | 'y'; constant: number; low: number; high: number }[] {
  return paths.flatMap(path => path.slice(1).map((b, index) => {
    const a = path[index];
    const vertical = Math.abs(a.x - b.x) < 0.01;
    return {
      axis: vertical ? 'x' as const : 'y' as const,
      constant: vertical ? a.x : a.y,
      low: vertical ? Math.min(a.y, b.y) : Math.min(a.x, b.x),
      high: vertical ? Math.max(a.y, b.y) : Math.max(a.x, b.x),
    };
  })).filter(segment => segment.high - segment.low > 30);
}

function parallelGap(a: ReturnType<typeof longSegments>[number], b: ReturnType<typeof longSegments>[number]): number {
  if (a.axis !== b.axis || Math.min(a.high, b.high) - Math.max(a.low, b.low) < 30) return Infinity;
  return Math.abs(a.constant - b.constant);
}

function assertLayout(layout: DiagramLayout): void {
  for (const box of [...layout.nodes, ...layout.groups, ...layout.sections, ...layout.edges.flatMap(edge => edge.label ? [edge.label] : [])]) {
    assert.ok([box.x, box.y, box.width, box.height].every(Number.isFinite));
    assert.ok(box.x >= 0 && box.y >= 0);
    assert.ok(box.x + box.width <= layout.width + 0.1);
    assert.ok(box.y + box.height <= layout.height + 0.1);
  }
  for (let i = 0; i < layout.nodes.length; i++) {
    for (const other of layout.nodes.slice(i + 1)) {
      assert.equal(overlaps(layout.nodes[i], other), false, `${layout.nodes[i].node.id} overlaps ${other.node.id}`);
    }
    const node = layout.nodes[i];
    if (node.node.parent) {
      const parent = layout.groups.find(group => group.group.id === node.node.parent)!;
      assert.ok(parent, 'Every declared parent is preserved');
      assert.ok(node.x >= parent.x && node.y >= parent.y);
      assert.ok(node.x + node.width <= parent.x + parent.width + 0.1);
      assert.ok(node.y + node.height <= parent.y + parent.height + 0.1);
    }
  }
  for (const group of layout.groups.filter(group => group.depth >= 0)) {
    for (const line of group.lines) assert.ok(approximateMeasure(line, 16) <= group.width - 20, 'Group titles fit their boundary');
  }
  for (const route of layout.edges) {
    for (const points of route.paths) for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      assert.ok(Math.abs(a.x - b.x) < 0.01 || Math.abs(a.y - b.y) < 0.01, 'Routes remain orthogonal');
      for (const node of layout.nodes) {
        if (node.node.id === route.edge.source || node.node.id === route.edge.target) continue;
        const box = { x: node.x + 1, y: node.y + 1, width: node.width - 2, height: node.height - 2 };
        const enters = Math.abs(a.x - b.x) < 0.01
          ? a.x > box.x && a.x < box.x + box.width && Math.max(a.y, b.y) > box.y && Math.min(a.y, b.y) < box.y + box.height
          : a.y > box.y && a.y < box.y + box.height && Math.max(a.x, b.x) > box.x && Math.min(a.x, b.x) < box.x + box.width;
        assert.equal(enters, false, `${route.edge.id} passes through ${node.node.id}`);
      }
    }
    if (route.label) for (const node of layout.nodes) {
      assert.equal(overlaps(route.label, node), false, `${route.edge.id} label overlaps ${node.node.id}`);
    }
  }
  assert.equal(layout.nodes.length, layout.graph.nodes.length);
  const visible = layout.graph.edges.filter(edge => edge.stroke !== 'invisible');
  const represented = layout.edges.filter(edge => edge.edge.stroke !== 'invisible').map(edge => edge.edge.id);
  assert.equal(represented.length, visible.length);
  assert.equal(new Set(represented).size, visible.length);
  const svg = renderDiagram(layout, () => {});
  assert.equal(svg.querySelectorAll('.node').length, layout.graph.nodes.length);
  assert.equal(svg.querySelectorAll('.edge').length, visible.length);
  for (const link of layout.structure.crossLinks) {
    const arrow = svg.querySelector(`.edge[data-edge="${link.edge.id}"]`)!;
    assert.ok(arrow, 'Each cross-region connection is an actual arrow');
    assert.equal(arrow.getAttribute('data-source'), link.edge.source);
    assert.equal(arrow.getAttribute('data-target'), link.edge.target);
  }
  assert.equal(svg.querySelectorAll('script, foreignObject, image, .reference, .overview-card').length, 0);
}

test('reference diagram separates control, deployment, and independently rooted production traffic', async () => {
  const input = await graph(examples[0].source);
  const structure = buildStructure(input);
  assert.equal(structure.sections.length, 3);
  const sectionFor = (id: string) => structure.sectionByEntity.get(id);
  assert.equal(sectionFor('user'), sectionFor('helper'));
  assert.equal(sectionFor('repo'), sectionFor('success'));
  assert.equal(sectionFor('browser'), sectionFor('app'));
  assert.notEqual(sectionFor('helper'), sectionFor('repo'));
  assert.notEqual(sectionFor('repo'), sectionFor('app'));
  assert.equal(structure.crossLinks.length, 5);
});

test('automatic grouping is independent of node IDs and domain vocabulary', async () => {
  const input = await graph(examples[0].source);
  const renames = new Map([...input.nodes, ...input.groups].map((entity, index) => [entity.id, `q${index}`]));
  const renamed: FlowGraph = {
    ...input,
    nodes: input.nodes.map(node => ({ ...node, id: renames.get(node.id)!, label: 'Node', parent: node.parent ? renames.get(node.parent) : undefined })),
    groups: input.groups.map(group => ({ ...group, id: renames.get(group.id)!, label: 'Group', parent: group.parent ? renames.get(group.parent) : undefined })),
    edges: input.edges.map(edge => ({ ...edge, source: renames.get(edge.source)!, target: renames.get(edge.target)!, label: '' })),
  };
  const a = buildStructure(input);
  const b = buildStructure(renamed);
  assert.deepEqual(a.sections.map(section => section.nodeIds.map(id => renames.get(id))), b.sections.map(section => section.nodeIds));
});

test('all shipped flowcharts preserve graph entities and non-overlapping geometry in both label modes', async () => {
  for (const example of examples.filter(example => example.id !== 'sequence')) {
    const input = await graph(example.source);
    for (const detail of [false, true]) {
      const layout = await layoutGraph(input, engine, { automatic: true, detail });
      assertLayout(layout);
    }
  }
});

test('declared-only grouping, cycles, self-loops, parallel edges, disconnected nodes and empty groups', async () => {
  const input = await graph(`flowchart TB
    subgraph outer[Boundary]
      subgraph inner[Inner boundary]
        A[Alpha] --> B{Ready?}
        B -->|yes| A
        B -. retry .-> B
        A --> B
      end
      C[Third]
    end
    D[Separate]
    subgraph empty[Empty boundary]
    end
    B --> C
  `);
  const layout = await layoutGraph(input, engine, { automatic: false, detail: true });
  assertLayout(layout);
  assert.equal(layout.groups.length, 3);
  assert.equal(layout.structure.sections.length, 3);
});

test('all four source directions are retained within a section', async () => {
  for (const direction of ['TB', 'BT', 'LR', 'RL']) {
    const layout = await layoutGraph(await graph(`flowchart ${direction}\n A --> B --> C`), engine, { automatic: true, detail: false });
    const a = layout.nodes.find(node => node.node.id === 'A')!;
    const c = layout.nodes.find(node => node.node.id === 'C')!;
    assert.ok(direction === 'TB' ? a.y < c.y : direction === 'BT' ? a.y > c.y : direction === 'LR' ? a.x < c.x : a.x > c.x);
    assertLayout(layout);
  }
});

test('a declared section direction overrides the diagram direction when lifted into a section', async () => {
  const input = await graph('flowchart TB\nsubgraph g[Group]\ndirection LR\nA --> B --> C\nend');
  const layout = await layoutGraph(input, engine, { automatic: true, detail: true });
  assertLayout(layout);
  const a = layout.nodes.find(node => node.node.id === 'A')!;
  const c = layout.nodes.find(node => node.node.id === 'C')!;
  assert.ok(a.x < c.x);
  assert.equal(a.y, c.y);
});

test('subgraph endpoints are not silently replaced by arbitrary member nodes', async () => {
  const input = await graph(`flowchart TB
    subgraph cluster[Workers]
      A --> B
    end
    cluster --> C
    D --> cluster
  `);
  const layout = await layoutGraph(input, engine, { automatic: false, detail: true });
  assertLayout(layout);
  assert.equal(layout.graph.edges[1].source, 'cluster');
  assert.equal(layout.graph.edges[2].target, 'cluster');
});

test('multiple arrows retain a subgraph endpoint with a long title', async () => {
  const input = await graph(`flowchart TB
    subgraph cluster[A long declared group title that wraps across multiple header lines]
      A --> B
    end
    cluster --> C & D & E & F & G & H
  `);
  const layout = await layoutGraph(input, engine, { automatic: false, detail: true });
  assertLayout(layout);
  assert.equal(layout.edges.filter(edge => edge.crossSection).length, 6);
});

test('long unbroken labels and Unicode are wrapped without losing characters', () => {
  const text = 'abcdefghijklmnopqrstuvwxyz'.repeat(3);
  const lines = wrapText(text, 100, 13, approximateMeasure);
  assert.equal(lines.join(''), text);
  assert.ok(lines.every(line => approximateMeasure(line, 13) <= 100));
  assert.equal(wrapText('\u4e2d\u6587\u6e2c\u8a66', 30, 13, approximateMeasure).join(''), '\u4e2d\u6587\u6e2c\u8a66');
});

test('authored safe links remain SVG links rather than application panels', async () => {
  const input = await graph('flowchart LR\nA[Docs] --> B\nclick A "https://example.com"');
  const layout = await layoutGraph(input, engine, { automatic: true, detail: true });
  const svg = renderDiagram(layout, () => {});
  const link = svg.querySelector('a.node');
  assert.equal(link?.getAttribute('href'), 'https://example.com/');
  assert.equal(link?.getAttribute('rel'), 'noopener noreferrer');
});

test('the complete deployment diagram stays compact without collapsed steps or reference lookups', async () => {
  const input = await graph(examples[0].source);
  const layout = await layoutGraph(input, engine, { automatic: true, detail: true });
  const referenceScale = Math.min(1968 / layout.width, 1330 / layout.height, 1);
  assert.ok(12.5 * referenceScale >= 11, 'Full labels remain readable at the supplied reference image size');
  assert.equal(layout.edges.length, 26);
  assert.equal(layout.nodes.length, 24);
  for (const node of layout.nodes) {
    assert.equal(node.lines.map(line => line.text).join('').replace(/\s/g, ''), node.node.label.replace(/\s/g, ''));
  }
});

test('dashed return paths have real spacing and separate arrival points', async () => {
  const layout = await layoutGraph(await graph(examples[0].source), engine, { automatic: true, detail: true });
  const returns = layout.edges.filter(edge => edge.crossSection && edge.edge.stroke === 'dotted');
  assert.equal(returns.length, 3);
  const arrivals = returns.map(edge => edge.paths.at(-1)!.at(-1)!);
  assert.equal(new Set(arrivals.map(point => `${point.x},${point.y}`)).size, 3, 'Returns must not collapse onto one port');
  for (let i = 0; i < returns.length; i++) for (const other of returns.slice(i + 1)) {
    for (const a of longSegments(returns[i].paths)) for (const b of longSegments(other.paths)) {
      assert.ok(parallelGap(a, b) >= CROSS_ROUTE_GAP - 0.1, `${returns[i].edge.source}/${other.edge.source} have only ${parallelGap(a, b)}px clearance`);
    }
  }
  for (const edge of layout.edges.filter(edge => edge.crossSection)) {
    for (const group of layout.groups) {
      const bounds: Point[] = [
        { x: group.x, y: group.y }, { x: group.x + group.width, y: group.y },
        { x: group.x + group.width, y: group.y + group.height },
        { x: group.x, y: group.y + group.height }, { x: group.x, y: group.y },
      ];
      for (const a of longSegments(edge.paths)) for (const b of longSegments([bounds])) {
        assert.ok(parallelGap(a, b) >= BOUNDARY_ROUTE_GAP - 0.1, `${edge.edge.source} hugs ${group.group.id}'s border`);
      }
    }
  }
});
