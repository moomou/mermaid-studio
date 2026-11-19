import type { ELK, ElkExtendedEdge, ElkNode, LayoutOptions } from 'elkjs/lib/elk-api.js';
import type {
  Box, DiagramEdge, DiagramLayout, DiagramNode, Direction, FlowGraph, Point,
  PositionedEdge, PositionedSection, Section, Structure, TextLine,
} from './model.ts';
import { buildStructure } from './structure.ts';
import { approximateMeasure, EDGE_FONT_SIZE, EDGE_LINE_HEIGHT, NODE_FONT_SIZE, NODE_LINE_HEIGHT, nodeLines, wrapText } from './text.ts';
import type { MeasureText } from './text.ts';
import { routeConnections } from './routing.ts';
import { forwardEdges, positionGroupCaptions, routeFlowConnections } from './flow-routing.ts';
import { curveBounds, curveCost, curveIntersectsBox } from './curves.ts';

export interface LayoutSettings {
  automatic: boolean;
  detail: boolean;
  measure?: MeasureText;
  strategy?: 'adaptive' | 'regions';
  aspectRatio?: number;
}

interface NodeSize {
  width: number;
  height: number;
  lines: TextLine[];
}

const directions: Record<Direction, string> = { TB: 'DOWN', BT: 'UP', LR: 'RIGHT', RL: 'LEFT' };
function measureNode(node: DiagramNode, detail: boolean, measure: MeasureText): NodeSize {
  const round = node.shape === 'circle' || node.shape === 'doublecircle' || node.shape === 'ellipse';
  const decision = node.shape === 'diamond' || node.shape === 'hexagon';
  const paragraphs = detail || decision ? node.label.split('\n') : [node.label.split('\n')[0]];
  const naturalWidth = Math.max(0, ...paragraphs.map(line => measure(line, NODE_FONT_SIZE)));
  let width = Math.min(260, Math.max(64, naturalWidth + 28));
  if (node.shape === 'diamond') width = Math.min(280, Math.max(96, naturalWidth * 1.7 + 32));
  if (node.shape === 'hexagon') width = Math.min(280, Math.max(96, naturalWidth + 48));
  if (round) width = Math.min(200, Math.max(56, naturalWidth + 36));
  const textWidth = node.shape === 'diamond' ? width * 0.55
    : node.shape === 'hexagon' ? width * 0.6 : round ? width * 0.72 : width - 28;
  const lines = nodeLines(node.label, textWidth, detail || decision, measure);
  if (decision) lines.forEach(line => { line.secondary = false; });
  const textHeight = lines.length * NODE_LINE_HEIGHT;
  let height = Math.max(40, textHeight + 20);
  if (node.shape === 'diamond') height = Math.max(64, textHeight * 2 + 20);
  if (node.shape === 'cylinder') height += 10;
  if (node.shape === 'circle' || node.shape === 'doublecircle') {
    width = Math.max(width, height);
    height = width;
  }
  return { width, height, lines };
}

function groupDepth(id: string, parents: Map<string, string | undefined>): number {
  let depth = 0;
  let parent = parents.get(id);
  while (parent) { depth++; parent = parents.get(parent); }
  return depth;
}

function number(value: number | undefined, context: string): number {
  if (value === undefined || !Number.isFinite(value)) throw new Error(`The layout engine returned an invalid ${context}.`);
  return value;
}

function boundsOf(boxes: Box[]): Box {
  const x = Math.min(...boxes.map(box => box.x));
  const y = Math.min(...boxes.map(box => box.y));
  return { x, y, width: Math.max(...boxes.map(box => box.x + box.width)) - x, height: Math.max(...boxes.map(box => box.y + box.height)) - y };
}

function drawingBounds(layout: DiagramLayout): Box {
  return boundsOf([
    ...layout.nodes, ...layout.groups, ...layout.groups.flatMap(group => group.caption ? [group.caption] : []),
    ...layout.edges.flatMap(edge => [...edge.curves?.map(curveBounds) ?? [], ...edge.label ? [edge.label] : []]),
  ]);
}

