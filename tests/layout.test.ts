import './setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ELK from 'elkjs/lib/elk.bundled.js';
import { parseSource } from '../src/parser.ts';
import { examples } from '../src/examples.ts';
import { buildStructure } from '../src/structure.ts';
import { layoutGraph } from '../src/layout.ts';
import { routeConnections } from '../src/routing.ts';
import { renderDiagram } from '../src/render.ts';
import { wrapText, approximateMeasure, NODE_FONT_SIZE } from '../src/text.ts';
import type { Box, DiagramLayout, FlowGraph } from '../src/model.ts';
import { renderingCases } from './fixtures/rendering-cases.ts';
import { curveBounds, curveCost, curveIntersectsBox, flattenCurve, insideNode } from '../src/curves.ts';
import { curveMetrics } from './route-metrics.ts';

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
    if (group.caption) {
      assert.ok(group.caption.x >= 0 && group.caption.y >= 0);
      for (const node of layout.nodes) assert.equal(overlaps(group.caption, node), false, 'A container heading must not cover a node');
    }
  }
  for (const route of layout.edges.filter(edge => edge.edge.stroke !== 'invisible')) {
    assert.ok(route.curves?.length, 'Visible connections have actual curve geometry');
    assert.equal(curveMetrics(route.curves!).sharpJoins, 0, 'Connections have continuous tangents, not hidden hard corners');
    const last = route.curves!.at(-1)!;
    for (const [id, point] of [[route.edge.source, route.curves![0].start], [route.edge.target, last.segments.at(-1)!.end]] as const) {
      const group = layout.groups.find(group => group.group.id === id);
      if (!group) continue;
      assert.ok(point.x >= group.x - 0.1 && point.x <= group.x + group.width + 0.1
        && point.y >= group.y - 0.1 && point.y <= group.y + group.height + 0.1);
      const boundaryDistance = Math.min(Math.abs(point.x - group.x), Math.abs(point.x - group.x - group.width),
        Math.abs(point.y - group.y), Math.abs(point.y - group.y - group.height));
      assert.ok(boundaryDistance <= 0.1, `${route.edge.id} is detached from its final subgraph boundary`);
    }
    for (const curve of route.curves!) {
      const points = flattenCurve(curve, 0.05);
      for (const point of points) {
        assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
        assert.ok(point.x >= -0.1 && point.y >= -0.1 && point.x <= layout.width + 0.1 && point.y <= layout.height + 0.1);
      }
      for (const node of layout.nodes) {
        if (node.node.id === route.edge.source || node.node.id === route.edge.target) {
          assert.equal(points.some(point => insideNode(point, node)), false, `${route.edge.id} returns through its own endpoint ${node.node.id}`);
          continue;
        }
        const box = { x: node.x + 1, y: node.y + 1, width: node.width - 2, height: node.height - 2 };
        assert.equal(curveIntersectsBox(curve, box), false, `${route.edge.id} passes through ${node.node.id}`);
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

test('cross-region routing uses bounded scratch memory without changing routes', async () => {
  const input = await graph(examples[0].source);
  const layout = await layoutGraph(input, engine, { automatic: true, detail: true, strategy: 'regions' });
  const inputLayout = structuredClone(layout);
  inputLayout.edges = inputLayout.edges.filter(edge => !edge.crossSection);
  const expectedLayout = structuredClone(inputLayout);
  routeConnections(expectedLayout, approximateMeasure);
  const expected = expectedLayout.edges.filter(edge => edge.crossSection);
  let allocatedBytes = 0;
  const floatArrays = globalThis.Float64Array;
  const integerArrays = globalThis.Int32Array;
  const track = <T extends typeof Float64Array | typeof Int32Array>(constructor: T): T => new Proxy(constructor, {
    construct(target, args) {
      const array = Reflect.construct(target, args);
      allocatedBytes += array.byteLength;
      return array;
    },
  });
  globalThis.Float64Array = track(floatArrays);
  globalThis.Int32Array = track(integerArrays);
  try {
    routeConnections(inputLayout, approximateMeasure);
  } finally {
    globalThis.Float64Array = floatArrays;
    globalThis.Int32Array = integerArrays;
  }
  assert.deepEqual(inputLayout.edges.filter(edge => edge.crossSection), expected);
  const maximumScratchBytes = 160_000 * 2 * (Float64Array.BYTES_PER_ELEMENT + Int32Array.BYTES_PER_ELEMENT);
  assert.ok(allocatedBytes <= maximumScratchBytes, `Routing allocated ${allocatedBytes} scratch bytes`);
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
  const layout = await layoutGraph(input, engine, { automatic: false, detail: true, strategy: 'regions' });
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
  const layout = await layoutGraph(input, engine, { automatic: false, detail: true, strategy: 'regions' });
  assertLayout(layout);
  assert.equal(layout.edges.filter(edge => edge.crossSection).length, 6);
});

test('group endpoint ports follow nested boundaries enlarged by internal feedback in every direction', async () => {
  for (const direction of ['TB', 'BT', 'LR', 'RL']) {
    const input = await graph(`flowchart ${direction}
      S[Source] --> outer
      subgraph outer[Workflow]
        U[Entry] --> inner
        subgraph inner[Processing]
          A[Start] --> B[Finish]
          B -. retry .-> A
        end
        inner --> Z[Exit]
        inner -. status .-> U
      end
      outer --> F[End]
      outer -. report .-> S
    `);
    const layout = await layoutGraph(input, engine, { automatic: true, detail: true });
    assertLayout(layout);
  }
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
  assert.ok(NODE_FONT_SIZE * referenceScale >= 11, 'Full labels remain readable at the supplied reference image size');
  assert.equal(layout.edges.length, 26);
  assert.equal(layout.nodes.length, 24);
  for (const node of layout.nodes) {
    assert.equal(node.lines.map(line => line.text).join('').replace(/\s/g, ''), node.node.label.replace(/\s/g, ''));
  }
});

test('compatible feedback connections share one arrival stem without losing individual edges', async () => {
  const layout = await layoutGraph(await graph(examples[0].source), engine, { automatic: true, detail: true, strategy: 'regions' });
  const returns = layout.edges.filter(edge => edge.crossSection && edge.edge.stroke === 'dotted');
  assert.equal(returns.length, 3);
  const arrivals = returns.map(edge => edge.curves!.at(-1)!.segments.at(-1)!.end);
  assert.equal(new Set(arrivals.map(point => `${point.x},${point.y}`)).size, 1, 'A shared destination should not have a comb of arrowheads');
  assert.equal(new Set(returns.map(edge => edge.edge.id)).size, 3);
  assert.equal(new Set(returns.map(edge => `${edge.curves![0].start.x},${edge.curves![0].start.y}`)).size, 3);
  assertLayout(layout);
});

test('adaptive layouts preserve readable geometry across the comparison corpus in both grouping modes', async () => {
  for (const example of renderingCases) {
    const input = await parseSource(example.source);
    if (input.kind !== 'flowchart') continue;
    for (const automatic of [true, false]) {
      const layout = await layoutGraph(input, engine, { automatic, detail: true });
      assertLayout(layout);
      for (const node of layout.nodes) {
        assert.equal(node.lines.map(line => line.text).join('').replace(/\s/g, ''), node.node.label.replace(/\s/g, ''), example.id);
      }
    }
  }
});

test('simple and disconnected diagrams do not acquire artificial reading regions or placeholder headings', async () => {
  const ids = ['chain-tb', 'chain-lr', 'branch-tb', 'branch-lr', 'disconnected', 'fan-out', 'fan-in', 'dense-layers', 'group-endpoints'];
  for (const id of ids) {
    const input = await graph(renderingCases.find(example => example.id === id)!.source);
    const layout = await layoutGraph(input, engine, { automatic: true, detail: true });
    assert.equal(layout.sections.length, 1, id);
    const svg = renderDiagram(layout, () => {});
    assert.equal(svg.querySelectorAll('.section-title').length, 0, id);
    assert.equal([...svg.querySelectorAll('text')].some(text => text.textContent === 'Untitled diagram'), false, id);
  }
});

test('compound group headers fit in every source direction without transposed minimum dimensions', async () => {
  for (const direction of ['TB', 'BT', 'LR', 'RL']) {
    const input = await graph(`flowchart ${direction}
      subgraph cluster[A long declared group title that wraps across multiple header lines]
        A --> B
      end
      cluster --> C & D
    `);
    const layout = await layoutGraph(input, engine, { automatic: true, detail: true });
    assertLayout(layout);
  }
});

test('cycles retain the authored forward spine without reversing reverse-declared acyclic chains', async () => {
  const cycle = renderingCases.find(example => example.id === 'cycle')!.source;
  for (const source of [cycle, 'flowchart LR\nC[Finish]\nB[Middle]\nA[Start]\nA --> B --> C']) {
    const layout = await layoutGraph(await graph(source), engine, { automatic: true, detail: true });
    const x = (id: string) => layout.nodes.find(node => node.node.id === id)!.x;
    assert.ok(x('A') < x('B') && x('B') < x('C'));
    if (source === cycle) assert.ok(x('C') < x('D'));
    assertLayout(layout);
  }
});

test('reading regions improve fitting on wide canvases without forcing them onto portrait canvases', async () => {
  const input = await graph(examples.find(example => example.id === 'data')!.source);
  const wide = await layoutGraph(input, engine, { automatic: true, detail: true, aspectRatio: 2 });
  const portrait = await layoutGraph(input, engine, { automatic: true, detail: true, aspectRatio: 0.5 });
  assert.ok(wide.sections.length > 1);
  assert.equal(portrait.sections.length, 1);
  assert.ok(Math.min(760 / wide.width, 390 / wide.height) > Math.min(760 / portrait.width, 390 / portrait.height) * 1.3);
  assertLayout(wide);
  assertLayout(portrait);
});

test('decisions have balanced forks, corner departures, and a centered join', async () => {
  const layout = await layoutGraph(await graph(renderingCases.find(item => item.id === 'branch-tb')!.source), engine, { automatic: true, detail: true });
  const node = (id: string) => layout.nodes.find(item => item.node.id === id)!;
  const cx = (id: string) => node(id).x + node(id).width / 2;
  assert.ok(Math.abs(cx('B') - (cx('C') + cx('D')) / 2) < Math.abs(cx('C') - cx('D')) * 0.05);
  assert.ok(Math.abs(cx('B') - cx('E')) < 7);
  const outgoing = layout.edges.filter(edge => edge.edge.source === 'B').map(edge => edge.curves![0].start).sort((a, b) => a.x - b.x);
  assert.ok(Math.abs(outgoing[0].x - node('B').x) < 0.01);
  assert.ok(Math.abs(outgoing[1].x - node('B').x - node('B').width) < 0.01);
  assertLayout(layout);
});

test('fans use shared stems while preserving every individually traceable connection', async () => {
  for (const id of ['fan-out', 'fan-in', 'dense-layers']) {
    const layout = await layoutGraph(await graph(renderingCases.find(item => item.id === id)!.source), engine, { automatic: true, detail: true });
    const endpoints = new Map<string, Set<string>>();
    for (const edge of layout.edges) {
      const end = edge.curves![0].segments.at(-1)!.end;
      const arrivals = endpoints.get(edge.edge.target) ?? new Set();
      arrivals.add(`${end.x},${end.y}`);
      endpoints.set(edge.edge.target, arrivals);
    }
    for (const arrivals of endpoints.values()) assert.equal(arrivals.size, 1, 'Shared destinations have one deliberate arrival instead of a comb');
    assertLayout(layout);
  }
});

test('curvature costs penalize abrupt changes rather than merely counting guide vertices', () => {
  const start = { x: 0, y: 0 };
  const end = { x: 100, y: 100 };
  const gentle = { start, segments: [{ control1: { x: 0, y: 60 }, control2: { x: 100, y: 40 }, end }] };
  const abrupt = { start, segments: [{ control1: { x: 0, y: 1 }, control2: { x: 100, y: 0 }, end }] };
  assert.ok(curveCost(gentle) < curveCost(abrupt));
  const loop = { start, segments: [{ control1: { x: 100, y: 100 }, control2: { x: -100, y: 100 }, end: start }] };
  const bounds = curveBounds(loop);
  assert.ok(bounds.width < 100, 'Export bounds describe the visible curve, not distant control handles');
  assert.ok(Math.abs(bounds.height - 75) < 0.01);
});

test('a diagram made of dotted connections still keeps its authored flow direction', async () => {
  for (const direction of ['TB', 'BT', 'LR', 'RL']) {
    const layout = await layoutGraph(await graph(`flowchart ${direction}\nA -.-> B -.-> C`), engine, { automatic: true, detail: true });
    const a = layout.nodes.find(item => item.node.id === 'A')!;
    const c = layout.nodes.find(item => item.node.id === 'C')!;
    assert.ok(direction === 'TB' ? a.y < c.y : direction === 'BT' ? a.y > c.y : direction === 'LR' ? a.x < c.x : a.x > c.x);
    assertLayout(layout);
  }
});

test('container headings move away from a forward entry instead of making the spine hook around text', async () => {
  const layout = await layoutGraph(await graph(renderingCases.find(item => item.id === 'nested-groups')!.source), engine, { automatic: true, detail: true });
  for (const [source, target] of [['U', 'A'], ['B', 'C']]) {
    const edge = layout.edges.find(item => item.edge.source === source && item.edge.target === target)!;
    const curve = edge.curves![0];
    for (const point of flattenCurve(curve)) assert.ok(Math.abs(point.x - curve.start.x) < 0.1, 'A vertical entry remains a straight connection');
  }
  assertLayout(layout);
});

test('different relation styles and opposing returns do not disappear into a shared port', async () => {
  for (const id of ['cycle', 'parallel-edges']) {
    const layout = await layoutGraph(await graph(renderingCases.find(item => item.id === id)!.source), engine, { automatic: true, detail: true });
    const arrivals = layout.edges.filter(edge => edge.edge.target === (id === 'cycle' ? 'A' : 'B'));
    const solid = arrivals.find(edge => edge.edge.stroke === 'normal')!.curves![0].segments.at(-1)!.end;
    const dotted = arrivals.find(edge => edge.edge.stroke === 'dotted')!.curves![0].segments.at(-1)!.end;
    assert.ok(Math.hypot(solid.x - dotted.x, solid.y - dotted.y) >= 14);
    assertLayout(layout);
  }
  const layout = await layoutGraph(await graph(renderingCases.find(item => item.id === 'feedback-network')!.source), engine, { automatic: true, detail: true });
  const incoming = layout.edges.find(edge => edge.edge.source === 'F' && edge.edge.target === 'C')!.curves![0].segments.at(-1)!.end;
  const outgoing = layout.edges.find(edge => edge.edge.source === 'C' && edge.edge.target === 'B')!.curves![0].start;
  assert.ok(Math.hypot(incoming.x - outgoing.x, incoming.y - outgoing.y) >= 14);
  assertLayout(layout);
});

test('parallel channels with different authored paints keep separate paths and arrowheads', async () => {
  const layout = await layoutGraph(await graph(`flowchart LR
    A -->|Read| B
    A ==>|Write| B
    linkStyle 0 stroke:#cc3333
    linkStyle 1 stroke:#3333cc
  `), engine, { automatic: true, detail: true });
  const ends = layout.edges.map(edge => edge.curves![0].segments.at(-1)!.end);
  assert.ok(Math.hypot(ends[0].x - ends[1].x, ends[0].y - ends[1].y) >= 14);
  assertLayout(layout);
});

test('return ports stay distinct from other relation styles and opposing endpoints across regions', async () => {
  for (const id of ['checkout', 'data', 'ungrouped']) {
    const layout = await layoutGraph(await graph(renderingCases.find(item => item.id === id)!.source), engine,
      { automatic: true, detail: true, strategy: 'regions' });
    const end = (route: typeof layout.edges[number]) => route.curves!.at(-1)!.segments.at(-1)!.end;
    for (const route of layout.edges.filter(route => route.edge.stroke === 'dotted')) {
      for (const other of layout.edges.filter(other => other !== route)) {
        if (other.edge.target === route.edge.target && other.edge.stroke !== route.edge.stroke) {
          assert.ok(Math.hypot(end(route).x - end(other).x, end(route).y - end(other).y) >= 10,
            `${id}: different relation styles need separate arrowheads`);
        }
        if (other.edge.target === route.edge.source) {
          const start = route.curves![0].start;
          assert.ok(Math.hypot(start.x - end(other).x, start.y - end(other).y) >= 10,
            `${id}: a return must not begin on another edge's arrowhead`);
        }
      }
    }
    assertLayout(layout);
  }
});

test('a labeled leaf fan preserves authored order without a node-count-sized vertical corridor', async () => {
  const input = await graph(renderingCases.find(item => item.id === 'fan-out')!.source);
  const layout = await layoutGraph(input, engine, { automatic: true, detail: true });
  const workers = layout.nodes.filter(node => node.node.id !== 'A');
  assert.deepEqual([...workers].sort((a, b) => a.x - b.x).map(node => node.node.id),
    input.nodes.filter(node => node.id !== 'A').map(node => node.id));
  assert.ok(layout.height <= 300, 'A two-rank fan should not become a tall diagram');
  assert.equal(new Set(layout.edges.map(edge => JSON.stringify(edge.curves![0].start))).size, 1);
  assertLayout(layout);
});

test('aligned chains through slanted shape boundaries stay straight', async () => {
  const layout = await layoutGraph(await graph(renderingCases.find(item => item.id === 'shapes')!.source), engine,
    { automatic: true, detail: true });
  for (const source of ['A', 'B']) {
    const curve = layout.edges.find(edge => edge.edge.source === source)!.curves![0];
    for (const point of flattenCurve(curve)) assert.ok(Math.abs(point.y - curve.start.y) < 0.1);
  }
  assertLayout(layout);
});