function moveDrawing(layout: DiagramLayout, dx: number, dy: number): void {
  for (const box of [...layout.nodes, ...layout.groups, ...layout.groups.flatMap(group => group.caption ? [group.caption] : [])]) {
    box.x += dx; box.y += dy;
  }
  for (const edge of layout.edges) {
    for (const path of edge.paths) for (const point of path) { point.x += dx; point.y += dy; }
    for (const curve of edge.curves ?? []) {
      curve.start = { x: curve.start.x + dx, y: curve.start.y + dy };
      for (const segment of curve.segments) for (const key of ['control1', 'control2', 'end'] as const) {
        segment[key] = { x: segment[key].x + dx, y: segment[key].y + dy };
      }
    }
    if (edge.label) { edge.label.x += dx; edge.label.y += dy; }
  }
}

function encloseLocalConnections(layout: DiagramLayout): void {
  const parents = new Map([...layout.graph.nodes, ...layout.graph.groups].map(entity => [entity.id, entity.parent]));
  const inside = (id: string, group: string) => {
    let parent = parents.get(id);
    while (parent) { if (parent === group) return true; parent = parents.get(parent); }
    return false;
  };
  for (const group of [...layout.groups].sort((a, b) => b.depth - a.depth)) {
    const boxes: Box[] = [
      ...layout.nodes.filter(node => inside(node.node.id, group.group.id)),
      ...layout.groups.filter(other => inside(other.group.id, group.group.id)),
      ...layout.edges.filter(edge => inside(edge.edge.source, group.group.id) && inside(edge.edge.target, group.group.id))
        .flatMap(edge => [...edge.curves?.map(curveBounds) ?? [], ...edge.label ? [edge.label] : []]),
    ];
    if (!boxes.length) continue;
    const content = boundsOf(boxes);
    const right = Math.max(group.x + group.width, content.x + content.width + 12);
    const bottom = Math.max(group.y + group.height, content.y + content.height + 12);
    const header = group.depth < 0 ? layout.sections[0].headerHeight : 16 + group.lines.length * 19;
    group.x = Math.min(group.x, content.x - 12);
    if (content.y < group.y + header) group.y = Math.min(group.y, content.y - header - 12);
    group.width = right - group.x;
    group.height = bottom - group.y;
  }
}

function detachedGroupConnections(layout: DiagramLayout): Set<string> {
  const groups = new Map(layout.groups.map(group => [group.group.id, group]));
  const attached = (id: string, point: Point | undefined): boolean => {
    const box = groups.get(id);
    if (!box) return true;
    if (!point || point.x < box.x - 0.1 || point.x > box.x + box.width + 0.1
      || point.y < box.y - 0.1 || point.y > box.y + box.height + 0.1) return false;
    return Math.min(Math.abs(point.x - box.x), Math.abs(point.x - box.x - box.width),
      Math.abs(point.y - box.y), Math.abs(point.y - box.y - box.height)) <= 0.1;
  };
  return new Set(layout.edges.filter(route => {
    if (route.edge.stroke === 'invisible') return false;
    const last = route.curves?.at(-1);
    return !attached(route.edge.source, route.curves?.[0]?.start)
      || !attached(route.edge.target, last?.segments.at(-1)?.end ?? last?.start);
  }).map(route => route.edge.id));
}

function alignEquivalentRanks(layout: DiagramLayout, forward: Set<string>): void {
  const nodes = new Map(layout.nodes.map(node => [node.node.id, node]));
  const outgoing = new Map<string, Set<string>>();
  const incoming = new Map<string, Set<string>>();
  for (const edge of layout.graph.edges.filter(edge => forward.has(edge.id) && nodes.has(edge.source) && nodes.has(edge.target))) {
    const targets = outgoing.get(edge.source) ?? new Set<string>();
    const sources = incoming.get(edge.target) ?? new Set<string>();
    targets.add(edge.target); sources.add(edge.source);
    outgoing.set(edge.source, targets); incoming.set(edge.target, sources);
  }
  const direction = layout.groups.find(group => group.depth < 0)?.group.direction ?? layout.graph.direction;
  const vertical = direction === 'TB' || direction === 'BT';
  const rank = (node: typeof layout.nodes[number]) => vertical ? node.y + node.height / 2 : node.x + node.width / 2;
  const axis = (node: typeof layout.nodes[number]) => vertical ? node.x + node.width / 2 : node.y + node.height / 2;
  const cohorts = new Map<string, typeof layout.nodes>();
  for (const node of layout.nodes) {
    const targets = [...outgoing.get(node.node.id) ?? []].sort();
    if (!targets.length) continue;
    const key = JSON.stringify([node.node.parent, targets]);
    const members = cohorts.get(key) ?? [];
    members.push(node); cohorts.set(key, members);
  }
  for (const cohort of cohorts.values()) {
    if (cohort.length < 2 || Math.max(...cohort.map(rank)) - Math.min(...cohort.map(rank)) > 1) continue;
    const ids = new Set(cohort.map(node => node.node.id));
    const targets = [...outgoing.get(cohort[0].node.id)!].map(id => nodes.get(id)!);
    const partners = targets.length > 1 && targets.every(node => {
      const sources = incoming.get(node.node.id)!;
      return sources.size === ids.size && [...sources].every(id => ids.has(id));
    }) && targets.every(node => node.node.parent === targets[0].node.parent)
      && Math.max(...targets.map(rank)) - Math.min(...targets.map(rank)) <= 1 ? targets : [];
    if (!partners.length) continue;
    const participants = [...cohort, ...partners];
    const center = partners.length ? participants.reduce((sum, node) => sum + axis(node), 0) / participants.length
      : targets.length === 1 ? axis(targets[0]) : cohort.reduce((sum, node) => sum + axis(node), 0) / cohort.length;
    const proposed = new Map<typeof layout.nodes[number], Box>();
    for (const members of [cohort, partners]) {
      const ordered = [...members].sort((a, b) => axis(a) - axis(b));
      const span = ordered.reduce((sum, node) => sum + (vertical ? node.width : node.height), 0) + Math.max(0, ordered.length - 1) * 22;
      let cursor = center - span / 2;
      for (const node of ordered) {
        proposed.set(node, { x: vertical ? cursor : node.x, y: vertical ? node.y : cursor, width: node.width, height: node.height });
        cursor += (vertical ? node.width : node.height) + 22;
      }
    }
    let safe = true;
    for (const [node, box] of proposed) {
      if (layout.nodes.some(other => other !== node && !proposed.has(other)
        && box.x < other.x + other.width + 3 && box.x + box.width > other.x - 3
        && box.y < other.y + other.height + 3 && box.y + box.height > other.y - 3)) safe = false;
      const parent = layout.groups.find(group => group.group.id === node.node.parent);
      if (parent && (box.x < parent.x + 4 || box.y < parent.y + 4
        || box.x + box.width > parent.x + parent.width - 4 || box.y + box.height > parent.y + parent.height - 4)) safe = false;
    }
    if (safe) for (const [node, box] of proposed) { node.x = box.x; node.y = box.y; }
  }
}

export async function layoutGraph(
  graph: FlowGraph,
  engine: Pick<ELK, 'layout'>,
  settings: LayoutSettings,
): Promise<DiagramLayout> {
  const structure = buildStructure(graph, settings.automatic);
  if (!structure.sections.length) throw new Error('Add at least one node to this flowchart.');
  if (settings.strategy === 'regions') return layoutSections(graph, engine, settings, structure);
  const aspectRatio = Math.max(0.25, Math.min(4, settings.aspectRatio ?? 1.6));
  const section: Section = {
    id: 'section-0', index: 0, label: '', inferred: false,
    nodeIds: graph.nodes.map(node => node.id), groupIds: graph.groups.map(group => group.id),
  };
  const compact: Structure = {
    sections: [section], crossLinks: [],
    sectionByEntity: new Map([...section.nodeIds, ...section.groupIds].map(id => [id, section.id])),
  };
  let connected: DiagramLayout | undefined;
  let failure: unknown;
  try {
    connected = await layoutSections(graph, engine, settings, compact);
  } catch (error) {
    failure = error;
  }
  if (structure.sections.length > 1) {
    try {
      const regions = await layoutSections(graph, engine, settings, structure);
      // Extra reading regions must earn their added headings and cross-region wires.
      if (!connected || layoutCost(regions, aspectRatio) < layoutCost(connected, aspectRatio) * 0.88) return regions;
    } catch (error) {
      if (!connected) throw error;
    }
  }
  if (!connected) throw failure;
  return connected;
}

function layoutCost(layout: DiagramLayout, aspectRatio: number): number {
  let length = 0;
  let bends = 0;
  const visible = layout.edges.filter(edge => edge.edge.stroke !== 'invisible');
  for (const edge of visible) {
    if (edge.curves) {
      length += edge.curves.reduce((sum, path) => sum + curveCost(path), 0);
    } else for (const path of edge.paths) {
      bends += Math.max(0, path.length - 2);
      path.slice(1).forEach((point, index) => {
        length += Math.hypot(point.x - path[index].x, point.y - path[index].y);
      });
    }
  }
  return Math.max(layout.width / aspectRatio, layout.height) + Math.sqrt(layout.width * layout.height) * 0.15
    + (length * 0.1 + bends * 8) / Math.max(1, visible.length);
}

async function layoutSections(
  graph: FlowGraph,
  engine: Pick<ELK, 'layout'>,
  settings: LayoutSettings,
  structure: Structure,
): Promise<DiagramLayout> {
  const measure = settings.measure ?? approximateMeasure;
  const guided = structure.sections.length > 1;
  const result: DiagramLayout = {
    graph, structure, nodes: [], groups: [], edges: [], sections: [], width: 0, height: 0, detail: settings.detail, titleLines: [],
  };
  const localLayouts: { section: Section; root: ElkNode; lifted?: string }[] = [];
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const groups = new Map(graph.groups.map(group => [group.id, group]));
  const edges = new Map(graph.edges.map(edge => [edge.id, edge]));
  const parents = new Map([...graph.nodes, ...graph.groups].map(entity => [entity.id, entity.parent]));
  const sizes = new Map<string, NodeSize>();
  const backbone = forwardEdges(graph);
  const groupLines = new Map<string, string[]>();
  const edgeLines = new Map<string, string[]>();
  for (const node of graph.nodes) sizes.set(node.id, measureNode(node, settings.detail, measure));

  for (const section of structure.sections) {
    const topGroups = section.groupIds.filter(id => !groups.get(id)!.parent);
    const lifted = topGroups.length === 1
      && section.nodeIds.every(id => {
        let root = id;
        while (parents.get(root)) root = parents.get(root)!;
        return root === topGroups[0];
      }) ? topGroups[0] : undefined;
    const localDirection = (lifted && groups.get(lifted)?.direction) || graph.direction;
    const vertical = localDirection === 'TB' || localDirection === 'BT';
    const options: LayoutOptions = {
      'elk.algorithm': 'layered',
      'elk.direction': directions[localDirection],
      'elk.edgeRouting': 'POLYLINE',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.padding': '[top=8,left=12,bottom=12,right=12]',
      'elk.spacing.nodeNode': '22',
      'elk.layered.spacing.nodeNodeBetweenLayers': '32',
      'elk.layered.spacing.edgeNodeBetweenLayers': '8',
      'elk.spacing.edgeNode': '10',
      'elk.spacing.edgeEdge': '9',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.layered.crossingMinimization.forceNodeModelOrder': 'false',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.layered.nodePlacement.favorStraightEdges': 'false',
      'elk.layered.mergeEdges': 'false',
      'elk.layered.cycleBreaking.strategy': 'DEPTH_FIRST',
      'elk.separateConnectedComponents': 'true',
    };
    const root: ElkNode = { id: `layout-${section.id}`, children: [], edges: [], layoutOptions: options };
    const elkEntities = new Map<string, ElkNode>();
    if (lifted) elkEntities.set(lifted, root);
    for (const id of section.groupIds) {
      if (id === lifted) continue;
      const group = groups.get(id)!;
      const lines = wrapText(group.label, 240, 16, measure);
      groupLines.set(id, lines);
      const headerHeight = 16 + lines.length * 19;
      const minimumWidth = Math.max(96, ...lines.map(line => measure(line, 16) + 24));
      const minimumHeight = headerHeight + 34;
      elkEntities.set(id, {
        id: `group:${id}`, children: [], edges: [],
        width: minimumWidth, height: minimumHeight,
        layoutOptions: {
          'elk.direction': directions[group.direction ?? graph.direction],
          'elk.padding': `[top=${headerHeight},left=12,bottom=12,right=12]`,
          'elk.nodeSize.constraints': 'MINIMUM_SIZE',
          // Layered ELK transposes compound minimum sizes in vertical layouts.
          'elk.nodeSize.minimum': vertical ? `(${minimumHeight},${minimumWidth})` : `(${minimumWidth},${minimumHeight})`,
        },
      });
    }
    for (const id of section.nodeIds) {
      const size = sizes.get(id)!;
      elkEntities.set(id, { id: `node:${id}`, width: size.width, height: size.height });
    }
    for (const id of [...section.groupIds, ...section.nodeIds]) {
      if (id === lifted) continue;
      const parent = parents.get(id);
      const container = parent ? elkEntities.get(parent) : root;
      if (!container?.children) throw new Error(`Cannot place "${id}" inside its declared subgraph.`);
      container.children.push(elkEntities.get(id)!);
    }
    const localEdges = graph.edges.filter(edge =>
      structure.sectionByEntity.get(edge.source) === section.id
      && structure.sectionByEntity.get(edge.target) === section.id
      && (backbone.has(edge.id) || edge.stroke === 'invisible'));
    for (const edge of localEdges) {
      const source = elkEntities.get(edge.source)!;
      const target = elkEntities.get(edge.target)!;
      const ancestorIds = (id: string): string[] => {
        const ancestors: string[] = [];
        let parent = parents.get(id);
        while (parent) { ancestors.push(parent); parent = parents.get(parent); }
        return ancestors;
      };
      const sourceAncestors = ancestorIds(edge.source);
      const targetAncestors = new Set(ancestorIds(edge.target));
      const common = sourceAncestors.find(id => targetAncestors.has(id));
      const container = common ? elkEntities.get(common)! : root;
      const lines = wrapText(edge.label, 160, EDGE_FONT_SIZE, measure);
      edgeLines.set(edge.id, lines);
      const elkEdge: ElkExtendedEdge = {
        id: edge.id,
        sources: [source.id], targets: [target.id],
        layoutOptions: {
          'elk.layered.priority.direction': edge.stroke === 'dotted' ? '0' : '10',
          'elk.layered.layering.minLength': String(Math.max(1, edge.length)),
        },
        labels: [],
      };
      container.edges!.push(elkEdge);
    }
    const containers = new Set([root, ...elkEntities.values()]);
    let scaffold = 0;
    for (const container of containers) {
      const actual = [...container.edges ?? []].filter(edge => edges.get(edge.id)!.stroke !== 'invisible');
      if (!container.children || !actual.length) continue;
      const annotation = (id: string) => {
        const edge = edges.get(id)!;
        const lines = edgeLines.get(id)!;
        return !edge.label ? 0 : vertical ? lines.length * EDGE_LINE_HEIGHT + 6
          : Math.max(...lines.map(line => measure(line, EDGE_FONT_SIZE))) + 10;
      };
      const reserve = (sources: string[], targets: string[], extent: number) => {
        // Layout-only spacers reserve a curve corridor without stretching unrelated ranks.
        const id = `space:${section.id}:${scaffold++}`;
        const size = Math.max(1, extent - 64);
        container.children!.push({ id, width: vertical ? 1 : size, height: vertical ? size : 1 });
        for (const source of new Set(sources)) container.edges!.push({ id: `${id}:in:${source}`, sources: [source], targets: [id] });
        for (const target of new Set(targets)) container.edges!.push({ id: `${id}:out:${target}`, sources: [id], targets: [target] });
        container.layoutOptions = { ...container.layoutOptions, 'elk.layered.spacing.nodeNodeBetweenLayers': '32' };
      };
      const fanned = new Set<string>();
      for (const endpoint of ['sources', 'targets'] as const) {
        const families = new Map<string, ElkExtendedEdge[]>();
        for (const edge of actual) {
          const members = families.get(edge[endpoint][0]) ?? [];
          members.push(edge);
          families.set(edge[endpoint][0], members);
        }
        for (const members of families.values()) {
          if (members.length < 2 || (members.length === 2 && !members.some(edge => edges.get(edge.id)!.label))) continue;
          members.forEach(edge => fanned.add(edge.id));
          const label = Math.max(...members.map(edge => annotation(edge.id)));
          const leafFan = endpoint === 'sources' && members.length > 2 && members.every(edge => {
            const original = edges.get(edge.id)!;
            return nodes.has(original.target) && !graph.edges.some(other => other.source === original.target
              || (other.target === original.target && other.source !== original.source));
          });
          const extent = leafFan ? Math.max(80, label + 48)
            : members.length > 2 ? Math.min(512, 48 + members.length * NODE_FONT_SIZE * 2 + label) : Math.max(64, label + 32);
          reserve(members.flatMap(edge => edge.sources), members.flatMap(edge => edge.targets), extent);
          if (leafFan) {
            const replaced = new Set(members.map(edge => edge.id));
            container.edges = container.edges!.filter(edge => !replaced.has(edge.id));
            container.layoutOptions = { ...container.layoutOptions, 'elk.layered.crossingMinimization.forceNodeModelOrder': 'true' };
          }
        }
      }
      for (const edge of actual) {
        const original = edges.get(edge.id)!;
        if (!fanned.has(edge.id) && (original.label || original.length > 1)) {
          reserve(edge.sources, edge.targets, Math.max(64, annotation(edge.id) + 32, original.length * 32));
        }
      }
    }
    const laidOut = await engine.layout(root);
    localLayouts.push({ section, root: laidOut, lifted });
  }

  const horizontal = localLayouts.filter(local => {
    const direction = (local.lifted && groups.get(local.lifted)?.direction) || graph.direction;
    return direction === 'LR' || direction === 'RL';
  }).length <= localLayouts.length / 2;
  const outerPadding = guided ? 36 : 16;
  const titled = graph.title !== 'Untitled diagram';
  const minimumWidth = guided ? 256 : titled ? Math.min(320, measure(graph.title, 20)) : 0;
  const sectionIndex = new Map(structure.sections.map((section, index) => [section.id, index]));
  const gaps = structure.sections.map((_, index) => {
    const crossing = structure.crossLinks.filter(link => {
      const a = sectionIndex.get(link.sourceSection)!;
      const b = sectionIndex.get(link.targetSection)!;
      return Math.min(a, b) <= index && Math.max(a, b) > index;
    }).length;
    const annotationWidth = Math.max(0, ...graph.edges.filter(edge => edge.label
      && (structure.sectionByEntity.get(edge.source) === structure.sections[index].id
        || structure.sectionByEntity.get(edge.target) === structure.sections[index].id))
      .map(edge => Math.max(...wrapText(edge.label, 160, EDGE_FONT_SIZE, measure).map(line => measure(line, EDGE_FONT_SIZE))) + 10));
    return Math.max(64, 32 + crossing * 18, annotationWidth + 48);
  });
  const widths = localLayouts.map(local => Math.max(minimumWidth, number(local.root.width, 'section width')));
  const maxWidth = Math.max(...widths);
  const diagramWidth = (horizontal ? widths.reduce((a, b) => a + b, 0)
    + gaps.slice(0, -1).reduce((a, b) => a + b, 0) : maxWidth) + 2 * outerPadding;
  result.titleLines = titled ? wrapText(graph.title, diagramWidth - 32, 20, measure) : [];
  let titleHeight = result.titleLines.length ? 16 + result.titleLines.length * 24 : 0;
  let cursor = outerPadding + (horizontal ? 0 : titleHeight);
  const sectionTitles = localLayouts.map(({ section, lifted }, index) => guided
    ? wrapText(section.label, widths[index] - 54, 13, measure)
    : lifted ? wrapText(groups.get(lifted)!.label, widths[index] - 24, 16, measure) : []);
  const headerHeight = guided ? Math.max(42, ...sectionTitles.map(lines => 20 + lines.length * 17))
    : sectionTitles[0].length ? 16 + sectionTitles[0].length * 19 : 0;
  const maxHeight = Math.max(...localLayouts.map(local => number(local.root.height, 'section height')));
  const coordinateById = new Map<string, Box>();
  const pendingEdges: { edge: ElkExtendedEdge; origin: { x: number; y: number }; sectionId: string }[] = [];
  localLayouts.forEach(({ section, root, lifted }, index) => {
    const width = horizontal ? widths[index] : maxWidth;
    const height = number(root.height, 'section height') + headerHeight;
    const card: PositionedSection = {
      section, lines: sectionTitles[index], headerHeight,
      x: horizontal ? cursor : outerPadding,
      y: horizontal ? outerPadding + titleHeight : cursor,
      width, height,
    };
    result.sections.push(card);
    const contentX = card.x + (width - number(root.width, 'section width')) / 2;
    const contentY = card.y + headerHeight;
    const visit = (item: ElkNode, x: number, y: number) => {
      const box = {
        x, y, width: number(item.width, 'entity width'), height: number(item.height, 'entity height'),
      };
      coordinateById.set(item.id, box);
      if (item.id.startsWith('node:')) {
        const id = item.id.slice(5);
        result.nodes.push({ ...box, node: nodes.get(id)!, ...sizes.get(id)!, sectionId: section.id });
      } else if (item.id.startsWith('group:')) {
        const id = item.id.slice(6);
        result.groups.push({
          ...box, group: groups.get(id)!, sectionId: section.id,
          lines: groupLines.get(id)!, depth: groupDepth(id, parents),
        });
      }
      for (const edge of item.edges ?? []) if (edges.has(edge.id)) pendingEdges.push({ edge, origin: { x, y }, sectionId: section.id });
      for (const child of item.children ?? []) visit(child, x + number(child.x, 'x coordinate'), y + number(child.y, 'y coordinate'));
    };
    visit(root, contentX, contentY);
    if (lifted) {
      result.groups.push({
        group: groups.get(lifted)!, ...card, sectionId: section.id, lines: [],
        depth: -1,
      });
    }
    cursor += (horizontal ? width : height) + gaps[index];
  });
  for (const { edge, origin, sectionId } of pendingEdges) {
    const offset = edge.container ? coordinateById.get(edge.container) : origin;
    if (!offset) throw new Error(`Cannot locate edge container "${edge.container}".`);
    const original = edges.get(edge.id)!;
    const paths = (edge.sections ?? []).map(part =>
      [part.startPoint, ...(part.bendPoints ?? []), part.endPoint]
        .map(point => ({ x: point.x + offset.x, y: point.y + offset.y })));
    if (!paths.length && original.stroke !== 'invisible') throw new Error(`No route was produced for "${original.source}" to "${original.target}".`);
    const positioned: PositionedEdge = { edge: original, paths, sectionId };
    const label = edge.labels?.[0];
    if (label) positioned.label = {
      x: offset.x + number(label.x, 'edge label x'), y: offset.y + number(label.y, 'edge label y'),
      width: number(label.width, 'edge label width'), height: number(label.height, 'edge label height'),
      lines: edgeLines.get(edge.id)!,
    };
    result.edges.push(positioned);
  }
  result.width = horizontal ? cursor - gaps.at(-1)! + outerPadding : maxWidth + 2 * outerPadding;
  result.height = horizontal ? titleHeight + maxHeight + headerHeight + 2 * outerPadding : cursor - gaps.at(-1)! + outerPadding;
  const completed: { mini: DiagramLayout; bounds: Box; border: boolean; width: number; height: number }[] = [];
  for (const card of result.sections) {
    const nodeIds = new Set(card.section.nodeIds);
    const groupIds = new Set(card.section.groupIds);
    const localGraph: FlowGraph = {
      ...graph,
      nodes: graph.nodes.filter(node => nodeIds.has(node.id)),
      groups: graph.groups.filter(group => groupIds.has(group.id)),
      edges: graph.edges.filter(edge => structure.sectionByEntity.get(edge.source) === card.section.id
        && structure.sectionByEntity.get(edge.target) === card.section.id),
    };
    const mini: DiagramLayout = {
      ...result, graph: localGraph, nodes: result.nodes.filter(node => node.sectionId === card.section.id),
      groups: result.groups.filter(group => group.sectionId === card.section.id),
      edges: result.edges.filter(edge => edge.sectionId === card.section.id), sections: [card],
      structure: { sections: [card.section], sectionByEntity: structure.sectionByEntity, crossLinks: [] },
    };
    alignEquivalentRanks(mini, backbone);
    routeFlowConnections(mini, measure, { forward: backbone, fit: false });
    encloseLocalConnections(mini);
    for (let pass = 0; pass < mini.groups.length; pass++) {
      const detached = detachedGroupConnections(mini);
      if (!detached.size) break;
      // Enlarged boundaries invalidate only their displaced ports, not the finished spine.
      const preserve = new Set(mini.edges.filter(edge => !detached.has(edge.edge.id)).map(edge => edge.edge.id));
      routeFlowConnections(mini, measure, { forward: backbone, fit: false, preserve });
      encloseLocalConnections(mini);
    }
    positionGroupCaptions(mini, measure, backbone);
    const bounds = drawingBounds(mini);
    const border = mini.groups.some(group => group.depth < 0);
    completed.push({
      mini, bounds, border,
      width: Math.max(minimumWidth, bounds.width + (border ? 0 : 24)),
      height: bounds.height + (border ? 0 : card.headerHeight + 24),
    });
  }
  const finalMaxWidth = Math.max(...completed.map(item => item.width));
  const finalWidth = (horizontal ? completed.reduce((sum, item) => sum + item.width, 0)
    + gaps.slice(0, -1).reduce((a, b) => a + b, 0) : finalMaxWidth) + 2 * outerPadding;
  result.titleLines = titled ? wrapText(graph.title, finalWidth - 32, 20, measure) : [];
  titleHeight = result.titleLines.length ? 16 + result.titleLines.length * 24 : 0;
  cursor = outerPadding + (horizontal ? 0 : titleHeight);
  result.edges = [];
  for (const [index, item] of completed.entries()) {
    const card = item.mini.sections[0];
    card.x = horizontal ? cursor : outerPadding;
    card.y = horizontal ? outerPadding + titleHeight : cursor;
    card.width = horizontal ? item.width : finalMaxWidth;
    card.height = item.height;
    const left = card.x + (card.width - item.width) / 2 + (item.border ? 0 : 12);
    const top = card.y + (item.border ? 0 : card.headerHeight + 12);
    moveDrawing(item.mini, left - item.bounds.x, top - item.bounds.y);
    for (const group of item.mini.groups.filter(group => group.depth < 0)) {
      group.x = card.x; group.y = card.y; group.width = card.width; group.height = card.height;
    }
    result.edges.push(...item.mini.edges);
    cursor += (horizontal ? card.width : card.height) + gaps[index];
  }
  result.width = finalWidth;
  result.height = horizontal ? Math.max(...result.sections.map(card => card.y + card.height)) + outerPadding
    : cursor - gaps.at(-1)! + outerPadding;
  const localEdges = new Set(result.edges.filter(edge => edge.curves).map(edge => edge.edge.id));
  try {
    routeConnections(result, measure);
  } catch {
    // Orthogonal routes are only optional obstacle guides for the curve router.
  }
  routeFlowConnections(result, measure, { forward: backbone, preserve: localEdges });
  assertComplete(result);
  return result;
}

function assertComplete(layout: DiagramLayout): void {
  if (detachedGroupConnections(layout).size) {
    throw new Error('A connection could not be attached to its final subgraph boundary.');
  }
  const rendered = new Set(layout.nodes.map(node => node.node.id));
  if (rendered.size !== layout.graph.nodes.length || layout.nodes.length !== rendered.size) {
    throw new Error('Layout did not preserve every node exactly once.');
  }
  const visible = layout.graph.edges.filter(edge => edge.stroke !== 'invisible');
  const represented = layout.edges.filter(edge => edge.edge.stroke !== 'invisible').map(edge => edge.edge.id);
  if (new Set(represented).size !== visible.length || represented.length !== visible.length) {
    throw new Error('Layout did not preserve every visible connection exactly once.');
  }
  const overlaps = (a: Box, b: Box): boolean => a.x + 0.1 < b.x + b.width && b.x + 0.1 < a.x + a.width
    && a.y + 0.1 < b.y + b.height && b.y + 0.1 < a.y + a.height;
  for (const [index, node] of layout.nodes.entries()) {
    if (layout.nodes.slice(index + 1).some(other => overlaps(node, other))) {
      throw new Error('The layout engine placed overlapping nodes.');
    }
  }
  for (const route of layout.edges.filter(edge => edge.edge.stroke !== 'invisible')) {
    if (route.label && layout.nodes.some(node => overlaps(route.label!, node))) {
      throw new Error('The layout engine placed an edge label over a node.');
    }
    for (const curve of route.curves ?? []) {
      for (const node of layout.nodes) {
        if (node.node.id === route.edge.source || node.node.id === route.edge.target) continue;
        if (curveIntersectsBox(curve, { x: node.x + 1, y: node.y + 1, width: node.width - 2, height: node.height - 2 })) {
          throw new Error('The layout engine routed a connection through another node.');
        }
      }
    }
  }
}

export function edgeDescription(edge: DiagramEdge, graph: FlowGraph): string {
  const labels = new Map([...graph.nodes, ...graph.groups].map(entity => [entity.id, entity.label.split('\n')[0]]));
  const direction = edge.startMarker !== 'none' ? ' <-> ' : edge.endMarker !== 'none' ? ' -> ' : ' -- ';
  return `${labels.get(edge.source)}${direction}${labels.get(edge.target)}${edge.label ? `: ${edge.label}` : ''}`;
}
